// 두 가지 버전 중 사진 캐러셀: 버전 고르기, 사진 목록(올리기·순서·빼기), 글씨 스타일 고르기, [광고] 표시, 만들 상품 정보.
// 데이터 계약은 docs/사진캐러셀.md. 카드 편집은 tab-edit-photo.js.
import { request, stream } from '../lib/bus.js';
import * as store from '../lib/store.js';
import { IS_WEB } from '../lib/platform.js';
import { formatPrice } from '../lib/coupang.js';
import { h, setChildren, pickImageFiles, toast } from './dom.js';
import { S, fn, imageUrl } from './app.js';
import { showError } from './errors.js';
import { icon } from './icons.js';
import { fontDetails, pickStartFont } from './fontpick.js';
import { adPanel, adCfg, adFields } from './adlabel.js';
import { openImageTool } from './imagetools.js';
import { identifyRow, identTyped } from './identify.js';
import { teaseRow, refreshTeaseDetail } from './tease.js';
import { TRANSFORMS } from '../lib/imageprompt.js';

export const STYLES = [
  { key: 'outline', label: '테두리', desc: '굵은 흰 글씨 + 검은 테두리' },
  { key: 'gradient', label: '그라데이션', desc: '아래를 어둡게, 왼쪽 정렬' },
  { key: 'band', label: '띠', desc: '반투명 검은 띠 위 글씨' },
  { key: 'shadow', label: '그림자', desc: '테두리 없이 진한 그림자' },
];
export const STYLE_LABEL = Object.fromEntries(STYLES.map((s) => [s.key, s.label]));
export const MAX_PHOTOS = 10;         // 캐러셀 최대 10장(2026-10-29 사용자 결정: 장수는 직접 적고 최대 10)
export const MIN_PHOTOS = 2;
export const DEFAULT_COUNT = 5;       // "몇 장으로 만들까요?" 기본값 — 모자라면 AI 사진으로 채운다
/** 목표 장수 정리: 2~10 정수만, 아니면 기본 5 */
export const clampCount = (v) => { const n = Math.round(Number(v)); return Number.isInteger(n) && n >= MIN_PHOTOS && n <= MAX_PHOTOS ? n : DEFAULT_COUNT; };

// ───────────────────────── 마지막 선택 기억 ─────────────────────────

export async function loadModePrefs() {
  try {
    const m = await store.kvGet('panel.mode', null);
    if (m?.mode === 'photo' || m?.mode === 'cardnews') S.mode = m.mode;
    if (STYLE_LABEL[m?.style]) S.photoStyle = m.style;
    if (m?.ad && typeof m.ad === 'object') S.ad = m.ad;
    else if (typeof m?.adLabel === 'boolean') S.ad = { photo: { on: m.adLabel } };
    if (typeof m?.font === 'string') S.font = m.font;
    if (typeof m?.tease === 'boolean') S.tease = m.tease;
    if (m?.photoCount != null) S.photoCount = clampCount(m.photoCount);
  } catch { /* 기억 못 해도 기본값 */ }
}
export function fontCard() {
  return h('section', { class: 'extra', id: 'font-card' },
    fontDetails({ value: S.font, onPick: pickStartFont, id: 'font-picker', open: !!S.fontOpen }),
    null);
}

export function saveModePrefs() {
  store.kvSet('panel.mode', { mode: S.mode, style: S.photoStyle, ad: S.ad, font: S.font, tease: S.tease !== false, photoCount: S.photoCount }).catch(() => {});
}

// ───────────────────────── 작은 그림(예시·스타일 미리보기) ─────────────────────────

/** 글씨 스타일 미리보기 (CSS 도형, 외부 파일 없음) */
export function stylePreview(key) {
  const txt = h('span', { class: 'sp-text' }, '글씨가\n이렇게');
  const box = h('span', { class: `style-preview sp-${key}`, 'aria-hidden': 'true' }, txt);
  if (key === 'gradient') box.append(h('span', { class: 'sp-grad' }));
  return box;
}

