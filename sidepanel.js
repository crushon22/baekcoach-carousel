// 사이드 패널 진입점 — 상태를 모으고 화면 모듈들을 이어 붙인다. (docs/인터페이스_패널.md)
import { request } from './lib/bus.js';
import * as store from './lib/store.js';
import { IS_WEB } from './lib/platform.js';
import { h, setChildren, toast, $ } from './ui/dom.js';
import { S, fn, el, composed, saveNow, updateStatus, unmountPf, isPhoto, refreshAll, scheduleSave, scheduleReview } from './ui/app.js';
import { showError, clearErrors } from './ui/errors.js';
import { TYPE_LABELS } from './ui/labels.js';
import { PURPOSES } from './lib/ai-util.js';
import { COUNT_OPTIONS } from './ui/labels.js';
import { renderStrip, renderStartStage, loadProduct, loadStatus, buildProduct, hasKey, updateMakeEnabled } from './ui/start.js';
import { renderAiStatus } from './ui/aistatus.js';
import { identBlock, resetIdent } from './ui/identify.js';
import { STYLES, STYLE_LABEL, loadModePrefs, saveModePrefs, MIN_PHOTOS, modeTabs, cancelRecreate, maybeAutoFill, pickPhotosForMake } from './ui/photo.js';
import { decorateIcons, logoMark, icon } from './ui/icons.js';
import { renderPreview, schedulePreview } from './ui/preview.js';
import { adCfg } from './ui/adlabel.js';
import { openGuide, guideBand, guideSeen, markGuideSeen } from './ui/guide.js';
import { startGenerate, regenerate, cancelStream } from './ui/stream.js';
import { renderEdit, renderEditMeta, onCardIndexChanged, startRewrite } from './ui/tab-edit.js';
import { renderReview, gotoCard } from './ui/tab-review.js';
import { renderCaption } from './ui/tab-caption.js';
import { initDock, showDock, loadChat, renderChatLog } from './ui/dock.js';
import { openExport, closeOverlay } from './ui/export.js';
import { openHistory, openProject } from './ui/history.js';
import { initDropIn } from './ui/dropin.js';

// ───────────────────────── 화면 자리 ─────────────────────────
for (const id of ['app', 'banner', 'hero', 'modebar', 'livepreview', 'strip', 'notices', 'decision', 'stage', 'phone', 'sheet', 'dock', 'overlay']) el[id] = document.getElementById(id);

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
  if (isPhoto(p)) { renderDecisionPhoto(p, locked); return; }
  const chip = (k, label, value) => h('button', { type: 'button', class: 'decide-chip', 'data-kind': k, 'aria-expanded': String(S.picker === k), disabled: locked, onclick: () => { S.picker = S.picker === k ? null : k; renderDecision(); } },
    h('span', { class: 'chip-k' }, label), h('span', { class: 'chip-v' }, value));
  const kids = [h('div', { class: 'decide-row', role: 'group', 'aria-label': '자동으로 정한 것 (누르면 바꿀 수 있어요)' },
    chip('type', '유형', p.plan.typeName || TYPE_LABELS[p.plan.type] || p.plan.type),
    chip('purpose', '목적', p.plan.purpose || '-'),
    chip('count', '장수', `${p.plan.count || p.carousel.cards.length}장`),
    // 댓글 유도(번호·색상명 숨기기)는 상품 이름이 있을 때만 뜻이 있다(주제·쇼츠 대본으로 만든 것은 칩 없음)
    ...(p.input?.title ? [chip('tease', '댓글 유도', p.options?.tease ? `켬 · "${p.plan?.commentWord || '나도'}"` : '끔')] : []))];
  if (S.picker && !locked) {
    const opts = S.picker === 'type' ? Object.entries(TYPE_LABELS).map(([k, v]) => [k, v, k === p.plan.type])
      : S.picker === 'purpose' ? PURPOSES.filter((v) => !p.options?.tease || ['댓글', 'DM·문의'].includes(v)).map((v) => [v, v, v === p.plan.purpose])   // 댓글 유도가 켜져 있으면 저장·링크·팔로우는 CTA 와 어긋나 고를 수 없다
      : S.picker === 'tease' ? [['on', '켬 · 번호·색상명 숨김', !!p.options?.tease], ['off', '끔 · 이름 그대로', !p.options?.tease]]
        : COUNT_OPTIONS.map((n) => [n, `${n}장`, n === (p.plan.count || p.carousel.cards.length)]);
    kids.push(h('div', { class: 'picker', id: 'decide-picker' },
      h('div', { class: 'chips' }, ...opts.map(([val, label, on]) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(on), 'data-value': val, onclick: () => pick(S.picker, val, on) }, label))),
      h('p', { class: 'muted small' }, (S.picker === 'purpose' && p.options?.tease ? '댓글 유도가 켜져 있어 목적은 댓글·DM 중에서 골라요. ' : '') + '바꾸면 조사한 정보는 그대로 두고 카드를 새로 써요. 직접 고친 글은 사라지고, 사진은 같은 자리면 유지돼요. 유지하지 못한 사진은 위 안내에 한 줄 남아요.')));
  }
  setChildren(el.decision, ...kids);
}

