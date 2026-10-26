// 시작 화면: 상품 띠(사진·이름·가격·다른 사진), 시작 상태 3가지(키 없음 / 상품 페이지 아님 / 상품 페이지), 수동 입력, 파트너스 검색.
import { request } from '../lib/bus.js';
import * as store from '../lib/store.js';
import { formatPrice, searchItemToProduct, canonicalProductUrl } from '../lib/coupang.js';
import { IS_WEB } from '../lib/platform.js';
import { WHERE } from '../lib/common.js';
import { h, setChildren, pickImageFile, pickImageFiles, toast } from './dom.js';
import { S, fn, el, imageUrl } from './app.js';
import { showError } from './errors.js';
import { modeTabs, renderPhotoStart, buildPhotoProduct } from './photo.js';

const hasKey = () => !!(S.settings?.has?.geminiKey || S.settings?.devMockAI);

// ───────────────────────── 상품 정보 모으기 ─────────────────────────

/** 지금 화면에 보이는 상품(시작 전). kind: 'page' | 'search' | 'manual' | null */
export function currentInfo() {
  const rec = S.rec;
  if (S.sel?.kind === 'search') {
    const it = S.sel.item;
    return { kind: 'search', title: it.title, priceText: it.priceText, imageId: S.sel.imageId, count: 1, idx: 0 };
  }
  if (rec?.product) {
    const p = rec.product;
    const title = p.title || S.manual.title.trim();
    const manualPrice = Number(String(S.manual.price).replace(/[^\d]/g, ''));
    const price = p.price ?? (manualPrice >= 100 ? manualPrice : null);
    return {
      kind: 'page', title, priceText: price ? formatPrice(price) : null, price,
      imageId: S.manual.imageId || rec.imageIds?.[S.photoIdx] || null, count: p.images?.length || 0, idx: S.photoIdx, warnings: rec.warnings || [], noTitle: !p.title,
    };
  }
  if (S.manual.imageId || S.manual.title.trim()) {
    const manualPrice = Number(String(S.manual.price).replace(/[^\d]/g, ''));
    return { kind: 'manual', title: S.manual.title.trim(), priceText: manualPrice >= 100 ? formatPrice(manualPrice) : null, price: manualPrice >= 100 ? manualPrice : null, imageId: S.manual.imageId || null, count: 0, idx: 0 };
  }
  return null;
}

/** ai.generate 에 넘길 product. 아직 만들 수 없으면 null. */
export function buildProduct(kind) {
  const rec = S.rec;
  if (S.mode === 'photo') return buildPhotoProduct();
  if (IS_WEB) return buildWebProduct(kind || S.webKind || 'manual');
  if (S.sel?.kind === 'search') {
    const base = searchItemToProduct(S.sel.item);
    return { ...base, imageIds: S.sel.imageId ? [S.sel.imageId] : [] };
  }
  if (rec?.product) {
    const info = currentInfo();
    if (!info.title) return null;
    // 상품명을 사용자가 직접 적었으면 출처를 "직접 입력"(manual)으로 — 페이지에서 읽었다고 표시하지 않는다. 페이지 설명은 쓰지 않는다.
    if (!rec.product.title) {
      const ids0 = (rec.imageIds || []).filter(Boolean);
      const main0 = S.manual.imageId || rec.imageIds?.[S.photoIdx] || null;
      return { source: 'manual', title: info.title, price: info.price ?? null, priceText: info.priceText || null, images: [], imageIds: [main0, ...ids0.filter((x) => x !== main0)].filter(Boolean), description: '', breadcrumb: [] };
    }
    const ids = (rec.imageIds || []).filter(Boolean);
    const main = S.manual.imageId || rec.imageIds?.[S.photoIdx] || null;
    const order = [main, ...ids.filter((x) => x !== main)].filter(Boolean);
    return { ...rec.product, title: info.title, price: info.price ?? null, priceText: info.priceText || null, imageIds: order };
  }
  const title = S.manual.title.trim();
  if (!title) return null;
  const imageIds = S.manual.imageId ? [S.manual.imageId] : [];
  // 읽기 실패 폴백(상품명·가격을 직접 넣는 칸)은 manual, 채팅 모드의 주제(+사진)는 topic
  if (rec && !rec.product && rec.reason === 'CAPTURE_FAILED') {
    const info = currentInfo();
    return { source: 'manual', title, price: info.price ?? null, priceText: info.priceText || null, images: [], imageIds, description: '', breadcrumb: [] };
  }
  return { source: 'topic', topic: title, ...(imageIds.length ? { imageIds } : {}) };
}

