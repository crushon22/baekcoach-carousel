// Canvas 카드 렌더러 (2단계 renderer) — v1 §6·§20-A·§20-B·§20-C·§20-E·§20-G, v3 §6·§12-A.
// 레이아웃 7종(title·photo-full·split·number·quote·table·cta) · 템플릿 6종 · 진행 점 · peek · 파노라마 · 로고 ·
// 색 추출 · 흰 여백 트리밍 · 의미 단위 줄바꿈 · 숫자 강조 · 1:1·9:16 · 텍스트 없는 버전 · 커버 3안 · zip 내보내기.
// 사이드 패널(DOM)에서 돈다. 이미지는 IndexedDB(store.getImageBlob) → Blob → createImageBitmap 으로만 그린다
// (외부 주소를 직접 그리지 않으므로 캔버스가 오염되지 않는다 — CLAUDE.md 규칙 8).
// 공개 함수 설명: docs/인터페이스_렌더러.md
import * as store from './store.js';
import { makeZip } from './zip.js';
import { fontByKey, ensureCardFont, DEFAULT_FONT } from './fonts.js';

export { makeZip, crc32 } from './zip.js';
export { mountPhoneFrame } from './phone-frame.js';

// ───────────────────────── 상수 ─────────────────────────

/** 크기: 4x5 = 1080×1350(기본), 1x1 = 1080×1080, 9x16 = 1080×1920(1번·마지막 카드용). top/bottom = 안전영역 */
export const SIZES = {
  '4x5': { w: 1080, h: 1350, top: 100, bottom: 100 },
  '1x1': { w: 1080, h: 1080, top: 100, bottom: 100 },
  '9x16': { w: 1080, h: 1920, top: 250, bottom: 280 },   // 스토리·릴스 UI가 위아래를 가린다
};
export const MARGIN_X = 100;
export const LAYOUTS = ['title', 'photo-full', 'split', 'number', 'quote', 'table', 'cta'];
export const TYPES = ['list', 'sales', 'problem', 'checklist', 'compare', 'story', 'reviews', 'qna', 'ranking'];

/** v1 §6 템플릿 색표. head:null 이면 브랜드색, bg:null 이면 브랜드색 */
export const TEMPLATES = {
  basic: { name: '기본', bg: '#F5F7FB', head: null, accent: '#F59E0B', body: '#1A1F2B', bodyAlpha: 1 },
  warm: { name: '베이지', bg: '#FFFBEB', head: '#B45309', accent: '#F59E0B', body: '#3B2F2F', bodyAlpha: 1 },
  dark: { name: '다크', bg: '#111827', head: '#FFFFFF', accent: '#FBBF24', body: '#FFFFFF', bodyAlpha: 1 },
  pastel: { name: '파스텔', bg: '#FDF2F8', head: '#9D174D', accent: '#F472B6', body: '#3B1F2B', bodyAlpha: 1 },
  nature: { name: '자연', bg: '#F0FDF4', head: '#166534', accent: '#A3E635', body: '#1A2E1A', bodyAlpha: 1 },
  pop: { name: '포인트', bg: null, head: '#FFFFFF', accent: '#FDE68A', body: '#FFFFFF', bodyAlpha: 0.9 },
};

const FAMILY_NAME = 'BC Pretendard';
const FAMILY = `"${FAMILY_NAME}", "Pretendard", "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif`;
const HEAD_SIZES = [108, 92, 78, 66];
const BODY_SIZES = [44, 40, 36, 32, 30];
const NUM_RE = /\d+(?:[,.]\d+)*\s?(?:kg|ml|cm|mm|만\s?원|가지|단계|시간|개월|[만원개분%배장위초명회일gGLl])?/g;

// ───────────────────────── 폰트 ─────────────────────────

let fontsPromise = null;
/** Pretendard woff2 2종을 FontFace 로 등록하고 document.fonts 로드가 끝난 뒤 resolve. 실패하면 {ok:false}(시스템 폰트로 그림). */
export function loadFonts() {
  if (fontsPromise) return fontsPromise;
  fontsPromise = (async () => {
    const fontSet = globalThis.document?.fonts ?? globalThis.fonts;
    if (!fontSet || typeof FontFace === 'undefined') return { ok: false, reason: 'FontFace 를 쓸 수 없는 환경' };
    const defs = [['500', 'Pretendard-Medium.woff2'], ['700', 'Pretendard-Bold.woff2']];
    const faces = defs.map(([weight, file]) =>
      new FontFace(FAMILY_NAME, `url("${chrome.runtime.getURL('fonts/' + file)}") format("woff2")`, { weight, style: 'normal' }));
    await Promise.all(faces.map((f) => f.load()));
    faces.forEach((f) => fontSet.add(f));
    await Promise.all([fontSet.load(`500 40px "${FAMILY_NAME}"`, '가나다 0123'), fontSet.load(`700 40px "${FAMILY_NAME}"`, '가나다 0123')]);
    return { ok: true };
  })().catch((e) => { fontsPromise = null; return { ok: false, reason: String(e && e.message || e) }; });
  return fontsPromise;
}

// ───────────────────────── 색 유틸 ─────────────────────────

const validHex = (s) => (typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s.trim()) ? s.trim().toUpperCase() : null);
const hex2rgb = (h) => { const s = h.replace('#', ''); return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)]; };
const rgb2hex = (r) => '#' + r.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
const lum = (hex) => { const [r, g, b] = hex2rgb(hex).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
const mix = (a, b, t) => { const x = hex2rgb(a), y = hex2rgb(b); return rgb2hex(x.map((v, i) => v + (y[i] - v) * t)); };
const rgba = (hex, a) => { const [r, g, b] = hex2rgb(hex); return `rgba(${r},${g},${b},${a})`; };
/** fg 를 배경 대비 min 이상이 될 때까지 검정/흰색 쪽으로 이동 */
function ensureContrast(fg, bg, min) {
  if (contrast(fg, bg) >= min) return fg;
  const toward = lum(bg) > 0.4 ? '#000000' : '#FFFFFF';
  for (let t = 0.05; t <= 1.0001; t += 0.05) { const c = mix(fg, toward, t); if (contrast(c, bg) >= min) return c; }
  return toward;
}

function buildTheme(carousel) {
  const key = TEMPLATES[carousel.template] ? carousel.template : 'basic';
  const tpl = TEMPLATES[key];
  const uc = carousel.colors || {};            // 사용자 색 덮어쓰기(#RRGGBB). 없으면 템플릿 그대로
  const ucBg = validHex(uc.bg), ucHead = validHex(uc.headline), ucBody = validHex(uc.body), ucAccent = validHex(uc.accent);
  const brand = validHex(carousel.brandColor) || '#2563EB';
  const accent = ucAccent || validHex(carousel.accentColor) || tpl.accent;
  const bg = ucBg || tpl.bg || ensureContrast(brand, '#FFFFFF', 4.2);       // pop: 흰 글자가 읽히도록 브랜드색을 필요하면 어둡게
  const head = ucHead || tpl.head || ensureContrast(brand, bg, 4.5);
  const bodyHex = ucBody || tpl.body;
  const darkBg = lum(bodyHex) > lum(bg);
  const bodyColor = !ucBody && tpl.bodyAlpha < 1 ? rgba(bodyHex, tpl.bodyAlpha) : bodyHex;
  return {
    key, bg, head, accent, bodyHex, body: bodyColor, darkBg, custom: !!(ucBg || ucHead || ucBody || ucAccent),
    accentText: ucAccent ? ucAccent : ensureContrast(accent, bg, 2.8),      // 사용자가 고른 강조색은 숫자 강조에도 그대로
    chipFg: lum(accent) > 0.4 ? '#1A1F2B' : '#FFFFFF',
    panel: darkBg ? mix(bg, '#FFFFFF', 0.09) : '#FFFFFF',
    line: rgba(bodyHex, 0.16), faint: rgba(bodyHex, 0.45), muted: rgba(bodyHex, 0.62),
  };
}
/** 사진 위에 얹는 글자용 테마 (어두운 그라데이션 위 흰 글자) */
function photoTheme(base, over = '#0F172A') {
  return { ...base, bg: over, head: '#FFFFFF', body: 'rgba(255,255,255,0.92)', bodyHex: '#FFFFFF', darkBg: true,
    accentText: ensureContrast(base.accent, over, 3), line: 'rgba(255,255,255,0.25)', faint: 'rgba(255,255,255,0.5)', muted: 'rgba(255,255,255,0.75)' };
}
/** 단색 밝은/어두운 바탕 위(흰 배경 사진) 글자용 */
function inkOn(base, bgHex) {
  if (lum(bgHex) > 0.45) return { ...base, bg: bgHex, head: '#1A1F2B', body: '#1A1F2B', bodyHex: '#1A1F2B', darkBg: false, accentText: ensureContrast(base.accent, bgHex, 2.8), line: 'rgba(26,31,43,0.16)', faint: 'rgba(26,31,43,0.45)', muted: 'rgba(26,31,43,0.62)' };
  return photoTheme(base, bgHex);
}

// ───────────────────────── 캔버스·이미지 ─────────────────────────

function makeCanvas(w, h) {
  if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  return new OffscreenCanvas(w, h);
}
export async function canvasToBlob(canvas, type = 'image/png', quality) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob 실패: 캔버스가 오염되었거나 비어 있습니다.'))), type, quality));
}

let imageLoader = (id) => store.getImageBlob(id);
/** 테스트·특수 용도: imageId → Blob 읽는 함수를 바꾼다(기본: store.getImageBlob). */
export function setImageLoader(fn) { imageLoader = fn; imgCache.clear(); }

const imgCache = new Map();   // imageId → Promise<{id,bitmap,w,h,info}|null>
const IMG_CACHE_MAX = 24;
/** 캐시 비우기. id 를 주면 그 이미지만(같은 id 로 이미지를 덮어쓴 경우 호출). */
export function clearImageCache(id) {
  const drop = (k) => { const p = imgCache.get(k); imgCache.delete(k); p && p.then((r) => r && r.bitmap && r.bitmap.close && r.bitmap.close(), () => {}); };
  if (id) drop(id); else [...imgCache.keys()].forEach(drop);
}
async function loadPhoto(id) {
  if (!id) return null;
  if (!imgCache.has(id)) {
    if (imgCache.size >= IMG_CACHE_MAX) clearImageCache(imgCache.keys().next().value);
    imgCache.set(id, (async () => {
      const blob = await imageLoader(id);
      if (!blob) return null;
      return fromBlob(blob, id);
    })().catch(() => null));
  }
  const r = await imgCache.get(id);
  if (!r) imgCache.delete(id);
  return r;
}
async function fromBlob(blob, id = null) {
  const bitmap = await createImageBitmap(blob);
  return { id, bitmap, w: bitmap.width, h: bitmap.height, info: analyzeBitmap(bitmap) };
}

// ───────────────────────── 사진 지능 (§20-C) ─────────────────────────

const hex3 = (r, g, b) => rgb2hex([r, g, b]);
function rgb2hsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
  return [h, mx ? d / mx : 0, mx];
}

/**
 * 비트맵 분석: 테두리가 흰색·투명·단색이면 flat(=쇼핑몰식 단색 배경), 그 배경을 뺀 사진 영역(trim),
 * 대표색 2개, 추천 레이아웃. 256px 로 줄여 getImageData 한 번만 읽는다.
 */
