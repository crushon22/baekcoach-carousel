// 패널 공용 상태와 프로젝트 도우미. 화면 모듈들이 이 파일의 S(상태)와 fn(서로 부르는 함수 모음)을 공유한다.
import { request } from '../lib/bus.js';
import * as store from '../lib/store.js';
import { composeCaption } from '../lib/coupang.js';
import { renderCardMeta, mountPhoneFrame } from '../lib/render.js';
import { debounce, deepClone } from './dom.js';
import { showError } from './errors.js';

export const BRAND = '#2F5BEA';

/** 화면 상태. phase: 'loading' | 'start' | 'generating' | 'ready' */
export const S = {
  settings: null,          // 공개 설정(키 값 없음)
  cp: null,                // coupang.status 결과
  fixedTab: undefined,     // 시험용: ?tabId= 로 고정한 탭(없으면 현재 창의 활성 탭)
  rec: null,               // getCurrentProduct 결과(상품 레코드 또는 {product:null, reason})
  product: null,           // 시작 화면에서 만들 상품(페이지·수동·검색 결과)
  photoIdx: 0,             // product.images 중 대표로 고른 번호(페이지 상품)
  topic: '',
  sel: null,               // 검색 결과로 고른 상품 {kind:'search', item, imageId}
  manual: { title: '', price: '', imageId: null, imageIds: [], desc: '' },
  topicImageIds: [], webKind: 'manual',
  mode: 'cardnews',        // 'cardnews' | 'photo' (시작 화면에서 고른 버전. 마지막 선택을 기억)
  photos: [],              // 사진 캐러셀: 올린 사진 imageId (순서 = 카드 순서)
  photoStyle: 'outline',   // 사진 캐러셀 글씨 스타일
  adLabel: true,           // 사진 왼쪽 위 [광고] 표시
  link: '',                // 만들기 전에 알고 있는 링크(검색 결과의 수수료 링크)
  searchResults: null,
  project: null,
  phase: 'loading',
  tab: 'edit',             // 'edit' | 'review' | 'caption'
  cardIndex: 0,
  pf: null,
  stream: null,
  progress: null,          // {stage, label, got, total}
  chat: [],                // [{role:'user'|'assistant', text, at}]
  newProductBanner: null,  // 작업 중 다른 상품 알림 {productId, title}
  openHints: {},           // 시험·진단용
};

/** 서로 다른 화면 모듈이 부르는 함수 모음(순환 import 방지). 각 모듈이 자기 함수를 등록한다. */
export const fn = {};
export const el = {};      // 주요 DOM 자리 (boot 에서 채움)

// ───────────────────────── 이미지 ─────────────────────────

const urlCache = new Map();
/** imageId → <img> 에 쓸 object URL (IndexedDB 의 Blob. 외부 주소를 직접 그리지 않는다 — 규칙 8) */
export async function imageUrl(imageId) {
  if (!imageId) return null;
  if (urlCache.has(imageId)) return urlCache.get(imageId);
  const u = await store.getImageObjectUrl(imageId);
  if (u) urlCache.set(imageId, u);
  return u || null;
}
export function forgetImageUrl(imageId) {
  const u = urlCache.get(imageId);
  if (u) { URL.revokeObjectURL(u); urlCache.delete(imageId); }
}

// ───────────────────────── 프로젝트 도우미 ─────────────────────────

export const isPhoto = (p = S.project) => p?.carousel?.mode === 'photo';
export const cards = () => S.project?.carousel?.cards || [];
export const factIssues = () => (S.project?.issues || []).filter((i) => i.level === 'fact' && !i.resolved);
export const formatIssues = () => (S.project?.issues || []).filter((i) => i.level === 'format');

/** 대표(상품) 사진 id: 만들 때 쓴 첫 사진 */
export const mainImageId = () => S.project?.input?.imageIds?.[0] || null;

/** 지금 프로젝트에 쓰인 모든 이미지 id (저장·보관용) */
export function collectImageIds(p) {
  const ids = new Set([...(p?.input?.imageIds || [])]);
  for (const c of p?.carousel?.cards || []) if (c?.imageId) ids.add(c.imageId);
  return [...ids];
}

/** 캡션 최종본(고지 첫 줄·링크·안내 포함). 내보내기와 같은 함수를 쓴다. */
export function composed(project = S.project) {
  if (!project) return null;
  return composeCaption({ caption: project.caption || '', link: project.link || '', disclosureVariant: S.settings?.disclosureVariant ?? 0 });
}