/** 웹 버전: 직접 입력(manual) 또는 주제(topic). 사진은 여러 장, 첫 장이 대표 */
function buildWebProduct(kind) {
  if (kind === 'topic') {
    const topic = (S.topic || '').trim();
    if (!topic) return null;
    const ids = S.topicImageIds || [];
    return { source: 'topic', topic, ...(ids.length ? { imageIds: ids.slice(0, 8) } : {}) };
  }
  const title = (S.manual.title || '').trim();
  if (!title) return null;
  const n = Number(String(S.manual.price || '').replace(/[^\d]/g, ''));
  const price = n >= 100 && n <= 100000000 ? n : null;
  return {
    source: 'manual', title, price, priceText: price ? formatPrice(price) : null, images: [], imageIds: (S.manual.imageIds || []).slice(0, 8),
    description: (S.manual.desc || '').trim().slice(0, 3000), breadcrumb: [],
  };
}

// ───────────────────────── 상품 읽기 ─────────────────────────

export async function loadProduct({ refresh = false } = {}) {
  if (IS_WEB) { S.rec = { product: null, imageIds: [], reason: 'WEB' }; return S.rec; }
  try {
    const rec = await request('coupang.getCurrentProduct', { tabId: S.fixedTab, refresh });
    S.rec = rec;
    S.photoIdx = 0;
    if (rec?.product) { S.sel = null; S.manual = { ...S.manual, imageId: null }; }
    return rec;
  } catch (e) {
    S.rec = { product: null, imageIds: [], reason: 'CAPTURE_FAILED', messageKo: e.messageKo, raw: e.raw, where: e.where };
    return S.rec;
  }
}

export async function loadStatus() {
  try { S.cp = await request('coupang.status', {}); } catch { S.cp = null; }
}

async function nextPhoto() {
  const rec = S.rec;
  const n = rec?.product?.images?.length || 0;
  if (n < 2) { toast('이 상품은 사진이 한 장이에요. "내 사진"으로 올릴 수 있어요.'); return; }
  const idx = (S.photoIdx + 1) % n;
  try {
    if (!rec.imageIds[idx]) {
      const r = await request('coupang.fetchProductImage', { tabId: S.fixedTab ?? rec.tabId, index: idx });
      rec.imageIds[idx] = r.imageId;
    }
    S.photoIdx = idx;
    S.manual.imageId = null;
    fn.renderStrip();
  } catch (e) { showError(e); }
}

async function uploadPhoto() {
  const file = await pickImageFile();
  if (!file) return;
  if (file.size > 15 * 1024 * 1024) { toast('사진이 너무 커요(15MB 이하로 올려 주세요).', { kind: 'warn' }); return; }
  try {
    const imageId = await store.putImage(file, { kind: 'upload' });
    S.manual.imageId = imageId;
    fn.renderStrip();
    fn.renderStage();
  } catch (e) { showError(e); }
}

// ───────────────────────── 상품 띠 ─────────────────────────

function thumb(imageId, size = 72) {
  const box = h('div', { class: 'thumb', style: { width: size + 'px', height: size + 'px' }, 'aria-hidden': 'true' }, h('span', { class: 'thumb-empty' }, '사진 없음'));
  if (imageId) {
    imageUrl(imageId).then((u) => {
      if (!u) return;
      box.replaceChildren(h('img', { src: u, alt: '' }));
    });
  }
  return box;
}

