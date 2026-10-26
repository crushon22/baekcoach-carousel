// 카드 편집 탭: 헤드라인·본문 직접 수정, 레이아웃, 사진(상품/업로드/AI), 다시 쓰기 3안, 1번 카드 훅·커버 3안, 템플릿, 제품 색 맞추기.
import { request } from '../lib/bus.js';
import { WHERE } from '../lib/common.js';
import * as store from '../lib/store.js';
import { TEMPLATES, LAYOUTS, renderCoverVariants, extractColorsFromImageId } from '../lib/render.js';
import { h, setChildren, debounce, pickImageFile, toast } from './dom.js';
import { S, fn, cards, mainImageId, refreshCard, refreshAll, scheduleReview, scheduleSave, cardMeta, imageUrl } from './app.js';
import { showError } from './errors.js';
import { LAYOUT_LABELS, LAYOUT_SLOT, TEMPLATE_LABELS, HOOK_LABELS, STYLE_HELP, IMAGE_CHIPS } from './labels.js';

const ui = { photosOpen: false, aiOpen: false, chips: new Set(), rewrite: null, covers: null, aiNote: '', busy: '' };
let host;

const cur = () => cards()[S.cardIndex];

function resetPerCard() { ui.rewrite = null; ui.covers = null; ui.aiNote = ''; ui.photosOpen = false; ui.aiOpen = false; }