/** [카드뉴스 | 사진 캐러셀] 세그먼트 스위치 (트랙 + 흰 썸) */
export function modeTabs() {
  const tab = (mode, name) => h('button', {
    type: 'button', role: 'tab', class: 'mode-tab', id: `mode-${mode}`, 'aria-selected': String(S.mode === mode), 'data-mode': mode,
    onclick: () => setMode(mode),
  }, name);
  return h('div', { class: 'mode-tabs', id: 'mode-tabs', role: 'tablist', 'aria-label': '만들 버전 고르기' },
    tab('photo', '사진 캐러셀'), tab('cardnews', '카드뉴스'));   // 사진 캐러셀이 주 용도라 앞에(2026-10-29)
}

export function setMode(mode) {
  if (S.mode === mode) return;
  S.mode = mode;
  saveModePrefs();
  fn.renderModebar();
  fn.renderPreview();
  fn.renderStrip();
  fn.renderStage();
}

// ───────────────────────── 사진 목록 ─────────────────────────

export async function addPhotos(files) {
  let n = 0;
  for (const f of files) {
    if (S.photos.length >= MAX_PHOTOS) { toast(`사진은 ${MAX_PHOTOS}장까지만 쓸 수 있어요. 앞의 ${MAX_PHOTOS}장만 넣었어요.`, { kind: 'warn' }); break; }
    if (f.size > 15 * 1024 * 1024) { toast(`"${f.name}" 사진이 너무 커요(15MB 이하).`, { kind: 'warn' }); continue; }
    try { S.photos.push(await store.putImage(f, { kind: 'upload' })); n++; } catch (e) { showError(e); }
  }
  if (n) queueMicrotask(maybeAutoFill);   // 목표 장수보다 모자라면 AI 사진으로 채운다(상품 알아보기가 돌고 있으면 그 뒤에)
  return n;
}

/**
 * 사진이 목표 장수(S.photoCount)보다 모자라면 AI 사진을 자동으로 만들어 채운다(2026-10-29 사용자 요청: "사진이 3장만 들어가도 자동으로").
 * 상품 알아보기가 돌고 있으면 끝난 뒤(제품 모습을 요청문에 넣으려고) identify.js 가 다시 부른다. 같은 사진 상태에서는 한 번만 돈다. 시험용 dev:ai.autoFill=false 면 안 한다.
 */
export async function maybeAutoFill() {
  if (S.mode !== 'photo' || S.phase !== 'start' || recreating) return;
  const have = S.photos.length;
  const want = clampCount(S.photoCount);
  if (!have || have >= want) return;
  if (S.ident?.status === 'busy') return;
  const key = `${want}:${S.photos.join(',')}`;
  if (S.autoFillKey === key) return;
  S.autoFillKey = key;
  try { if ((await store.kvGet('dev:ai', null))?.autoFill === false) return; } catch { /* 시험용 값 없음 */ }
  if (S.photos.length !== have || recreating) return;
  await addAiPhotos(S.photos, 'photo-list', { total: want - have, auto: true });
}

async function uploadPhotos() {
  const files = await pickImageFiles();
  if (!files.length) return;
  await addPhotos(files);
  fn.renderStage();
}

function move(list, i, d, key) {
  const j = i + d;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  S.photoSel[key] = j;
  fn.renderStage();
}

/**
 * 사진 썸네일 가로 줄: 맨 앞 [+ 추가] 타일, 썸네일을 누르면 선택되고 아래에 앞으로·뒤로·빼기 한 줄이 나온다.
 * opts: {key, listId, uploadId, firstLabel, onAdd}
 */