function analyzeBitmap(bitmap) {
  const maxSide = 256;
  const sc = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const sw = Math.max(1, Math.round(bitmap.width * sc)), sh = Math.max(1, Math.round(bitmap.height * sc));
  const c = makeCanvas(sw, sh);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bitmap, 0, 0, sw, sh);
  const d = g.getImageData(0, 0, sw, sh).data;

  // 1) 테두리 링 분석
  const ring = Math.max(1, Math.round(Math.min(sw, sh) * 0.02));
  let n = 0, transp = 0, white = 0, tr = 0, tg = 0, tb = 0;
  const samples = [];
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      if (x >= ring && x < sw - ring && y >= ring && y < sh - ring) { x = sw - ring - 1; continue; }
      const i = (y * sw + x) * 4; n++;
      if (d[i + 3] < 20) { transp++; continue; }
      const r = d[i], gg = d[i + 1], b = d[i + 2];
      tr += r; tg += gg; tb += b;
      if (r >= 238 && gg >= 238 && b >= 238) white++;
      samples.push(i);
    }
  }
  const opaque = n - transp;
  const avg = opaque ? [tr / opaque, tg / opaque, tb / opaque] : [255, 255, 255];
  let dev = 0;
  for (const i of samples) dev += Math.abs(d[i] - avg[0]) + Math.abs(d[i + 1] - avg[1]) + Math.abs(d[i + 2] - avg[2]);
  dev = samples.length ? dev / (samples.length * 3) : 0;
  const whiteBg = (white + transp) / Math.max(1, n) >= 0.9;
  const flat = whiteBg || (transp / Math.max(1, n) < 0.5 && dev < 10);
  const bgRef = whiteBg ? [255, 255, 255] : avg;
  const bgColor = flat ? hex3(...bgRef) : '#FFFFFF';
  const fgAt = (i) => d[i + 3] >= 20 && (Math.abs(d[i] - bgRef[0]) + Math.abs(d[i + 1] - bgRef[1]) + Math.abs(d[i + 2] - bgRef[2])) > 54;

  // 2) 흰 여백 트리밍
  let trim = { x: 0, y: 0, w: bitmap.width, h: bitmap.height };
  if (flat) {
    const rows = new Uint16Array(sh), cols = new Uint16Array(sw);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) if (fgAt((y * sw + x) * 4)) { rows[y]++; cols[x]++; }
    const first = (arr) => arr.findIndex((v) => v >= 2);
    const last = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] >= 2) return i; return -1; };
    let x0 = first(cols), x1 = last(cols), y0 = first(rows), y1 = last(rows);
    if (x0 >= 0 && y0 >= 0 && x1 > x0 && y1 > y0) {
      const pad = Math.round(0.03 * Math.max(x1 - x0, y1 - y0)) + 1;
      x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(sw - 1, x1 + pad); y1 = Math.min(sh - 1, y1 + pad);
      const area = ((x1 - x0 + 1) * (y1 - y0 + 1)) / (sw * sh);
      if (area >= 0.04 && area < 0.97) trim = { x: Math.floor(x0 / sc), y: Math.floor(y0 / sc), w: Math.min(bitmap.width, Math.ceil((x1 - x0 + 1) / sc)), h: Math.min(bitmap.height, Math.ceil((y1 - y0 + 1) / sc)) };
    }
  }
  const aspect = trim.w / trim.h;

  // 3) 대표색 (흰색 근처·단색 배경 제외)
  const colors = pickColors(d, sw * sh, flat ? bgRef : null);

  // 4) 레이아웃 추천: 단색 배경 제품컷은 세로로 길면 split, 아니면 photo-full. 풍경·연출컷은 비율 0.7 이상이면 photo-full.
  const recommend = flat ? (aspect <= 0.9 ? 'split' : 'photo-full') : (aspect >= 0.7 ? 'photo-full' : 'split');
  return { width: bitmap.width, height: bitmap.height, flat, whiteBg, bgColor, trim, aspect, colors, recommend };
}

function pickColors(d, count, bgRef) {
  const buckets = new Map();
  let used = 0;
  for (let p = 0; p < count; p++) {
    const i = p * 4;
    if (d[i + 3] < 200) continue;
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const mxc = Math.max(r, g, b), mnc = Math.min(r, g, b);
    if (mnc >= 232 && mxc - mnc < 24) continue;                                       // 흰 배경
    if (bgRef && Math.abs(r - bgRef[0]) + Math.abs(g - bgRef[1]) + Math.abs(b - bgRef[2]) < 40) continue;
    const [h, s, v] = rgb2hsv(r, g, b);
    const key = Math.floor(h / 15) * 9 + (s < 0.22 ? 0 : s < 0.6 ? 1 : 2) * 3 + (v < 0.3 ? 0 : v < 0.7 ? 1 : 2);
    let w = 1 + 2 * s;
    if (s < 0.18 || v < 0.15) w *= 0.3;                                               // 회색·검정은 덜 쳐 준다
    const bk = buckets.get(key) || { w: 0, n: 0, r: 0, g: 0, b: 0, s: 0 };
    bk.w += w; bk.n++; bk.r += r; bk.g += g; bk.b += b; bk.s += s;
    buckets.set(key, bk);
    used++;
  }
  if (!used) return [];
  const list = [...buckets.values()].sort((a, b) => b.w - a.w).map((b) => ({ rgb: [b.r / b.n, b.g / b.n, b.b / b.n], n: b.n, s: b.s / b.n }));
  const first = list[0];
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const second = list.slice(1).find((c) => dist(c.rgb, first.rgb) >= 90 && c.n >= used * 0.03 && c.s >= 0.2);
  const c2 = second ? second.rgb : first.rgb.map((v) => v * 0.72);                  // 비슷한 색뿐이면 어두운 변형
  return [rgb2hex(first.rgb), rgb2hex(c2)];
}

/** 이미지 Blob 에서 대표색 2개 ['#RRGGBB','#RRGGBB'] (흰 배경 제외, 외부 라이브러리 없음). 색이 없으면 []. */
export async function extractColors(blob) {
  const bm = await createImageBitmap(blob);
  try { return analyzeBitmap(bm).colors; } finally { bm.close && bm.close(); }
}
/** imageId 로 대표색(캐시 사용). */
export async function extractColorsFromImageId(imageId) {
  const ph = await loadPhoto(imageId);
  return ph ? ph.info.colors : [];
}
/** 사진 분석 결과: {width,height,flat,whiteBg,bgColor,trim:{x,y,w,h},aspect,colors,recommend} */
export async function analyzeImage(blobOrId) {
  if (typeof blobOrId === 'string') { const ph = await loadPhoto(blobOrId); return ph ? ph.info : null; }
  const bm = await createImageBitmap(blobOrId);
  try { return analyzeBitmap(bm); } finally { bm.close && bm.close(); }
}
/** 사진 비율에 맞는 레이아웃 추천: 'split' | 'photo-full' */
export async function recommendLayout(blobOrId) {
  const info = await analyzeImage(blobOrId);
  return info ? info.recommend : null;
}

// ───────────────────────── 레이아웃 자동 배정 (§20-A) ─────────────────────────

/**
 * card.layout 이 있으면 그대로, 없으면 role 규칙으로 배정.
 * opts: {hasImage:boolean, type?:string, total?:number}  (total 이 있으면 마지막 카드는 cta)
 */
export function autoLayout(card, { hasImage = false, type, total } = {}) {
  if (card && card.layout === 'overlay') return 'overlay';          // 사진 캐러셀(mode:'photo') 전용
  if (card && LAYOUTS.includes(card.layout)) return card.layout;
  const role = String((card && card.role) || '');
  const idx = card && Number.isFinite(card.index) ? card.index : 0;
  const slot = card && card.imageSlot;
  const hasImg = !!hasImage && slot !== 'none';
  const lines = String((card && card.body) || '').split('\n').filter((l) => l.trim());
  if (/CTA|행동|마무리/i.test(role)) return 'cta';
  if (total && idx === total - 1 && idx > 0) return 'cta';
  if (lines.length >= 2 && lines.every((l) => l.includes('|'))) return 'table';
  if (/훅|hook/i.test(role) || (idx === 0 && !role)) return hasImg ? 'photo-full' : 'title';
  if (/제품\s*등장/.test(role)) return hasImg ? 'photo-full' : 'title';
  if (/요약표|가격|구성|항목|체크|표/.test(role)) return 'table';
  if (/후기|인용|리뷰/.test(role)) return 'quote';
  if (hasImg && slot === 'side') return 'split';
  if (/특징|비포|애프터|before|after/i.test(role)) return hasImg ? 'split' : 'title';
  if (/핵심|실수|순위|위\b|Q&A|질문|차이|포인트|[①-⑳]|\d/.test(role)) return 'number';
  return hasImg ? (slot === 'hero' ? 'photo-full' : 'split') : 'title';
}

function numberLabelOf(card) {
  if (card.numberLabel) return String(card.numberLabel);
  const role = String(card.role || '');
  const circled = role.match(/[①-⑳]/);
  if (circled) return String(circled[0].charCodeAt(0) - 0x2460 + 1).padStart(2, '0');
  const m = role.match(/(\d+)/);
  if (m) return m[1].padStart(2, '0');
  return String((card.index || 0) + 1).padStart(2, '0');
}

// ───────────────────────── 글자 배치 (줄바꿈·숫자 강조) ─────────────────────────

function setFont(ctx, weight, size, ls = 0) {
  ctx.font = `${weight} ${size}px ${FAMILY}`;
  ctx.letterSpacing = `${ls}px`;
}
const headLs = (size) => -Math.round(size * 0.02 * 10) / 10;

// ── 카드 글씨체 (carousel.font = CARD_FONTS key) ──
// 헤드라인·사진 위 문장 = 고른 글꼴(role 'head'), 카드뉴스 본문 = 같은 글꼴(role 'body'). 단 BODY_PLAIN_FONTS 는 본문만 Pretendard Medium.
// 번호·계정명·[광고]·고지·연출 이미지·진행 점 라벨·칩 등 작은 고정 글자는 항상 Pretendard(setFont, role 'ui').
export const BODY_PLAIN_FONTS = ['pen', 'myeongjo', 'blackhan']; // 검은고딕은 제목용(본문까지 쓰면 너무 무거움 — 2026-10-27 실제 카드 확인)
// 글꼴별 보정(상수 표): scale = 글자 크기 보정 계수(그릴 px = 기준 크기 × scale), lh = 행간 보정, base = 글줄 가운데 맞춤 오프셋(그릴 px 기준 비율),
// lsr = 자간 비율(Pretendard 는 큰 글씨를 살짝 모으는 -0.02). 값은 test/out/render/fonts/ 시트를 눈으로 보고 정했다.
export const FONT_TUNE = {
  pretendard: { scale: 1, lh: 1, base: 0.35, lsr: -0.02 },
  blackhan: { scale: 0.94, lh: 1.0, base: 0.35, lsr: 0 },
  dohyeon: { scale: 1.05, lh: 1.0, base: 0.35, lsr: 0 },
  jua: { scale: 1, lh: 1.0, base: 0.35, lsr: 0 },
  gowun: { scale: 1, lh: 1.0, base: 0.35, lsr: 0 },
  myeongjo: { scale: 0.96, lh: 1.0, base: 0.35, lsr: -0.01 },
  pen: { scale: 1.25, lh: 0.92, base: 0.3, lsr: 0 },
};
let FS = null;   // 지금 그리는 카드의 글꼴 명세. renderCardMeta 가 그리기 직전에 정한다(그리는 동안은 await 없음)
function buildFontSpec(key) {
  const f = fontByKey(key);
  const pre = { fam: FAMILY, weight: 700, ...FONT_TUNE.pretendard };
  if (f.key === 'pretendard') return { key: f.key, head: pre, body: { ...pre, weight: 500 }, item: pre };
  const tune = FONT_TUNE[f.key] || FONT_TUNE.pretendard;
  const own = { fam: `"${f.family}", ${FAMILY}`, weight: f.weight, ...tune };
  const plain = BODY_PLAIN_FONTS.includes(f.key);
  return { key: f.key, head: own, body: plain ? { ...pre, weight: 500 } : own, item: plain ? pre : own };   // item = 표 왼쪽 항목 글자(손글씨·명조는 작게 읽히므로 Pretendard Bold)
}
const specOf = (role) => (FS || (FS = buildFontSpec(DEFAULT_FONT)))[role];
/** role 'head' | 'body' 글꼴로 설정. 반환: 실제 그리는 px(= size × scale) */
function setFontR(ctx, role, size, ls = 0) {
  const sp = specOf(role), px = Math.round(size * sp.scale * 10) / 10;
  ctx.font = `${sp.weight} ${px}px ${sp.fam}`;
  ctx.letterSpacing = `${ls}px`;
  return px;
}
const lsOf = (role, size) => { const sp = specOf(role); return Math.round(size * sp.scale * sp.lsr * 10) / 10; };
const pxOf = (role, size) => size * specOf(role).scale;
const lhOf = (role, size, ratio) => Math.round(size * specOf(role).scale * ratio * specOf(role).lh);
const baseOf = (role, size) => pxOf(role, size) * specOf(role).base;

/** 어절 토큰: 1글자 어절은 다음 어절에, "3 가지" 같은 숫자+단위는 한 덩어리로. 한 덩어리가 줄보다 넓으면 글자 단위로 쪼갠다. */
function tokenize(ctx, text, maxW) {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const merged = [];
  const isSymbol = (w) => !/[\p{L}\p{N}]/u.test(w);       // · / + → 같은 기호만 있는 어절은 앞 어절에 붙인다
  for (let i = 0; i < words.length; i++) {
    let w = words[i];
    if (merged.length && isSymbol(w)) { merged[merged.length - 1] += ' ' + w; continue; }
    while (i < words.length - 1 && ((w.replace(/[^\p{L}\p{N}]/gu, '').length === 1 && !/[!?,]$/.test(w)) || (/^\d[\d,.]*$/.test(w) && [...words[i + 1]].length <= 2))) { w += ' ' + words[++i]; }
    merged.push(w);
  }
  const out = [];
  merged.forEach((w) => {
    if (ctx.measureText(w).width <= maxW) { out.push({ t: w, sp: out.length > 0 }); return; }
    let cur = '', first = true;
    for (const ch of w) {
      if (cur && ctx.measureText(cur + ch).width > maxW) { out.push({ t: cur, sp: first && out.length > 0 }); first = false; cur = ch; } else cur += ch;
    }
    if (cur) out.push({ t: cur, sp: first && out.length > 0 });
  });
  return out;
}