/** 해시태그 최종본: 고정 태그를 합치고 중복 제거 */
export function finalTags(project = S.project) {
  const seen = new Set();
  const out = [];
  for (const t of [...(project?.hashtags || []), ...(S.settings?.fixedTags || [])]) {
    const x = String(t || '').trim().replace(/\s+/g, '');
    if (!x) continue;
    const tag = x.startsWith('#') ? x : `#${x}`;
    if (tag.length < 2 || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out;
}

/** 쇼츠 대본을 한 덩어리 글로 */
export function shortsText(shorts) {
  if (!shorts) return '';
  const subs = (shorts.subtitles || []).map((s, i) => `${i + 1}. ${s}`).join('\n');
  return [
    '[0~3초 훅]', shorts.hook || '', '',
    '[3~20초 본문]', shorts.body || '', '',
    '[마지막 CTA]', shorts.cta || '', '',
    '[자막용 짧은 줄]', subs,
  ].join('\n').trim();
}

// ───────────────────────── 저장 ─────────────────────────

let saving = Promise.resolve();
export async function saveNow() {
  const p = S.project;
  if (!p || S.phase !== 'ready') return;
  saving = saving.then(async () => {
    try {
      const rec = await store.putProject(p);
      p.id = rec.id;
      await store.attachImages(collectImageIds(p), p.id);
      await store.putChat(p.id, S.chat.slice(-40));
    } catch (e) { showError(e); }
  });
  return saving;
}
export const scheduleSave = debounce(saveNow, 600);

// ───────────────────────── 상태 표시줄(근거·점수 상시 접근) ─────────────────────────

export function updateStatus() {
  const chip = document.getElementById('status-chip');
  if (!chip) return;
  const p = S.project;
  if (!p || (S.phase !== 'ready' && !(p.issues && p.score))) { chip.hidden = true; return; }
  const n = factIssues().length;
  const total = p.score?.total;
  chip.hidden = false;
  chip.textContent = n ? `🔎${n}건 · ${total ?? '-'}점` : `✅ ${total ?? '-'}점`;
  chip.dataset.level = n ? 'warn' : 'ok';
  chip.setAttribute('aria-label', `근거 없음 ${n}건, 저장 가능성 ${total ?? '-'}점. 누르면 근거·검수 탭을 엽니다.`);
}

// ───────────────────────── 폰 프레임 ─────────────────────────

/** 화면용 carousel (아직 도착 안 한 칸은 null) */
export function pfCarousel() {
  const c = S.project?.carousel || { cards: [] };
  return c;
}

export function mountPf(total) {
  S.pf?.destroy();
  el.phone.replaceChildren();
  el.phone.hidden = false;
  document.body.dataset.phone = '1';
  S.pf = mountPhoneFrame(el.phone, {
    carousel: pfCarousel(), total, scale: 0.75, caption: composed()?.text || '',
    onIndexChange: (i) => { S.cardIndex = i; fn.onCardIndex?.(i); },
    onCardTap: (i) => { S.cardIndex = i; fn.openTab?.('edit', { scroll: true }); fn.onCardIndex?.(i); },
  });
  return S.pf;
}
export function unmountPf() {
  delete document.body.dataset.phone;
  S.pf?.destroy();
  S.pf = null;
  el.phone.replaceChildren();
  el.phone.hidden = true;
}
/** 한 칸만 다시 그린다 */
export function refreshCard(i) {
  const c = cards()[i];
  if (S.pf && c) return S.pf.setCard(i, c);
}
/** 템플릿·강조색·링크처럼 전체가 바뀔 때 */
export function refreshAll() {
  if (!S.pf || !S.project) return;
  return S.pf.update(pfCarousel(), { total: cards().length, caption: composed()?.text || '' });
}
export function refreshCaptionInFrame() { S.pf?.setCaption(composed()?.text || ''); }

/** 카드 한 장의 글자 넘침 점검 (작은 크기로 그려 meta 만 본다) */
export async function cardMeta(i, carousel = S.project?.carousel) {
  if (!carousel?.cards?.[i]) return null;
  try { return (await renderCardMeta(carousel, i, { scale: 0.12, total: carousel.cards.length })).meta; } catch (e) { console.warn('[panel] 카드 점검 실패', e); return null; }
}

// ───────────────────────── 검수 다시 ─────────────────────────

let reviewSeq = 0;
export async function runReview() {
  if (!S.project || S.phase !== 'ready') return;
  const seq = ++reviewSeq;
  try {
    const r = await request('ai.review', { project: S.project });
    if (seq !== reviewSeq || !S.project) return;
    S.project.issues = r.issues;
    S.project.score = r.score;
    updateStatus();
    fn.renderReview?.();
    fn.renderEditMeta?.();
    scheduleSave();
  } catch (e) { showError(e); }
}
export const scheduleReview = debounce(runReview, 700);

/** ai.applyFix / ai.chat 의 patch 를 프로젝트에 적용하고 바뀐 부분만 다시 그린다. */
export function applyPatch(patch) {
  const p = S.project;
  if (!p || !patch) return { all: false, changed: [] };
  let all = false;
  const changed = [];
  if (patch.carousel) { Object.assign(p.carousel, patch.carousel); all = true; }
  if (patch.plan) { Object.assign(p.plan, patch.plan); if (patch.plan.template) { p.options = { ...(p.options || {}), template: patch.plan.template }; } }
  for (const [i, card] of Object.entries(patch.cards || {})) { p.carousel.cards[Number(i)] = card; changed.push(Number(i)); }
  if (patch.caption !== undefined) p.caption = patch.caption;
  if (patch.facts) p.facts = patch.facts;
  if (patch.issues) p.issues = patch.issues;
  if (patch.score) p.score = patch.score;
  if (all) refreshAll(); else changed.forEach(refreshCard);
  if (patch.caption !== undefined) refreshCaptionInFrame();
  updateStatus();
  scheduleSave();
  return { all, changed };
}

export { deepClone };