export function photoStrip(list, { key, listId, uploadId, firstLabel = '커버', onAdd }) {
  const sel = S.photoSel[key] ?? null;
  const ul = h('ul', { class: 'photo-list', id: listId });
  list.forEach((id, i) => {
    const b = h('button', { type: 'button', class: 'photo-thumb', 'data-kind': S.genImages?.has(id) ? 'ai' : null, 'aria-pressed': String(sel === i), 'aria-label': `${i + 1}번 사진 ${sel === i ? '선택 해제' : '선택'}`, onclick: () => { S.photoSel[key] = sel === i ? null : i; fn.renderStage(); } },
      h('span', { class: 'thumb-empty' }, '…'));
    imageUrl(id).then((u) => { if (u) b.replaceChildren(h('img', { src: u, alt: '' })); });
    ul.append(h('li', { class: 'photo-item web-photo', 'data-i': i, 'data-id': id }, b, h('span', { class: 'photo-no web-photo-tag' }, i === 0 ? firstLabel : String(i + 1))));
  });
  const add = h('button', { type: 'button', class: 'photo-add', id: uploadId, 'aria-label': '사진 추가', onclick: onAdd }, icon('plus', { size: 22 }), h('span', null, '추가'));
  const row = h('div', { class: 'photo-row' }, ul, add);
  const originals = list.filter((id) => !S.genImages?.has(id)).length;
  const room = Math.max(0, MAX_PHOTOS - list.length);
  const want = Math.min(ADD_AI_COUNT, room);
  const busy = recreating && recreating.listId === listId;
  const recreate = list.length ? h('div', { class: 'recreate-row', id: `${listId}-recreate-row` },
    h('button', { type: 'button', class: 'btn btn-block', id: `${listId}-recreate`, disabled: !!recreating || !originals || !want, onclick: () => addAiPhotos(list, listId) },
      icon('sparkle', { size: 18 }), busy ? `AI 사진 만드는 중… ${recreating.done}/${recreating.total}` : !want ? `사진이 꽉 찼어요 (${MAX_PHOTOS}장)` : `AI 사진 ${want}장 추가 만들기`),
    busy ? h('button', { type: 'button', class: 'btn btn-block recreate-stop', id: `${listId}-recreate-stop`, disabled: recreating.stopped, onclick: () => cancelRecreate() },
      recreating.stopped ? '멈추는 중…' : '멈추기') : null,
    h('p', { class: 'muted small' }, '원본은 그대로 두고, 같은 상품을 다른 각도·구도·배경으로 찍은 사진을 뒤에 더 넣어요. 만든 사진은 원본과 같은 제품인지(색·모양) 확인해서, 다르면 넣지 않아요. 사진과 카드에 AI 표시는 넣지 않아요(올릴 때 직접 체크).')) : null;
  const actions = sel !== null && list[sel] ? h('div', { class: 'photo-actions', id: `${listId}-actions` },
    h('button', { type: 'button', class: 'btn', 'data-act': 'up', disabled: sel === 0, onclick: () => move(list, sel, -1, key) }, icon('arrowLeft', { size: 18 }), '앞으로'),
    h('button', { type: 'button', class: 'btn', 'data-act': 'down', disabled: sel === list.length - 1, onclick: () => move(list, sel, 1, key) }, '뒤로', icon('arrowRight', { size: 18 })),
    h('button', { type: 'button', class: 'btn', 'data-act': 'remove', onclick: () => { list.splice(sel, 1); S.photoSel[key] = null; fn.renderStage(); } }, '빼기'),
    h('button', { type: 'button', class: 'btn', 'data-act': 'transform', onclick: () => transformListPhoto(list, sel) }, icon('sparkle', { size: 18 }), 'AI로 바꾸기'),
    // AI 로 바꾼 사진이면 원본으로 되돌리기(원본은 지우지 않고 남겨 둔다)
    S.genFrom?.has(list[sel]) ? h('button', { type: 'button', class: 'btn', 'data-act': 'original', onclick: () => { list[sel] = S.genFrom.get(list[sel]); fn.renderStage(); } }, '원본으로') : null) : null;
  return h('div', { class: 'photo-strip' }, row, actions, recreate);
}