export function renderEdit() {
  host = host || document.getElementById('tab-edit');
  const p = S.project;
  const i = S.cardIndex;
  const card = cur();
  if (!p || !card) { setChildren(host, h('p', { class: 'muted' }, '카드가 아직 없어요.')); return; }
  const n = cards().length;

  const head = h('textarea', { id: 'edit-headline', class: 'input', rows: 2, 'aria-label': '헤드라인' });
  head.value = card.headline || '';
  const body = h('textarea', { id: 'edit-body', class: 'input', rows: 4, 'aria-label': '본문' });
  body.value = card.body || '';
  const headCount = h('span', { class: 'count', id: 'head-count' });
  const paintCount = () => {
    const len = head.value.replace(/\s/g, '').length;
    headCount.textContent = `${len}/16자`;
    headCount.classList.toggle('over', len > 16);
  };
  paintCount();
  const onText = () => {
    card.headline = head.value; card.body = body.value;
    const all = [card.headline, card.body, card.bridge, card.cta].join('\n');
    card.claims = (card.claims || []).filter((c) => all.includes(c.text));
    paintCount();
    liveRender();
  };
  head.addEventListener('input', onText);
  body.addEventListener('input', onText);
  const liveRender = debounce(() => { refreshCard(i); scheduleReview(); scheduleSave(); renderEditMeta(); }, 250);

  const tableTip = card.layout === 'table' && !(card.body || '').includes('|');

  setChildren(host,
    // 카드 이동
    h('div', { class: 'card-nav' },
      h('button', { type: 'button', class: 'btn', id: 'card-prev', disabled: i <= 0, 'aria-label': '이전 카드', onclick: () => S.pf?.goTo(i - 1) }, '‹ 이전'),
      h('div', { class: 'card-nav-title', id: 'card-title' }, h('strong', null, `카드 ${i + 1} / ${n}`), h('span', { class: 'muted small' }, card.role || '')),
      h('button', { type: 'button', class: 'btn', id: 'card-next', disabled: i >= n - 1, 'aria-label': '다음 카드', onclick: () => S.pf?.goTo(i + 1) }, '다음 ›')),
    card.error ? h('div', { class: 'warn-box', id: 'card-error' },
      h('strong', null, '이 카드는 다시 써야 해요'), h('p', null, card.error.messageKo || '카드를 만들지 못했어요.'),
      card.error.raw ? h('details', null, h('summary', null, '원문 보기'), h('p', { class: 'error-where' }, `발생 위치: ${WHERE.SW}`), h('pre', { class: 'raw' }, card.error.raw)) : null,
      h('button', { type: 'button', class: 'btn btn-primary', onclick: () => fn.regenerate('card', { index: i, label: `${i + 1}번 카드를 다시 쓰는 중` }) }, '이 카드 다시 만들기')) : null,
    h('div', { id: 'edit-warn' }),

    // 글
    h('section', { class: 'group' },
      h('div', { class: 'label-row' }, h('label', { class: 'label', for: 'edit-headline' }, '헤드라인'), headCount), head,
      h('label', { class: 'label', for: 'edit-body' }, '본문'), body,
      h('p', { class: 'muted small' }, card.layout === 'table' ? '표는 "항목|내용" 모양으로 줄마다 적어요.' : '줄을 바꾸면 카드에서도 줄이 나뉘어요. 고치면 바로 다시 그려요.'),
      tableTip ? h('p', { class: 'warn-line' }, '표 모양인데 "항목|내용" 줄이 없어요. 본문을 이 모양으로 고치거나 다른 모양을 고르세요.') : null),

    // 모양
    h('section', { class: 'group' },
      h('h3', null, '카드 모양'),
      h('div', { class: 'chips', id: 'layout-chips', role: 'group', 'aria-label': '레이아웃' },
        ...LAYOUTS.map((l) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String((card.layout || '') === l), 'data-layout': l, onclick: () => setLayout(l) }, LAYOUT_LABELS[l] || l))),
      !card.layout ? h('p', { class: 'muted small' }, '지금은 자동으로 정해진 모양이에요. 고르면 그 모양으로 고정돼요.') : null),

    // 사진
    h('section', { class: 'group', id: 'photo-group' },
      h('h3', null, '사진'),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn', id: 'btn-photos', 'aria-expanded': String(ui.photosOpen), onclick: () => { ui.photosOpen = !ui.photosOpen; renderEdit(); } }, '상품 사진'),
        h('button', { type: 'button', class: 'btn', id: 'btn-photo-upload', onclick: uploadForCard }, '내 사진'),
        h('button', { type: 'button', class: 'btn', id: 'btn-photo-ai', 'aria-expanded': String(ui.aiOpen), onclick: () => { ui.aiOpen = !ui.aiOpen; renderEdit(); } }, 'AI로 만들기')),
      ui.photosOpen ? photoPicker(card) : null,
      ui.aiOpen ? aiPanel(card) : null,
      card.imageId ? h('div', { class: 'btn-row' },
        h('span', { class: 'muted small grow' }, card.imageIsGenerated ? '지금 사진: AI가 만든 연출 이미지 (카드에 표시가 붙어요)' : '지금 사진이 들어 있어요'),
        h('button', { type: 'button', class: 'btn', id: 'btn-photo-remove', onclick: removePhoto }, '사진 빼기')) : h('p', { class: 'muted small' }, '이 카드에는 사진이 없어요.')),

    // 다시 쓰기
    h('section', { class: 'group', id: 'rewrite-group' },
      h('h3', null, '다시 쓰기'),
      h('button', { type: 'button', class: 'btn btn-block', id: 'btn-rewrite', disabled: !!ui.busy, onclick: rewrite }, ui.busy === 'rewrite' ? '3가지로 쓰는 중…' : '다시 쓰기 3안 보기'),
      ui.rewrite && ui.rewrite.index === i ? rewriteList(ui.rewrite) : null),

    // 1번 카드 전용
    i === 0 ? h('section', { class: 'group', id: 'first-card-group' },
      h('h3', null, '1번 카드(훅) 고르기'),
      h('p', { class: 'muted small' }, '훅 3안 중 하나를 고르면 1번 카드와 캡션만 다시 써요.'),
      h('div', { class: 'stack', id: 'hook-list' },
        ...(p.plan?.hooks || []).map((hk, k) => h('button', { type: 'button', class: 'option', 'aria-pressed': String(k === (p.plan.hookPick ?? 0)), 'data-hook': k, onclick: () => fn.regenerate('hook', { hookIndex: k, options: { hookIndex: k }, label: '훅을 바꾸는 중' }) },
          h('span', { class: 'option-k' }, HOOK_LABELS[k] || hk.type), h('span', { class: 'option-v' }, String(hk.headline || '').replace(/\n/g, ' '))))),
      h('button', { type: 'button', class: 'btn btn-block', id: 'btn-covers', disabled: !!ui.busy, onclick: showCovers }, ui.busy === 'covers' ? '커버를 그리는 중…' : '커버 3안 보기'),
      ui.covers ? coverList(ui.covers) : null) : null,

    // 전체 디자인
    h('section', { class: 'group', id: 'design-group' },
      h('h3', null, '전체 디자인'),
      h('div', { class: 'chips', id: 'template-chips', role: 'group', 'aria-label': '템플릿' },
        ...Object.keys(TEMPLATES).map((t) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(p.carousel.template === t), 'data-template': t, onclick: () => setTemplate(t) },
          h('span', { class: 'dot', style: { background: TEMPLATES[t].bg || '#2F5BEA', borderColor: TEMPLATES[t].accent } }), TEMPLATE_LABELS[t]))),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn', id: 'btn-product-color', onclick: matchProductColor }, '제품 색으로 맞추기'),
        p.carousel.accentColor ? h('span', { class: 'swatch-row' }, h('span', { class: 'swatch', style: { background: p.carousel.accentColor }, title: p.carousel.accentColor }), h('span', { class: 'muted small' }, '강조색')) : null)));
  renderEditMeta();
}