/** 한 문단을 어절 경계에서 줄바꿈. 필요한 줄 수 중 가장 적은 줄 수로, 줄 길이 제곱합이 최소(=길이 차 최소)가 되게 DP. */
function wrapPara(ctx, p, maxW) {
  if (ctx.measureText(p).width <= maxW) return [p];
  const tk = tokenize(ctx, p, maxW);
  const n = tk.length;
  const wd = tk.map((t) => ctx.measureText(t.t).width);
  const spW = ctx.measureText(' ').width;
  const lw = (i, j) => { let s = 0; for (let k = i; k < j; k++) { s += wd[k]; if (k > i && tk[k].sp) s += spW; } return s; };
  const text = (i, j) => { let s = tk[i].t; for (let k = i + 1; k < j; k++) s += (tk[k].sp ? ' ' : '') + tk[k].t; return s; };
  for (let K = 2; K <= Math.min(n, 8); K++) {
    const dp = Array.from({ length: K + 1 }, () => new Array(n + 1).fill(Infinity));
    const from = Array.from({ length: K + 1 }, () => new Array(n + 1).fill(-1));
    dp[0][0] = 0;
    for (let k = 1; k <= K; k++) {
      for (let j = k; j <= n; j++) {
        for (let i = k - 1; i < j; i++) {
          if (dp[k - 1][i] === Infinity) continue;
          const w = lw(i, j);
          if (w > maxW) continue;
          let cost = w * w;
          if (k > 1 && j - i === 1 && [...tk[i].t].length <= 2) cost += maxW * maxW * 0.3;   // 둘째 줄 이후 한두 글자만 달랑 남는 것 방지
          const c = dp[k - 1][i] + cost;
          if (c < dp[k][j]) { dp[k][j] = c; from[k][j] = i; }
        }
      }
    }
    if (dp[K][n] < Infinity) {
      const lines = []; let j = n;
      for (let k = K; k >= 1; k--) { const i = from[k][j]; lines.unshift(text(i, j)); j = i; }
      return lines;
    }
  }
  const lines = []; let cur = '';       // 도달 불가(방어): 단순 탐욕
  tk.forEach((t) => { const nx = cur ? cur + (t.sp ? ' ' : '') + t.t : t.t; if (cur && ctx.measureText(nx).width > maxW) { lines.push(cur); cur = t.t; } else cur = nx; });
  if (cur) lines.push(cur);
  return lines;
}
function wrapText(ctx, text, maxW) {
  const out = [];
  String(text || '').split('\n').forEach((para) => { const p = para.trim(); if (p) out.push(...wrapPara(ctx, p, maxW)); });
  return out;
}

function splitNumbers(line) {
  const segs = []; let last = 0;
  line.replace(NUM_RE, (m, off) => { if (off > last) segs.push({ t: line.slice(last, off), hl: false }); segs.push({ t: m, hl: true }); last = off + m.length; return m; });
  if (last < line.length) segs.push({ t: line.slice(last), hl: false });
  return segs.length ? segs : [{ t: line, hl: false }];
}

// ───────────────────────── 렌더 컨텍스트 R ─────────────────────────

function frameOf(S) {
  const footerY = S.h - S.bottom - 32;
  return {
    mx: MARGIN_X, w: S.w - 2 * MARGIN_X,
    headerY: S.top + 20, chipTop: S.top + 76, chipH: 56, contentTop: S.top + 170,
    footerY, slotY: footerY - 56, contentBottom: footerY - 96,
  };
}

function box(R, tag, x0, y0, x1, y1) { if (!R.textless) R.boxes.push({ tag, x0, y0, x1, y1 }); }
const pad2 = (n) => String(n).padStart(2, '0');

/** 한 줄 그리기(숫자 강조 포함). 반환: 그린 폭 */
function drawLine(R, line, x, baseline, { color, hl, align = 'left', tag, size }) {
  const ctx = R.ctx;
  const segs = hl ? splitNumbers(line) : [{ t: line, hl: false }];
  const ws = segs.map((s) => ctx.measureText(s.t).width);
  const total = ws.reduce((a, b) => a + b, 0);
  let sx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
  const x0 = sx;
  ctx.textAlign = 'left';
  segs.forEach((s, i) => { ctx.fillStyle = s.hl ? hl : color; ctx.fillText(s.t, sx, baseline); sx += ws[i]; });
  if (tag) box(R, tag, x0, baseline - size * 0.82, x0 + total, baseline + size * 0.22);
  return total;
}

/**
 * 헤드라인+강조선+본문 한 덩어리의 크기를 정한다. 헤드라인은 큰 크기부터, 본문은 44부터 내려가며
 * 줄 수·높이가 들어가는 첫 조합을 고른다. 안 들어가면 가장 작은 크기로 강제하고 overflow=true.
 */
