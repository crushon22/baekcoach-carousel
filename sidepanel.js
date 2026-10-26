// 사이드 패널 진입점 — 상태를 모으고 화면 모듈들을 이어 붙인다. (docs/인터페이스_패널.md)
import { request } from './lib/bus.js';
import * as store from './lib/store.js';
import { IS_WEB } from './lib/platform.js';
import { h, setChildren, toast, $ } from './ui/dom.js';
import { S, fn, el, composed, saveNow, updateStatus, unmountPf } from './ui/app.js';
import { showError, clearErrors } from './ui/errors.js';
import { TYPE_LABELS } from './ui/labels.js';
import { PURPOSES } from './lib/ai-util.js';
import { COUNT_OPTIONS } from './ui/labels.js';
import { renderStrip, renderStartStage, loadProduct, loadStatus, buildProduct, hasKey } from './ui/start.js';
import { startGenerate, regenerate, cancelStream } from './ui/stream.js';
import { renderEdit, renderEditMeta, onCardIndexChanged, startRewrite } from './ui/tab-edit.js';
import { renderReview, gotoCard } from './ui/tab-review.js';
import { renderCaption } from './ui/tab-caption.js';
import { initDock, showDock, loadChat, renderChatLog } from './ui/dock.js';
import { openExport, closeOverlay } from './ui/export.js';
import { openHistory, openProject } from './ui/history.js';

// ───────────────────────── 화면 자리 ─────────────────────────
for (const id of ['app', 'banner', 'strip', 'notices', 'decision', 'stage', 'phone', 'sheet', 'dock', 'overlay']) el[id] = document.getElementById(id);

const TABS = ['edit', 'review', 'caption'];

// ───────────────────────── 작은 화면 조각 ─────────────────────────

function renderBanner() {
  const b = S.newProductBanner;
  el.banner.hidden = !b;
  if (!b) { el.banner.replaceChildren(); return; }
  setChildren(el.banner, h('div', { class: 'card banner', id: 'new-product-banner', role: 'status' },
    h('strong', null, '다른 상품을 보고 계세요'),
    h('p', null, b.title ? `“${b.title}”` : '새 상품 페이지가 열렸어요.'),
    h('p', { class: 'muted small' }, '지금 하던 작업은 덮어쓰지 않고 "지난 작업"에 저장돼요.'),
    h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn btn-primary', id: 'btn-new-product', onclick: () => startNew() }, '새 상품으로 시작'),
      h('button', { type: 'button', class: 'btn', onclick: () => { S.newProductBanner = null; renderBanner(); } }, '계속 이 작업 하기'))));
}

function renderNotices() {
  const lines = (S.project?.notices || []).filter(Boolean);
  if (!lines.length || S.phase === 'start') { el.notices.replaceChildren(); return; }
  setChildren(el.notices, h('ul', { class: 'notices', id: 'notice-list' }, ...lines.slice(0, 4).map((l) => h('li', { class: /시험용 더미/.test(l) ? 'notice-mock' : '' }, l))));
}

function renderDecision() {
  const p = S.project;
  if (!p?.plan || S.phase === 'start') { el.decision.hidden = true; el.decision.replaceChildren(); return; }
  el.decision.hidden = false;
  const locked = !!S.stream || S.phase !== 'ready';
  const chip = (k, label, value) => h('button', { type: 'button', class: 'decide-chip', 'data-kind': k, 'aria-expanded': String(S.picker === k), disabled: locked, onclick: () => { S.picker = S.picker === k ? null : k; renderDecision(); } },
    h('span', { class: 'chip-k' }, label), h('span', { class: 'chip-v' }, value));
  const kids = [h('div', { class: 'decide-row', role: 'group', 'aria-label': '자동으로 정한 것 (누르면 바꿀 수 있어요)' },
    chip('type', '유형', p.plan.typeName || TYPE_LABELS[p.plan.type] || p.plan.type),
    chip('purpose', '목적', p.plan.purpose || '-'),
    chip('count', '장수', `${p.plan.count || p.carousel.cards.length}장`))];
  if (S.picker && !locked) {
    const opts = S.picker === 'type' ? Object.entries(TYPE_LABELS).map(([k, v]) => [k, v, k === p.plan.type])
      : S.picker === 'purpose' ? PURPOSES.map((v) => [v, v, v === p.plan.purpose])
        : COUNT_OPTIONS.map((n) => [n, `${n}장`, n === (p.plan.count || p.carousel.cards.length)]);
    kids.push(h('div', { class: 'picker', id: 'decide-picker' },
      h('div', { class: 'chips' }, ...opts.map(([val, label, on]) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(on), 'data-value': val, onclick: () => pick(S.picker, val, on) }, label))),
      h('p', { class: 'muted small' }, '바꾸면 근거 자료는 그대로 두고 카드를 새로 써요. 직접 고친 글은 사라지고, 사진은 같은 자리면 유지돼요. 유지하지 못한 사진은 위 안내에 한 줄 남아요.')));
  }
  setChildren(el.decision, ...kids);
}

