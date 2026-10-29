// 쿠팡 연동 (coupang.* 핸들러 + 순수 유틸) — 2단계 coupang 담당. 규칙: CLAUDE.md 3·4, 설계서 v3 §4. 요청/응답 형식은 docs/인터페이스_쿠팡.md.
//
//  서비스워커 전용(키를 읽는 부분): coupang.search · coupang.deeplink · coupang.status
//  서비스워커(콘텐츠/패널 요청): coupang.productCaptured · coupang.getCurrentProduct · coupang.fetchProductImage
//  어디서든 import 가능한 순수 함수(패널·내보내기·형식검수가 사용):
//    DISCLOSURE_TEXT, DISCLOSURE_VARIANTS, CARD_DISCLOSURE, PRICE_NOTICE, composeCaption, findVolatileClaims,
//    loadVolatileTerms, normalizeProduct, parseProductUrl, canonicalProductUrl, searchItemToProduct,
//    formatSignedDate, hmacSha256Hex, buildAuthorization
//  이 파일 최상위에서는 chrome.* 를 부르지 않는다(패널이 import 해도 안전).
//
//  지킬 것: 사용자가 열어 둔 상품 페이지 외 자동 탐색·대량 수집 금지 · 검색 API는 사용자가 누를 때만, 시간당 8회 ·
//          403이면 즉시 중단 · 키는 로그·오류 원문에 남기지 않는다.

import { AppError, WHERE, redactSecrets } from './common.js';
import * as store from './store.js';
import { handlers as coreHandlers } from './core.js';
import { IS_WEB } from './platform.js';

export const prefix = 'coupang.';

/** 콘텐츠 스크립트가 보낼 수 있는 요청은 이것 하나뿐. payload 는 위조될 수 있다고 보고 normalizeProduct 로 다시 만든다. */
export const contentAllowed = ['coupang.productCaptured'];

// ───────────────────────── 고지 문구 (해제 불가) ─────────────────────────

/** v3 §4-C 캡션 첫 줄 고지. */
export const DISCLOSURE_TEXT = '이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.';
/** 마지막 카드 하단 작은 글씨. */
export const CARD_DISCLOSURE = '쿠팡 파트너스 수수료 수령';
/** 캡션에 항상 넣는 줄 (변동 사실은 링크에서 확인하게 한다). */
export const PRICE_NOTICE = '배송·가격은 링크에서 확인';
/** 고지 문구가 갖춰야 할 필수 요소. 변형 문구에서 하나라도 빠지면 기본 문구로 되돌린다. */
export const DISCLOSURE_REQUIRED = Object.freeze(['쿠팡 파트너스 활동', '수수료']);
/** 설정 disclosureVariant(번호)의 문구 목록. 0번이 기본. 문구 변형만 가능하고 고지 자체는 끌 수 없다. */
export const DISCLOSURE_VARIANTS = Object.freeze([
  DISCLOSURE_TEXT,
  '이 게시물은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.',
  `#광고 ${DISCLOSURE_TEXT}`,
]);

const hasRequired = (s) => DISCLOSURE_REQUIRED.every((w) => String(s).includes(w));

// ───────────────────────── 변동 사실(로켓배송·무료배송·최저가·오늘 도착 등) 검사 ─────────────────────────

/**
 * K-금지어.md 표의 "(변동 사실)" 행과 같은 4개. 지식 파일을 읽지 못할 때만 쓰는 대비용이다(규칙 7: 원본은 knowledge/K-금지어.md).
 * 이 파일의 행: "주의 | 로켓배송, 무료배송, 최저가, 오늘 도착 (변동 사실)".
 */
const VOLATILE_FALLBACK = ['로켓배송', '무료배송', '최저가', '오늘 도착'];
/**
 * [코드 상수 — 지식 파일에 없는 보강어] K-금지어.md "변동 사실" 행에는 없지만 같은 성격이라 함께 검사한다.
 * 선생님이 K-금지어.md 의 변동 사실 행에 추가하면 이 목록은 지워도 된다.
 */
const VOLATILE_EXTRA = ['내일 도착', '모레 도착', '도착 보장', '새벽배송', '당일배송'];

let volatileTerms = [...VOLATILE_FALLBACK, ...VOLATILE_EXTRA];
let volatileSource = 'fallback';
let regexCache = new Map();

/** K-금지어.md 본문에서 "(변동 사실)" 행의 단어를 뽑는다. (순수 함수) */
export function parseVolatileTerms(markdown) {
  const out = [];
  for (const line of String(markdown || '').split('\n')) {
    if (!line.trim().startsWith('|') || !line.includes('변동 사실')) continue;
    const cells = line.split('|');
    const cell = cells[2] || '';
    for (const t of cell.replace(/\([^)]*\)/g, '').split(/[,、，]/)) {
      const w = t.trim();
      if (w) out.push(w);
    }
  }
  return [...new Set(out)];
}

/** 지식 파일에서 단어를 읽어 검사 목록을 갱신한다. 실패하면 대비용 목록을 유지한다. 서비스워커·패널 어디서든 호출 가능. */
export async function loadVolatileTerms() {
  try {
    const res = await fetch(chrome.runtime.getURL('knowledge/K-금지어.md'));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const terms = parseVolatileTerms(await res.text());
    if (!terms.length) throw new Error('변동 사실 행을 찾지 못함');
    volatileTerms = [...new Set([...terms, ...VOLATILE_EXTRA])];
    volatileSource = 'knowledge';
    regexCache = new Map();
  } catch {
    volatileSource = 'fallback';
  }
  return { source: volatileSource, terms: [...volatileTerms] };
}

