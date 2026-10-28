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
import { identifyRow } from './identify.js';
import { TRANSFORMS } from '../lib/imageprompt.js';

export const STYLES = [
  { key: 'outline', label: '테두리', desc: '굵은 흰 글씨 + 검은 테두리' },
  { key: 'gradient', label: '그라데이션', desc: '아래를 어둡게, 왼쪽 정렬' },
  { key: 'band', label: '띠', desc: '반투명 검은 띠 위 글씨' },
  { key: 'shadow', label: '그림자', desc: '테두리 없이 진한 그림자' },
];
export const STYLE_LABEL = Object.fromEntries(STYLES.map((s) => [s.key, s.label]));
export const MAX_PHOTOS = 10;
export const MIN_PHOTOS = 2;

// ───────────────────────── 마지막 선택 기억 ─────────────────────────

export async function loadModePrefs() {
  try {
    const m = await store.kvGet('panel.mode', null);
    if (m?.mode === 'photo' || m?.mode === 'cardnews') S.mode = m.mode;
    if (STYLE_LABEL[m?.style]) S.photoStyle = m.style;
    if (m?.ad && typeof m.ad === 'object') S.ad = m.ad;
    else if (typeof m?.adLabel === 'boolean') S.ad = { photo: { on: m.adLabel } };
    if (typeof m?.font === 'string') S.font = m.font;
  } catch { /* 기억 못 해도 기본값 */ }
}
export function fontCard() {
  return h('section', { class: 'extra', id: 'font-card' },
    fontDetails({ value: S.font, onPick: pickStartFont, id: 'font-picker', open: !!S.fontOpen }),
    null);
}

export function saveModePrefs() {
  store.kvSet('panel.mode', { mode: S.mode, style: S.photoStyle, ad: S.ad, font: S.font }).catch(() => {});
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
    tab('cardnews', '카드뉴스'), tab('photo', '사진 캐러셀'));
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
  return n;
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
  const todo = list.filter((id) => !S.genImages?.has(id)).length;
  const busy = recreating && recreating.listId === listId;
  const recreate = list.length ? h('div', { class: 'recreate-row', id: `${listId}-recreate-row` },
    h('button', { type: 'button', class: 'btn btn-block', id: `${listId}-recreate`, disabled: !!recreating || !todo, onclick: () => recreateAll(list, listId) },
      icon('sparkle', { size: 18 }), busy ? `새로 그리는 중… ${recreating.done}/${recreating.total}` : todo ? `사진 ${todo}장 AI로 새로 그리기 (중복 피하기)` : '모두 새로 그린 사진이에요'),
    busy ? h('button', { type: 'button', class: 'btn btn-block recreate-stop', id: `${listId}-recreate-stop`, disabled: recreating.stopped, onclick: () => cancelRecreate() },
      recreating.stopped ? '멈추는 중…' : '멈추기') : null,
    h('p', { class: 'muted small' }, '판매처 사진을 그대로 쓰지 않고, 같은 상품을 다른 각도·구도·배경의 새 사진으로 바꿔요. 원본은 그대로 남고, 카드에는 "연출 이미지" 표시가 붙어요.')) : null;
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

/** 사진 전부 새로 그리기(중복 피하기): 아직 새로 그리지 않은 사진을 2장씩 차례로 image.transformStream(recreate) 에 보낸다.
 *  연출은 사진마다 돌려 가며(깔끔한 연출 → 생활 속 → 다른 각도 → 위에서) 서로 비슷해지지 않게 한다. 한도에 걸리면 멈추고 안내한다.
 *  [멈추기]·새 상품 시작·패널 닫기면 진행 중인 요청까지 끊는다(포트 취소 → 서비스워커 fetch 중단). */
