// 두 가지 버전 중 사진 캐러셀: 버전 고르기, 사진 목록(올리기·순서·빼기), 글씨 스타일 고르기, [광고] 표시, 만들 상품 정보.
// 데이터 계약은 docs/사진캐러셀.md. 카드 편집은 tab-edit-photo.js.
import { request } from '../lib/bus.js';
import * as store from '../lib/store.js';
import { IS_WEB } from '../lib/platform.js';
import { formatPrice } from '../lib/coupang.js';
import { h, setChildren, pickImageFiles, toast } from './dom.js';
import { S, fn, imageUrl } from './app.js';
import { showError } from './errors.js';

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
    if (typeof m?.adLabel === 'boolean') S.adLabel = m.adLabel;
  } catch { /* 기억 못 해도 기본값 */ }
}
export function saveModePrefs() {
  store.kvSet('panel.mode', { mode: S.mode, style: S.photoStyle, adLabel: S.adLabel }).catch(() => {});
}

// ───────────────────────── 작은 그림(예시·스타일 미리보기) ─────────────────────────

/** 글씨 스타일 미리보기 (CSS 도형, 외부 파일 없음) */
export function stylePreview(key) {
  const txt = h('span', { class: 'sp-text' }, '글씨가\n이렇게');
  const box = h('span', { class: `style-preview sp-${key}`, 'aria-hidden': 'true' }, txt);
  if (key === 'gradient') box.append(h('span', { class: 'sp-grad' }));
  return box;
}

function exampleCardnews() {
  return h('span', { class: 'mode-ex ex-cardnews', 'aria-hidden': 'true' }, h('i', { class: 'ex-chip' }), h('i', { class: 'ex-title' }), h('i', { class: 'ex-line' }), h('i', { class: 'ex-line short' }));
}
function examplePhoto() {
  return h('span', { class: 'mode-ex ex-photo', 'aria-hidden': 'true' }, h('span', { class: 'sp-text' }, '글만\n쓱'));
}

/** [카드뉴스 | 사진 캐러셀] 큰 탭 2개 */
export function modeTabs() {
  const tab = (mode, name, desc, ex) => h('button', {
    type: 'button', role: 'tab', class: 'mode-tab', id: `mode-${mode}`, 'aria-selected': String(S.mode === mode), 'data-mode': mode,
    onclick: () => setMode(mode),
  }, ex, h('span', { class: 'mode-name' }, name), h('span', { class: 'mode-desc' }, desc));
  return h('div', { class: 'mode-tabs', id: 'mode-tabs', role: 'tablist', 'aria-label': '만들 버전 고르기' },
    tab('cardnews', '카드뉴스', '글 카드로 정리해요', exampleCardnews()),
    tab('photo', '사진 캐러셀', '사진을 넣으면 글만 써 줘요', examplePhoto()));
}