/** 글자 넘침 ⚠️ (현재 카드만, 작은 크기로 그려 meta 만 확인) */
export async function renderEditMeta() {
  const box = document.getElementById('edit-warn');
  if (!box || !S.project) return;
  const i = S.cardIndex;
  const m = await cardMeta(i);
  if (!document.getElementById('edit-warn') || i !== S.cardIndex) return;
  const issues = (S.project.issues || []).filter((x) => x.cardIndex === i && x.level === 'format');
  const lines = [];
  if (m?.overflow) lines.push(`글이 칸을 넘치거나 겹쳐요. 글을 줄여 보세요. (${(m.overflowReasons || []).join(' / ') || '넘침'})`);
  if (m?.imageMissing) lines.push('사진을 찾지 못했어요. 사진을 다시 골라 주세요.');
  issues.slice(0, 3).forEach((x) => lines.push(`${x.text}${x.why ? ' — ' + x.why : ''}`));
  setChildren(box, lines.length ? h('div', { class: 'warn-box', id: 'overflow-warn', 'data-overflow': String(!!m?.overflow) }, ...lines.map((l) => h('p', null, `⚠️ ${l}`))) : null);
}

// ── 모양 ──
function setLayout(layout) {
  const i = S.cardIndex;
  const c = cur();
  c.layout = layout;
  c.imageSlot = LAYOUT_SLOT[layout] || 'none';
  if (c.imageSlot !== 'none' && !c.imageId) { const m = mainImageId(); if (m) c.imageId = m; }
  refreshCard(i); renderEdit(); scheduleReview(); scheduleSave();
}

function setTemplate(t) {
  const p = S.project;
  p.carousel.template = t;
  if (p.plan) p.plan.template = t;
  p.options = { ...(p.options || {}), template: t };
  refreshAll(); renderEdit(); scheduleSave();
}

async function matchProductColor() {
  const id = mainImageId() || cur()?.imageId;
  if (!id) { toast('색을 뽑을 상품 사진이 없어요. 사진을 먼저 넣어 주세요.', { kind: 'warn' }); return; }
  try {
    const colors = await extractColorsFromImageId(id);
    if (!colors.length) { toast('사진에서 뚜렷한 색을 찾지 못했어요.', { kind: 'warn' }); return; }
    S.project.carousel.accentColor = colors[0];
    refreshAll(); renderEdit(); scheduleSave();
    toast('제품 사진의 색으로 맞췄어요.');
  } catch (e) { showError(e); }
}