/** 상품 띠 그리기. project 가 있으면 한 줄로 줄여 보여 준다. */
export function renderStrip() {
  const host = el.strip;
  if (S.mode === 'photo' && !(S.project && (S.phase === 'ready' || S.phase === 'generating')) && !(!IS_WEB && S.rec?.product)) { host.hidden = true; setChildren(host); return; }
  if (IS_WEB && !(S.project && (S.phase === 'ready' || S.phase === 'generating'))) { host.hidden = true; setChildren(host); return; }
  host.hidden = false;
  applyAccent(S.project?.input?.imageIds?.[0] || currentInfo()?.imageId);
  if (S.phase === 'loading') { setChildren(host, h('div', { class: 'card muted' }, '상품을 확인하는 중…')); return; }

  if (S.project && (S.phase === 'ready' || S.phase === 'generating')) {
    const inp = S.project.input || {};
    const title = inp.title || inp.topic || (inp.script ? '쇼츠 대본' : '내 캐러셀');
    const price = inp.priceText || (inp.source === 'topic' || inp.source === 'shorts' ? '' : '가격은 링크에서 확인');
    setChildren(host, h('section', { class: 'card strip strip-compact', 'aria-label': '상품' },
      thumb(inp.imageIds?.[0], 48),
      h('div', { class: 'strip-text' }, h('div', { class: 'strip-title' }, title), price ? h('div', { class: 'strip-price' }, price) : null),
      S.phase === 'ready' ? h('button', { type: 'button', class: 'btn', id: 'btn-new', onclick: () => fn.startNew() }, '새로 만들기') : null));
    return;
  }

  const info = currentInfo();
  if (!info) { setChildren(host); host.hidden = true; return; }
  host.hidden = false;
  const warn = (info.warnings || []).filter((w) => w.code !== 'NO_PRICE' && w.code !== 'NO_TITLE');
  setChildren(host, h('section', { class: 'card strip', 'aria-label': '상품' },
    h('div', { class: 'strip-row' },
      thumb(info.imageId, 72),
      h('div', { class: 'strip-text' },
        h('div', { class: 'strip-title', id: 'strip-title' }, info.title || '(상품 이름을 적어 주세요)'),
        h('div', { class: 'strip-price', id: 'strip-price' }, info.priceText || '가격은 링크에서 확인'),
        info.kind === 'page' && info.count > 1 && S.mode !== 'photo' ? h('div', { class: 'muted small' }, `사진 ${info.idx + 1} / ${info.count}`) : null)),
    ...warn.map((w) => h('p', { class: 'warn-line' }, w.messageKo)),
    S.mode === 'photo' ? null : h('div', { class: 'btn-row' },
      info.kind === 'page' ? h('button', { type: 'button', class: 'btn', id: 'btn-next-photo', onclick: nextPhoto }, '다른 사진') : null,
      h('button', { type: 'button', class: 'btn', id: 'btn-upload', onclick: uploadPhoto }, '내 사진'),
      info.kind === 'page' ? h('button', { type: 'button', class: 'btn', id: 'btn-reread', onclick: async () => { await loadProduct({ refresh: true }); fn.renderStrip(); fn.renderStage(); } }, '다시 읽기') : null,
      info.kind === 'search' ? h('button', { type: 'button', class: 'btn', onclick: () => { S.sel = null; S.link = ''; fn.renderStrip(); fn.renderStage(); } }, '다시 고르기') : null)));
}

// ───────────────────────── 시작 화면 본문 ─────────────────────────

function keyNotice() {
  return h('section', { class: 'card notice-card', id: 'nokey' },
    h('h2', null, '먼저 Gemini 키가 필요해요'),
    h('p', null, '글과 이미지는 내 Gemini 키로 만들어요. 키는 무료로 만들 수 있고, 이 브라우저에만 저장돼요.'),
    h('ol', { class: 'steps' },
      h('li', null, 'aistudio.google.com/apikey 에서 키를 만들어요 (결제 연결 없이 무료).'),
      h('li', null, '아래 버튼으로 설정을 열어 키를 붙여넣고 "키 연결 확인"을 눌러요.')),
    h('button', { type: 'button', class: 'btn btn-primary btn-block', id: 'btn-open-options', onclick: () => fn.openOptions() }, '설정에서 키 넣기'));
}