function pick(kind, value, same) {
  S.picker = null;
  if (same) { renderDecision(); return; }
  const options = kind === 'type' ? { type: value } : kind === 'purpose' ? { purpose: value } : { count: value };
  regenerate('all', { options, label: '바꾼 설정으로 다시 만드는 중' });
}

function renderProgress() {
  if (!S.stream) { if (S.phase !== 'start') el.stage.replaceChildren(); return; }
  const pr = S.progress || {};
  const pct = pr.total ? Math.round(((pr.got || 0) / pr.total) * 100) : 8;
  setChildren(el.stage, h('div', { class: 'card progress-card', id: 'progress-card', role: 'status' },
    h('div', { class: 'progress-label', id: 'progress-label' }, pr.total ? `${pr.label} · ${pr.got || 0}/${pr.total}` : pr.label || '만드는 중'),
    h('div', { class: 'progress', 'aria-hidden': 'true' }, h('div', { class: 'progress-bar', style: { width: pct + '%' } })),
    h('p', { class: 'muted small' }, '카드가 만들어지는 대로 아래 폰 화면에 하나씩 나타나요.'),
    h('button', { type: 'button', class: 'btn', id: 'btn-cancel', onclick: () => cancelStream() }, '취소')));
}

function renderStage() {
  if (S.phase === 'start' || S.phase === 'loading') renderStartStage();
  else renderProgress();
}