function termRegex(term) {
  let re = regexCache.get(term);
  if (!re) {
    // 글자 사이의 공백·괄호 설명("내일(화) 도착")이 끼어 있어도 잡는다.
    const chars = [...term.replace(/\s+/g, '')].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    re = new RegExp(chars.join('(?:\\s|\\([^)]{0,12}\\))*'), 'g');
    regexCache.set(term, re);
  }
  return re;
}

/**
 * 변동 사실 표현 찾기. 순수 함수(동기). loadVolatileTerms() 를 먼저 불렀다면 지식 파일의 단어를 쓰고, 아니면 대비용 목록을 쓴다.
 * @returns {{term:string,start:number,end:number,match:string}[]}  start/end 는 text 안 위치(끝은 미포함)
 */
export function findVolatileClaims(text, { terms } = {}) {
  const src = String(text ?? '');
  const out = [];
  const seen = new Set();
  for (const term of terms || volatileTerms) {
    const re = termRegex(term);
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) {
      const key = `${m.index}:${m[0].length}`;
      if (!seen.has(key)) { seen.add(key); out.push({ term, start: m.index, end: m.index + m[0].length, match: m[0] }); }
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// ───────────────────────── 캡션 합성 (고지 · 링크 · 안내 줄) ─────────────────────────

function pickDisclosure(variant, warnings) {
  if (typeof variant === 'string' && variant.trim()) {
    if (hasRequired(variant)) return variant.trim();
    warnings.push({ code: 'DISCLOSURE_RESTORED', messageKo: '고지 문구에 "쿠팡 파트너스 활동"과 "수수료"가 모두 있어야 해서 기본 문구로 되돌렸어요. 고지는 끌 수 없어요.' });
    return DISCLOSURE_TEXT;
  }
  const n = Number(variant);
  if (Number.isInteger(n) && n >= 0 && n < DISCLOSURE_VARIANTS.length) return DISCLOSURE_VARIANTS[n];
  return DISCLOSURE_TEXT;
}

/** 붙여넣은 링크 정리. 첫 토큰만 쓰고 https 주소인지·쿠팡 파트너스 링크로 보이는지 확인한다. */
export function normalizeLink(link) {
  const raw = String(link ?? '').trim().split(/\s+/)[0] || '';
  if (!raw) return { url: '', state: 'empty' };
  let u;
  try { u = new URL(raw); } catch { return { url: '', state: 'invalid' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { url: '', state: 'invalid' };
  const h = u.hostname;
  const isCoupang = h === 'link.coupang.com' || h === 'coupa.ng' || h === 'coupang.com' || h.endsWith('.coupang.com');
  return { url: u.toString(), state: isCoupang ? 'ok' : 'not_coupang' };
}

const LINK_PREFIX = '상품 링크: ';
const TAG_LINE = /^\s*#\S+(?:\s+#\S+)*\s*$/;

/**
 * 캡션 완성본 만들기 (순수 함수, 같은 입력을 다시 넣어도 결과가 같다).
 *   1) 첫 줄 = 파트너스 고지 (변형 문구에 필수 요소가 없으면 기본 문구로 되돌림. 끌 수 없음)
 *   2) 본문 (AI가 쓴 고지·링크·안내 줄은 걷어내고 한 번만 넣는다)
 *   3) 링크 줄 (링크가 없으면 줄을 만들지 않고, 대신처럼 보이는 문구도 넣지 않는다 → warnings 에 LINK_EMPTY)
 *   4) "배송·가격은 링크에서 확인" 줄 (항상)
 *   5) 해시태그 줄 (본문 끝에 있던 것)
 * @param {{caption?:string, link?:string, disclosureVariant?:number|string}} arg
 * @returns {{text:string, warnings:{code:string,messageKo:string,terms?:string[]}[], disclosure:string, hasLink:boolean}}
 */
export function composeCaption({ caption = '', link = '', disclosureVariant = 0, disclosure: withDisclosure = false } = {}) {
  const warnings = [];
  // 고지문은 설정(captionDisclosure)으로 켰을 때만 첫 줄에 붙는다(2026-10-29: 카드의 [광고] 표기로 충분). 끄면 AI 가 쓴 고지 줄도 걷어낸다
  const disclosure = withDisclosure ? pickDisclosure(disclosureVariant, warnings) : '';
  const lk = normalizeLink(link);
  // 링크는 선택(댓글 → DM 으로 보내는 흐름이 기본)이라 비어 있어도 경고하지 않는다
  if (lk.state === 'invalid') warnings.push({ code: 'LINK_INVALID', messageKo: '링크 형식이 올바르지 않아 넣지 않았어요. 파트너스에서 만든 링크를 다시 붙여넣어 주세요.' });
  else if (lk.state === 'not_coupang') warnings.push({ code: 'LINK_NOT_COUPANG', messageKo: '쿠팡 파트너스 링크가 아닌 것 같아요. 수수료 링크가 맞는지 확인해 주세요.' });

  // 본문 정리: 이미 들어 있는 고지·링크·안내 줄 제거
  const variantTexts = new Set(DISCLOSURE_VARIANTS);
  let lines = String(caption ?? '').replace(/\r\n?/g, '\n').split('\n');
  lines = lines.filter((l) => {
    const t = l.trim();
    if (!t) return true;
    if (variantTexts.has(t) || (disclosure && t === disclosure)) return false;
    if (hasRequired(t)) return false;           // AI가 직접 쓴 고지 줄
    if (t === PRICE_NOTICE || t.startsWith(LINK_PREFIX)) return false;
    return true;
  });
  // 끝의 해시태그 줄 분리
  const tags = [];
  while (lines.length && (!lines[lines.length - 1].trim() || TAG_LINE.test(lines[lines.length - 1]))) {
    const l = lines.pop();
    if (l.trim()) tags.unshift(l.trim());
  }
  const body = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  const claims = findVolatileClaims(body);
  if (claims.length) {
    warnings.push({ code: 'VOLATILE_CLAIM', messageKo: `배송·가격처럼 바뀔 수 있는 표현이 있어요: ${[...new Set(claims.map((c) => c.match))].join(', ')}. 빼거나 "바뀔 수 있어요"처럼 단정하지 않는 말로 바꿔 주세요.`, terms: [...new Set(claims.map((c) => c.term))] });
  }

  const parts = [];
  if (disclosure) parts.push(disclosure, '');
  if (body) parts.push(body);
  if (lk.url) parts.push('', LINK_PREFIX + lk.url, PRICE_NOTICE);   // 링크가 있을 때만 링크 줄 + 가격 안내 줄
  if (tags.length) parts.push('', tags.join('\n'));
  return { text: parts.join('\n').trim(), warnings, disclosure, hasLink: !!lk.url };
}

// ───────────────────────── 상품 URL · Product 정규화 (서비스워커가 콘텐츠 payload 를 믿지 않고 다시 만든다) ─────────────────────────

const CDN_HOST = /(^|\.)coupangcdn\.com$/;

/** 상품 페이지 주소에서 ID 추출. 쿠팡 상품 주소가 아니면 null. */
export function parseProductUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname !== 'www.coupang.com') return null;
  const m = u.pathname.match(/^\/vp\/products\/(\d{1,20})\/?$/);
  if (!m) return null;
  const digits = (v) => (/^\d{1,20}$/.test(v || '') ? v : null);
  const itemId = digits(u.searchParams.get('itemId'));
  const vendorItemId = digits(u.searchParams.get('vendorItemId'));
  return { productId: m[1], itemId, vendorItemId, canonical: canonicalProductUrl({ productId: m[1], itemId, vendorItemId }) };
}

/** 추적 값을 뺀 상품 주소. (딥링크 입력·Product.url) */
export function canonicalProductUrl({ productId, itemId = null, vendorItemId = null }) {
  const q = [];
  if (itemId) q.push(`itemId=${itemId}`);
  if (vendorItemId) q.push(`vendorItemId=${vendorItemId}`);
  return `https://www.coupang.com/vp/products/${productId}${q.length ? '?' + q.join('&') : ''}`;
}

const cleanText = (s, max) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
export const formatPrice = (n) => `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}원`;

function cleanImageUrl(u) {
  let x;
  try { x = new URL(String(u)); } catch { return null; }
  if (x.protocol !== 'https:' || !CDN_HOST.test(x.hostname)) return null;
  return x.toString();
}

/**
 * 콘텐츠 스크립트가 보낸 상품을 계약된 Product 로 정규화한다. 모르는 필드는 버리고, 값은 모두 다시 검사한다.
 * 가격을 못 읽었으면 price:null, priceText:null (단정 금지). 변동 정보(배송·할인)는 넣지 않는다(v3 §4-C).
 * @param {object} raw  콘텐츠가 보낸 값(위조 가능)
 * @param {{url:string, terms?:string[], capturedAt?:string}} opt  url 은 서비스워커가 확인한 탭 주소
 */
export function normalizeProduct(raw, { url, terms, capturedAt } = {}) {
  const info = parseProductUrl(url);
  if (!info) throw new AppError('쿠팡 상품 페이지가 아니라서 상품 정보를 받지 않았어요.', { raw: `url=${String(url).slice(0, 200)}`, where: WHERE.SW, code: 'NOT_PRODUCT_PAGE' });
  const r = raw && typeof raw === 'object' ? raw : {};

  let price = Number(r.price);
  price = Number.isFinite(price) && Number.isInteger(price) && price >= 100 && price <= 100000000 ? price : null;

  const images = [];
  for (const u of Array.isArray(r.images) ? r.images : []) {
    const c = cleanImageUrl(u);
    if (c && !images.includes(c)) images.push(c);
    if (images.length >= 8) break;
  }

  // 설명: 변동 사실(로켓배송 등)이 들어간 줄은 빼고 3,000자로 자른다.
  let description = String(r.description ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  description = description.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter((l) => !findVolatileClaims(l, { terms }).length).join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 3000);

  const breadcrumb = [];
  for (const b of Array.isArray(r.breadcrumb) ? r.breadcrumb : []) {
    const t = cleanText(b, 40);
    if (t && !breadcrumb.includes(t)) breadcrumb.push(t);
    if (breadcrumb.length >= 8) break;
  }

  return {
    source: 'coupang_page',
    url: info.canonical,
    productId: info.productId,
    itemId: info.itemId,
    vendorItemId: info.vendorItemId,
    title: cleanText(r.title, 200),
    price,
    priceText: price == null ? null : formatPrice(price),
    images,
    description,
    breadcrumb,
    capturedAt: capturedAt || new Date().toISOString(),
  };
}

/** 검색 결과 한 건 → Product 모양. (페이지 없이 검색으로 시작할 때. source 는 'coupang_search') */
export function searchItemToProduct(item) {
  const price = Number.isInteger(item?.price) ? item.price : null;
  return {
    source: 'coupang_search', url: item?.partnersUrl || '', productId: String(item?.productId ?? ''), itemId: null, vendorItemId: null,
    title: cleanText(item?.title, 200), price, priceText: price == null ? null : formatPrice(price),
    images: item?.image ? [item.image] : [], description: '', breadcrumb: item?.categoryName ? [cleanText(item.categoryName, 40)] : [],
    capturedAt: new Date().toISOString(),
  };
}

// ───────────────────────── HMAC 서명 (v3 §4-B) ─────────────────────────

/** UTC 기준 yyMMdd'T'HHmmss'Z' */
export function formatSignedDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

export async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Authorization 헤더 값 만들기. message = signed-date + METHOD + path + query(물음표 없이).
 * @returns {{authorization:string, signedDate:string, signature:string}}
 */
export async function buildAuthorization({ accessKey, secretKey, method, path, query = '', date = new Date() }) {
  const signedDate = formatSignedDate(date);
  const message = signedDate + String(method).toUpperCase() + path + String(query).replace(/^\?/, '');
  const signature = await hmacSha256Hex(secretKey, message);
  return { authorization: `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${signedDate}, signature=${signature}`, signedDate, signature };
}

// ───────────────────────── 파트너스 API 호출 · 한도 보호 ─────────────────────────

const API_ORIGIN = 'https://api-gateway.coupang.com';
const API_BASE = '/v2/providers/affiliate_open_api/apis/openapi/v1';
export const SEARCH_LIMIT_PER_HOUR = 8;
const HOUR_MS = 60 * 60 * 1000;
const BLOCK_403_MS = 6 * HOUR_MS;      // 403 한 번에 멈춘다: 3회면 계정 제한 위험(v3 §4-B)
const BLOCK_429_MS = 30 * 60 * 1000;
const API_TIMEOUT_MS = 15000;

// 테스트에서 네트워크를 가로챌 수 있게 fetch 를 한 곳으로 모은다.
const doFetch = (...a) => globalThis.fetch(...a);

const KV_API = 'coupang.api';             // {searches:[ms…], blockedUntil, blockedReason}
const KV_PRODUCTS = 'coupang.products';   // {[tabId]: record}
const KV_DEEPLINKS = 'coupang.deeplinks'; // {[projectId]: {…, at}}

let kvChain = Promise.resolve();
/** kv 읽고-쓰기를 순서대로 (동시에 눌러도 횟수가 새지 않게) */
function serial(fn) {
  const job = kvChain.then(fn);
  kvChain = job.catch(() => {});
  return job;
}

async function readApiState(now = Date.now()) {
  const s = (await store.kvGet(KV_API, null)) || {};
  return {
    searches: (Array.isArray(s.searches) ? s.searches : []).filter((t) => Number.isFinite(t) && now - t < HOUR_MS && t <= now + 1000),
    blockedUntil: Number(s.blockedUntil) > now ? Number(s.blockedUntil) : 0,
    blockedReason: Number(s.blockedUntil) > now ? String(s.blockedReason || '') : '',
  };
}

const minutesLeft = (ms) => Math.max(1, Math.ceil(ms / 60000));
const fmtWait = (ms) => (ms >= HOUR_MS ? `약 ${Math.ceil(ms / HOUR_MS)}시간` : `${minutesLeft(ms)}분`);

async function requireKeys() {
  const { coupangAccessKey, coupangSecretKey } = await store.getSecrets();
  if (!coupangAccessKey || !coupangSecretKey) {
    throw new AppError('쿠팡 파트너스 키가 없어요. 옵션에서 Access Key와 Secret Key를 넣거나, 파트너스에서 만든 링크를 직접 붙여넣어 주세요.', { raw: 'coupang keys missing', where: WHERE.SW, code: 'NO_KEYS' });
  }
  return { accessKey: coupangAccessKey, secretKey: coupangSecretKey };
}

/** 이미 막힌 상태면 호출하지 않고 안내한다. */
async function assertNotBlocked() {
  const st = await readApiState();
  if (st.blockedUntil) {
    const left = st.blockedUntil - Date.now();
    throw new AppError(`쿠팡 파트너스 API 호출을 잠시 멈춰 두었어요. ${fmtWait(left)} 뒤에 다시 시도할 수 있어요. 계정 보호를 위한 조치예요. 키와 파트너스 승인 상태를 확인하고, 그동안은 링크를 직접 붙여넣어 주세요.`, { raw: `blocked(${st.blockedReason}) until ${new Date(st.blockedUntil).toISOString()}`, where: WHERE.SW, code: 'API_BLOCKED' });
  }
}

async function setBlock(ms, reason) {
  await serial(async () => {
    const st = await readApiState();
    await store.kvSet(KV_API, { searches: st.searches, blockedUntil: Date.now() + ms, blockedReason: reason });
  });
}

/** 검색 1회분을 먼저 차감한다(실패해도 센다 — 한도 보호가 우선). 한도 초과면 호출하지 않는다. */
function reserveSearch() {
  return serial(async () => {
    const now = Date.now();
    const st = await readApiState(now);
    if (st.blockedUntil) {
      throw new AppError(`쿠팡 파트너스 API 호출을 잠시 멈춰 두었어요. ${fmtWait(st.blockedUntil - now)} 뒤에 다시 시도할 수 있어요. 계정 보호를 위한 조치예요. 키와 파트너스 승인 상태를 확인해 주세요.`, { raw: `blocked(${st.blockedReason}) until ${new Date(st.blockedUntil).toISOString()}`, where: WHERE.SW, code: 'API_BLOCKED' });
    }
    if (st.searches.length >= SEARCH_LIMIT_PER_HOUR) {
      const wait = Math.min(...st.searches) + HOUR_MS - now;
      throw new AppError(`검색은 1시간에 ${SEARCH_LIMIT_PER_HOUR}번까지만 할 수 있어요(쿠팡 계정 보호). ${fmtWait(wait)} 뒤에 다시 검색해 주세요. 상품 페이지에서 시작하면 검색이 필요 없어요.`, { raw: `search count ${st.searches.length}/${SEARCH_LIMIT_PER_HOUR}`, where: WHERE.SW, code: 'SEARCH_LIMIT' });
    }
    const searches = [...st.searches, now];
    await store.kvSet(KV_API, { searches, blockedUntil: 0, blockedReason: '' });
    return { used: searches.length, remaining: SEARCH_LIMIT_PER_HOUR - searches.length, resetAt: Math.min(...searches) + HOUR_MS };
  });
}

async function callApi({ method, path, query = '', body = null }, keys) {
  const { authorization } = await buildAuthorization({ accessKey: keys.accessKey, secretKey: keys.secretKey, method, path, query });
  const url = API_ORIGIN + path + (query ? '?' + query : '');
  let res;
  try {
    res = await doFetch(url, {
      method,
      headers: { Authorization: authorization, 'Content-Type': 'application/json;charset=UTF-8' },
      body: body == null ? undefined : JSON.stringify(body),
      credentials: 'omit',
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (e) {
    throw new AppError('쿠팡 파트너스 서버에 연결하지 못했어요. 인터넷 연결을 확인하고 잠시 뒤 다시 시도해 주세요.', { raw: redactSecrets(`${e?.name}: ${e?.message} (${method} ${path})`, [keys.accessKey, keys.secretKey]), where: WHERE.SW, code: 'API_NETWORK' });
  }
  const text = await res.text().catch(() => '');
  const rawOf = () => redactSecrets(`HTTP ${res.status} ${method} ${path} ${text.slice(0, 300)}`, [keys.accessKey, keys.secretKey]);
  if (res.status === 403) {
    await setBlock(BLOCK_403_MS, '403');
    throw new AppError('쿠팡 파트너스가 접근을 거부했어요(403). 계정이 제한되지 않도록 지금부터 약 6시간 동안 API 호출을 멈춰요. Access Key·Secret Key가 맞는지, 파트너스 승인(API 사용 권한)이 났는지 확인해 주세요. 그동안은 링크를 직접 붙여넣으면 됩니다.', { raw: rawOf(), where: WHERE.SW, code: 'API_FORBIDDEN' });
  }
  if (res.status === 429) {
    await setBlock(BLOCK_429_MS, '429');
    throw new AppError('쿠팡 파트너스가 요청이 너무 많다고 답했어요(429). 30분 동안 API 호출을 멈춰요. 잠시 뒤에 다시 시도해 주세요.', { raw: rawOf(), where: WHERE.SW, code: 'API_RATE_LIMIT' });
  }
  if (res.status === 401) {
    throw new AppError('쿠팡 파트너스 키 확인에 실패했어요(401). 옵션의 Access Key·Secret Key를 다시 붙여넣어 주세요. PC 시계가 크게 틀려도 이 오류가 나요.', { raw: rawOf(), where: WHERE.SW, code: 'API_UNAUTHORIZED' });
  }
  if (!res.ok) {
    throw new AppError(`쿠팡 파트너스 서버가 오류로 답했어요(${res.status}). 잠시 뒤 다시 시도해 주세요.`, { raw: rawOf(), where: WHERE.SW, code: 'API_ERROR' });
  }
  let json;
  try { json = JSON.parse(text); } catch {
    throw new AppError('쿠팡 파트너스 응답을 읽지 못했어요.', { raw: rawOf(), where: WHERE.SW, code: 'API_BAD_RESPONSE' });
  }
  if (json && json.rCode !== undefined && !['0', '200'].includes(String(json.rCode))) {
    throw new AppError(`쿠팡 파트너스가 요청을 받아들이지 않았어요: ${cleanText(json.rMessage, 100) || '사유 없음'}`, { raw: rawOf(), where: WHERE.SW, code: 'API_ERROR' });
  }
  return json;
}

const asPrice = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 100 && n <= 100000000 ? n : null; };

/** 검색 응답의 상품 한 건 → 화면용. 변동 정보(isRocket·isFreeShipping)는 일부러 버린다(v3 §4-C). */
function mapSearchItem(it) {
  const price = asPrice(it?.productPrice);
  return {
    productId: String(it?.productId ?? ''),
    title: cleanText(it?.productName, 200),
    price,
    priceText: price == null ? null : formatPrice(price),
    image: cleanImageUrl(it?.productImage),
    partnersUrl: normalizeLink(it?.productUrl).url || '',   // 파트너스 링크(수수료 링크)
    categoryName: cleanText(it?.categoryName, 40),
  };
}

// ───────────────────────── 탭별 최근 상품 (kv) ─────────────────────────

const pending = new Map(); // tabId → Promise<record>   (productCaptured 처리 중인 것)

async function updateProducts(fn) {
  return serial(async () => {
    const all = (await store.kvGet(KV_PRODUCTS, null)) || {};
    const out = await fn(all);
    const keep = Object.values(all).sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || '')).slice(0, 12);
    await store.kvSet(KV_PRODUCTS, Object.fromEntries(keep.map((r) => [String(r.tabId), r])));
    return out;
  });
}
const getRecord = async (tabId) => ((await store.kvGet(KV_PRODUCTS, null)) || {})[String(tabId)] || null;

/** 패널·콘텐츠에 돌려줄 모양 (내부용 fallbacks 는 뺀다) */
const publicRecord = (r) => ({ tabId: r.tabId, product: r.product, imageIds: r.imageIds, extractDebug: r.debug || null, via: r.via, savedAt: r.savedAt, warnings: r.warnings || [] });

async function fetchImageIndex(rec, index, ctx) {
  const url = rec.product.images[index];
  if (!url) return { imageId: null };
  const tries = [url, rec.fallbacks?.[url]].filter((u, i, a) => u && cleanImageUrl(u) && a.indexOf(u) === i);
  let lastErr = null;
  for (const u of tries) {
    try {
      const r = await coreHandlers['core.fetchImage']({ url: u, kind: 'remote' }, ctx);
      return { imageId: r.imageId, meta: r, usedUrl: u };
    } catch (e) { lastErr = e; }
  }
  return { imageId: null, error: lastErr };
}

async function saveCaptured(tabId, pageUrl, payload, via, ctx) {
  const terms = (await ensureVolatileTerms()).terms;
  const product = normalizeProduct(payload?.product, { url: pageUrl, terms });
  // 내려받기에 실패하면 원래 썸네일 주소로 다시 시도하려고 (큰 크기로 바꾼 주소 → 원본) 짝을 보관한다.
  const fallbacks = {};
  const fb = payload?.imageFallbacks && typeof payload.imageFallbacks === 'object' ? payload.imageFallbacks : {};
  for (const u of product.images) { const o = cleanImageUrl(fb[u]); if (o && o !== u) fallbacks[u] = o; }
  const debug = payload?.extractDebug && typeof payload.extractDebug === 'object' ? JSON.parse(JSON.stringify(payload.extractDebug).slice(0, 6000)) : null;
  const rec = { tabId, product, imageIds: product.images.map(() => null), fallbacks, debug, via, savedAt: new Date().toISOString(), warnings: [] };
  if (!product.title) rec.warnings.push({ code: 'NO_TITLE', messageKo: '상품명을 읽지 못했어요. 직접 입력해 주세요.' });
  if (product.price == null) rec.warnings.push({ code: 'NO_PRICE', messageKo: '가격을 읽지 못했어요. 가격은 링크에서 확인하도록 안내돼요.' });
  if (!product.images.length) rec.warnings.push({ code: 'NO_IMAGE', messageKo: '상품 사진을 찾지 못했어요. 사진을 직접 올려 주세요.' });

  const job = (async () => {
    await updateProducts((all) => { all[String(tabId)] = rec; });
    if (product.images.length) {
      const r = await fetchImageIndex(rec, 0, ctx);
      if (r.imageId) rec.imageIds[0] = r.imageId;
      else rec.warnings.push({ code: 'IMAGE_FETCH_FAILED', messageKo: '대표 사진을 내려받지 못했어요. 다른 사진을 고르거나 직접 올려 주세요.' });
      await updateProducts((all) => { all[String(tabId)] = rec; });
    }
    broadcastUpdated(tabId, product.productId);
    return rec;
  })();
  pending.set(tabId, job);
  try { return await job; } finally { if (pending.get(tabId) === job) pending.delete(tabId); }
}

function broadcastUpdated(tabId, productId) {
  // 패널이 열려 있으면 알려 준다(없으면 무시). chrome.storage.onChanged('kv:coupang.products') 로도 알 수 있다.
  try { chrome.runtime.sendMessage({ type: 'coupang.productUpdated', tabId, productId }).catch(() => {}); } catch { /* 받는 쪽 없음 */ }
}

let termsPromise = null;
function ensureVolatileTerms() {
  if (!termsPromise) termsPromise = loadVolatileTerms().catch(() => ({ source: 'fallback', terms: [...volatileTerms] }));
  return termsPromise;
}

async function resolveTab(p, ctx) {
  const tabId = Number.isInteger(p?.tabId) ? p.tabId : ctx.sender?.tab?.id;
  if (Number.isInteger(tabId)) return chrome.tabs.get(tabId).catch(() => null);
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

/** 사용자가 패널을 열었을 때만 호출: 현재 탭의 콘텐츠 스크립트에게 지금 페이지를 읽어 달라고 요청한다. */
async function captureFromTab(tab, ctx) {
  const ask = () => chrome.tabs.sendMessage(tab.id, { type: 'coupang.capturePage' });
  let res;
  try { res = await ask(); } catch {
    try {
      // 확장을 설치하기 전에 열려 있던 페이지: 콘텐츠 스크립트를 한 번 넣고 다시 요청 (activeTab/호스트 권한 범위)
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/coupang.js'] });
      res = await ask();
    } catch (e2) {
      throw new AppError('이 페이지에서 상품 정보를 읽지 못했어요. 페이지를 새로고침한 뒤 다시 열어 주세요.', { raw: `capture: ${e2?.message}`, where: WHERE.SW, code: 'CAPTURE_FAILED' });
    }
  }
  if (!res?.ok) throw new AppError(res?.error?.messageKo || '상품 정보를 읽지 못했어요.', { raw: res?.error?.raw || 'content 응답 없음', where: WHERE.CONTENT, code: 'CAPTURE_FAILED' });
  return saveCaptured(tab.id, tab.url, res, 'panel', ctx);
}

// ───────────────────────── 핸들러 ─────────────────────────

// 웹 버전: 쿠팡 페이지 읽기·파트너스 API 는 브라우저 CORS 와 비밀 키 노출 때문에 쓸 수 없다. 응답은 항상 같은 모양으로 막는다.
const webUnavailable = () => new AppError('웹 버전에서는 쿠팡 파트너스 API를 쓸 수 없어요. 파트너스에서 만든 링크를 붙여 넣어 주세요.', { raw: 'web: coupang api 비활성', where: WHERE.SW, code: 'WEB_UNAVAILABLE' });

export const handlers = {
  /**
   * 콘텐츠 스크립트(플로팅 버튼 클릭) → 서비스워커. payload {product, imageFallbacks?, extractDebug?}.
   * 주소는 payload 가 아니라 서비스워커가 아는 탭 주소를 쓴다. 대표 사진을 IndexedDB 로 받아 imageIds 를 붙여 저장한다.
   * 패널 열기는 콘텐츠가 같은 클릭에서 core.openPanel 을 따로 보낸다(사용자 제스처 유지).
   */
  'coupang.productCaptured': async (p, ctx) => {
    const tabId = ctx.sender?.tab?.id ?? (ctx.from === 'ext' && Number.isInteger(p?.tabId) ? p.tabId : null);
    if (!Number.isInteger(tabId)) throw new AppError('어느 탭의 상품인지 알 수 없어요.', { raw: 'sender.tab 없음', where: WHERE.SW, code: 'NO_TAB' });
    const pageUrl = ctx.sender?.tab?.url || ctx.sender?.url || p?.product?.url;
    const rec = await saveCaptured(tabId, pageUrl, p, ctx.from === 'content' ? 'fab' : 'ext', ctx);
    return publicRecord(rec);
  },

  /**
   * 패널 → 현재 탭 상품. payload {tabId?, refresh?}. 저장된 것이 없거나 다른 상품이면 현재 탭의 콘텐츠 스크립트에게 읽어 달라고 요청한다.
   * → {tabId, product|null, imageIds, extractDebug, via, savedAt, warnings, reason?}   reason: NOT_PRODUCT_PAGE | CAPTURE_FAILED (+ messageKo, raw, where)
   */
  'coupang.getCurrentProduct': async (p, ctx) => {
    if (IS_WEB) return { tabId: null, product: null, imageIds: [], reason: 'WEB' };
    const tab = await resolveTab(p, ctx);
    const info = tab ? parseProductUrl(tab.url) : null;
    if (!tab || !info) return { tabId: tab?.id ?? null, product: null, imageIds: [], reason: 'NOT_PRODUCT_PAGE' };
    if (pending.has(tab.id)) await Promise.race([pending.get(tab.id).catch(() => null), new Promise((r) => setTimeout(r, 8000))]);
    let rec = await getRecord(tab.id);
    const same = rec && rec.product.productId === info.productId && rec.product.itemId === info.itemId;
    if (!same || p?.refresh) {
      try { rec = await captureFromTab(tab, ctx); } catch (e) {
        return { tabId: tab.id, product: null, imageIds: [], reason: 'CAPTURE_FAILED', messageKo: e.messageKo, raw: e.raw, where: e.where || WHERE.SW };
      }
    }
    return publicRecord(rec);
  },

  /** 패널 → 다른 사진 고르기. payload {tabId?, index} → {index, url, imageId, mime, width, height}. product.images 안의 사진만 받는다. */
  'coupang.fetchProductImage': async (p, ctx) => {
    if (IS_WEB) throw new AppError('웹 버전에서는 쿠팡 사진을 가져올 수 없어요. 사진 파일을 직접 올려 주세요.', { raw: 'web: 쿠팡 사진 비활성', where: WHERE.SW, code: 'WEB_UNAVAILABLE' });
    const tab = await resolveTab(p, ctx);
    const rec = tab ? await getRecord(tab.id) : null;
    const index = Number(p?.index);
    if (!rec || !Number.isInteger(index) || index < 0 || index >= rec.product.images.length) {
      throw new AppError('고를 수 있는 사진을 찾지 못했어요. 상품 페이지에서 다시 시작해 주세요.', { raw: `tab=${tab?.id} index=${p?.index}`, where: WHERE.SW, code: 'NOT_FOUND' });
    }
    if (rec.imageIds[index]) {
      const img = await store.getImage(rec.imageIds[index]);
      if (img) return { index, url: rec.product.images[index], imageId: img.id, mime: img.type, width: img.width ?? null, height: img.height ?? null };
    }
    const r = await fetchImageIndex(rec, index, ctx);
    if (!r.imageId) {
      throw new AppError('사진을 내려받지 못했어요. 다른 사진을 고르거나 직접 올려 주세요.', { raw: r.error?.raw || r.error?.message || '', where: WHERE.SW, code: 'IMAGE_FETCH_FAILED' });
    }
    await updateProducts((all) => { const cur = all[String(rec.tabId)]; if (cur) cur.imageIds[index] = r.imageId; });
    return { index, url: rec.product.images[index], imageId: r.imageId, mime: r.meta.mime, width: r.meta.width, height: r.meta.height };
  },

  /**
   * 파트너스 상품 검색. 패널에서 사용자가 "검색"을 누를 때만. payload {keyword}.
   * 시간당 8회 제한(서비스워커가 꺼졌다 켜져도 kv 에 기록), 403 이면 즉시 중단하고 이후 약 6시간 막는다.
   * → {items:[{productId,title,price,priceText,image,partnersUrl,categoryName}], used, remaining, resetAt}
   */
  'coupang.search': async (p) => {
    if (IS_WEB) throw webUnavailable();
    const keyword = cleanText(p?.keyword, 60);
    if (!keyword) throw new AppError('검색어를 입력해 주세요.', { raw: 'keyword 없음', where: WHERE.SW, code: 'BAD_INPUT' });
    const keys = await requireKeys();
    const slot = await reserveSearch();
    const { subId } = await store.getSettings();
    const query = `keyword=${encodeURIComponent(keyword)}&limit=10` + (subId ? `&subId=${encodeURIComponent(subId)}` : '');
    const json = await callApi({ method: 'GET', path: `${API_BASE}/products/search`, query }, keys);
    const list = Array.isArray(json?.data?.productData) ? json.data.productData : [];
    return { items: list.slice(0, 10).map(mapSearchItem).filter((x) => x.productId && x.title), used: slot.used, remaining: slot.remaining, resetAt: slot.resetAt };
  },

  /**
   * 딥링크(파트너스 단축 링크) 만들기. 캐러셀(projectId)당 1번만 API 를 부르고 이후는 저장된 값을 돌려준다.
   * payload {projectId, url?}  url 이 없으면 현재 탭 상품 주소. → {shortenUrl, landingUrl, originalUrl, cached}
   */
  'coupang.deeplink': async (p, ctx) => {
    if (IS_WEB) throw webUnavailable();
    const projectId = cleanText(p?.projectId, 80);
    if (!projectId) throw new AppError('어느 캐러셀의 링크인지 알 수 없어요.', { raw: 'projectId 없음', where: WHERE.SW, code: 'BAD_INPUT' });
    const cache = (await store.kvGet(KV_DEEPLINKS, null)) || {};
    if (cache[projectId]) { const { at, ...rest } = cache[projectId]; return { ...rest, cached: true }; }
    let url = p?.url;
    if (!url) { const tab = await resolveTab(p, ctx); url = tab?.url; }
    const info = parseProductUrl(url);
    if (!info) throw new AppError('쿠팡 상품 주소가 아니라서 링크를 만들 수 없어요. 파트너스에서 만든 링크를 직접 붙여넣어 주세요.', { raw: `url=${String(url).slice(0, 200)}`, where: WHERE.SW, code: 'NOT_PRODUCT_PAGE' });
    const keys = await requireKeys();
    await assertNotBlocked();
    const { subId } = await store.getSettings();
    const json = await callApi({ method: 'POST', path: `${API_BASE}/deeplink`, body: { coupangUrls: [info.canonical], ...(subId ? { subId } : {}) } }, keys);
    const d = Array.isArray(json?.data) ? json.data[0] : null;
    const shortenUrl = normalizeLink(d?.shortenUrl).url;
    if (!shortenUrl) throw new AppError('쿠팡이 링크를 만들어 주지 않았어요. 파트너스에서 만든 링크를 직접 붙여넣어 주세요.', { raw: 'deeplink 응답에 shortenUrl 없음', where: WHERE.SW, code: 'API_BAD_RESPONSE' });
    const out = { shortenUrl, landingUrl: normalizeLink(d?.landingUrl).url || null, originalUrl: info.canonical };
    await serial(async () => {
      const cur = (await store.kvGet(KV_DEEPLINKS, null)) || {};
      cur[projectId] = { ...out, at: Date.now() };
      const keep = Object.entries(cur).sort((a, b) => b[1].at - a[1].at).slice(0, 50);
      await store.kvSet(KV_DEEPLINKS, Object.fromEntries(keep));
    });
    return { ...out, cached: false };
  },

  /** 패널 → 키 있음/없음, 남은 검색 횟수, 막힘 상태. payload {projectId?}. 키 값은 돌려주지 않는다. */
  'coupang.status': async (p) => {
    const s = await store.getPublicSettings();
    const st = await readApiState();
    const now = Date.now();
    const deeplinks = (await store.kvGet(KV_DEEPLINKS, null)) || {};
    return {
      webDisabled: IS_WEB, // 웹 버전: 검색·딥링크·페이지 읽기 모두 꺼짐 (화면은 이 값을 보고 안내를 바꾼다)
      hasKeys: !IS_WEB && !!(s.has.coupangAccessKey && s.has.coupangSecretKey),
      hasAccessKey: s.has.coupangAccessKey,
      hasSecretKey: s.has.coupangSecretKey,
      hasSubId: !!s.subId,
      search: { limit: SEARCH_LIMIT_PER_HOUR, used: st.searches.length, remaining: Math.max(0, SEARCH_LIMIT_PER_HOUR - st.searches.length), resetAt: st.searches.length ? Math.min(...st.searches) + HOUR_MS : null },
      blocked: st.blockedUntil ? { until: st.blockedUntil, reason: st.blockedReason, remainingMs: st.blockedUntil - now } : null,
      deeplinkCached: p?.projectId ? !!deeplinks[cleanText(p.projectId, 80)] : null,
    };
  },
};

export const portHandlers = {};