/** 사진 캐러셀: [사진 캐러셀 · N장 · 스타일]. 스타일은 AI 없이 바로 다시 그린다. */
function renderDecisionPhoto(p, locked) {
  const n = p.carousel.cards.length;
  const style = p.carousel.overlayStyle || 'outline';
  // 버전·장수는 바꿀 수 없는 정보라 작은 한 줄로, 바꿀 수 있는 스타일만 칩으로 크게(2026-10-28 사용자 의견: "같은 크기면 안 예뻐요")
  const kids = [h('div', { class: 'decide-row decide-photo', role: 'group', 'aria-label': '사진 캐러셀 설정' },
    h('p', { class: 'decide-meta', id: 'decide-meta' }, h('span', { 'data-kind': 'mode' }, '사진 캐러셀'), h('span', { class: 'decide-sep', 'aria-hidden': 'true' }, '·'), h('span', { 'data-kind': 'count' }, S.lastPick?.from > n ? `${n}장 (사진 ${S.lastPick.from}장 중 골라서)` : `${n}장`),
      ...(p.options?.tease ? [h('span', { class: 'decide-sep', 'aria-hidden': 'true' }, '·'), h('span', { 'data-kind': 'tease' }, `댓글 유도 "${p.plan?.commentWord || '나도'}"`)] : [])),
    h('button', { type: 'button', class: 'decide-chip', 'data-kind': 'style', 'aria-expanded': String(S.picker === 'style'), disabled: locked, onclick: () => { S.picker = S.picker === 'style' ? null : 'style'; renderDecision(); } },
      h('span', { class: 'chip-k' }, '스타일'), h('span', { class: 'chip-v' }, STYLE_LABEL[style] || style)))];
  if (S.picker === 'style' && !locked) {
    kids.push(h('div', { class: 'picker', id: 'decide-picker' },
      h('div', { class: 'chips' }, ...STYLES.map((st) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(st.key === style), 'data-value': st.key, onclick: () => setPhotoStyle(st.key) }, st.label))),
      h('p', { class: 'muted small' }, '스타일은 바로 다시 그려요. 글은 그대로예요. 그라데이션은 줄 수·글자 수 기준이 달라 ⚠️가 바뀔 수 있어요.')));
  }
  setChildren(el.decision, ...kids);
}

/** 글씨 스타일 바꾸기(AI 호출 없음) */
function setPhotoStyle(key) {
  const p = S.project;
  S.picker = null;
  if (!p || p.carousel.overlayStyle === key) { renderDecision(); return; }
  p.carousel.overlayStyle = key;
  p.options = { ...(p.options || {}), overlayStyle: key };
  S.photoStyle = key;
  refreshAll();
  scheduleSave(); scheduleReview();
  renderDecision();
  if (S.tab === 'edit') renderTab();
}

function pick(kind, value, same) {
  S.picker = null;
  if (same) { renderDecision(); return; }
  const options = kind === 'type' ? { type: value } : kind === 'purpose' ? { purpose: value } : kind === 'tease' ? { tease: value === 'on' } : { count: value };
  regenerate('all', { options, label: '바꾼 설정으로 다시 만드는 중' });
}