function renderTabsState() {
  document.querySelectorAll('.tabs [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === S.tab)));
  for (const t of TABS) document.getElementById(`tab-${t}`).hidden = t !== S.tab;
}

function renderTab() {
  if (S.phase !== 'ready' || !S.project) return;
  renderTabsState();
  if (S.tab === 'edit') renderEdit();
  else if (S.tab === 'review') renderReview();
  else renderCaption();
}

function openTab(tab, { scroll = false } = {}) {
  if (!TABS.includes(tab)) return;
  S.tab = tab;
  renderTab();
  if (scroll) el.sheet.scrollIntoView({ block: 'start', behavior: 'auto' });
}

function render() {
  document.body.dataset.phase = S.phase;
  document.body.dataset.streaming = S.stream ? '1' : '';
  renderBanner();
  renderStrip();
  renderNotices();
  renderDecision();
  renderStage();
  const ready = S.phase === 'ready' && !!S.project;
  el.sheet.hidden = !ready;
  el.sheet.classList.toggle('busy', !!S.stream);
  showDock(ready);
  if (ready) renderTab();
  updateStatus();
}

// ───────────────────────── 동작 ─────────────────────────

async function onMake(kind) {
  if (S.phase === 'generating') return;
  if (IS_WEB) S.webKind = kind === 'topic' ? 'topic' : 'manual';
  if (!hasKey()) { renderStage(); document.getElementById('nokey')?.scrollIntoView({ block: 'center' }); return; }
  const product = buildProduct(IS_WEB ? S.webKind : undefined);
  if (!product) { toast(IS_WEB && S.webKind === 'topic' ? '주제를 먼저 적어 주세요.' : '상품 이름이나 주제를 먼저 적어 주세요.', { kind: 'warn' }); document.getElementById(IS_WEB && S.webKind === 'topic' ? 'topic-text' : 'manual-title')?.focus(); return; }
  await startGenerate(product, { link: S.link || '' });
}

async function makeFromShorts(script) {
  const text = String(script || '').trim();
  if (text.length < 10) { toast('쇼츠 대본을 10자 이상 붙여 넣어 주세요.', { kind: 'warn' }); return; }
  if (!hasKey()) { toast('먼저 설정에서 Gemini 키를 넣어 주세요.', { kind: 'warn' }); return; }
  if (S.project && S.phase === 'ready') await saveNow();
  S.link = '';
  await startGenerate({ source: 'shorts', script: text }, { link: '' });
}

/** 새 상품/주제로 시작. 하던 작업은 저장만 하고 덮어쓰지 않는다. */
async function startNew({ keepNothing = false } = {}) {
  if (S.stream) { S.stream.cancel(); S.stream = null; }
  if (S.project && S.phase === 'ready') await saveNow();
  S.project = null; S.phase = 'start'; S.progress = null; S.chat = [];
  S.newProductBanner = null; S.picker = null; S.sel = null; S.link = ''; S.searchResults = null;
  S.manual = { title: '', price: '', imageId: null, imageIds: [], desc: '' };
  S.topic = ''; S.topicImageIds = []; S.webKind = 'manual';
  unmountPf();
  closeOverlay();
  clearErrors();
  if (!keepNothing) { await loadProduct(); await loadStatus(); }
  render();
}

async function openOptions() {
  try { await request('core.openOptions'); } catch (e) { showError(e); }
}

function onCardIndex() { onCardIndexChanged(); if (S.tab === 'review' && S.phase === 'ready') renderReview(); }

Object.assign(fn, {
  render, renderStrip, renderStage, renderProgress, renderDecision, renderNotices, renderTab, openTab, onMake, makeFromShorts, startNew, openOptions,
  regenerate, startGenerate, openExport, gotoCard, openProject, onCardIndex, renderReview, renderEditMeta, rewriteCurrent: () => startRewrite(),
});

// ───────────────────────── 시작 ─────────────────────────

async function resumeCard() {
  try {
    const [last] = await store.listProjects({ limit: 1 });
    S.resume = last && Date.now() - (last.updatedAt || 0) < 6 * 3600 * 1000 && last.carousel?.cards?.length ? { id: last.id, title: last.title } : null;
  } catch { S.resume = null; }
}

async function onProductUpdated(msg) {
  if (S.fixedTab && msg.tabId !== S.fixedTab) return;
  if (S.phase === 'start' || S.phase === 'loading') { await loadProduct(); render(); return; }
  try {
    const rec = await request('coupang.getCurrentProduct', { tabId: msg.tabId });
    const pid = rec?.product?.productId;
    const cur = S.project?.input?.productId;
    if (pid && String(pid) !== String(cur)) { S.newProductBanner = { productId: pid, title: rec.product.title }; renderBanner(); }
  } catch { /* 알림은 선택 기능 */ }
}

async function onSettingsChanged() {
  try {
    S.settings = await request('core.getSettings');
    await loadStatus();
    if (S.phase === 'start') renderStage();
    if (S.phase === 'ready' && S.tab === 'caption') renderTab();
  } catch { /* 다음에 다시 */ }
}

async function boot() {
  const params = new URLSearchParams(location.search);
  const t = Number(params.get('tabId'));
  S.fixedTab = Number.isInteger(t) && t > 0 ? t : undefined;

  initDock();
  document.getElementById('btn-settings').addEventListener('click', openOptions);
  document.getElementById('btn-history').addEventListener('click', openHistory);
  document.getElementById('status-chip').addEventListener('click', () => { if (S.phase === 'ready') openTab('review', { scroll: true }); });
  document.querySelectorAll('.tabs [role=tab]').forEach((b) => b.addEventListener('click', () => openTab(b.dataset.tab)));
  el.overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOverlay(); });

  window.addEventListener('error', (e) => showError(e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => { if (e.reason?.code !== 'CANCELLED') showError(e.reason); });

  if (!IS_WEB) chrome.runtime.onMessage.addListener((msg) => { if (msg?.type === 'coupang.productUpdated') onProductUpdated(msg); });
  if (IS_WEB) document.documentElement.classList.add('web');
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.settings) onSettingsChanged(); });
  render();
  try { S.settings = await request('core.getSettings'); } catch (e) { showError(e); S.settings = { has: {}, fixedTags: [] }; }
  await loadStatus();
  await resumeCard();
  await loadProduct();
  S.phase = 'start';
  render();
  document.documentElement.dataset.ready = '1';
}

boot().catch((e) => showError(e));