/** 지금 화면에 걸린 사진 목록인지(새 상품으로 바뀌면 옛 목록은 버려진다) */
const isLiveList = (list) => list === S.photos || list === S.topicImageIds || list === S.manual?.imageIds;
/** AI 로 바꾼 사진을 원본 자리에 넣는다. 처음 원본을 기억해 상품 사진 고르기가 "이미 넣음"으로 보게 한다. */
function placeGenerated(list, oldId, newId) {
  const at = list.indexOf(oldId);
  if (at < 0) return false;
  list[at] = newId;
  (S.genImages ||= new Set()).add(newId);
  (S.genFrom ||= new Map()).set(newId, S.genFrom.get(oldId) ?? oldId);
  return true;
}
/** id 가 목록에 원본 그대로 또는 AI 로 바꾼 모습으로 들어 있는 자리(없으면 -1) */
const slotOf = (list, id) => list.findIndex((x) => x === id || S.genFrom?.get(x) === id);

/** AI 사진 추가 만들기(2026-10-29 사용자 결정: "변환이 아니라 추가 생성, 2~3장이면 된다"):
 *  원본은 그대로 두고 원본 사진을 참고로 새 사진 ADD_AI_COUNT 장을 뒤에 붙인다(2장씩 동시에). 연출은 돌려 가며(깔끔한 연출 → 생활 속 → 다른 각도).
 *  서비스워커가 원본과 같은 제품인지 검증한 결과(check.same)가 false 면 목록에 넣지 않고 알려 준다. 한도에 걸리면 멈추고 안내한다.
 *  [멈추기]·새 상품 시작·패널 닫기면 진행 중인 요청까지 끊는다(포트 취소 → 서비스워커 fetch 중단). */
let recreating = null;   // {listId, done, total, stopped, runs:Set<stream>, rejected, rejectedWhy}
export const ADD_AI_COUNT = 3;
const RECREATE_OPTS = TRANSFORMS.find((t) => t.key === 'recreate').options.map((o) => o.key);
export function cancelRecreate() {
  if (!recreating || recreating.stopped) return;
  recreating.stopped = true;
  for (const s of recreating.runs) s.cancel();
  fn.renderStage();
}
async function addAiPhotos(list, listId, { total: wantTotal = ADD_AI_COUNT, auto = false } = {}) {
  if (recreating) return;
  const originals = list.filter((id) => !S.genImages?.has(id));
  if (!originals.length) return;
  const total = Math.min(wantTotal, Math.max(0, MAX_PHOTOS - list.length));
  if (!total) { if (!auto) toast(`사진은 ${MAX_PHOTOS}장까지예요. 몇 장 빼고 다시 눌러 주세요.`, { kind: 'warn' }); return; }
  const job = recreating = { listId, done: 0, total, stopped: false, runs: new Set(), rejected: 0, rejectedWhy: '', unverified: 0, auto };
  fn.renderStage();
  const title = (S.manual.title || '').trim() || S.rec?.product?.title;
  const look = S.ident?.look || '';
  const ref = await ensureProductRef(title);   // 이름으로 찾은 제품 모습(모르면 null) — 제품 자체가 바뀌지 않게 요청문·검증에 같이 넣는다
  if (!isLiveList(list) || job.stopped) { recreating = null; fn.renderStage(); return; }
  let stop = null;
  const one = async (k) => {
    if (stop || job.stopped) return;
    const src = originals[k % originals.length];                 // 참고 사진은 원본을 돌아가며
    const option = RECREATE_OPTS[k % RECREATE_OPTS.length];        // 연출도 돌아가며(깔끔한 연출 → 생활 속 → 다른 각도)
    const s = stream('image.transformStream', { imageId: src, kind: 'recreate', option, aspect: '4:5', productTitle: title, productLook: look, productRef: ref });
    job.runs.add(s);
    let r;
    try { r = await s.done; } catch (e) { if (e?.code !== 'CANCELLED' && !job.stopped) stop = stop || { error: e }; return; } finally { job.runs.delete(s); }
    if (r.fallback || !r.imageId) { stop = stop || { messageKo: r.messageKo }; return; }
    if (r.check && r.check.same === false) { job.rejected++; job.rejectedWhy = r.check.differences?.[0] || r.check.summary || ''; return; }   // 원본과 다른 제품이면 넣지 않는다
    if (r.check && r.check.comparable === false) job.unverified++;   // 원본과 대조할 게 없어 확인 못 함(연출 차이는 거절 사유가 아니다) — 넣되 알려 준다
    if (!isLiveList(list) || list.length >= MAX_PHOTOS) return;    // 그 사이 새 상품으로 바뀌었거나 꽉 참
    list.push(r.imageId);
    (S.genImages ||= new Set()).add(r.imageId);
    (S.genFrom ||= new Map()).set(r.imageId, src);
    job.done++;
    fn.renderStage();
  };
  const queue = Array.from({ length: total }, (_, k) => k);
  await Promise.all([0, 1].map(async () => { while (queue.length && !stop && !job.stopped) await one(queue.shift()); }));
  const { done, rejected, rejectedWhy, unverified } = job;
  recreating = null;
  fn.renderStage();
  if (!isLiveList(list)) return; // 새 상품으로 넘어갔으면 옛 결과를 알리지 않는다
  const rej = (rejected ? ` 원본과 달라 보여서 뺀 사진 ${rejected}장${rejectedWhy ? `(${rejectedWhy})` : ''}.` : '') + (unverified ? ` ${unverified}장은 원본과 대조할 부분이 적어 확인하지 못했어요. 제품이 맞는지 봐 주세요.` : '');
  if (stop?.error) showError(stop.error);
  else if (stop) toast(`AI 사진 ${done}장을 추가했어요. ${stop.messageKo || '이미지 생성 한도에 걸렸어요.'}`, { kind: 'warn', ms: 7000 });
  else if (job.stopped) toast(done ? `멈췄어요. AI 사진 ${done}장은 추가됐어요.` : '멈췄어요. 추가한 사진은 없어요.');
  else if (!done && rejected) toast(`AI 사진을 넣지 못했어요.${rej} 다시 눌러 보세요.`, { kind: 'warn', ms: 7000 });
  else if (auto) toast(`사진이 ${list.length}장이 되도록 AI 사진 ${done}장을 만들어 채웠어요. 원본은 그대로예요.${rej}`, { ms: rej ? 7000 : 5000 });
  else toast(`AI 사진 ${done}장을 뒤에 추가했어요. 원본은 그대로예요.${rej}`, { ms: rej ? 7000 : 4000 });
}