function renderProgress() {
  if (!S.stream) { if (S.phase !== 'start') el.stage.replaceChildren(); return; }
  const pr = S.progress || {};
  const pct = pr.total ? Math.round(((pr.got || 0) / pr.total) * 100) : 8;
  setChildren(el.stage, h('div', { class: 'card progress-card', id: 'progress-card', role: 'status' },
    h('div', { class: 'progress-label', id: 'progress-label' }, pr.total ? `${pr.label} · ${pr.got || 0}/${pr.total}` : pr.label || '만드는 중'),
    h('div', { class: 'progress', 'aria-hidden': 'true' }, h('div', { class: 'progress-bar', style: { width: pct + '%' } })),
    
    h('button', { type: 'button', class: 'btn', id: 'btn-cancel', onclick: () => cancelStream() }, '취소')));
}

/** 시작 화면 맨 위: 히어로 문구 + 버전 고르기 */
function renderHero() {
  if (S.phase !== 'start') { el.hero.replaceChildren(); return; }
  setChildren(el.hero, h('h2', { class: 'hero-title' }, '사진과 상품 이름만 넣으면', h('br'), '캐러셀이 10초 만에 나와요'));
}

function renderModebar() {
  if (S.phase !== 'start') { el.modebar.replaceChildren(); return; }
  const kids = [];
  if (!S.guideSeen) kids.push(guideBand({ onClose: () => { S.guideSeen = true; markGuideSeen(); renderModebar(); } }));
  kids.push(modeTabs());
  setChildren(el.modebar, ...kids);
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
  renderHero();
  renderModebar();
  renderPreview();
  renderStrip();
  renderNotices();
  renderDecision();
  renderStage();
  const ready = S.phase === 'ready' && !!S.project;
  el.sheet.hidden = !ready;
  el.sheet.classList.toggle('busy', !!S.stream);
  showDock(ready);
  const ci = document.getElementById('chat-input');
  if (ci) ci.placeholder = isPhoto(S.project) ? '말로 고쳐요. 예: 3번 글 위로, 광고 오른쪽 위로' : '말로 고쳐요. 예: 3번 짧게, 배경 베이지로, 광고 오른쪽 위로';
  if (ready) renderTab();
  updateStatus();
}

// ───────────────────────── 동작 ─────────────────────────

async function onMake(kind) {
  if (S.phase === 'generating') return;
  if (IS_WEB) S.webKind = kind === 'topic' ? 'topic' : 'manual';
  if (!hasKey()) { renderStage(); document.getElementById('nokey')?.scrollIntoView({ block: 'center' }); return; }
  // 사진으로 찾은 이름을 아직 확인하지 않았으면 만들지 않는다(버튼도 꺼져 있다)
  const gate = kind === 'topic' ? '' : identBlock();
  if (gate) { toast(gate, { kind: 'warn' }); document.getElementById('identify-row')?.scrollIntoView({ block: 'center' }); return; }
  if (S.mode === 'photo') {
    if (S.photos.length < MIN_PHOTOS) { toast(`사진을 ${MIN_PHOTOS}장 이상 올려 주세요.`, { kind: 'warn' }); return; }
    const pp = buildProduct();
    // 적은 장수가 곧 캐러셀 장수: 사진이 더 많으면 AI 가 쓸 사진을 고른다(원본·AI 사진 섞여도)
    const pick = await pickPhotosForMake();
    if (S.phase !== 'start') return;
    pp.imageIds = pick.imageIds;
    S.lastPick = pick.picked;
    await startGenerate(pp, { link: S.link || '', options: { mode: 'photo', overlayStyle: S.photoStyle, adLabel: adCfg('photo').on, tease: S.tease !== false } });
    return;
  }
  const product = buildProduct(IS_WEB ? S.webKind : undefined);
  if (!product) { toast(IS_WEB && S.webKind === 'topic' ? '주제를 먼저 적어 주세요.' : '상품 이름이나 주제를 먼저 적어 주세요.', { kind: 'warn' }); document.getElementById(IS_WEB && S.webKind === 'topic' ? 'topic-text' : 'manual-title')?.focus(); return; }
  // 광고 표기 값을 처음부터 보내야 첫 점수(광고 표기 −20)와 내보내기 확인이 어긋나지 않는다
  await startGenerate(product, { link: S.link || '', options: { adLabel: adCfg('cardnews').on, ...(product.source === 'topic' ? {} : { tease: S.tease !== false }) } });
}

async function makeFromShorts(script) {
  const text = String(script || '').trim();
  if (text.length < 10) { toast('쇼츠 대본을 10자 이상 붙여 넣어 주세요.', { kind: 'warn' }); return; }
  if (!hasKey()) { toast('먼저 설정에서 AI 키(Gemini 또는 GPT)를 넣어 주세요.', { kind: 'warn' }); return; }
  if (S.project && S.phase === 'ready') await saveNow();
  S.link = '';
  await startGenerate({ source: 'shorts', script: text }, { link: '' });
}

