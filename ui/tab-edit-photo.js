// 카드 편집 탭(사진 캐러셀): 줄 단위 문장, 위치·크기·정렬, 강조 단어, 사진 바꾸기, 다시 쓰기 3안, 1번 카드 훅·커버(위치) 3안, 글씨 스타일·[광고].
// 카드뉴스 전용 컨트롤(레이아웃·템플릿·제품 색)은 만들지 않는다. headline 은 항상 overlay.lines 를 줄바꿈으로 합친 값과 같게 맞춘다.
import { request } from '../lib/bus.js';
import * as store from '../lib/store.js';
import { renderCoverVariants } from '../lib/render.js';
import { Knowledge, effectivePhotoRules } from '../lib/knowledge.js';
import { syncOverlay } from '../lib/review.js';
import { WHERE } from '../lib/common.js';
import { h, setChildren, debounce, pickImageFile, toast } from './dom.js';
import { S, fn, cards, refreshCard, refreshAll, scheduleReview, scheduleSave, imageUrl } from './app.js';
import { showError } from './errors.js';
import { HOOK_LABELS, STYLE_HELP } from './labels.js';
import { STYLES } from './photo.js';

const POS = { top: '위', middle: '가운데', bottom: '아래' };
const SIZE = { xl: '크게', l: '보통', m: '작게' };
const ui = { rewrite: null, covers: null, busy: '', draft: null, draftFor: -1 };
let rules = null;

async function ensureRules() {
  if (!rules) { try { rules = await new Knowledge().photoRules(); } catch { rules = null; } }
  return rules;
}

/** 카드가 바뀌면 임시 상태를 지운다 */
export function resetPhotoCardState() {
  (ui.covers || []).forEach((c) => URL.revokeObjectURL(c.url));
  ui.rewrite = null; ui.covers = null; ui.draft = null; ui.draftFor = -1; ui.busy = '';
}

const cur = () => cards()[S.cardIndex];
const overlayOf = (c) => c.overlay || (c.overlay = { lines: String(c.headline || '').split('\n').filter(Boolean), position: S.cardIndex === 0 ? 'top' : 'bottom', size: S.cardIndex === 0 ? 'xl' : 'l' });

/** 이 카드의 줄 수·글자 수 기준 (지식 파일 값, 그라데이션이면 넓혀 본다) */
function limitFor(i) {
  if (!rules) return null;
  const r = effectivePhotoRules(rules, S.project.carousel.overlayStyle || 'outline');
  return i === 0 ? r.cover : i === cards().length - 1 ? r.last : r.inner;
}

function commitLines(card, lines) {
  const next = syncOverlay({ ...card, overlay: { ...overlayOf(card), lines }, headline: lines.join('\n') });
  card.overlay = next.overlay; card.headline = next.headline; card.body = '';
  const all = card.headline;
  card.claims = (card.claims || []).filter((c) => all.includes(c.text));
}