// ── 사진 ──
function photoPicker(card) {
  const ids = [...new Set([...(S.project.input?.imageIds || [])])];
  if (!ids.length) return h('p', { class: 'muted small' }, '이 작업에는 상품 사진이 없어요. "내 사진"이나 "AI로 만들기"를 써 보세요.');
  const row = h('div', { class: 'thumbs', id: 'photo-thumbs' });
  ids.forEach((id) => {
    const b = h('button', { type: 'button', class: 'thumb-btn', 'aria-pressed': String(card.imageId === id), 'aria-label': '이 사진 쓰기', onclick: () => usePhoto(id) }, h('span', { class: 'thumb-empty' }, '…'));
    imageUrl(id).then((u) => { if (u) b.replaceChildren(h('img', { src: u, alt: '' })); });
    row.append(b);
  });
  return row;
}

function usePhoto(id, { generated = false } = {}) {
  const i = S.cardIndex;
  const c = cur();
  c.imageId = id;
  if (generated) c.imageIsGenerated = true; else delete c.imageIsGenerated;
  if (!c.imageSlot || c.imageSlot === 'none') { c.layout = 'photo-full'; c.imageSlot = 'hero'; }
  refreshCard(i); renderEdit(); scheduleReview(); scheduleSave();
}

async function uploadForCard() {
  const file = await pickImageFile();
  if (!file) return;
  if (file.size > 15 * 1024 * 1024) { toast('사진이 너무 커요(15MB 이하).', { kind: 'warn' }); return; }
  try {
    const id = await store.putImage(file, { kind: 'upload', projectId: S.project.id || undefined });
    usePhoto(id);
  } catch (e) { showError(e); }
}

function removePhoto() {
  const i = S.cardIndex; const c = cur();
  delete c.imageId; delete c.imageIsGenerated;
  c.imageSlot = 'none';
  if (c.layout === 'photo-full' || c.layout === 'split') c.layout = 'title';
  refreshCard(i); renderEdit(); scheduleReview(); scheduleSave();
}

function aiPanel(card) {
  return h('div', { class: 'ai-panel', id: 'ai-panel' },
    h('p', { class: 'muted small' }, '누를 때만 만들어요. 사진에는 글자가 들어가지 않고, 카드에 "연출 이미지" 표시가 붙어요. 상품 모양은 바꾸지 않아요.'),
    h('div', { class: 'chips', role: 'group', 'aria-label': '분위기' },
      ...IMAGE_CHIPS.map((c) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(ui.chips.has(c)), onclick: (e) => { ui.chips.has(c) ? ui.chips.delete(c) : ui.chips.add(c); e.currentTarget.setAttribute('aria-pressed', String(ui.chips.has(c))); } }, c))),
    h('button', { type: 'button', class: 'btn btn-primary btn-block', id: 'btn-ai-make', disabled: ui.busy === 'image', onclick: makeAiImage }, ui.busy === 'image' ? '만드는 중… (최대 1분)' : '이 카드 사진 만들기'),
    ui.aiNote ? h('p', { class: 'warn-line', id: 'ai-note' }, ui.aiNote) : null);
}

async function makeAiImage() {
  const i = S.cardIndex;
  const p = S.project;
  const ref = mainImageId();
  ui.busy = 'image'; ui.aiNote = ''; renderEdit();
  try {
    const r = await request('image.generate', {
      purpose: ref ? 'product' : 'background', chips: [...ui.chips], referenceImageId: ref || undefined,
      category: p.plan?.category, productTitle: p.input?.title || p.input?.topic, facts: (p.facts || []).slice(0, 6).map((f) => ({ claim: f.claim })),
      cardIndex: i, projectId: p.id || undefined,
    });
    ui.busy = '';
    if (r.fallback === 'template' || !r.imageId) { ui.aiNote = r.messageKo || '사진을 만들지 못해 템플릿 배경으로 두었어요.'; renderEdit(); return; }
    usePhoto(r.imageId, { generated: true });
  } catch (e) { ui.busy = ''; renderEdit(); showError(e); }
}