/**
 * 상품 이름으로 그 제품이 실제로 어떻게 생겼는지 찾아 둔다(ai.productLook, 2026-10-29 사용자 요청: "제품 정보를 넣어 주면 제품 검색 후 AI 이미지로").
 * 같은 이름이면 한 번만 찾고(S.productRef), 모르는 제품이면 null — 지어내지 않는다. 못 찾아도 AI 사진 만들기는 막지 않는다.
 * @returns {Promise<{look:string, mustKeep:string[], avoid:string[], confidence:number}|null>}
 */
export async function ensureProductRef(title) {
  const key = String(title || '').trim();
  if (!key) return null;
  if (S.productRef?.key === key) return S.productRef.busy ? S.productRef.promise : S.productRef.ref;
  const entry = S.productRef = { key, ref: null, busy: true, promise: null };
  entry.promise = (async () => {
    let ref = null;
    try {
      const r = await request('ai.productLook', { title: key, brand: S.ident?.brand?.brand || '', photoLook: S.ident?.look || '' }, { timeoutMs: 45000 });
      if (r?.known && r.look) ref = { look: r.look, mustKeep: r.mustKeep || [], avoid: r.avoid || [], confidence: r.confidence || 0 };
    } catch (e) {
      if (['NO_KEY', 'KEY_INVALID', 'BILLING', 'FORBIDDEN'].includes(e?.code)) showError(e);
    }
    if (S.productRef === entry) { entry.ref = ref; entry.busy = false; fn.renderStage(); }
    return ref;
  })();
  fn.renderStage();
  return entry.promise;
}