export async function renderPhotoEdit(host) {
  const p = S.project;
  const i = S.cardIndex;
  const card = cur();
  if (!p || !card) { setChildren(host, h('p', { class: 'muted' }, '카드가 아직 없어요.')); return; }
  await ensureRules();
  if (i !== S.cardIndex || !cur()) return;
  const n = cards().length;
  const ov = overlayOf(card);
  const style = p.carousel.overlayStyle || 'outline';
  const lim = limitFor(i);
  if (ui.draftFor !== i || !ui.draft) { ui.draft = (ov.lines && ov.lines.length ? ov.lines : ['']).slice(0, 3); ui.draftFor = i; }

  const wordsBox = h('div', { id: 'word-box' });
  function renderWords() {
    const o = overlayOf(card);
    const hl = new Set(o.highlight || []);
    const lines = (o.lines || []).filter(Boolean);
    setChildren(wordsBox, ...lines.map((line) => h('div', { class: 'words' }, ...line.split(/\s+/).filter(Boolean).map((w) => h('button', { type: 'button', class: 'chip word', 'data-word': w, 'aria-pressed': String(hl.has(w)), onclick: () => toggleWord(w) }, w)))));
  }
  function toggleWord(w) {
    const o = overlayOf(card);
    const set = [...(o.highlight || [])];
    const at = set.indexOf(w);
    const max = rules?.maxHighlight || 2;
    if (at >= 0) set.splice(at, 1);
    else if (set.length >= max) { toast(`강조는 한 장에 ${max}단어까지예요. 먼저 켜 둔 단어를 눌러 끄세요.`, { kind: 'warn' }); return; }
    else set.push(w);
    if (set.length) o.highlight = set; else delete o.highlight;
    refreshCard(i); scheduleSave(); scheduleReview(); renderWords();
  }

  // 줄 입력
  const liveRender = debounce(() => { refreshCard(i); scheduleReview(); scheduleSave(); fn.renderEditMeta?.(); renderWords(); }, 250);
  const inputs = ui.draft.map((text, k) => {
    const inp = h('input', { class: 'input line-input', id: `line-${k}`, 'data-line': k, 'aria-label': `${k + 1}번째 줄` });
    inp.value = text;
    const cnt = h('span', { class: 'count', id: `line-count-${k}` });
    const paint = () => { const len = inp.value.trim().length; cnt.textContent = lim ? `${len}/${lim.maxChars}자` : `${len}자`; cnt.classList.toggle('over', !!lim && len > lim.maxChars); };
    paint();
    inp.addEventListener('input', () => {
      ui.draft[k] = inp.value; paint();
      commitLines(card, ui.draft.map((x) => x.trim()).filter(Boolean));
      liveRender();
    });
    return h('div', { class: 'line-row', 'data-row': k },
      h('div', { class: 'label-row' }, h('label', { class: 'label', for: `line-${k}` }, `${k + 1}번째 줄`), cnt),
      h('div', { class: 'line-edit' }, inp,
        ui.draft.length > 1 ? h('button', { type: 'button', class: 'btn', 'data-act': 'line-remove', 'aria-label': `${k + 1}번째 줄 빼기`, onclick: () => { ui.draft.splice(k, 1); commitLines(card, ui.draft.map((x) => x.trim()).filter(Boolean)); refreshCard(i); scheduleReview(); scheduleSave(); renderPhotoEdit(host); } }, '빼기') : null));
  });

  const seg = (options, value, onPick, id) => h('div', { class: 'chips', id, role: 'group', 'aria-label': id }, ...Object.entries(options).map(([k, label]) => h('button', { type: 'button', class: 'chip', 'data-value': k, 'aria-pressed': String(value === k), onclick: () => onPick(k) }, label)));
  const posOptions = style === 'gradient' ? { top: POS.top, bottom: POS.bottom } : POS;
  const defaultAlign = style === 'gradient' ? 'left' : 'center';
  const setOv = (patch) => { Object.assign(overlayOf(card), patch); refreshCard(i); scheduleSave(); scheduleReview(); renderPhotoEdit(host); };

  setChildren(host,
    h('div', { class: 'card-nav' },
      h('button', { type: 'button', class: 'btn', id: 'card-prev', disabled: i <= 0, 'aria-label': '이전 카드', onclick: () => S.pf?.goTo(i - 1) }, '‹ 이전'),
      h('div', { class: 'card-nav-title', id: 'card-title' }, h('strong', null, `카드 ${i + 1} / ${n}`), h('span', { class: 'muted small' }, i === 0 ? '커버' : card.role || '')),
      h('button', { type: 'button', class: 'btn', id: 'card-next', disabled: i >= n - 1, 'aria-label': '다음 카드', onclick: () => S.pf?.goTo(i + 1) }, '다음 ›')),
    card.error ? h('div', { class: 'warn-box', id: 'card-error' }, h('strong', null, '이 카드는 다시 써야 해요'), h('p', null, card.error.messageKo || '카드를 만들지 못했어요.'),
      card.error.raw ? h('details', null, h('summary', null, '원문 보기'), h('p', { class: 'error-where' }, `발생 위치: ${WHERE.SW}`), h('pre', { class: 'raw' }, card.error.raw)) : null,
      h('button', { type: 'button', class: 'btn btn-primary', onclick: () => fn.regenerate('card', { index: i, label: `${i + 1}번 카드를 다시 쓰는 중` }) }, '이 카드 다시 만들기')) : null,
    h('div', { id: 'edit-warn' }),

    h('section', { class: 'group', id: 'lines-group' },
      h('h3', null, '사진 위 글'),
      lim ? h('p', { class: 'muted small', id: 'line-limit' }, `${lim.minLines === lim.maxLines ? lim.maxLines : `${lim.minLines}~${lim.maxLines}`}줄, 한 줄 ${lim.maxChars}자 안쪽이 보기 좋아요.`) : null,
      ...inputs,
      ui.draft.length < 3 ? h('button', { type: 'button', class: 'btn btn-block', id: 'btn-line-add', onclick: () => { ui.draft.push(''); renderPhotoEdit(host).then(() => document.getElementById(`line-${ui.draft.length - 1}`)?.focus()); } }, '줄 추가') : null),

    h('section', { class: 'group', id: 'highlight-group' },
      h('h3', null, '강조 단어'),
      h('p', { class: 'muted small' }, `단어를 누르면 노란색으로 강조돼요 (한 장에 ${rules?.maxHighlight || 2}개까지).`),
      wordsBox),

    h('section', { class: 'group', id: 'placement-group' },
      h('h3', null, '글 위치·크기'),
      h('div', { class: 'label' }, '위치'), seg(posOptions, ov.position, (v) => setOv({ position: v }), 'overlay-position'),
      style === 'gradient' ? h('p', { class: 'muted small' }, '그라데이션은 글이 위나 아래에만 들어가요.') : null,
      h('div', { class: 'label' }, '글씨 크기'), seg(SIZE, ov.size || 'l', (v) => setOv({ size: v }), 'overlay-size'),
      h('div', { class: 'label' }, '정렬'), seg({ center: '가운데', left: '왼쪽' }, ov.align || defaultAlign, (v) => setOv({ align: v }), 'overlay-align')),

    h('section', { class: 'group', id: 'photo-group' },
      h('h3', null, '이 카드 사진'),
      photoPicker(card, host),
      h('button', { type: 'button', class: 'btn btn-block', id: 'btn-photo-replace', onclick: () => replacePhoto(host) }, '내 사진으로 바꾸기')),

    h('section', { class: 'group', id: 'rewrite-group' },
      h('h3', null, '다시 쓰기'),
      h('button', { type: 'button', class: 'btn btn-block', id: 'btn-rewrite', disabled: !!ui.busy, onclick: () => rewrite(host) }, ui.busy === 'rewrite' ? '3가지로 쓰는 중…' : '다시 쓰기 3안 보기'),
      ui.rewrite && ui.rewrite.index === i ? rewriteList(ui.rewrite, host) : null),

    i === 0 ? h('section', { class: 'group', id: 'first-card-group' },
      h('h3', null, '1번 카드(커버) 고르기'),
      h('p', { class: 'muted small' }, '훅 3안 중 하나를 고르면 커버 문장과 캡션만 다시 써요.'),
      h('div', { class: 'stack', id: 'hook-list' },
        ...(p.plan?.hooks || []).map((hk, k) => h('button', { type: 'button', class: 'option', 'aria-pressed': String(k === (p.plan.hookPick ?? 0)), 'data-hook': k, onclick: () => fn.regenerate('hook', { hookIndex: k, options: { hookIndex: k }, label: '커버 문장을 바꾸는 중' }) },
          h('span', { class: 'option-k' }, HOOK_LABELS[k] || hk.type), h('span', { class: 'option-v' }, String(hk.headline || '').replace(/\n/g, ' '))))),
      h('button', { type: 'button', class: 'btn btn-block', id: 'btn-covers', disabled: !!ui.busy, onclick: () => showCovers(host) }, ui.busy === 'covers' ? '커버를 그리는 중…' : '커버 3안 보기 (글 위치 3가지)'),
      ui.covers ? h('div', { class: 'covers', id: 'cover-list' }, ...ui.covers.map((c, k) => h('button', { type: 'button', class: 'cover-btn', 'data-cover': k, 'aria-label': `커버 ${k + 1}안: 글 ${POS[c.position] || c.position}`, onclick: () => applyCover(c, host) },
        h('img', { src: c.url, alt: '' }), h('span', { class: 'small' }, `글 ${POS[c.position] || c.position}`)))) : null) : null,

    h('section', { class: 'group', id: 'design-group' },
      h('h3', null, '글씨 스타일·광고 표시'),
      h('div', { class: 'chips', id: 'style-chips', role: 'group', 'aria-label': '글씨 스타일' },
        ...STYLES.map((s) => h('button', { type: 'button', class: 'chip', 'data-style': s.key, 'aria-pressed': String(style === s.key), onclick: () => fn.setPhotoStyle(s.key) }, s.label))),
      adToggle(p, host),
      p.carousel.adLabel === false ? h('p', { class: 'warn-line small' }, '파트너스 게시물이면 켜 두세요.') : null));
  renderWords();
  fn.renderEditMeta?.();
}