let recreating = null;   // {listId, done, total, stopped, runs:Set<stream>}
const RECREATE_OPTS = TRANSFORMS.find((t) => t.key === 'recreate').options.map((o) => o.key);
export function cancelRecreate() {
  if (!recreating || recreating.stopped) return;
  recreating.stopped = true;
  for (const s of recreating.runs) s.cancel();
  fn.renderStage();
}
async function recreateAll(list, listId) {
  if (recreating) return;
  const ids = list.filter((id) => !S.genImages?.has(id));
  if (!ids.length) return;
  const job = recreating = { listId, done: 0, total: ids.length, stopped: false, runs: new Set() };
  fn.renderStage();
  const title = (S.manual.title || '').trim() || S.rec?.product?.title;
  let stop = null, k = 0;
  const one = async (id) => {
    if (stop || job.stopped) return;
    const option = RECREATE_OPTS[(list.indexOf(id) >= 0 ? list.indexOf(id) : k++) % RECREATE_OPTS.length];
    const s = stream('image.transformStream', { imageId: id, kind: 'recreate', option, aspect: '4:5', productTitle: title });
    job.runs.add(s);
    let r;
    try { r = await s.done; } catch (e) { if (e?.code !== 'CANCELLED' && !job.stopped) stop = stop || { error: e }; return; } finally { job.runs.delete(s); }
    if (r.fallback || !r.imageId) { stop = stop || { messageKo: r.messageKo }; return; }
    if (!isLiveList(list) || !placeGenerated(list, id, r.imageId)) return; // 그 사이 사진을 빼거나 새 상품으로 바뀜
    job.done++;
    fn.renderStage();
  };
  const queue = ids.slice();
  await Promise.all([0, 1].map(async () => { while (queue.length && !stop && !job.stopped) await one(queue.shift()); }));
  const done = job.done;
  recreating = null;
  fn.renderStage();
  if (!isLiveList(list)) return; // 새 상품으로 넘어갔으면 옛 결과를 알리지 않는다
  if (stop?.error) showError(stop.error);
  else if (stop) toast(`${done}장을 새로 그렸어요. ${stop.messageKo || '이미지 생성 한도에 걸렸어요.'}`, { kind: 'warn', ms: 7000 });
  else if (job.stopped) toast(done ? `멈췄어요. 사진 ${done}장은 새로 그린 사진으로 바꿨어요.` : '멈췄어요. 바꾼 사진은 없어요.');
  else toast(`사진 ${done}장을 새로 그렸어요. 원본은 그대로 남아 있어요.`);
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
    else S.photos.push(id);
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
  title.addEventListener('input', () => { S.manual.title = title.value; fn.schedulePreview(300); });
  kids.push(h('section', { class: 'field-block', id: 'photo-start' },
    pageProduct ? null : h('label', { class: 'label', for: 'photo-title' }, '상품 이름 (선택)'),
    pageProduct ? null : title,
    pageProduct ? null : identifyRow({ ids: S.photos, inputId: 'photo-title' }),
    h('div', { class: 'label label-row' }, h('span', null, '사진'), h('span', { class: 'muted small', id: 'photo-count' }, `${n}장 · 2~${MAX_PHOTOS}장`)),
    photoStrip(S.photos, { key: 'photo', listId: 'photo-list', uploadId: 'btn-photo-upload', firstLabel: '커버', onAdd: uploadPhotos }),
    h('p', { class: 'muted small', id: 'photo-drop-hint' }, '사진을 끌어다 놓거나 붙여 넣기(Ctrl+V · ⌘V)로도 넣을 수 있어요. 사진을 누르면 AI로 바꿀 수 있어요.'),
    productPhotoPicker()));
  kids.push(h('section', { class: 'extra', id: 'photo-style' },
    h('div', { class: 'label' }, '글씨 스타일'), styleButtons()));
  kids.push(infoForm());
  kids.push(h('div', { class: 'make-wrap' },
    h('button', { type: 'button', class: 'btn btn-primary btn-big btn-block', id: 'btn-make', disabled: n < MIN_PHOTOS, onclick: () => fn.onMake() }, '만들기'),
    n < MIN_PHOTOS ? h('p', { class: 'warn-line small center', id: 'photo-few' }, `사진을 ${MIN_PHOTOS}장 이상 올려 주세요 (지금 ${n}장)`) : null));
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