function makeButton(label = '만들기') {
  return h('div', { class: 'make-wrap' },
    h('button', { type: 'button', class: 'btn btn-primary btn-big btn-block', id: 'btn-make', onclick: () => fn.onMake() }, label),
    h('p', { class: 'muted small center' }, '누르면 카드와 캡션, 쇼츠 대본까지 한 번에 만들어요. 따로 묻지 않아요.'));
}

function manualForm({ withPrice, titleLabel, titleHint, note }) {
  const info = currentInfo();
  const title = h('textarea', { id: 'manual-title', class: 'input', rows: 2, placeholder: titleHint, 'aria-label': titleLabel });
  title.value = S.manual.title;
  title.addEventListener('input', () => {
    S.manual.title = title.value;
    const t = document.getElementById('strip-title'); if (t) t.textContent = title.value.trim() || '(상품 이름을 적어 주세요)';
    updateMakeEnabled();
  });
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); fn.onMake(); } });
  const price = withPrice ? h('input', { id: 'manual-price', class: 'input', inputmode: 'numeric', placeholder: '가격(숫자만, 모르면 비워 두세요)', 'aria-label': '가격' }) : null;
  if (price) {
    price.value = S.manual.price;
    price.addEventListener('input', () => { S.manual.price = price.value; });
    price.addEventListener('change', () => fn.renderStrip());
  }
  return h('div', { class: 'form' },
    note ? h('p', { class: 'muted' }, note) : null,
    h('label', { class: 'label', for: 'manual-title' }, titleLabel), title,
    price ? h('label', { class: 'label', for: 'manual-price' }, '가격 (선택)') : null, price,
    !info?.imageId ? h('button', { type: 'button', class: 'btn btn-block', id: 'btn-upload-form', onclick: uploadPhoto }, '사진 올리기 (선택)') : null);
}

function updateMakeEnabled() {
  const b = document.getElementById('btn-make');
  if (b) b.disabled = !buildProduct(IS_WEB ? 'manual' : undefined);
  const t = document.getElementById('btn-make-topic');
  if (t) t.disabled = !buildProduct('topic');
}

function searchPanel() {
  const cp = S.cp;
  const blocked = cp?.blocked && cp.blocked.remainingMs > 0;
  const remaining = cp?.search?.remaining ?? 0;
  const box = h('div', { class: 'search', id: 'search-box' });
  const btn = h('button', { type: 'button', class: 'btn btn-block', id: 'btn-search', disabled: blocked || remaining <= 0, onclick: () => doSearch(btn) },
    blocked ? '쿠팡이 잠시 막았어요' : `쿠팡에서 검색 (이번 시간 남은 횟수 ${remaining}/${cp?.search?.limit ?? 8})`);
  append2(box, btn);
  if (blocked) append2(box, h('p', { class: 'warn-line' }, `쿠팡 서버가 잠시 요청을 막았어요. 약 ${Math.ceil(cp.blocked.remainingMs / 60000)}분 뒤에 다시 시도하거나, 상품 페이지에서 시작해 주세요.`));
  else if (remaining <= 0) append2(box, h('p', { class: 'warn-line' }, '이번 시간 검색 횟수를 모두 썼어요. 상품 페이지에서 시작하거나 잠시 뒤에 다시 눌러 주세요.'));
  else append2(box, h('p', { class: 'muted small' }, '검색은 누를 때만 하고, 한 시간에 8번까지만 해요. 상품 페이지에서 시작하면 검색이 필요 없어요.'));
  if (S.searchResults) append2(box, searchList(S.searchResults));
  return box;
}
function append2(parent, child) { parent.append(child); }

function searchList(results) {
  if (!results.items.length) return h('p', { class: 'muted' }, '검색 결과가 없어요. 다른 낱말로 다시 검색해 보세요.');
  return h('ul', { class: 'result-list', id: 'search-results' }, ...results.items.map((it, i) => {
    const t = h('div', { class: 'thumb', style: { width: '56px', height: '56px' } }, h('span', { class: 'thumb-empty' }, '…'));
    if (it.imageId) imageUrl(it.imageId).then((u) => { if (u) t.replaceChildren(h('img', { src: u, alt: '' })); });
    return h('li', null, h('button', { type: 'button', class: 'result-btn', 'data-i': i, onclick: () => pickResult(it) },
      t, h('span', { class: 'result-text' }, h('span', { class: 'result-title' }, it.title), h('span', { class: 'result-price' }, it.priceText || '가격은 링크에서 확인')),
      h('span', { class: 'result-go' }, '선택')));
  }));
}