function planText(R, { w, avail, headSizes = HEAD_SIZES, headCap, bodySizes = BODY_SIZES, bodyCap = 3, head = '', body = '', headLh = 1.22, bodyLh = 1.5 }) {
  const ctx = R.ctx;
  const headStr = String(head || '').trim();
  const srcBody = String(body || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const cap = headCap || ((s) => (s >= 92 ? 2 : s >= 66 ? 3 : 4));
  const fitHead = (size) => {
    if (!headStr) return { size, lines: [], lh: 0, fits: true };
    setFontR(ctx, 'head', size, lsOf('head', size));
    const lines = wrapText(ctx, headStr, w);
    return { size, lines, lh: lhOf('head', size, headLh), fits: lines.length <= cap(size) && lines.every((l) => ctx.measureText(l).width <= w + 0.5) };
  };
  const fitBody = (size) => {
    if (!srcBody.length) return { size, lines: [], lh: 0, fits: true };
    setFontR(ctx, 'body', size, 0);
    const lines = []; srcBody.forEach((l) => lines.push(...wrapText(ctx, l, w)));
    return { size, lines, lh: lhOf('body', size, bodyLh), fits: lines.length <= Math.max(bodyCap, srcBody.length) && lines.every((l) => ctx.measureText(l).width <= w + 0.5) };
  };
  const total = (h, b) => (headStr ? h.lines.length * h.lh + 28 + 10 : 0) + (srcBody.length ? (headStr ? 36 : 0) + b.lines.length * b.lh : 0);
  for (const hs of headSizes) {
    const h = fitHead(hs);
    if (!h.fits) continue;
    for (const bs of bodySizes) {
      const b = fitBody(bs);
      if (!b.fits) continue;
      const t = total(h, b);
      if (t <= avail) return { head: h, body: b, total: t, w, overflow: false };
    }
  }
  const h = fitHead(headSizes[headSizes.length - 1]);
  const b = fitBody(bodySizes[bodySizes.length - 1]);
  const t = total(h, b);
  const widthOver = [...h.lines.map((l) => (setFontR(ctx, 'head', h.size, lsOf('head', h.size)), ctx.measureText(l).width)), ...b.lines.map((l) => (setFontR(ctx, 'body', b.size, 0), ctx.measureText(l).width))].some((x) => x > w + 0.5);
  const why = [];
  if (t > avail) why.push(`높이 ${Math.round(t)}px > ${Math.round(avail)}px`);
  if (widthOver) why.push('폭 초과');
  if (headStr && h.lines.length > cap(h.size)) why.push(`헤드라인 ${h.lines.length}줄(최대 ${cap(h.size)}줄)`);
  if (srcBody.length && b.lines.length > Math.max(bodyCap, srcBody.length)) why.push(`본문 ${b.lines.length}줄(최대 ${Math.max(bodyCap, srcBody.length)}줄)`);
  R.meta.overflow = true;
  R.meta.overflowReasons.push(`글이 너무 길어 가장 작은 크기로도 규칙을 못 맞춤: ${why.join(', ')} (헤드라인 ${h.size}px, 본문 ${b.size}px)`);
  return { head: h, body: b, total: t, w, overflow: true };
}

/** planText 결과를 그린다. y = 덩어리 윗변. x = 왼쪽 정렬이면 왼쪽 끝, 가운데 정렬이면 가운데. 반환: 아랫변 y */
function drawPlan(R, plan, x, y, { align = 'left', T = R.T, tagPrefix = '' } = {}) {
  const ctx = R.ctx;
  if (R.textless) return y + plan.total;
  let yy = y;
  const { head, body } = plan;
  if (head.lines.length) {
    setFontR(ctx, 'head', head.size, lsOf('head', head.size));
    head.lines.forEach((l) => { drawLine(R, l, x, yy + head.lh / 2 + baseOf('head', head.size), { color: T.head, hl: T.accentText, align, tag: tagPrefix + 'head', size: pxOf('head', head.size) }); yy += head.lh; });
    yy += 28;
    ctx.fillStyle = T.accent;
    const bx = align === 'center' ? x - 60 : x;
    ctx.beginPath(); ctx.roundRect(bx, yy, 120, 10, 5); ctx.fill();
    box(R, tagPrefix + 'bar', bx, yy, bx + 120, yy + 10);
    yy += 10;
  }
  if (body.lines.length) {
    if (head.lines.length) yy += 36;
    setFontR(ctx, 'body', body.size, 0);
    body.lines.forEach((l) => { drawLine(R, l, x, yy + body.lh / 2 + baseOf('body', body.size), { color: T.body, align, tag: tagPrefix + 'body', size: pxOf('body', body.size) }); yy += body.lh; });
  }
  return yy;
}

// ───────────────────────── 사진 그리기 ─────────────────────────

function drawPhoto(ctx, ph, rect, mode, { trim = true } = {}) {
  const s = trim && ph.info.flat ? ph.info.trim : { x: 0, y: 0, w: ph.w, h: ph.h };
  const k = mode === 'cover' ? Math.max(rect.w / s.w, rect.h / s.h) : Math.min(rect.w / s.w, rect.h / s.h);
  const dw = s.w * k, dh = s.h * k;
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  if (mode === 'cover') {
    ctx.save(); ctx.beginPath(); ctx.rect(rect.x, rect.y, rect.w, rect.h); ctx.clip();
    ctx.drawImage(ph.bitmap, s.x, s.y, s.w, s.h, rect.x + (rect.w - dw) / 2, rect.y + (rect.h - dh) / 2, dw, dh);
    ctx.restore();
  } else {
    ctx.drawImage(ph.bitmap, s.x, s.y, s.w, s.h, rect.x + (rect.w - dw) / 2, rect.y + (rect.h - dh) / 2, dw, dh);
  }
}
/** 둥근 패널 + 사진. 단색(흰) 배경 사진이면 패널을 사진 배경색으로 칠해 경계를 녹인다. */
function drawPhotoPanel(R, ph, rect, radius) {
  const { ctx } = R;
  ctx.save();
  ctx.beginPath(); ctx.roundRect(rect.x, rect.y, rect.w, rect.h, radius); ctx.clip();
  ctx.fillStyle = ph.info.flat ? ph.info.bgColor : '#FFFFFF';
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  if (ph.info.flat) { const pad = Math.round(Math.min(rect.w, rect.h) * 0.06); drawPhoto(ctx, ph, { x: rect.x + pad, y: rect.y + pad, w: rect.w - 2 * pad, h: rect.h - 2 * pad }, 'contain'); }
  else drawPhoto(ctx, ph, rect, 'cover');
  ctx.restore();
}

// ───────────────────────── 공통 요소: 배경·머리·칩·바닥 ─────────────────────────

function drawBackground(R) {
  const { ctx, W, H, T, carousel } = R;
  ctx.fillStyle = T.bg; ctx.fillRect(0, 0, W, H);
  if (!carousel.panorama || R.total < 2) return;
  // 파노라마: 카드 N장이 하나의 긴 배경(폭 W*N)을 나눠 가진다. offsetX = idx/(N-1) * (bgW - W)
  const N = R.total, bgW = W * N, off = (R.idx / (N - 1)) * (bgW - W);
  ctx.save(); ctx.translate(-off, 0);
  const g = ctx.createLinearGradient(0, 0, bgW, 0);
  g.addColorStop(0, rgba(T.accent, T.darkBg ? 0.16 : 0.22)); g.addColorStop(0.5, rgba(T.head, 0.06)); g.addColorStop(1, rgba(T.accent, T.darkBg ? 0.16 : 0.22));
  ctx.fillStyle = g; ctx.fillRect(0, 0, bgW, H);
  const dot = T.darkBg ? 'rgba(255,255,255,0.07)' : rgba(T.accent, 0.16);
  const m = Math.round(N * 1.5);
  for (let i = 0; i < m; i++) {
    const cx = (bgW * (i + 0.5)) / m, cy = H * (0.18 + 0.64 * (((i * 53) % 100) / 100)), r = 190 + 130 * ((i * 37) % 3);
    ctx.fillStyle = dot; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.strokeStyle = rgba(T.accent, 0.45); ctx.lineWidth = 6; ctx.beginPath();
  for (let x = 0; x <= bgW; x += 20) { const y = H * 0.84 + Math.sin((x / bgW) * Math.PI * 2 * N * 0.75) * 40; if (x) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
  ctx.stroke();
  ctx.restore();
}

/** 번호·계정명·역할 칩 */
function drawTop(R, ink) {
  if (R.textless) return;
  const { ctx, W, F, card, idx, total } = R;
  const by = F.headerY + 12;
  setFont(ctx, 700, 34, 0);
  const cur = pad2(idx + 1), rest = ` / ${pad2(total)}`;
  ctx.textAlign = 'left'; ctx.fillStyle = ink.head; ctx.fillText(cur, F.mx, by);
  const cw = ctx.measureText(cur).width;
  setFont(ctx, 500, 34, 0); ctx.fillStyle = ink.faint; ctx.fillText(rest, F.mx + cw, by);
  const numRight = F.mx + cw + ctx.measureText(rest).width;
  box(R, 'num', F.mx, by - 28, numRight, by + 8);
  const acct = String(R.carousel.accountName || '').trim();
  let acctLeft = W - F.mx;
  if (acct) {
    let size = 34;
    setFont(ctx, 500, size, 0);
    while (ctx.measureText(acct).width > 430 && size > 22) { size -= 2; setFont(ctx, 500, size, 0); }
    ctx.textAlign = 'right'; ctx.fillStyle = ink.muted; ctx.fillText(acct, W - F.mx, by);
    acctLeft = W - F.mx - ctx.measureText(acct).width;
    box(R, 'acct', acctLeft, by - size * 0.82, W - F.mx, by + 8);
  }
  if (R.ad && (R.ad.position === 'tl' || R.ad.position === 'tr')) {       // 광고 표기: 왼쪽 위 = 번호 오른쪽, 오른쪽 위 = 계정명 왼쪽
    const left = R.ad.position === 'tl';
    drawAdLabelR(R, { x: left ? numRight + 28 : acctLeft - 28, baseline: Math.max(by, R.S.top + Math.round(AD_SIZES[R.ad.size] * 1.06) + 2), align: left ? 'left' : 'right' });
  }
  const role = String(card.role || '').trim();
  if (role) {
    setFont(ctx, 700, 30, 0);
    const tw = Math.min(ctx.measureText(role).width, F.w - 56);
    const cw2 = tw + 56;
    ctx.fillStyle = R.T.accent; ctx.beginPath(); ctx.roundRect(F.mx, F.chipTop, cw2, F.chipH, F.chipH / 2); ctx.fill();
    ctx.fillStyle = R.T.chipFg; ctx.textAlign = 'left'; ctx.fillText(role, F.mx + 28, F.chipTop + F.chipH / 2 + 10.5, tw);
    box(R, 'chip', F.mx, F.chipTop, F.mx + cw2, F.chipTop + F.chipH);
  }
}

/** 진행 점·브릿지·밀어서 넘기기·마지막 카드 문구·고지·연출 이미지·로고 */
function drawBottom(R, ink) {
  if (R.textless) return;
  const { ctx, W, F, card, idx, total, carousel } = R;
  // 진행 점
  const n = total, d = n > 12 ? 8 : 12, gap = n > 12 ? 10 : 14, aw = n > 12 ? 24 : 36;
  const dotsW = (n - 1) * (d + gap) + aw;
  let dx = W / 2 - dotsW / 2;
  for (let i = 0; i < n; i++) {
    const cur = i === idx, w = cur ? aw : d;
    ctx.fillStyle = cur ? R.T.accent : ink.faint;
    ctx.beginPath(); ctx.roundRect(dx, F.footerY - d / 2, w, d, d / 2); ctx.fill();
    dx += w + gap;
  }
  // 슬롯 줄: 브릿지(왼쪽) · 밀어서 넘기기(오른쪽) · 파트너스 고지(가운데, 마지막 카드)
  const isLast = idx === total - 1 && total > 1;
  const bridge = String(card.bridge || '').trim();
  const hint = idx === 0 && total > 1 ? '밀어서 넘기기 →' : '';
  const notice = isLast && carousel.hasPartnersLink ? '쿠팡 파트너스 수수료 수령' : '';
  const slotY = F.slotY;
  let hintW = 0;
  if (hint) {
    setFont(ctx, 700, 28, 0); ctx.textAlign = 'right'; ctx.fillStyle = ink.accentText;
    hintW = ctx.measureText(hint).width;
    ctx.fillText(hint, W - F.mx, slotY + 10); box(R, 'hint', W - F.mx - hintW, slotY - 14, W - F.mx, slotY + 14);
  }
  if (notice) {
    setFont(ctx, 500, 24, 0); ctx.textAlign = 'center'; ctx.fillStyle = ink.muted;
    ctx.fillText(notice, W / 2, slotY + 8); box(R, 'notice', W / 2 - ctx.measureText(notice).width / 2, slotY - 14, W / 2 + ctx.measureText(notice).width / 2, slotY + 12);
  }
  if (bridge) {
    const by = notice ? slotY - 44 : slotY;
    let size = 30;
    const maxW = F.w - (hint ? hintW + 40 : 0);
    setFont(ctx, 500, size, 0);
    const text = `→ ${bridge}`;
    while (ctx.measureText(text).width > maxW && size > 22) { size -= 2; setFont(ctx, 500, size, 0); }
    if (ctx.measureText(text).width > maxW) { R.meta.overflow = true; R.meta.overflowReasons.push('브릿지 문장이 한 줄을 넘음'); }
    ctx.textAlign = 'left'; ctx.fillStyle = ink.muted; ctx.fillText(text, F.mx, by + size * 0.35);
    box(R, 'bridge', F.mx, by - size * 0.5, F.mx + ctx.measureText(text).width, by + size * 0.5);
  }
  // 연출 이미지 표시 (바닥 줄 왼쪽)
  if (R.generated) {
    setFont(ctx, 500, 24, 0); ctx.textAlign = 'left'; ctx.fillStyle = ink.muted;
    const label = R.carousel.imageDisclosureText || '연출 이미지';
    ctx.fillText(label, F.mx, F.footerY + 8); box(R, 'gen', F.mx, F.footerY - 14, F.mx + ctx.measureText(label).width, F.footerY + 12);
  }
  if (R.ad && (R.ad.position === 'bl' || R.ad.position === 'br')) {       // 광고 표기: 진행 점·고지 줄 위
    const left = R.ad.position === 'bl';
    drawAdLabelR(R, { x: left ? F.mx : W - F.mx, baseline: R.adY, align: left ? 'left' : 'right' });
  }
  // 로고 (우하단)
  if (R.logo) {
    const lg = R.logo, k = Math.min(200 / lg.w, 64 / lg.h, 1.5), lw = lg.w * k, lh = lg.h * k;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(lg.bitmap, W - F.mx - lw, F.footerY - lh / 2, lw, lh);
    box(R, 'logo', W - F.mx - lw, F.footerY - lh / 2, W - F.mx, F.footerY + lh / 2);
  }
}

function drawAdLabelR(R, at) {
  const r = drawAdLabel(R.ctx, R.scale, { w: R.cw, h: R.ch }, R.ad, at);
  box(R, 'ad', r.box.x0, r.box.y0, r.box.x1, r.box.y1);
  if (r.low) pushUnique(R.meta.lowContrast, 'adLabel');
}

/** 마지막 카드 CTA 문구(cta 레이아웃이 아닐 때): 내용 영역 맨 아래 강조색 한 줄 */
function drawCtaLine(R, ink) {
  if (R.textless || !R.ctaLine) return;
  const { ctx, W, F } = R;
  let size = 38;
  setFontR(ctx, 'head', size, 0);
  while (ctx.measureText(R.ctaLine).width > F.w && size > 24) { size -= 2; setFontR(ctx, 'head', size, 0); }
  ctx.textAlign = 'center'; ctx.fillStyle = ink.accentText;
  const y = R.ctaY;
  ctx.fillText(R.ctaLine, W / 2, y + baseOf('head', size));
  box(R, 'ctaline', W / 2 - ctx.measureText(R.ctaLine).width / 2, y - size * 0.5, W / 2 + ctx.measureText(R.ctaLine).width / 2, y + size * 0.5);
}

/** 다음 카드 헤드라인 첫 3글자를 오른쪽 가장자리에 살짝 잘리게 (peek) */
function drawPeek(R, color) {
  if (R.textless || !R.carousel.peek || !R.next) return;
  const { ctx, W, F } = R;
  const t = [...String(R.next.headline || '').replace(/\s+/g, '')].slice(0, 3).join('');
  if (!t) return;
  setFont(ctx, 700, 96, -2);
  ctx.textAlign = 'left'; ctx.fillStyle = color;
  const y = F.contentTop + (F.contentBottom - F.contentTop) * 0.5;
  ctx.fillText(t, W - 54, y + 34);
}

// ───────────────────────── 레이아웃 7종 ─────────────────────────

function availBox(R) { return { top: R.F.contentTop, bottom: R.cb, h: R.cb - R.F.contentTop }; }

/** hero 사진을 본문 아래 전체 폭 둥근 패널로(title·number·quote·cta 에서) */
function heroReserve(R, availH) {
  if (!R.photo || R.card.imageSlot !== 'hero') return 0;
  return Math.round(Math.min(availH * 0.4, 440));
}
function drawHero(R, ph, h) {
  const { F } = R;
  drawPhotoPanel(R, ph, { x: F.mx, y: R.cb - h, w: F.w, h }, 44);
}

function layoutTitle(R) {
  const { F, W, ctx } = R;
  const a = availBox(R);
  const hero = heroReserve(R, a.h);
  const avail = a.h - (hero ? hero + 40 : 0);
  const plan = planText(R, { w: F.w, avail, headSizes: [120, 108, 92, 78, 66, 56], head: R.card.headline, body: R.card.body });
  const y = a.top + Math.max(0, (avail - plan.total) * 0.45);
  drawPlan(R, plan, W / 2, y, { align: 'center' });
  if (hero) drawHero(R, R.photo, hero);
  R.meta.headlineSize = plan.head.size;
  R.meta.headlineLines = plan.head.lines.length;
  R.meta.bodySize = plan.body.size;
}

/** 글 왼쪽 정렬·세로 중앙 근처 (split·photo-full 에 사진이 없을 때의 대체 배치 겸용) */
function layoutPlain(R, w = R.F.w, x = R.F.mx) {
  const a = availBox(R);
  const plan = planText(R, { w, avail: a.h, head: R.card.headline, body: R.card.body });
  drawPlan(R, plan, x, a.top + Math.max(0, (a.h - plan.total) * 0.42), { align: 'left' });
  R.meta.headlineSize = plan.head.size; R.meta.headlineLines = plan.head.lines.length; R.meta.bodySize = plan.body.size;
}

function layoutPhotoFull(R) {
  const { ctx, W, H, F } = R;
  const ph = R.photo;
  const flat = ph.info.flat;
  const photoTop = F.chipTop + F.chipH + 16;
  // 글 덩어리: 아래쪽(사진 영역이 최소 높이를 갖도록 위쪽 한계 = 사진 시작 + 280)
  const plan = planText(R, { w: F.w, avail: R.cb - (photoTop + 280 + 130), headSizes: flat ? [92, 78, 66, 56] : [108, 92, 78, 66, 56], head: R.card.headline, body: R.card.body });
  const textTop = R.cb - plan.total;
  const gradStart = textTop - 130;           // 여기서부터 어두워지고, 글은 그라데이션이 충분히 진해진 뒤에 시작
  if (flat) {
    ctx.fillStyle = ph.info.bgColor; ctx.fillRect(0, 0, W, H);
    drawPhoto(ctx, ph, { x: 90, y: photoTop, w: W - 180, h: gradStart - 10 - photoTop }, 'contain');
  } else {
    drawPhoto(ctx, ph, { x: 0, y: 0, w: W, h: H }, 'cover', { trim: false });
    const gt = ctx.createLinearGradient(0, 0, 0, F.contentTop + 40);
    gt.addColorStop(0, 'rgba(0,0,0,0.42)'); gt.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gt; ctx.fillRect(0, 0, W, F.contentTop + 40);
  }
  const len = H - gradStart;
  const g = ctx.createLinearGradient(0, gradStart, 0, H);
  g.addColorStop(0, 'rgba(15,23,42,0)'); g.addColorStop(Math.min(0.9, 150 / len), 'rgba(15,23,42,0.86)'); g.addColorStop(1, 'rgba(15,23,42,0.95)');
  ctx.fillStyle = g; ctx.fillRect(0, gradStart, W, len);
  drawPlan(R, plan, F.mx, textTop, { align: 'left', T: R.TonPhoto });
  R.meta.headlineSize = plan.head.size; R.meta.headlineLines = plan.head.lines.length; R.meta.bodySize = plan.body.size;
}

function layoutSplit(R) {
  const { ctx, W, F } = R;
  const px = Math.round(W * 0.55), pw = W - px;
  const panel = { x: px, y: F.chipTop, w: pw, h: R.cb + 10 - F.chipTop };
  // 오른쪽 가장자리까지 붙는 패널(왼쪽 모서리만 둥글게)
  ctx.save();
  ctx.beginPath(); ctx.roundRect(panel.x, panel.y, panel.w, panel.h, [48, 0, 0, 48]); ctx.clip();
  ctx.fillStyle = R.photo.info.flat ? R.photo.info.bgColor : '#FFFFFF';
  ctx.fillRect(panel.x, panel.y, panel.w, panel.h);
  if (R.photo.info.flat) { const pad = 34; drawPhoto(ctx, R.photo, { x: panel.x + pad, y: panel.y + pad, w: panel.w - 2 * pad - 20, h: panel.h - 2 * pad }, 'contain'); }
  else drawPhoto(ctx, R.photo, panel, 'cover');
  ctx.restore();
  const colW = px - F.mx - 40;
  const a = availBox(R);
  const plan = planText(R, { w: colW, avail: a.h, headSizes: [84, 72, 64, 56, 48], headCap: (s) => (s >= 72 ? 3 : 4), bodySizes: [40, 36, 32, 30, 28], bodyCap: 4, head: R.card.headline, body: R.card.body });
  drawPlan(R, plan, F.mx, a.top + Math.max(0, (a.h - plan.total) * 0.35), { align: 'left' });
  R.meta.headlineSize = plan.head.size; R.meta.headlineLines = plan.head.lines.length; R.meta.bodySize = plan.body.size;
}

function layoutNumber(R) {
  const { ctx, F } = R;
  const a = availBox(R);
  const hero = heroReserve(R, a.h);
  const label = numberLabelOf(R.card);
  let ns = 220;
  setFont(ctx, 700, ns, -6);
  while (ctx.measureText(label).width > F.w && ns > 120) { ns -= 10; setFont(ctx, 700, ns, -6); }
  const numH = Math.round(ns * 0.68);
  const avail = a.h - numH - 16 - (hero ? hero + 40 : 0);
  const plan = planText(R, { w: F.w, avail, head: R.card.headline, body: R.card.body });
  const group = numH + 16 + plan.total;
  const y0 = a.top + Math.max(0, (a.h - (hero ? hero + 40 : 0) - group) * 0.3);
  if (!R.textless) {
    setFont(ctx, 700, ns, -6);
    ctx.textAlign = 'left'; ctx.fillStyle = rgba(R.T.darkBg ? R.T.accent : R.T.accentText, R.T.darkBg ? 0.3 : 0.32);
    ctx.fillText(label, F.mx - 8, y0 + numH);
  }
  drawPlan(R, plan, F.mx, y0 + numH + 16, { align: 'left' });
  if (hero) drawHero(R, R.photo, hero);
  R.meta.headlineSize = plan.head.size; R.meta.headlineLines = plan.head.lines.length; R.meta.bodySize = plan.body.size;
}

function layoutQuote(R) {
  const { ctx, F } = R;
  const a = availBox(R);
  const hero = heroReserve(R, a.h);
  const src = R.card.source ? String(R.card.source) : (R.carousel.type === 'reviews' || /후기/.test(String(R.card.role || '')) ? '구매자 후기 중' : '');
  const markH = 130;
  const avail = a.h - markH - (src ? 70 : 0) - (hero ? hero + 40 : 0);
  const plan = planText(R, { w: F.w - 20, avail, headSizes: [84, 76, 68, 60, 54], headCap: () => 4, bodySizes: [40, 36, 32, 30], head: R.card.headline, body: R.card.body });
  const group = markH + plan.total + (src ? 70 : 0);
  const y0 = a.top + Math.max(0, (a.h - (hero ? hero + 40 : 0) - group) * 0.35);
  if (!R.textless) {
    setFont(ctx, 700, 300, 0);
    ctx.textAlign = 'left'; ctx.fillStyle = rgba(R.T.darkBg ? R.T.accent : R.T.accentText, 0.45);
    ctx.fillText('“', F.mx - 6, y0 + 215);
  }
  const yEnd = drawPlan(R, plan, F.mx + 10, y0 + markH, { align: 'left' });
  if (src && !R.textless) {
    setFont(ctx, 500, 30, 0); ctx.textAlign = 'left'; ctx.fillStyle = R.T.muted;
    ctx.fillText('— ' + src, F.mx + 10, yEnd + 52);
    box(R, 'source', F.mx + 10, yEnd + 28, F.mx + 10 + ctx.measureText('— ' + src).width, yEnd + 62);
  }
  if (hero) drawHero(R, R.photo, hero);
  R.meta.headlineSize = plan.head.size; R.meta.headlineLines = plan.head.lines.length; R.meta.bodySize = plan.body.size;
}

function layoutTable(R) {
  const { ctx, F } = R;
  const a = availBox(R);
  const plan = planText(R, { w: F.w, avail: a.h * 0.36, headSizes: [84, 72, 64, 56, 48], headCap: () => 2, head: R.card.headline, body: '' });
  const rowsSrc = String(R.card.body || '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (rowsSrc.length > 6) { R.meta.overflow = true; R.meta.overflowReasons.push('표 줄 수 6줄 초과'); }
  const rows = rowsSrc.slice(0, 8).map((l) => {
    const i = l.indexOf('|');
    if (i >= 0) return { kind: 'kv', a: l.slice(0, i).trim(), b: l.slice(i + 1).trim() };
    return { kind: 'check', a: l.replace(/^[☐☑✔✓□■\-•·]\s*/, '').trim() };
  });
  const tableAvail = a.h - plan.total - 44;
  const PAD = 36, GAP = 28, BOX = 40;
  let chosen = null;
  for (const fs of [40, 36, 34, 32, 30, 28, 26]) {
    setFontR(ctx, 'item', fs, 0);
    const anyKv = rows.some((r) => r.kind === 'kv');
    const itemW = anyKv ? Math.min(330, Math.max(150, Math.max(...rows.filter((r) => r.kind === 'kv').map((r) => ctx.measureText(r.a).width)) + 6)) : 0;
    const contentW = F.w - 2 * PAD - itemW - (anyKv ? GAP : 0);
    const lhh = Math.round(fs * 1.36 * Math.max(specOf('item').scale * specOf('item').lh, specOf('body').scale * specOf('body').lh));
    let ok = true, total = 0;
    const laid = rows.map((r) => {
      let aLines, bLines;
      if (r.kind === 'kv') { setFontR(ctx, 'item', fs, 0); aLines = wrapText(ctx, r.a, itemW); setFontR(ctx, 'body', fs, 0); bLines = wrapText(ctx, r.b, contentW); }
      else { setFontR(ctx, 'body', fs, 0); aLines = wrapText(ctx, r.a, F.w - 2 * PAD - BOX - GAP); bLines = []; }
      const nl = Math.max(aLines.length, bLines.length, 1);
      if (nl > 2) ok = false;
      const h = Math.max(nl * lhh + 40, 92);
      total += h;
      return { ...r, aLines, bLines, h };
    });
    chosen = { fs, itemW, contentW, lhh, laid, total, ok };
    if (ok && total <= tableAvail) break;
    chosen.fail = true;
  }
  if (chosen.fail || chosen.total > tableAvail) { R.meta.overflow = true; R.meta.overflowReasons.push(`표가 영역을 넘음(필요 ${chosen.total}px > ${Math.round(tableAvail)}px)`); }
  const group = plan.total + 44 + chosen.total;
  const y0 = a.top + Math.max(0, (a.h - group) * 0.3);
  drawPlan(R, plan, F.mx, y0, { align: 'left' });
  const ty = y0 + plan.total + 44;
  if (R.textless) return;
  ctx.fillStyle = R.T.panel;
  ctx.beginPath(); ctx.roundRect(F.mx, ty, F.w, chosen.total, 36); ctx.fill();
  ctx.strokeStyle = R.T.line; ctx.lineWidth = 2; ctx.stroke();
  let yy = ty;
  chosen.laid.forEach((r, ri) => {
    if (ri > 0) { ctx.strokeStyle = R.T.line; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(F.mx + PAD, yy); ctx.lineTo(F.mx + F.w - PAD, yy); ctx.stroke(); }
    const mid = yy + r.h / 2;
    if (r.kind === 'kv') {
      setFontR(ctx, 'item', chosen.fs, 0);
      r.aLines.forEach((l, i) => { const by = mid + (i - (r.aLines.length - 1) / 2) * chosen.lhh + baseOf('item', chosen.fs); drawLine(R, l, F.mx + PAD, by, { color: R.T.head, align: 'left', tag: 'cell', size: pxOf('item', chosen.fs) }); });
      setFontR(ctx, 'body', chosen.fs, 0);
      r.bLines.forEach((l, i) => { const by = mid + (i - (r.bLines.length - 1) / 2) * chosen.lhh + baseOf('body', chosen.fs); drawLine(R, l, F.mx + PAD + chosen.itemW + GAP, by, { color: R.T.body, hl: R.T.accentText, align: 'left', tag: 'cell', size: pxOf('body', chosen.fs) }); });
    } else {
      ctx.strokeStyle = R.T.accent; ctx.lineWidth = 5; ctx.beginPath(); ctx.roundRect(F.mx + PAD, mid - BOX / 2, BOX, BOX, 10); ctx.stroke();
      setFontR(ctx, 'body', chosen.fs, 0);
      r.aLines.forEach((l, i) => { const by = mid + (i - (r.aLines.length - 1) / 2) * chosen.lhh + baseOf('body', chosen.fs); drawLine(R, l, F.mx + PAD + BOX + GAP, by, { color: R.T.body, hl: R.T.accentText, align: 'left', tag: 'cell', size: pxOf('body', chosen.fs) }); });
    }
    yy += r.h;
  });
  R.meta.headlineSize = plan.head.size; R.meta.headlineLines = plan.head.lines.length; R.meta.bodySize = chosen.fs;
}

function layoutCta(R) {
  const { ctx, W, F } = R;
  const a = availBox(R);
  const hero = heroReserve(R, a.h);
  const pillText = String(R.card.cta || '').trim();
  const acct = String(R.carousel.accountName || '').trim();
  const pillH = 120, acctH = acct ? 52 + 44 : 0, pillBlock = pillText ? pillH + 56 : 0;
  const avail = a.h - pillBlock - acctH - (hero ? hero + 40 : 0);
  const plan = planText(R, { w: F.w, avail, headSizes: [108, 92, 78, 66, 56], bodySizes: [40, 36, 32, 30], head: R.card.headline, body: R.card.body });
  const group = plan.total + pillBlock + acctH;
  const y0 = a.top + Math.max(0, (a.h - (hero ? hero + 40 : 0) - group) * 0.45);
  let y = drawPlan(R, plan, W / 2, y0, { align: 'center' });
  if (pillText) {
    y += 56;
    let size = 50;
    setFontR(ctx, 'head', size, 0);
    while (ctx.measureText(pillText).width + 120 > F.w && size > 28) { size -= 2; setFontR(ctx, 'head', size, 0); }
    const pw = Math.min(F.w, ctx.measureText(pillText).width + 120);
    if (!R.textless) {
      ctx.fillStyle = R.T.accent; ctx.beginPath(); ctx.roundRect(W / 2 - pw / 2, y, pw, pillH, pillH / 2); ctx.fill();
      ctx.fillStyle = R.T.chipFg; ctx.textAlign = 'center'; ctx.fillText(pillText, W / 2, y + pillH / 2 + baseOf('head', size));
      box(R, 'pill', W / 2 - pw / 2, y, W / 2 + pw / 2, y + pillH);
    }
    y += pillH;
  }
  if (acct && !R.textless) {
    y += 44;
    let size = 52;
    setFont(ctx, 700, size, 0);
    while (ctx.measureText(acct).width > F.w && size > 28) { size -= 2; setFont(ctx, 700, size, 0); }
    ctx.textAlign = 'center'; ctx.fillStyle = R.T.head; ctx.fillText(acct, W / 2, y + size * 0.85);
    box(R, 'acctbig', W / 2 - ctx.measureText(acct).width / 2, y, W / 2 + ctx.measureText(acct).width / 2, y + size);
  }
  if (hero) drawHero(R, R.photo, hero);
  R.meta.headlineSize = plan.head.size; R.meta.headlineLines = plan.head.lines.length; R.meta.bodySize = plan.body.size;
}

// ───────────────────────── 색 견본 · 광고 표기 ─────────────────────────
export const COLOR_PRESETS = [
  { key: 'ink', name: '잉크', hex: '#0F172A' }, { key: 'white', name: '흰색', hex: '#FFFFFF' }, { key: 'black', name: '검정', hex: '#000000' },
  { key: 'blue', name: '파랑', hex: '#2563EB' }, { key: 'sky', name: '하늘', hex: '#22D3EE' }, { key: 'yellow', name: '노랑', hex: '#FFE14D' },
  { key: 'coral', name: '코랄', hex: '#FF6B57' }, { key: 'pink', name: '분홍', hex: '#F472B6' }, { key: 'mint', name: '민트', hex: '#10B981' },
  { key: 'purple', name: '보라', hex: '#8B5CF6' }, { key: 'beige', name: '베이지', hex: '#F5EBDD' }, { key: 'gray', name: '회색', hex: '#64748B' },
];
export const AD_LABEL_TEXTS = ['[광고]', '광고', '#광고', '유료 광고'];
export const AD_LABEL_LOOKS = [{ key: 'box', name: '검은 상자' }, { key: 'shadow', name: '그림자 글자' }, { key: 'plain', name: '글자만' }, { key: 'outline', name: '테두리 상자' }];
export const AD_LABEL_POSITIONS = [{ key: 'tl', name: '왼쪽 위' }, { key: 'tr', name: '오른쪽 위' }, { key: 'bl', name: '왼쪽 아래' }, { key: 'br', name: '오른쪽 아래' }];
const AD_SIZES = { s: 26, m: 34, l: 44 };
const AD_INK = '#0F172A';

function resolveAdStyle(raw) {
  const r = raw || {};
  return {
    position: AD_LABEL_POSITIONS.some((x) => x.key === r.position) ? r.position : 'tl',
    look: AD_LABEL_LOOKS.some((x) => x.key === r.look) ? r.look : 'box',
    text: AD_LABEL_TEXTS.includes(r.text) ? r.text : '[광고]',
    size: AD_SIZES[r.size] ? r.size : 'm',
    color: validHex(r.color),
  };
}
const pushUnique = (arr, v) => { if (!arr.includes(v)) arr.push(v); };

/** 캔버스(장치 픽셀) 영역의 평균색 '#RRGGBB'. 좌표는 그림 좌표(scale 곱함). */
function sampleAvg(ctx, scale, dims, x0, y0, x1, y1) {
  const sx = Math.max(0, Math.floor(x0 * scale)), sy = Math.max(0, Math.floor(y0 * scale));
  const ex = Math.min(dims.w, Math.ceil(x1 * scale)), ey = Math.min(dims.h, Math.ceil(y1 * scale));
  const w = ex - sx, h = ey - sy;
  if (w < 1 || h < 1) return '#808080';
  const d = ctx.getImageData(sx, sy, w, h).data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
  return rgb2hex([r / n, g / n, b / n]);
}

/**
 * 광고 표기 한 개 그리기. st = resolveAdStyle 결과. at = {x(왼쪽 끝 또는 오른쪽 끝), baseline, align}.
 * 'box' 모양 + 'm' 크기 + 기본 색은 예전 고정 그림(34px 글자, 상자 14px 여백, rgba(0,0,0,.55))과 똑같다.
 * 반환: {box:{x0,y0,x1,y1}, low:boolean(글자색 대비 3:1 미만), color}
 */
function drawAdLabel(ctx, scale, dims, st, at) {
  const sz = AD_SIZES[st.size];
  setFont(ctx, 700, sz, 0);
  const tw = ctx.measureText(st.text).width;
  const boxy = st.look === 'box' || st.look === 'outline';
  const padX = boxy ? Math.round(sz * 0.41) : 0;
  const w = tw + padX * 2;
  const y0 = boxy ? at.baseline - Math.round(sz * 1.06) : at.baseline - sz * 0.82;
  const y1 = boxy ? at.baseline + Math.round(sz * 0.35) : at.baseline + sz * 0.22;
  const x0 = at.align === 'right' ? at.x - w : at.x;
  // 글자 색: 지정이 없으면 box·shadow 는 흰색, plain·outline 은 배경 밝기에 따라 흰색/잉크
  const bg = sampleAvg(ctx, scale, dims, x0, y0, x0 + w, y1);
  const refBg = st.look === 'box' ? mix(bg, '#000000', 0.55) : bg;      // 상자 모양은 반투명 검정 위
  const color = st.color || ((st.look === 'plain' || st.look === 'outline') ? (lum(bg) > 0.45 ? AD_INK : '#FFFFFF') : '#FFFFFF');
  ctx.save();
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  if (st.look === 'box') { ctx.fillStyle = 'rgba(0,0,0,0.55)'; roundRectPath(ctx, x0, y0, w, y1 - y0, 10); ctx.fill(); }
  if (st.look === 'outline') { ctx.strokeStyle = color; ctx.lineWidth = Math.max(2, sz * 0.09); roundRectPath(ctx, x0 + 1.5, y0 + 1.5, w - 3, y1 - y0 - 3, 10); ctx.stroke(); }
  ctx.fillStyle = color;
  if (st.look === 'shadow') { ctx.shadowColor = 'rgba(0,0,0,0.85)'; ctx.shadowBlur = Math.round(sz * 0.3); ctx.shadowOffsetY = 2; ctx.fillText(st.text, x0 + padX, at.baseline); }
  ctx.fillText(st.text, x0 + padX, at.baseline);
  ctx.restore();
  return { box: { x0, y0, x1: x0 + w, y1 }, low: contrast(color, refBg) < 3, color };
}

/**
 * 패널의 광고 표기 견본 썸네일용(작은 캔버스 240×96). style = adLabelStyle 모양의 객체, opts.bg = 'photo'|'light'|'dark'.
 * 반환 캔버스에 .lowContrast(boolean) 도 붙는다.
 */
export async function renderAdLabelSample(style, { bg = 'photo' } = {}) {
  await loadFonts();
  const W = 240, H = 96;
  const canvas = makeCanvas(W, H);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (bg === 'light') { ctx.fillStyle = '#F5F7FB'; ctx.fillRect(0, 0, W, H); }
  else if (bg === 'dark') { ctx.fillStyle = '#111827'; ctx.fillRect(0, 0, W, H); }
  else {
    const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#FDE68A'); g.addColorStop(0.5, '#93C5FD'); g.addColorStop(1, '#34D399');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,0.35)'; for (let x = -H; x < W; x += 28) { ctx.beginPath(); ctx.moveTo(x, H); ctx.lineTo(x + 14, H); ctx.lineTo(x + 14 + H * 0.5, 0); ctx.lineTo(x + H * 0.5, 0); ctx.fill(); }
  }
  const st = resolveAdStyle(style);
  const sz = AD_SIZES[st.size];
  setFont(ctx, 700, sz, 0);
  const r = drawAdLabel(ctx, 1, { w: W, h: H }, st, { x: W / 2 - ctx.measureText(st.text).width / 2 - (st.look === 'box' || st.look === 'outline' ? Math.round(sz * 0.41) : 0), baseline: H / 2 + sz * 0.35, align: 'left' });
  canvas.lowContrast = r.low;
  return canvas;
}

// ───────────────────────── 사진 캐러셀 (mode:'photo', layout:'overlay') ─────────────────────────
// 사진을 카드 전체에 cover 로 채우고(트리밍 없음) 문장만 얹는다. docs/사진캐러셀.md · knowledge/K-사진캐러셀.md
export const OVERLAY_BASE = { xl: 118, l: 96, m: 78 }; // 참고 스타일(@tem.duck)처럼 문장이 사진 폭의 80~90%를 채우게 크게. 폭을 넘으면 자동 축소
export const OVERLAY_STYLES = ['outline', 'gradient', 'band', 'shadow'];   // gradient = 아래(위) 40% 검은 그라데이션 + 왼쪽 정렬 글씨(@gollabom 스타일)
export const OVERLAY_POSITIONS = ['top', 'middle', 'bottom'];
const HIGHLIGHT_COLOR = '#FFE14D';
const OUTLINE_RATIO = 0.2;           // 테두리 선 두께 = 글자 크기의 20%(선이 글자 가장자리에 걸쳐 바깥으로 보이는 두께는 약 10%). 설계서 "약 14%"보다 살짝 굵게 — 밝은 사진에서 가독성 확보
const OVERLAY_MIN = 44;
const PHOTO_MX = 80;                 // 좌우 여백

/** 한 줄 안의 highlight 부분 문자열만 색을 바꾸기 위해 [{t, hl}] 조각으로 나눈다 */
function highlightRuns(line, words) {
  const mask = new Array(line.length).fill(false);
  (words || []).filter(Boolean).forEach((w) => { let i = line.indexOf(w); while (i >= 0) { for (let k = 0; k < w.length; k++) mask[i + k] = true; i = line.indexOf(w, i + w.length); } });
  const runs = [];
  for (let i = 0; i < line.length; i++) { const last = runs[runs.length - 1]; if (last && last.hl === mask[i]) last.t += line[i]; else runs.push({ t: line[i], hl: mask[i] }); }
  return runs.length ? runs : [{ t: '', hl: false }];
}

function overlayOf(card, idx) {
  const o = card.overlay || {};
  let lines = Array.isArray(o.lines) ? o.lines.map((l) => String(l == null ? '' : l).trim()).filter(Boolean) : [];
  if (!lines.length) lines = String(card.headline || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return {
    lines,
    position: OVERLAY_POSITIONS.includes(o.position) ? o.position : (idx === 0 ? 'top' : 'bottom'),
    size: OVERLAY_BASE[o.size] ? o.size : (idx === 0 ? 'xl' : 'l'),
    highlight: Array.isArray(o.highlight) ? o.highlight : [],
    align: o.align === 'left' || o.align === 'center' ? o.align : null,   // 없으면 스타일 기본(gradient 왼쪽, 나머지 가운데)
  };
}

function fitOverlay(ctx, lines, base, maxW, outline) {
  const widthOf = (size, ls) => { setFontR(ctx, 'head', size, lsOf('head', size)); const pad = outline ? pxOf('head', size) * OUTLINE_RATIO : 0; return Math.max(0, ...ls.map((l) => ctx.measureText(l).width)) + pad; };
  for (let size = base; size >= OVERLAY_MIN; size -= 2) if (widthOf(size, lines) <= maxW) return { size, lines, ok: true, rewrapped: false };
  // 한 줄이 최소 크기로도 넘치면 어절 경계에서 다시 줄바꿈(최대 4줄)
  const size = 52;
  setFontR(ctx, 'head', size, lsOf('head', size));
  const wrapped = []; lines.forEach((l) => wrapped.push(...wrapPara(ctx, l, maxW - pxOf('head', size) * OUTLINE_RATIO)));
  const ok = wrapped.length <= 4 && widthOf(size, wrapped) <= maxW;
  return { size, lines: wrapped, ok, rewrapped: true };
}

function renderPhotoCard({ carousel, card, cardIndex, total, S, sizeKey, scale, textless, photo, font, opts, fontInfo }) {
  const W = S.w, H = S.h;
  const canvas = makeCanvas(Math.round(W * scale), Math.round(H * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });   // 광고 표기·대비 점검이 배경 픽셀을 읽는다
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.textBaseline = 'alphabetic';
  if ('fontKerning' in ctx) ctx.fontKerning = 'normal';
  const style = OVERLAY_STYLES.includes(carousel.overlayStyle) ? carousel.overlayStyle : 'outline';
  const ov = overlayOf(card, cardIndex);
  if (OVERLAY_POSITIONS.includes(opts.overlayPosition)) ov.position = opts.overlayPosition;
  if (style === 'gradient' && ov.position === 'middle') ov.position = 'bottom'; // 그라데이션은 위·아래만(가운데 띠는 사진 중앙을 덮어 보기 나쁨)
  const align = ov.align || (style === 'gradient' ? 'left' : 'center');
  const adLabel = carousel.adLabel !== false;
  const adSt = resolveAdStyle(carousel.adLabelStyle);
  const oc = carousel.overlayColors || {};
  const col = { text: validHex(oc.text) || '#FFFFFF', stroke: validHex(oc.stroke) || '#000000', highlight: validHex(oc.highlight) || HIGHLIGHT_COLOR, shade: validHex(oc.shade) || '#000000' };
  const meta = { lowContrast: [], adLabelStyle: adSt, size: sizeKey, width: canvas.width, height: canvas.height, layout: 'overlay', effectiveLayout: 'overlay', mode: 'photo', style, align, adLabel, position: ov.position, overlaySize: ov.size, headlineSize: 0, headlineLines: 0, bodySize: 0, overflow: false, overflowReasons: [], overlaps: [], safeViolations: [], fontOk: font.ok, ...fontInfo, hasImage: !!photo, imageMissing: !photo, textless };
  const padV = sizeKey === '9x16' ? { top: S.top, bottom: S.bottom } : { top: 120, bottom: 120 };

  // 배경: 사진 꽉 채움(cover, 가운데 기준, 트리밍 없음) / 없으면 짙은 회색
  if (photo) drawPhoto(ctx, photo, { x: 0, y: 0, w: W, h: H }, 'cover', { trim: false });
  else {
    ctx.fillStyle = '#2B2F36'; ctx.fillRect(0, 0, W, H);
    if (!textless) { setFont(ctx, 700, 48, 0); ctx.textAlign = 'center'; ctx.fillStyle = '#9CA3AF'; ctx.fillText('사진을 넣어 주세요', W / 2, ov.position === 'middle' ? H / 2 + 240 : H / 2); }
  }
  if (textless) { canvas.meta = meta; return { canvas, meta }; }

  // 그라데이션(gradient 스타일): 글이 놓인 쪽(위/아래, 가운데면 가운데) 40% 에 투명 → 약 75% 검정
  if (style === 'gradient') {
    const gh = H * 0.4;
    let g;
    if (ov.position === 'top') { g = ctx.createLinearGradient(0, 0, 0, gh); g.addColorStop(0, rgba(col.shade, 0.78)); g.addColorStop(0.6, rgba(col.shade, 0.4)); g.addColorStop(1, rgba(col.shade, 0)); ctx.fillStyle = g; ctx.fillRect(0, 0, W, gh); }
    else if (ov.position === 'middle') { const y1 = H / 2 - gh / 2; g = ctx.createLinearGradient(0, y1, 0, y1 + gh); g.addColorStop(0, rgba(col.shade, 0)); g.addColorStop(0.5, rgba(col.shade, 0.65)); g.addColorStop(1, rgba(col.shade, 0)); ctx.fillStyle = g; ctx.fillRect(0, y1, W, gh); }
    else { g = ctx.createLinearGradient(0, H - gh, 0, H); g.addColorStop(0, rgba(col.shade, 0)); g.addColorStop(0.4, rgba(col.shade, 0.4)); g.addColorStop(1, rgba(col.shade, 0.78)); ctx.fillStyle = g; ctx.fillRect(0, H - gh, W, gh); }
  }

  // 글 크기 맞추기
  const maxW = W - 2 * PHOTO_MX;
  const fit = fitOverlay(ctx, ov.lines.length ? ov.lines : [''], OVERLAY_BASE[ov.size], maxW, style === 'outline');
  const size = fit.size, lines = fit.lines;
  const lh = lhOf('head', size, 1.2), blockH = lines.length * lh, px = pxOf('head', size);
  meta.headlineSize = size; meta.headlineLines = lines.length; meta.rewrapped = fit.rewrapped;
  if (!ov.lines.length) { meta.overflow = true; meta.overflowReasons.push('사진 위 문장이 비어 있음'); }
  if (!fit.ok) { meta.overflow = true; meta.overflowReasons.push(`문장이 너무 길어 최소 크기(${OVERLAY_MIN}px)로도 폭에 안 들어감`); }
  if (ov.lines.length > 3) { meta.overflow = true; meta.overflowReasons.push(`줄 수 ${ov.lines.length}줄(최대 3줄)`); }
  const availTop = padV.top, availBottom = H - padV.bottom;
  const lw = style === 'outline' ? px * OUTLINE_RATIO : 0;
  let y0 = ov.position === 'top' ? availTop : ov.position === 'bottom' ? availBottom - blockH - lw / 2 : (H - blockH) / 2;
  if (blockH > availBottom - availTop) { meta.overflow = true; meta.overflowReasons.push('문장 높이가 안전 여백을 넘음'); y0 = Math.max(0, y0); }

  const boxes = [];
  if (style === 'band') {
    const by0 = y0 - 36, by1 = y0 + blockH + 36;
    ctx.fillStyle = rgba(col.shade, 0.58); ctx.fillRect(0, by0, W, by1 - by0);
  }
  setFontR(ctx, 'head', size, lsOf('head', size));
  ctx.textAlign = 'left'; ctx.lineJoin = 'round'; ctx.miterLimit = 2;
  const placed = lines.map((l, i) => {
    const runs = highlightRuns(l, ov.highlight);
    const ws = runs.map((r) => ctx.measureText(r.t).width);
    const total = ws.reduce((a, b) => a + b, 0);
    const x = align === 'left' ? PHOTO_MX : (W - total) / 2, base = y0 + i * lh + lh / 2 + baseOf('head', size);
    boxes.push({ tag: 'ovl', x0: x - lw / 2, x1: x + total + lw / 2, y0: base - px * 0.82 - lw / 2, y1: base + px * 0.22 + lw / 2 });
    return { runs, ws, x, base };
  });
  const eachRun = (fn) => placed.forEach((p) => { let sx = p.x; p.runs.forEach((r, i) => { fn(r, sx, p.base); sx += p.ws[i]; }); });
  {   // 대비 점검: outline 은 글자 vs 테두리색, 나머지는 글자 바로 뒤(사진+띠·그라데이션)의 평균색 vs 글자색(강조 단어가 있으면 강조색도)
    const dims = { w: canvas.width, h: canvas.height };
    const bx0 = Math.min(...boxes.map((b) => b.x0)), bx1 = Math.max(...boxes.map((b) => b.x1)), by0 = Math.min(...boxes.map((b) => b.y0)), by1 = Math.max(...boxes.map((b) => b.y1));
    const refBg = style === 'outline' ? col.stroke : sampleAvg(ctx, scale, dims, bx0, by0, bx1, by1);
    const hasHl = ov.highlight.some((w) => w && lines.some((l) => l.includes(w)));
    if (contrast(col.text, refBg) < 3 || (hasHl && contrast(col.highlight, refBg) < 3)) pushUnique(meta.lowContrast, 'overlay');
  }
  if (style === 'outline') {
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 4;
    ctx.strokeStyle = col.stroke; ctx.lineWidth = lw;
    eachRun((r, sx, base) => ctx.strokeText(r.t, sx, base));
    ctx.restore();
  } else if (style === 'gradient') {
    ctx.save();                                   // 테두리 없음 — 약한 그림자만
    ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = px * 0.14; ctx.shadowOffsetY = px * 0.03;
    eachRun((r, sx, base) => { ctx.fillStyle = r.hl ? col.highlight : col.text; ctx.fillText(r.t, sx, base); });
    ctx.restore();
  } else if (style === 'shadow') {
    ctx.save();
    ctx.shadowColor = rgba(col.stroke, 0.92); ctx.shadowBlur = px * 0.32; ctx.shadowOffsetY = px * 0.05;
    for (let k = 0; k < 3; k++) eachRun((r, sx, base) => { ctx.fillStyle = r.hl ? col.highlight : col.text; ctx.fillText(r.t, sx, base); });
    ctx.restore();
  }
  eachRun((r, sx, base) => { ctx.fillStyle = r.hl ? col.highlight : col.text; ctx.fillText(r.t, sx, base); });

  // 작은 보조 글씨(안전 여백 안쪽 바깥): 계정명(옵션) · 연출 이미지 · 파트너스 고지
  const small = (text, x, y, align, sz = 26) => {
    setFont(ctx, 700, sz, 0); ctx.textAlign = align; ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.lineWidth = Math.max(4, sz * 0.22); ctx.strokeText(text, x, y);
    ctx.fillStyle = '#FFFFFF'; ctx.fillText(text, x, y);
  };
  const noticeY = sizeKey === '9x16' ? H - 200 : H - 60;
  const topY = sizeKey === '9x16' ? S.top - 40 : 84;
  const dims = { w: canvas.width, h: canvas.height };
  const smallBox = (tag, text, x, y, al, sz) => { setFont(ctx, 700, sz, 0); const tw2 = ctx.measureText(text).width; const x0 = al === 'right' ? x - tw2 : x; boxes.push({ tag, x0, x1: x0 + tw2, y0: y - sz * 0.82, y1: y + sz * 0.22 }); };
  const adTop = adLabel && (adSt.position === 'tl' || adSt.position === 'tr');
  const adBottom = adLabel && !adTop;
  // 위쪽 줄: 광고 표기(위 위치) ↔ 계정명(반대쪽)
  if (adTop) {
    const r = drawAdLabel(ctx, scale, dims, adSt, { x: adSt.position === 'tl' ? PHOTO_MX : W - PHOTO_MX, baseline: topY, align: adSt.position === 'tl' ? 'left' : 'right' });
    boxes.push({ tag: 'ad', ...r.box }); if (r.low) pushUnique(meta.lowContrast, 'adLabel');
  }
  const acct = String(carousel.accountName || '').trim();
  if (carousel.showAccount && acct) {
    const al = adTop && adSt.position === 'tl' ? 'right' : 'left';
    small(acct, al === 'right' ? W - PHOTO_MX : PHOTO_MX, topY, al, 28); smallBox('acct', acct, al === 'right' ? W - PHOTO_MX : PHOTO_MX, topY, al, 28);
  }
  // 아래쪽 줄(안전 여백 안): 왼쪽 = [광고(bl)] 연출 이미지 / 오른쪽 = 파트너스 고지 [광고(br)]
  let leftX = PHOTO_MX, rightX = W - PHOTO_MX;
  if (adBottom) {
    const left = adSt.position === 'bl';
    const r = drawAdLabel(ctx, scale, dims, adSt, { x: left ? leftX : rightX, baseline: noticeY, align: left ? 'left' : 'right' });
    boxes.push({ tag: 'ad', ...r.box }); if (r.low) pushUnique(meta.lowContrast, 'adLabel');
    if (left) leftX = r.box.x1 + 20; else rightX = r.box.x0 - 20;
  }
  if (card.imageIsGenerated && photo) { const t = carousel.imageDisclosureText || '연출 이미지'; small(t, leftX, noticeY, 'left'); smallBox('gen', t, leftX, noticeY, 'left', 26); }
  if (carousel.hasPartnersLink && cardIndex === total - 1 && total > 1) { const t = '쿠팡 파트너스 수수료 수령'; small(t, rightX, noticeY, 'right'); smallBox('notice', t, rightX, noticeY, 'right', 26); }

  // 점검: 안전 여백(좌우 80, 위·아래 120; 9:16 은 스토리 UI 여백)
  boxes.filter((b) => b.tag === 'ovl').forEach((b) => { if (b.x0 < PHOTO_MX - 3 || b.x1 > W - PHOTO_MX + 3 || b.y0 < padV.top - 3 - (style === 'band' ? 0 : 0) || b.y1 > H - padV.bottom + 3) meta.safeViolations.push(`${b.tag}(${Math.round(b.x0)},${Math.round(b.y0)})-(${Math.round(b.x1)},${Math.round(b.y1)})`); });
  if (meta.safeViolations.length) { meta.overflow = true; meta.overflowReasons.push('안전 여백 침범: ' + meta.safeViolations.join(', ')); }
  const adB = boxes.find((b) => b.tag === 'ad');
  if (adB) boxes.filter((b) => b.tag !== 'ad').forEach((b) => {
    if (Math.min(b.x1, adB.x1) - Math.max(b.x0, adB.x0) > 4 && Math.min(b.y1, adB.y1) - Math.max(b.y0, adB.y0) > 4) { meta.overlaps.push(`ad×${b.tag}`); meta.overflow = true; meta.overflowReasons.push(`광고 표기와 ${b.tag === 'ovl' ? '문장' : b.tag}이(가) 겹침`); }
  });
  if (opts.debug) meta.boxes = boxes;
  canvas.meta = meta;
  return { canvas, meta };
}

// ───────────────────────── 공개: renderCard ─────────────────────────

/**
 * 한 장 그리기. opts: {size:'4x5'|'1x1'|'9x16', textless?, scale?(기본 1, 미리보기는 0.5~0.75), total?, layout?(이 카드만 임시로 바꿔 그릴 때), overlayPosition?(photo 모드: top|middle|bottom 임시 지정)}
 * 반환: {canvas, meta}.  meta = {size,width,height,layout,headlineSize,headlineLines,bodySize,overflow,overflowReasons[],
 *   overlaps[],safeViolations[],fontOk,hasImage,imageMissing,textless}
 */
export async function renderCardMeta(carousel, cardIndex, opts = {}) {
  const sizeKey = SIZES[opts.size] ? opts.size : '4x5';
  const S = SIZES[sizeKey];
  const cards = carousel.cards || [];
  if (!cards[cardIndex]) throw new Error(`renderCard: ${cardIndex}번 카드가 없습니다.`);
  const card = { ...cards[cardIndex], index: Number.isFinite(cards[cardIndex].index) ? cards[cardIndex].index : cardIndex };
  const font = await loadFonts();
  const fontKey = fontByKey(carousel.font).key;
  let fontEff = fontKey, fontFallback = false;
  if (fontKey !== DEFAULT_FONT && !(await ensureCardFont(fontKey))) { fontEff = DEFAULT_FONT; fontFallback = true; }
  const scale = opts.scale > 0 ? opts.scale : 1;
  const total = Math.max(opts.total || carousel.total || 0, cards.length);
  const textless = !!opts.textless;
  const [photo, logo] = await Promise.all([
    card.imageId && card.imageSlot !== 'none' ? loadPhoto(card.imageId) : null,
    !textless && carousel.logoImageId ? loadPhoto(carousel.logoImageId) : null,
  ]);
  FS = buildFontSpec(fontEff);
  const fontInfo = { font: fontEff, fontFallback };
  if (carousel.mode === 'photo') return renderPhotoCard({ carousel, card, cardIndex, total, S, sizeKey, scale, textless, photo, font, opts, fontInfo });
  const hasImage = !!photo;
  const canvas = makeCanvas(Math.round(S.w * scale), Math.round(S.h * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });   // 광고 표기·대비 점검이 배경 픽셀을 읽는다
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.textBaseline = 'alphabetic';
  if ('fontKerning' in ctx) ctx.fontKerning = 'normal';

  const F = frameOf(S);
  let layout = LAYOUTS.includes(opts.layout) ? opts.layout : autoLayout(card, { hasImage, type: carousel.type, total });
  const meta = { size: sizeKey, width: canvas.width, height: canvas.height, layout, headlineSize: 0, headlineLines: 0, bodySize: 0, overflow: false, overflowReasons: [], overlaps: [], safeViolations: [], fontOk: font.ok, ...fontInfo, hasImage, imageMissing: !!(card.imageId && card.imageSlot !== 'none' && !photo), textless };
  const T = buildTheme(carousel);
  const R = { ctx, W: S.w, H: S.h, S, F, T, carousel, card, idx: cardIndex, total, next: cards[cardIndex + 1] || null, photo, logo, textless, meta, boxes: [], cb: F.contentBottom, generated: !!(card.imageIsGenerated && hasImage), ctaLine: '', scale, cw: canvas.width, ch: canvas.height, ad: carousel.adLabel === true ? resolveAdStyle(carousel.adLabelStyle) : null, ctaY: F.contentBottom - 20, adY: 0 };
  meta.lowContrast = [];
  meta.adLabel = !!R.ad; if (R.ad) meta.adLabelStyle = R.ad;

  // 마지막 카드 하단 문구 / 브릿지+고지가 같이 있을 때 내용 영역을 줄인다
  const isLast = cardIndex === total - 1 && total > 1;
  const cta = String(card.cta || '').trim();
  if (isLast && cta && layout !== 'cta') { R.ctaLine = cta; R.cb -= 70; }
  if (isLast && carousel.hasPartnersLink && String(card.bridge || '').trim()) R.cb -= 44;
  if (R.ad && (R.ad.position === 'bl' || R.ad.position === 'br')) {     // 아래 광고 표기 줄(진행 점·고지 위)을 비워 둔다
    const stack = (R.ctaLine ? 70 : 0) + (isLast && carousel.hasPartnersLink && String(card.bridge || '').trim() ? 44 : 0);
    R.adY = F.contentBottom - stack - 22;
    R.cb = Math.min(R.cb, R.adY - 63);
    if (R.ctaLine) R.ctaY = F.contentBottom - 20;
  }

  // 사진이 필요한 레이아웃인데 사진이 없을 때의 대체
  let effective = layout;
  if (layout === 'photo-full' && !photo) effective = 'title';
  if (layout === 'split' && !photo) effective = 'plain';
  meta.layout = layout; meta.effectiveLayout = effective;

  R.TonPhoto = null;
  let topInk = T, bottomInk = T;
  if (effective === 'photo-full') {
    R.TonPhoto = photoTheme(T);
    bottomInk = R.TonPhoto;
    topInk = photo.info.flat ? inkOn(T, photo.info.bgColor) : R.TonPhoto;
  } else {
    drawBackground(R);
  }
  switch (effective) {
    case 'title': layoutTitle(R); break;
    case 'photo-full': layoutPhotoFull(R); break;
    case 'split': layoutSplit(R); break;
    case 'number': layoutNumber(R); break;
    case 'quote': layoutQuote(R); break;
    case 'table': layoutTable(R); break;
    case 'cta': layoutCta(R); break;
    default: layoutPlain(R);
  }
  // 머리·바닥(텍스트 없는 버전에서는 건너뜀). 칩·진행 점은 템플릿 강조색을 유지하고 글자색만 바탕에 맞춘다.
  drawTop(R, topInk);
  drawBottom(R, bottomInk);
  drawCtaLine(R, bottomInk);
  drawPeek(R, effective === 'photo-full' || effective === 'split' ? 'rgba(255,255,255,0.9)' : rgba(T.accentText, 0.75));

  // 사용자가 고른 색의 대비(글씨 vs 배경 3:1 미만)
  if (carousel.colors && T.custom && effective !== 'photo-full') {
    if (contrast(T.head, T.bg) < 3) pushUnique(meta.lowContrast, 'headline');
    if (contrast(T.bodyHex, T.bg) < 3) pushUnique(meta.lowContrast, 'body');
  }
  // 자체 점검: 안전영역 침범·겹침
  if (!textless) {
    const mx = F.mx, top = S.top, bot = S.h - S.bottom, tol = 3;
    R.boxes.forEach((b) => { if (b.x0 < mx - tol || b.x1 > S.w - mx + tol || b.y0 < top - tol || b.y1 > bot + tol) meta.safeViolations.push(`${b.tag}(${Math.round(b.x0)},${Math.round(b.y0)})-(${Math.round(b.x1)},${Math.round(b.y1)})`); });
    for (let i = 0; i < R.boxes.length; i++) for (let j = i + 1; j < R.boxes.length; j++) {
      const a = R.boxes[i], b = R.boxes[j];
      if (a.tag === b.tag && (a.tag === 'head' || a.tag === 'body' || a.tag === 'cell')) continue;
      const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      if (ox > 4 && oy > 4) meta.overlaps.push(`${a.tag}×${b.tag}`);
    }
    if (meta.safeViolations.length) { meta.overflow = true; meta.overflowReasons.push('안전영역 침범: ' + meta.safeViolations.join(', ')); }
    if (meta.overlaps.length) { meta.overflow = true; meta.overflowReasons.push('겹침: ' + meta.overlaps.join(', ')); }
  }
  if (opts.debug) meta.boxes = R.boxes;
  canvas.meta = meta;
  return { canvas, meta };
}

/** 캔버스 한 장. 메타는 canvas.meta 로도 붙어 있다. */
export async function renderCard(carousel, cardIndex, opts = {}) {
  return (await renderCardMeta(carousel, cardIndex, opts)).canvas;
}
/** PNG Blob 한 장. 메타는 blob.meta. */
export async function renderCardBlob(carousel, cardIndex, opts = {}) {
  const { canvas, meta } = await renderCardMeta(carousel, cardIndex, { ...opts, scale: 1 });
  const blob = await canvasToBlob(canvas, 'image/png');
  blob.meta = meta;
  return blob;
}

/** 커버 변형 3안: 1번 카드를 레이아웃 3종으로. 사진이 있으면 photo-full·split·title, 없으면 title·quote·number. 각 Blob.meta.layout 에 쓴 레이아웃. */
export async function renderCoverVariants(carousel, opts = {}) {
  const c0 = (carousel.cards || [])[0];
  if (!c0) throw new Error('renderCoverVariants: 1번 카드가 없습니다.');
  if (carousel.mode === 'photo') {            // 사진 캐러셀: 같은 사진·문장을 글 위치 3가지(위·가운데·아래)로
    const outP = [];
    for (const overlayPosition of OVERLAY_POSITIONS) outP.push(await renderCardBlob(carousel, 0, { size: opts.size || '4x5', overlayPosition, textless: opts.textless }));
    return outP;
  }
  const photo = c0.imageId ? await loadPhoto(c0.imageId) : null;
  const layouts = photo ? ['photo-full', 'split', 'title'] : ['title', 'quote', 'number'];
  const out = [];
  for (const layout of layouts) out.push(await renderCardBlob(carousel, 0, { size: opts.size || '4x5', layout, textless: opts.textless }));
  return out;
}

// ───────────────────────── 내보내기 ─────────────────────────

const BOM = '﻿';
const asText = (v) => (Array.isArray(v) ? v.join('\n') : String(v == null ? '' : v));
/**
 * 내보내기 파일 구성 → [{name, data}]  (makeZip 에 그대로 넣는다)
 *  카드_01.png … / 캡션.txt / 해시태그.txt / 쇼츠대본.txt / (1x1/카드_01.png …) / (커버_9x16.png, 엔딩_9x16.png) / (텍스트없음/카드_01.png …)
 * 텍스트 파일은 UTF-8 BOM 을 붙인다(윈도 메모장). 캡션 문자열은 받은 그대로 쓴다(고지 삽입은 coupang 의 composeCaption 몫).
 */
export async function buildExportFiles(carousel, { caption, hashtags, shortsScript, include1x1 = false, include9x16 = false, includeTextless = false, onProgress, bom = true } = {}) {
  const files = [];
  const n = (carousel.cards || []).length;
  const jobs = n * (1 + (include1x1 ? 1 : 0) + (includeTextless ? 1 : 0)) + (include9x16 ? (n > 1 ? 2 : 1) : 0);
  let done = 0;
  const tick = (label) => { done++; if (onProgress) onProgress({ done, total: jobs, label }); };
  for (let i = 0; i < n; i++) { files.push({ name: `카드_${pad2(i + 1)}.png`, data: await renderCardBlob(carousel, i) }); tick(`카드 ${i + 1}`); }
  if (include1x1) for (let i = 0; i < n; i++) { files.push({ name: `1x1/카드_${pad2(i + 1)}.png`, data: await renderCardBlob(carousel, i, { size: '1x1' }) }); tick(`1:1 ${i + 1}`); }
  if (include9x16 && n) {
    files.push({ name: '커버_9x16.png', data: await renderCardBlob(carousel, 0, { size: '9x16' }) }); tick('9:16 커버');
    if (n > 1) { files.push({ name: '엔딩_9x16.png', data: await renderCardBlob(carousel, n - 1, { size: '9x16' }) }); tick('9:16 엔딩'); }
  }
  if (includeTextless) for (let i = 0; i < n; i++) { files.push({ name: `텍스트없음/카드_${pad2(i + 1)}.png`, data: await renderCardBlob(carousel, i, { textless: true }) }); tick(`글자 없음 ${i + 1}`); }
  const txt = (name, v) => { const s = asText(v); if (s.trim()) files.push({ name, data: (bom ? BOM : '') + s }); };
  txt('캡션.txt', caption);
  txt('해시태그.txt', hashtags);
  txt('쇼츠대본.txt', shortsScript);
  return files;
}
/** buildExportFiles → makeZip 한 번에. 반환: zip Blob */
export async function buildExportZip(carousel, opts = {}) {
  return makeZip(await buildExportFiles(carousel, opts));
}
/**
 * zip Blob 을 IndexedDB 에 임시 저장하고 서비스워커의 chrome.downloads 로 내려받는다(docs/인터페이스.md §4).
 * filename 예: '백코치캐러셀/제목.zip'
 */
export async function downloadZip(zipBlob, filename, { saveAs = false } = {}) {
  const { request } = await import('./bus.js');
  const imageId = await store.putImage(zipBlob, { kind: 'zip' });
  return request('core.downloadStored', { imageId, filename, saveAs });
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