export function setMode(mode) {
  if (S.mode === mode) return;
  S.mode = mode;
  saveModePrefs();
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

function move(i, d) {
  const j = i + d;
  if (j < 0 || j >= S.photos.length) return;
  [S.photos[i], S.photos[j]] = [S.photos[j], S.photos[i]];
  fn.renderStage();
}

function photoList() {
  const list = h('ul', { class: 'photo-list', id: 'photo-list' });
  S.photos.forEach((id, i) => {
    const t = h('div', { class: 'thumb', style: { width: '56px', height: '56px' } }, h('span', { class: 'thumb-empty' }, '…'));
    imageUrl(id).then((u) => { if (u) t.replaceChildren(h('img', { src: u, alt: '' })); });
    list.append(h('li', { class: 'photo-item', 'data-i': i, 'data-id': id },
      t,
      h('span', { class: 'photo-no' }, i === 0 ? '1번 · 커버' : `${i + 1}번`),
      h('span', { class: 'photo-btns' },
        h('button', { type: 'button', class: 'btn', 'data-act': 'up', disabled: i === 0, 'aria-label': `${i + 1}번 사진을 앞으로`, onclick: () => move(i, -1) }, '↑'),
        h('button', { type: 'button', class: 'btn', 'data-act': 'down', disabled: i === S.photos.length - 1, 'aria-label': `${i + 1}번 사진을 뒤로`, onclick: () => move(i, 1) }, '↓'),
        h('button', { type: 'button', class: 'btn', 'data-act': 'remove', 'aria-label': `${i + 1}번 사진 빼기`, onclick: () => { S.photos.splice(i, 1); fn.renderStage(); } }, '빼기'))));
  });
  return list;
}

/** 확장: 쿠팡 상품 사진 골라 넣기 */
function productPhotoPicker() {
  const rec = S.rec;
  const n = rec?.product?.images?.length || 0;
  if (IS_WEB || !n) return null;
  const grid = h('div', { class: 'thumbs', id: 'product-photo-grid' });
  for (let i = 0; i < n; i++) {
    const id = rec.imageIds?.[i];
    const b = h('button', { type: 'button', class: 'thumb-btn product-photo', 'data-index': i, 'aria-label': `상품 사진 ${i + 1} 넣기`, 'aria-pressed': String(!!id && S.photos.includes(id)), onclick: () => addProductPhoto(i) },
      h('span', { class: 'thumb-empty' }, id ? '…' : `${i + 1}`));
    if (id) imageUrl(id).then((u) => { if (u) b.replaceChildren(h('img', { src: u, alt: '' })); });
    grid.append(b);
  }
  return h('div', null, h('div', { class: 'label' }, '쿠팡 상품 사진에서 고르기'), grid, h('p', { class: 'muted small' }, '누르면 사진 목록 맨 뒤에 들어가요. 다시 누르면 빠져요.'));
}

async function addProductPhoto(i) {
  const rec = S.rec;
  try {
    if (!rec.imageIds[i]) {
      const r = await request('coupang.fetchProductImage', { tabId: S.fixedTab ?? rec.tabId, index: i });
      rec.imageIds[i] = r.imageId;
    }
    const id = rec.imageIds[i];
    const at = S.photos.indexOf(id);
    if (at >= 0) S.photos.splice(at, 1);
    else if (S.photos.length >= MAX_PHOTOS) toast(`사진은 ${MAX_PHOTOS}장까지만 쓸 수 있어요.`, { kind: 'warn' });
    else S.photos.push(id);
    fn.renderStage();
  } catch (e) { showError(e); }
}

// ───────────────────────── 시작 화면(사진 모드) ─────────────────────────

function styleButtons() {
  return h('div', { class: 'style-grid', id: 'style-picker', role: 'group', 'aria-label': '글씨 스타일' },
    ...STYLES.map((s) => h('button', { type: 'button', class: 'style-btn', 'data-style': s.key, 'aria-pressed': String(S.photoStyle === s.key), onclick: () => { S.photoStyle = s.key; saveModePrefs(); fn.renderStage(); } },
      stylePreview(s.key), h('span', { class: 'style-name' }, s.label), h('span', { class: 'muted small' }, s.desc))));
}

function infoForm() {
  const title = h('input', { id: 'photo-title', class: 'input', placeholder: '예: 무선 핸디 청소기 (없어도 돼요)', 'aria-label': '상품 이름 (선택)' });
  title.value = S.manual.title;
  title.addEventListener('input', () => { S.manual.title = title.value; });
  const price = h('input', { id: 'photo-price', class: 'input', inputmode: 'numeric', placeholder: '예: 59900 (비워 두면 가격은 링크에서 확인)', 'aria-label': '가격 (선택)' });
  price.value = S.manual.price;
  price.addEventListener('input', () => { S.manual.price = price.value; });
  const desc = h('textarea', { id: 'photo-desc', class: 'input', rows: 3, placeholder: '상품 설명·특징을 붙여 넣으면 글이 더 정확해져요', 'aria-label': '상품 설명 (선택)' });
  desc.value = S.manual.desc || '';
  desc.addEventListener('input', () => { S.manual.desc = desc.value; });
  return h('details', { class: 'card', id: 'photo-info', open: !!(S.manual.title || S.manual.desc) },
    h('summary', null, '상품 정보 넣기 (선택)'),
    h('div', { class: 'form' },
      h('p', { class: 'muted small' }, '있으면 글이 더 정확해져요. 없어도 사진만 보고 써 줘요. 붙여 넣은 내용은 "내가 입력한 정보"로 기록돼요.'),
      h('label', { class: 'label', for: 'photo-title' }, '상품 이름'), title,
      h('label', { class: 'label', for: 'photo-price' }, '가격'), price,
      h('label', { class: 'label', for: 'photo-desc' }, '상품 설명·특징'), desc));
}

/** 사진 모드 시작 화면. kids 에 조각을 넣는다. */
export function renderPhotoStart(kids, { keyNotice, hasKey }) {
  if (!hasKey()) { kids.push(keyNotice()); return; }
  const n = S.photos.length;
  const pageProduct = !IS_WEB && S.rec?.product;
  kids.push(h('section', { class: 'card', id: 'photo-start' },
    h('h2', null, '사진을 넣어 주세요'),
    h('p', { class: 'muted' }, `사진 ${MIN_PHOTOS}~${MAX_PHOTOS}장을 순서대로 넣으면, 사진마다 맞는 글을 써 줘요. 사진 순서가 카드 순서예요(1번이 커버).`),
    n ? photoList() : null,
    n ? h('p', { class: 'muted small', id: 'photo-count' }, `지금 ${n}장`) : null,
    h('button', { type: 'button', class: 'btn btn-block', id: 'btn-photo-upload', onclick: uploadPhotos }, n ? '사진 더 올리기' : '사진 올리기 (여러 장 한 번에)'),
    productPhotoPicker()),
  h('section', { class: 'card', id: 'photo-style' },
    h('h2', null, '글씨 스타일'), styleButtons(),
    (() => {
      const cb = h('input', { type: 'checkbox', id: 'ad-label', checked: S.adLabel });
      cb.addEventListener('change', () => { S.adLabel = cb.checked; saveModePrefs(); fn.renderStage(); });
      return h('label', { class: 'check-row', for: 'ad-label' }, cb, h('span', null, '사진 왼쪽 위에 [광고] 표시'));
    })(),
    S.adLabel ? h('p', { class: 'muted small' }, '쿠팡 파트너스 게시물이면 켜 두세요. 캡션 첫 줄 고지 문구는 따로 항상 들어가요.')
      : h('p', { class: 'warn-line small', id: 'ad-off-note' }, '파트너스 게시물이면 켜 두세요. 끄면 광고 표시가 사진에 들어가지 않아요.')));
  if (!pageProduct) kids.push(infoForm());
  const make = h('div', { class: 'make-wrap' },
    h('button', { type: 'button', class: 'btn btn-primary btn-big btn-block', id: 'btn-make', disabled: n < MIN_PHOTOS, onclick: () => fn.onMake() }, '만들기'),
    n < MIN_PHOTOS ? h('p', { class: 'warn-line small center', id: 'photo-few' }, `사진을 ${MIN_PHOTOS}장 이상 올려 주세요 (지금 ${n}장)`) : h('p', { class: 'muted small center' }, '누르면 사진마다 글을 쓰고 캡션·쇼츠 대본까지 만들어요.'));
  kids.push(make);
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