async function doSearch(btn) {
  const keyword = S.manual.title.trim();
  if (!keyword) { toast('검색할 상품 이름을 위 칸에 적어 주세요.'); document.getElementById('manual-title')?.focus(); return; }
  btn.disabled = true;
  btn.textContent = '검색 중…';
  try {
    const r = await request('coupang.search', { keyword });
    S.searchResults = r;
    const urls = r.items.map((it) => it.image).filter(Boolean);
    await loadStatus();
    fn.renderStage();
    if (urls.length) {
      // 외부 주소를 직접 그리지 않고 서비스워커가 받아 둔 사진(imageId)으로 보여 준다
      request('core.fetchImages', { urls, kind: 'remote' }).then((res) => {
        const map = new Map(res.filter((x) => x.ok).map((x) => [x.url, x.imageId]));
        r.items.forEach((it) => { it.imageId = map.get(it.image) || null; });
        if (S.searchResults === r) fn.renderStage();
      }).catch(() => {});
    }
  } catch (e) {
    showError(e);
    await loadStatus();
    fn.renderStage();
  }
}

async function pickResult(it) {
  let imageId = it.imageId || null;
  try {
    if (!imageId && it.image) imageId = (await request('core.fetchImage', { url: it.image, kind: 'remote' })).imageId;
  } catch (e) { toast('사진을 받지 못했어요. 상품은 선택됐어요. "내 사진"으로 올릴 수 있어요.', { kind: 'warn' }); }
  S.sel = { kind: 'search', item: it, imageId };
  S.link = it.partnersUrl || '';
  S.searchResults = null;
  fn.renderStrip();
  fn.renderStage();
}

/** 시작 화면 본문 (단계에 따라 안내/진행) */
export function renderStartStage() {
  const kids = [modeTabs()];
  if (S.resume) {
    kids.push(h('section', { class: 'card resume-card', id: 'resume-card' },
      h('strong', null, '하던 작업이 있어요'), h('p', { class: 'muted' }, S.resume.title || '제목 없음'),
      h('button', { type: 'button', class: 'btn btn-block', id: 'btn-resume', onclick: () => fn.openProject(S.resume.id) }, '이어서 하기')));
  }
  const info = currentInfo();
  const rec = S.rec;
  const isPage = !!rec?.product;
  const failed = rec && !rec.product && rec.reason === 'CAPTURE_FAILED';

  if (S.mode === 'photo') {
    renderPhotoStart(kids, { keyNotice, hasKey });
    setChildren(el.stage, ...kids);
    return;
  }
  if (IS_WEB) {
    renderWebStart(kids);
    setChildren(el.stage, ...kids);
    updateMakeEnabled();
    return;
  }
  if (!hasKey()) {
    kids.push(keyNotice());
  } else if (isPage && !info.noTitle) {
    kids.push(makeButton());
  } else if (isPage && info.noTitle) {
    kids.push(h('section', { class: 'card' }, h('h2', null, '상품 이름을 못 읽었어요'),
      manualForm({ withPrice: true, titleLabel: '상품 이름', titleHint: '예: 무선 핸디 청소기', note: '상품 이름만 적어 주세요. 나머지는 페이지에서 읽은 대로 써요.' })), makeButton());
  } else if (failed) {
    kids.push(h('section', { class: 'card', id: 'capture-failed' }, h('h2', null, '상품 정보를 읽지 못했어요'),
      h('p', null, rec.messageKo || '페이지를 새로고침한 뒤 다시 열어 보세요. 급하면 아래에 직접 적어도 돼요.'),
      rec.raw ? h('details', null, h('summary', null, '원문 보기'), h('p', { class: 'error-where' }, `발생 위치: ${rec.where || WHERE.SW}`), h('pre', { class: 'raw' }, rec.raw)) : null,
      manualForm({ withPrice: true, titleLabel: '상품 이름', titleHint: '예: 무선 핸디 청소기' })),
    makeButton());
  } else if (S.sel?.kind === 'search') {
    kids.push(makeButton());
  } else {
    // 상품 페이지가 아님 → 채팅 모드
    kids.push(h('section', { class: 'card', id: 'chat-mode' },
      h('h2', null, '쿠팡 상품 페이지를 열면 자동으로 채워져요'),
      h('p', { class: 'muted' }, '상품 페이지가 아니에요. 보고 있는 상품이 있으면 그 페이지로 가 주세요. 아니면 아래에 상품 이름이나 주제를 적어도 돼요.'),
      manualForm({ withPrice: false, titleLabel: '상품 이름 또는 주제', titleHint: '예: 에어랩 캐러셀, 요즘 뜨는 핸디 청소기' }),
      h('button', { type: 'button', class: 'btn btn-block', id: 'btn-read-page', onclick: async () => { await loadProduct({ refresh: true }); fn.renderStrip(); fn.renderStage(); if (!S.rec?.product) toast('이 탭은 쿠팡 상품 페이지가 아니에요.', { kind: 'warn' }); } }, '지금 보는 탭에서 상품 읽기'),
      S.cp?.hasKeys ? searchPanel() : null),
    makeButton('이 내용으로 만들기'));
    kids.push(h('details', { class: 'card', id: 'shorts-start' }, h('summary', null, '쇼츠 대본으로 시작하기'),
      shortsStartForm()));
  }
  setChildren(el.stage, ...kids);
  updateMakeEnabled();
}