/** 새 상품/주제로 시작. 하던 작업은 저장만 하고 덮어쓰지 않는다. */
async function startNew({ keepNothing = false } = {}) {
  if (S.stream) { S.stream.cancel(); S.stream = null; }
  cancelRecreate(); // 사진 전부 새로 그리기 중이면 멈춘다(옛 상품 사진에 쓰던 요청)
  if (S.project && S.phase === 'ready') await saveNow();
  S.project = null; S.phase = 'start'; S.progress = null; S.chat = [];
  S.newProductBanner = null; S.picker = null; S.sel = null; S.link = ''; S.searchResults = null;
  S.manual = { title: '', price: '', imageId: null, imageIds: [], desc: '' };
  S.topic = ''; S.topicImageIds = []; S.webKind = 'manual'; S.photos = []; S.autoFillKey = ''; S.productRef = null; S.photoPick = null; S.lastPick = null; resetIdent();
  unmountPf();
  closeOverlay();
  clearErrors();
  if (!keepNothing) { await loadProduct(); await loadStatus(); }
  render();
  window.scrollTo(0, 0);
}

async function openOptions() {
  try { await request('core.openOptions'); } catch (e) { showError(e); }
}

function onCardIndex() { onCardIndexChanged(); if (S.tab === 'review' && S.phase === 'ready') renderReview(); }

Object.assign(fn, {
  render, renderStrip, renderStage, renderModebar, renderPreview, schedulePreview, renderProgress, renderDecision, renderNotices, renderTab, openTab, onMake, makeFromShorts, startNew, openOptions,
  regenerate, startGenerate, updateMakeEnabled, maybeAutoFill, openExport, gotoCard, openProject, setPhotoStyle, refreshAll, saveModePrefs, onCardIndex, renderReview, renderEditMeta, rewriteCurrent: () => startRewrite(),
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
    renderAiStatus();
    await loadStatus();
    if (S.phase === 'start') renderStage();
    if (S.phase === 'ready' && S.tab === 'caption') renderTab();
  } catch { /* 다음에 다시 */ }
}

async function boot() {
  const params = new URLSearchParams(location.search);
  const t = Number(params.get('tabId'));
  S.fixedTab = Number.isInteger(t) && t > 0 ? t : undefined;
  S.unfold = params.get('unfold') === '1';   // 시험용: 접힌 섹션을 모두 펼쳐서 연다
  S.guideSeen = await guideSeen();

  document.getElementById('brand-logo').append(logoMark(30));
  decorateIcons();
  initDock();
  document.getElementById('btn-settings').addEventListener('click', openOptions);
  document.getElementById('btn-guide').addEventListener('click', () => openGuide());
  document.getElementById('btn-history').addEventListener('click', openHistory);
  document.getElementById('btn-nav-new').addEventListener('click', () => {
    if (S.phase === 'start') { window.scrollTo({ top: 0 }); document.querySelector('#manual-title, #photo-title, #btn-photo-upload')?.focus(); return; }
    startNew();
  });
  document.getElementById('status-chip').addEventListener('click', () => { if (S.phase === 'ready') openTab('review', { scroll: true }); });
  document.querySelectorAll('.tabs [role=tab]').forEach((b) => b.addEventListener('click', () => openTab(b.dataset.tab)));
  el.overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOverlay(); });
  initDropIn();

  window.addEventListener('error', (e) => showError(e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => { if (e.reason?.code !== 'CANCELLED') showError(e.reason); });

  if (!IS_WEB) chrome.runtime.onMessage.addListener((msg) => { if (msg?.type === 'coupang.productUpdated') onProductUpdated(msg); });
  if (IS_WEB) document.documentElement.classList.add('web');
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.settings) onSettingsChanged(); });
  await loadModePrefs();
  render();
  try { S.settings = await request('core.getSettings'); } catch (e) { showError(e); S.settings = { has: {}, fixedTags: [] }; }
  renderAiStatus();
  await loadStatus();
  await resumeCard();
  await loadProduct();
  S.phase = 'start';
  render();
  document.documentElement.dataset.ready = '1';
}

boot().catch((e) => showError(e));