function adToggle(p, host) {
  const cb = h('input', { type: 'checkbox', id: 'ad-toggle', checked: p.carousel.adLabel !== false });
  cb.addEventListener('change', () => { p.carousel.adLabel = cb.checked; S.adLabel = cb.checked; refreshAll(); scheduleSave(); renderPhotoEdit(host); });
  return h('label', { class: 'check-row', for: 'ad-toggle' }, cb, h('span', null, '사진 왼쪽 위에 [광고] 표시'));
}

// ── 사진 ──
function photoPicker(card, host) {
  const ids = [...new Set([...(S.project.input?.imageIds || []), ...cards().map((c) => c?.imageId).filter(Boolean)])];
  const row = h('div', { class: 'thumbs', id: 'photo-thumbs' });
  ids.forEach((id) => {
    const b = h('button', { type: 'button', class: 'thumb-btn', 'aria-pressed': String(card.imageId === id), 'aria-label': '이 사진 쓰기', onclick: () => { card.imageId = id; delete card.imageIsGenerated; refreshCard(S.cardIndex); scheduleSave(); renderPhotoEdit(host); } }, h('span', { class: 'thumb-empty' }, '…'));
    imageUrl(id).then((u) => { if (u) b.replaceChildren(h('img', { src: u, alt: '' })); });
    row.append(b);
  });
  return h('div', null, row, h('p', { class: 'muted small' }, '올린 사진 중에서 바꾸거나, 아래 버튼으로 새 사진을 올려요. 글은 그대로예요.'));
}