/** 이름으로 찾은 제품 모습 한 줄(찾는 중 · 찾음 · 모름). 사진이 있을 때만 */
function productRefLine() {
  const pr = S.productRef;
  if (!pr || !S.photos.length) return null;
  if (pr.busy) return h('p', { class: 'muted small', id: 'product-ref-line', 'data-state': 'busy' }, `"${pr.key}"이(가) 어떻게 생긴 제품인지 찾는 중…`);
  if (!pr.ref) return h('p', { class: 'muted small', id: 'product-ref-line', 'data-state': 'unknown' }, `"${pr.key}"은(는) 이름만으로는 어떤 제품인지 특정하지 못해서, 올린 사진에 보이는 모습만 기준으로 AI 사진을 만들어요.`);
  return h('p', { class: 'muted small', id: 'product-ref-line', 'data-state': 'ok' }, h('b', null, '이름으로 찾은 제품 모습 '), pr.ref.look);
}

/** 사진 줄의 한 장을 AI 로 바꾼다. 바꾼 사진은 같은 자리에 들어가고, 만들 때 그 카드에 "연출 이미지" 표시가 붙는다(S.genImages). */
function transformListPhoto(list, i) {
  const id = list[i];
  openImageTool({ imageId: id, aspect: '4:5', productTitle: (S.manual.title || '').trim() || S.rec?.product?.title,
    onUse: (nid) => { if (placeGenerated(list, id, nid)) fn.renderStage(); } });
}

/** 확장: 쿠팡 상품 사진 골라 넣기 */
function productPhotoPicker() {
  const rec = S.rec;
  const n = rec?.product?.images?.length || 0;
  if (IS_WEB || !n) return null;
  const grid = h('div', { class: 'thumbs', id: 'product-photo-grid' });
  for (let i = 0; i < n; i++) {
    const id = rec.imageIds?.[i];
    const b = h('button', { type: 'button', class: 'thumb-btn product-photo', 'data-index': i, 'aria-label': `상품 사진 ${i + 1} 넣기`, 'aria-pressed': String(!!id && slotOf(S.photos, id) >= 0), onclick: () => addProductPhoto(i) },
      h('span', { class: 'thumb-empty' }, id ? '…' : `${i + 1}`));
    if (id) imageUrl(id).then((u) => { if (u) b.replaceChildren(h('img', { src: u, alt: '' })); });
    grid.append(b);
  }
  return h('div', null, h('div', { class: 'label' }, '쿠팡 상품 사진에서 고르기'), grid, h('p', { class: 'muted small' }, '누르면 맨 뒤에 들어가요. 다시 누르면 빠져요.'));
}

async function addProductPhoto(i) {
  const rec = S.rec;
  try {
    if (!rec.imageIds[i]) {
      const r = await request('coupang.fetchProductImage', { tabId: S.fixedTab ?? rec.tabId, index: i });
      rec.imageIds[i] = r.imageId;
    }
    const id = rec.imageIds[i];
    const at = slotOf(S.photos, id); // AI 로 바꾼 모습으로 들어 있어도 "넣음" — 다시 누르면 그 자리를 뺀다
    if (at >= 0) S.photos.splice(at, 1);
    else if (S.photos.length >= MAX_PHOTOS) toast(`사진은 ${MAX_PHOTOS}장까지만 쓸 수 있어요.`, { kind: 'warn' });
    else { S.photos.push(id); queueMicrotask(maybeAutoFill); }
    fn.renderStage();
  } catch (e) { showError(e); }
}

// ───────────────────────── 시작 화면(사진 모드) ─────────────────────────