// ───────────────────────── 웹 버전 시작 화면 ─────────────────────────

async function addWebPhotos(list) {
  const files = await pickImageFiles();
  if (!files.length) return;
  for (const f of files.slice(0, 8 - list.length)) {
    if (f.size > 15 * 1024 * 1024) { toast(`"${f.name}" 사진이 너무 커요(15MB 이하).`, { kind: 'warn' }); continue; }
    try { list.push(await store.putImage(f, { kind: 'upload' })); } catch (e) { showError(e); }
  }
  fn.renderStage();
}

function photoBlock(list, { label }) {
  const row = h('div', { class: 'thumbs web-photos' });
  list.forEach((id, i) => {
    const t = h('div', { class: 'thumb', style: { width: '64px', height: '64px' } }, h('span', { class: 'thumb-empty' }, '…'));
    imageUrl(id).then((u) => { if (u) t.replaceChildren(h('img', { src: u, alt: '' })); });
    row.append(h('div', { class: 'web-photo' }, t,
      h('span', { class: 'small web-photo-tag' }, i === 0 ? '대표' : `${i + 1}번`),
      h('button', { type: 'button', class: 'btn btn-quiet', 'aria-label': `${i + 1}번 사진 빼기`, onclick: () => { list.splice(i, 1); fn.renderStage(); } }, '빼기')));
  });
  return h('div', null,
    h('div', { class: 'label' }, label),
    list.length ? row : null,
    list.length ? h('p', { class: 'muted small' }, '첫 장이 대표 사진이에요.') : null,
    h('button', { type: 'button', class: 'btn btn-block', id: list === S.topicImageIds ? 'btn-upload-topic' : 'btn-upload-web', onclick: () => addWebPhotos(list) }, list.length ? '사진 더 올리기' : '사진 올리기 (여러 장 가능)'));
}