async function replacePhoto(host) {
  const file = await pickImageFile();
  if (!file) return;
  if (file.size > 15 * 1024 * 1024) { toast('사진이 너무 커요(15MB 이하).', { kind: 'warn' }); return; }
  try {
    const id = await store.putImage(file, { kind: 'upload', projectId: S.project.id || undefined });
    const c = cur();
    c.imageId = id; delete c.imageIsGenerated;
    refreshCard(S.cardIndex); scheduleSave(); renderPhotoEdit(host);
    toast('이 카드의 사진을 바꿨어요.');
  } catch (e) { showError(e); }
}

// ── 다시 쓰기 3안 ──
async function rewrite(host) {
  const i = S.cardIndex;
  ui.busy = 'rewrite'; renderPhotoEdit(host);
  try {
    const r = await request('ai.rewriteCard', { project: S.project, index: i });
    ui.rewrite = { index: i, variants: r.variants || [] };
  } catch (e) { showError(e); }
  ui.busy = '';
  if (i === S.cardIndex) renderPhotoEdit(host);
}
export function startRewrite() { return rewrite(document.getElementById('tab-edit')); }

function rewriteList(rw, host) {
  if (!rw.variants.length) return h('p', { class: 'muted' }, '새로 쓴 안이 없어요. 한 번 더 눌러 보세요.');
  return h('ul', { class: 'variant-list', id: 'variant-list' }, ...rw.variants.map((v, k) => h('li', { class: 'variant' },
    h('div', { class: 'variant-head' }, h('strong', null, v.style), h('span', { class: 'muted small' }, STYLE_HELP[v.style] || ''), v.factIssues?.length ? h('span', { class: 'badge badge-warn' }, `🔎 ${v.factIssues.length}`) : null),
    h('div', { class: 'variant-text' }, h('div', { class: 'variant-body' }, (v.card.overlay?.lines || String(v.card.headline || '').split('\n')).join('\n'))),
    v.factIssues?.length ? h('p', { class: 'warn-line' }, '근거 없는 말이 있을 수 있어요. 쓴 뒤 근거·검수 탭에서 확인하세요.') : null,
    h('button', { type: 'button', class: 'btn', 'data-variant': k, onclick: () => applyVariant(rw.index, v, host) }, '이 안 쓰기'))));
}

function applyVariant(index, v, host) {
  const old = cards()[index];
  const nc = { ...v.card, index };
  for (const k of ['layout', 'imageSlot', 'imageId', 'imageIsGenerated']) { if (old[k] !== undefined) nc[k] = old[k]; else delete nc[k]; }
  S.project.carousel.cards[index] = syncOverlay(nc);
  ui.rewrite = null; ui.draft = null;
  refreshCard(index); scheduleReview(); scheduleSave(); renderPhotoEdit(host);
  toast(`${index + 1}번 카드를 "${v.style}" 안으로 바꿨어요.`);
}

// ── 커버 3안(글 위치) ──
async function showCovers(host) {
  ui.busy = 'covers'; renderPhotoEdit(host);
  try {
    const blobs = await renderCoverVariants(S.project.carousel);
    ui.covers = blobs.map((b) => ({ url: URL.createObjectURL(b), position: b.meta?.position }));
  } catch (e) { showError(e); }
  ui.busy = '';
  renderPhotoEdit(host);
}

function applyCover(c, host) {
  overlayOf(cards()[0]).position = c.position;
  (ui.covers || []).forEach((x) => URL.revokeObjectURL(x.url));
  ui.covers = null;
  refreshCard(0); scheduleSave(); renderPhotoEdit(host);
  toast('커버 글 위치를 바꿨어요.');
}