function styleButtons() {
  const idx = STYLES.findIndex((x) => x.key === S.photoStyle);
  const pick = (key) => { S.photoStyle = key; saveModePrefs(); fn.renderStage(); setTimeout(() => document.querySelector(`#style-picker [data-style="${key}"]`)?.scrollIntoView({ inline: 'center', block: 'nearest' }), 30); };
  const step = (d) => { const j = Math.min(STYLES.length - 1, Math.max(0, idx + d)); if (j !== idx) pick(STYLES[j].key); };
  return h('div', { class: 'sample-rail' },
    h('button', { type: 'button', class: 'btn rail-arrow', id: 'style-prev', 'aria-label': '이전 스타일', disabled: idx <= 0, onclick: () => step(-1) }, icon('chevronLeft', { size: 20 })),
    h('div', { class: 'style-grid', id: 'style-picker', role: 'group', 'aria-label': '글씨 스타일' },
      ...STYLES.map((s) => h('button', { type: 'button', class: 'style-btn', 'data-style': s.key, 'aria-pressed': String(S.photoStyle === s.key), onclick: () => pick(s.key) },
        stylePreview(s.key), h('span', { class: 'style-name' }, s.label)))),
    h('button', { type: 'button', class: 'btn rail-arrow', id: 'style-next', 'aria-label': '다음 스타일', disabled: idx >= STYLES.length - 1, onclick: () => step(1) }, icon('chevronRight', { size: 20 })));
}

function infoForm() {
  const price = h('input', { id: 'photo-price', class: 'input', inputmode: 'numeric', placeholder: '예: 59900 (비우면 가격은 링크에서 확인)', 'aria-label': '가격 (선택)' });
  price.value = S.manual.price;
  price.addEventListener('input', () => { S.manual.price = price.value; });
  const desc = h('textarea', { id: 'photo-desc', class: 'input', rows: 3, placeholder: '상품 설명·특징을 붙여 넣으면 글이 더 정확해져요', 'aria-label': '상품 설명 (선택)' });
  desc.value = S.manual.desc || '';
  desc.addEventListener('input', () => { S.manual.desc = desc.value; });
  return h('details', { class: 'extra', id: 'photo-info', open: !!S.manual.desc },
    h('summary', null, '가격·상품 설명'),
    h('div', { class: 'form' },
      h('label', { class: 'label', for: 'photo-price' }, '가격'), price,
      h('label', { class: 'label', for: 'photo-desc' }, '상품 설명·특징'), desc));
}

/** 사진 모드 시작 화면. kids 에 조각을 넣는다. */
export function renderPhotoStart(kids, { keyNotice, hasKey }) {
  if (!hasKey()) { kids.push(keyNotice()); return; }
  const n = S.photos.length;
  const pageProduct = !IS_WEB && S.rec?.product;
  const title = h('input', { id: 'photo-title', class: 'input', placeholder: '예: 무선 핸디 청소기', 'aria-label': '상품 이름 (선택)' });
  title.value = S.manual.title;
  title.addEventListener('input', () => { S.manual.title = title.value; identTyped(); refreshTeaseDetail(title.value); fn.updateMakeEnabled?.(); fn.schedulePreview(300); });
  kids.push(h('section', { class: 'field-block', id: 'photo-start' },
    pageProduct ? null : h('label', { class: 'label', for: 'photo-title' }, '상품 이름 (선택)'),
    pageProduct ? null : title,
    pageProduct ? null : identifyRow({ ids: S.photos, inputId: 'photo-title', optional: true }),
    teaseRow({ title: pageProduct ? S.rec.product.title : S.manual.title }),
    countPicker(),
    productRefLine(),
    h('div', { class: 'label label-row' }, h('span', null, '사진'), h('span', { class: 'muted small', id: 'photo-count' }, `${n}장 · 최대 ${MAX_PHOTOS}장`)),
    photoStrip(S.photos, { key: 'photo', listId: 'photo-list', uploadId: 'btn-photo-upload', firstLabel: '커버', onAdd: uploadPhotos }),
    h('p', { class: 'muted small', id: 'photo-drop-hint' }, '사진을 끌어다 놓거나 붙여 넣기(Ctrl+V · ⌘V)로도 넣을 수 있어요. 사진을 누르면 AI로 바꿀 수 있어요.'),
    productPhotoPicker()));
  kids.push(h('section', { class: 'extra', id: 'photo-style' },
    h('div', { class: 'label' }, '글씨 스타일'), styleButtons()));
  kids.push(infoForm());
  kids.push(h('div', { class: 'make-wrap' },
    h('button', { type: 'button', class: 'btn btn-primary btn-big btn-block', id: 'btn-make', disabled: n < MIN_PHOTOS || !!recreating, onclick: () => fn.onMake() }, recreating ? 'AI 사진 만드는 중…' : '만들기'),
    n < MIN_PHOTOS ? h('p', { class: 'warn-line small center', id: 'photo-few' }, `사진을 ${MIN_PHOTOS}장 이상 올려 주세요 (지금 ${n}장)`) : null));
}