// ── 다시 쓰기 3안 ──
async function rewrite() {
  const i = S.cardIndex;
  ui.busy = 'rewrite'; renderEdit();
  try {
    const r = await request('ai.rewriteCard', { project: S.project, index: i });
    ui.rewrite = { index: i, variants: r.variants || [] };
  } catch (e) { showError(e); }
  ui.busy = '';
  if (i === S.cardIndex) renderEdit();
}

function rewriteList(rw) {
  if (!rw.variants.length) return h('p', { class: 'muted' }, '새로 쓴 안이 없어요. 한 번 더 눌러 보세요.');
  return h('ul', { class: 'variant-list', id: 'variant-list' }, ...rw.variants.map((v, k) => h('li', { class: 'variant' },
    h('div', { class: 'variant-head' }, h('strong', null, v.style), h('span', { class: 'muted small' }, STYLE_HELP[v.style] || ''), v.factIssues?.length ? h('span', { class: 'badge badge-warn' }, `🔎 ${v.factIssues.length}`) : null),
    h('div', { class: 'variant-text' }, h('div', { class: 'variant-title' }, String(v.card.headline || '').replace(/\n/g, ' ')), h('div', { class: 'variant-body' }, v.card.body || '')),
    v.factIssues?.length ? h('p', { class: 'warn-line' }, '근거 없는 말이 있을 수 있어요. 쓴 뒤 근거·검수 탭에서 확인하세요.') : null,
    h('button', { type: 'button', class: 'btn', 'data-variant': k, onclick: () => applyVariant(rw.index, v) }, '이 안 쓰기'))));
}

function applyVariant(index, v) {
  const old = cards()[index];
  const nc = { ...v.card, index };
  for (const k of ['layout', 'imageSlot', 'imageId', 'imageIsGenerated']) { if (old[k] !== undefined) nc[k] = old[k]; else delete nc[k]; }
  S.project.carousel.cards[index] = nc;
  ui.rewrite = null;
  refreshCard(index); renderEdit(); scheduleReview(); scheduleSave();
  toast(`${index + 1}번 카드를 "${v.style}" 안으로 바꿨어요.`);
}

// ── 커버 3안 ──
async function showCovers() {
  ui.busy = 'covers'; renderEdit();
  try {
    const blobs = await renderCoverVariants(S.project.carousel);
    ui.covers = blobs.map((b) => ({ url: URL.createObjectURL(b), layout: b.meta?.layout }));
  } catch (e) { showError(e); }
  ui.busy = '';
  renderEdit();
}

function coverList(covers) {
  return h('div', { class: 'covers', id: 'cover-list' }, ...covers.map((c, k) => h('button', { type: 'button', class: 'cover-btn', 'aria-label': `커버 ${k + 1}안 쓰기 (${LAYOUT_LABELS[c.layout] || c.layout})`, 'data-cover': k, onclick: () => applyCover(c) },
    h('img', { src: c.url, alt: '' }), h('span', { class: 'small' }, LAYOUT_LABELS[c.layout] || c.layout))));
}

function applyCover(c) {
  const card = cards()[0];
  card.layout = c.layout; card.imageSlot = LAYOUT_SLOT[c.layout] || 'none';
  if (card.imageSlot !== 'none' && !card.imageId) { const m = mainImageId(); if (m) card.imageId = m; }
  covers_revoke();
  refreshCard(0); renderEdit(); scheduleSave();
  toast('커버 모양을 바꿨어요.');
}
function covers_revoke() { (ui.covers || []).forEach((c) => URL.revokeObjectURL(c.url)); ui.covers = null; }

/** 카드가 바뀌면 카드별 임시 상태를 지운다 */
export function onCardIndexChanged() {
  covers_revoke();
  resetPerCard();
  if (S.tab === 'edit' && S.phase === 'ready') renderEdit();
}

/** 다른 곳(점수 '고치기')에서 현재 카드의 다시 쓰기 3안을 바로 띄운다 */
export function startRewrite() { return rewrite(); }