function renderWebStart(kids) {
  S.manual.imageIds = S.manual.imageIds || [];
  S.topicImageIds = S.topicImageIds || [];
  if (!hasKey()) { kids.push(keyNotice()); return; }
  const title = h('textarea', { id: 'manual-title', class: 'input', rows: 2, placeholder: '예: 무선 핸디 청소기 화이트', 'aria-label': '상품 이름' });
  title.value = S.manual.title;
  title.addEventListener('input', () => { S.manual.title = title.value; updateMakeEnabled(); });
  const price = h('input', { id: 'manual-price', class: 'input', inputmode: 'numeric', placeholder: '예: 59900 (모르면 비워 두세요)', 'aria-label': '가격' });
  price.value = S.manual.price;
  price.addEventListener('input', () => { S.manual.price = price.value; });
  const desc = h('textarea', { id: 'manual-desc', class: 'input', rows: 5, placeholder: '쿠팡 상품 페이지의 설명·특징을 복사해서 붙여 넣으세요', 'aria-label': '상품 설명 또는 특징' });
  desc.value = S.manual.desc || '';
  desc.addEventListener('input', () => { S.manual.desc = desc.value; });
  kids.push(h('section', { class: 'card', id: 'web-form' },
    h('h2', null, '상품 정보를 넣어 주세요'),
    h('p', { class: 'muted' }, '상품 이름만 있어도 만들 수 있어요. 아는 만큼 넣으면 글이 더 정확해져요.'),
    h('div', { class: 'form' },
      h('label', { class: 'label', for: 'manual-title' }, '상품 이름 (필수)'), title,
      h('label', { class: 'label', for: 'manual-price' }, '가격 (선택)'), price,
      h('p', { class: 'muted small' }, '비우면 카드에는 "가격은 링크에서 확인"이라고 나와요.'),
      h('label', { class: 'label', for: 'manual-desc' }, '상품 설명·특징 (선택)'), desc,
      h('p', { class: 'muted small' }, '쿠팡 상품 페이지의 설명을 복사해 붙여 넣으면 글이 그 내용을 근거로 써요. 붙여 넣은 내용은 "내가 입력한 정보"로 기록돼요.'),
      photoBlock(S.manual.imageIds, { label: '상품 사진 (선택)' }))),
  h('div', { class: 'make-wrap' },
    h('button', { type: 'button', class: 'btn btn-primary btn-big btn-block', id: 'btn-make', onclick: () => fn.onMake('manual') }, '만들기'),
    h('p', { class: 'muted small center' }, '누르면 카드와 캡션, 쇼츠 대본까지 한 번에 만들어요. 따로 묻지 않아요.')));

  const topic = h('textarea', { id: 'topic-text', class: 'input', rows: 2, placeholder: '예: 요즘 뜨는 핸디 청소기 고르는 법', 'aria-label': '주제' });
  topic.value = S.topic || '';
  topic.addEventListener('input', () => { S.topic = topic.value; updateMakeEnabled(); });
  kids.push(h('details', { class: 'card', id: 'topic-start', open: !!S.topic },
    h('summary', null, '주제로 만들기 (상품 정보 없이)'),
    h('div', { class: 'form' },
      h('p', { class: 'muted small' }, '주제만 적으면 숫자·후기 같은 사실은 쓰지 않고 체감 표현으로만 만들어요.'),
      h('label', { class: 'label', for: 'topic-text' }, '주제'), topic,
      photoBlock(S.topicImageIds, { label: '사진 (선택)' }),
      h('button', { type: 'button', class: 'btn btn-block', id: 'btn-make-topic', onclick: () => fn.onMake('topic') }, '이 주제로 만들기'))));
  kids.push(h('details', { class: 'card', id: 'shorts-start' }, h('summary', null, '쇼츠 대본으로 시작하기'), shortsStartForm()));
}

function shortsStartForm() {
  const ta = h('textarea', { class: 'input', id: 'shorts-start-text', rows: 5, placeholder: '쇼츠 대본이나 자막을 붙여 넣으세요 (10자 이상)', 'aria-label': '쇼츠 대본' });
  return h('div', { class: 'form' }, ta,
    h('button', { type: 'button', class: 'btn btn-block', id: 'btn-shorts-start', onclick: () => fn.makeFromShorts(ta.value) }, '이 대본으로 캐러셀 만들기'));
}

export { hasKey, canonicalProductUrl };

// ───────────────────────── 제품 추출색(UI 띠·막대에 쓰는 색) ─────────────────────────
let accentFor = null;
export async function applyAccent(imageId) {
  if (!imageId || accentFor === imageId) return;
  accentFor = imageId;
  try {
    const { extractColorsFromImageId } = await import('../lib/render.js');
    const colors = await extractColorsFromImageId(imageId);
    if (colors[0] && accentFor === imageId) document.documentElement.style.setProperty('--accent', colors[0]);
  } catch { /* 색을 못 뽑아도 브랜드색으로 */ }
}