/** "몇 장으로 만들까요?" 2~10장을 직접 적는다(−/+ 도 됨). 사진이 모자라면 AI 사진으로 채우고, 더 많으면 올린 사진을 다 쓴다(최대 10) */
function countPicker() {
  const want = clampCount(S.photoCount);
  const n = S.photos.length;
  const noteOf = (w) => (n && n < w ? `사진 ${n}장 + AI 사진 ${w - n}장으로 ${w}장을 만들어요.` : n > w ? `올린 사진 ${n}장을 다 써서 ${n}장으로 만들어요.` : `사진이 모자라면 AI 사진으로 채워요. 더 올리면 올린 만큼(최대 ${MAX_PHOTOS}장).`);
  const note = h('p', { class: 'muted small', id: 'photo-count-note' }, noteOf(want));
  const inp = h('input', { type: 'number', class: 'input count-input', id: 'photo-count-input', inputmode: 'numeric', min: String(MIN_PHOTOS), max: String(MAX_PHOTOS), step: '1', value: String(want), 'aria-label': '캐러셀 장수' });
  // 칸에 적는 동안(1 → 10 처럼 지나가는 값)은 상태를 바꾸지 않고 안내문만 맞춘다. 칸을 나가거나 Enter 를 치면(change) 그때 확정한다.
  const valid = () => { const v = Math.round(Number(inp.value)); return Number.isInteger(v) && v >= MIN_PHOTOS && v <= MAX_PHOTOS ? v : null; };
  inp.addEventListener('input', () => { const v = valid(); if (v != null) note.textContent = noteOf(v); });
  inp.addEventListener('change', () => commit(valid() ?? want));
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
  const commit = (v) => { S.photoCount = clampCount(v); saveModePrefs(); fn.renderStage(); maybeAutoFill(); };
  return h('div', { class: 'count-pick', id: 'photo-count-pick-wrap' },
    h('div', { class: 'label' }, '몇 장으로 만들까요?'),
    h('div', { class: 'count-stepper', id: 'photo-count-pick', role: 'group', 'aria-label': '캐러셀 장수' },
      h('button', { type: 'button', class: 'btn count-btn', id: 'photo-count-dec', 'aria-label': '한 장 줄이기', disabled: want <= MIN_PHOTOS, onclick: () => commit(want - 1) }, '−'),
      inp, h('span', { class: 'count-unit' }, '장'),
      h('button', { type: 'button', class: 'btn count-btn', id: 'photo-count-inc', 'aria-label': '한 장 늘리기', disabled: want >= MAX_PHOTOS, onclick: () => commit(want + 1) }, '+'),
      h('span', { class: 'muted small' }, `${MIN_PHOTOS}~${MAX_PHOTOS}장`)),
    note);
}

/** ai.generate 에 넘길 product (사진 모드). 사진이 모자라면 null */
export function buildPhotoProduct() {
  const ids = S.photos.slice(0, MAX_PHOTOS);
  if (ids.length < MIN_PHOTOS) return null;
  const rec = S.rec;
  const n = Number(String(S.manual.price || '').replace(/[^\d]/g, ''));
  const price = n >= 100 && n <= 100000000 ? n : null;
  if (!IS_WEB && rec?.product) return { ...rec.product, title: rec.product.title || S.manual.title.trim() || '내 사진', imageIds: ids };
  const title = (S.manual.title || '').trim();
  if (title || (S.manual.desc || '').trim()) return { source: 'manual', title: title || '내 사진', price, priceText: price ? formatPrice(price) : null, images: [], imageIds: ids, description: (S.manual.desc || '').trim().slice(0, 3000), breadcrumb: [] };
  return { source: 'topic', topic: '내가 올린 사진', imageIds: ids };
}
