// 더미 AI — 설정 devMockAI === true 일 때만 쓰인다(테스트 전용, 옵션 화면에 노출하지 않음). 실제 경로(agents.js)와 코드를 나눴다.
// 네트워크(Gemini) 호출 없이 "그럴듯한 고정 응답"을 실제와 같은 이벤트 순서·지연으로 흘린다:
//   plan → card(도착 순서가 살짝 뒤섞임) → facts → caption → review → score → shorts → done
// 카드 글·claims·facts 는 고정 틀이고, 일부러 근거 없는 문장 1개("후기 300개 분석" 또는 "처리 시간 50% 단축")를 넣어 🔎가 걸리게 한다.
// 검수·점수는 진짜 코드(review.js · score.js)를 그대로 돌린다 — 더미여도 🔎 탐지는 실제 규칙으로 일어난다.
// 이 상태를 "완료"로 치지 않는다(CLAUDE.md 규칙 5). 결과 Project 에는 mock:true 와 안내 문구가 들어 있다.

import { AppError, WHERE, sleep } from './common.js';
import * as store from './store.js';
import { Knowledge, guessCategory, effectivePhotoRules } from './knowledge.js';
import { ruleReview, reviewShorts, normalizeClaims, syncOverlay } from './review.js';
import { computeCarouselScore } from './score.js';
const scoreAdLabel = (S) => (typeof S.options?.adLabel === 'boolean' ? S.options.adLabel : typeof S.prev?.carousel?.adLabel === 'boolean' ? S.prev.carousel.adLabel : true);
import {
  normalizePhotoPlan, buildPhotoCard, carryOverImages, normalizePlan, buildLocalFacts, hasImagesOf, styleCards, assembleHashtags, deriveTitleTags, buildProject, shortTitle, fallbackCaption, shortsFromCards, cleanText, clampInt, teaseOf, findLeak } from './ai-util.js';

const NOTICE = '시험용 더미 응답입니다 — 실제 AI가 쓴 글이 아닙니다';

const op = (text) => ({ text, type: 'opinion', fact_id: null });
const fx = (text, id) => ({ text, type: 'fact', fact_id: id });
const L = (...a) => a.join('\n');

/** 더미 research 결과 facts (검색 출처처럼 보이는 것 2개 + 구매자 호평/아쉬움) */
function mockResearchFacts(t) {
  return [
    { id: 'f1', claim: `${t}은(는) 사용법이 간단하다는 평이 많다`, source: 'example.com/review', sourceTitle: 'example.com', quote: '사용법이 간단하다는 후기 요지', confidence: 'medium', kind: 'praise' },
    { id: 'f2', claim: '무게가 조금 있다는 아쉬움이 있다', source: 'example.com/review', sourceTitle: 'example.com', quote: '무게가 아쉽다는 후기 요지', confidence: 'medium', kind: 'cons' },
  ];
}

function priceWords(input) {
  const p = input.price;
  if (!p) return null;
  return p >= 10000 ? `약 ${Math.round(p / 10000)}만 원대` : `약 ${Math.max(1, Math.round(p / 1000))}천 원대`;
}

/** role → 카드 글 (고정 틀). c = {t, t8, i, count, plan, input, fabricate, ctaText, n(같은 role 안 번호)} */
function cardText(role, c) {
  const price = priceWords(c.input);
  const nth = Number((role.match(/[①-⑨]/) || [])[0] ? '①②③④⑤⑥⑦⑧⑨'.indexOf(role.match(/[①-⑨]/)[0]) + 1 : (role.match(/(\d+)/) || [])[1] || 1);
  if (/^훅/.test(role)) {
    const h = c.plan.hooks[c.plan.hookPick] || c.plan.hooks[0];
    return { headline: h.headline, body: h.body, claims: [op(h.headline)], reason: '훅 공식(숫자·질문·반전) 중 플래너가 고른 안을 그대로 사용' };
  }
  if (/제품 등장/.test(role)) return { headline: `그래서 고른 ${c.t8}`.slice(0, 16), body: L('복잡한 건 빼고', '필요한 것만 담았어요'), claims: [fx(c.t, 'p1'), op('복잡한 건 빼고 필요한 것만 담았어요')], reason: '제품 등장: 한 줄 포지셔닝' };
  if (/공감|상황|왜 필요/.test(role)) return { headline: '이런 경험, 있으시죠', body: L('매번 고르다가', '시간만 가는 날'), claims: [op('매번 고르다가 시간만 가는 날')], reason: '독자의 현재 불편 한 장면' };
  if (/갈등/.test(role)) return { headline: '쉽지 않았어요', body: L('이것저것 써 봤지만', '손이 자주 갔어요'), claims: [op('이것저것 써 봤지만 손이 자주 갔어요')], reason: '갈등: 시도와 한계' };
  if (/특징|전환/.test(role)) {
    const heads = ['손이 덜 가는 이유', '꺼내 쓰기 편한 이유'];
    return { headline: heads[(nth - 1) % 2], body: L('사용법이 간단하다는', '후기가 꽤 많아요'), bridge: '다음이 더 중요해요', claims: [fx('사용법이 간단하다는 후기가 꽤 많아요', 'f1')], reason: '특징: 독자 문제 → 체감 표현, 근거 f1' };
  }
  if (/결과/.test(role)) return { headline: '쓰고 나니 달라진 것', body: L('고르는 시간이', '눈에 띄게 줄었어요'), claims: [op('고르는 시간이 눈에 띄게 줄었어요')], reason: '결과: 체감 표현(수치 없음)' };
  if (/교훈/.test(role)) return { headline: '결국 기준이 먼저', body: L('내게 맞는 기준부터', '정하면 덜 후회해요'), claims: [op('내게 맞는 기준부터 정하면 덜 후회해요')], reason: '교훈 한 문장' };
  if (/비포|^A\b/.test(role)) return { headline: '쓰기 전엔', body: L('매번 번거로웠고', '손이 자주 갔어요'), claims: [op('매번 번거로웠고 손이 자주 갔어요')], reason: '비포 상태' };
  if (/애프터|^B\b/.test(role)) return { headline: '쓰고 나서는', body: L('꺼내서 바로 쓰는', '흐름이 생겼어요'), claims: [op('꺼내서 바로 쓰는 흐름이 생겼어요')], reason: '애프터 상태' };
  if (/차이 포인트/.test(role)) return { headline: nth === 1 ? '기준 ①: 사용 편의' : '기준 ②: 보관', body: L('일반 제품과 달리', '손이 덜 가는 쪽이에요'), claims: [op('일반 제품과 달리 손이 덜 가는 쪽이에요')], reason: '차이 포인트: 기준 하나' };
  if (/후기\/비교|^후기/.test(role)) {
    const bad = c.fabricate && /후기\/비교/.test(role);
    return {
      headline: '후기가 꼽는 장점', body: bad ? L('후기 300개 분석', '손목이 편하다는 말이 많아요') : L('손목이 편하다는 말이', '자주 보여요'),
      claims: bad ? [{ text: '후기 300개 분석', type: 'fact', fact_id: null }, fx('손목이 편하다는 말이 많아요', 'f1')] : [fx('손목이 편하다는 말이 자주 보여요', 'f1')], reason: '후기 인용: 호평 요지 재서술(facts f1)',
    };
  }
  if (/공통점/.test(role)) return { headline: '써 본 분들의 공통점', body: L('사용법이 간단하다는 점', '무게는 조금 있어요'), claims: [fx('사용법이 간단하다는 점', 'f1'), fx('무게는 조금 있어요', 'f2')], reason: '공통점 + 아쉬운 점 솔직하게(f1·f2)' };
  if (/가격|구성/.test(role)) {
    return {
      headline: price || '가격은 링크에서', body: L(`가격|${price || '링크에서 확인'}`, '구성|상세 페이지 확인', '특징|사용법이 간단'),
      claims: price ? [fx(price, 'p2'), fx('사용법이 간단', 'f1')] : [op('가격은 링크에서 확인')], reason: '가격·구성 표: 가격은 페이지 표시 기준 "약 ○만 원대"',
    };
  }
  if (/전체 요약표/.test(role)) return { headline: '한눈에 정리', body: L('사용법|간단한지', '무게|들어 보기', '구성|빠진 것 없는지', '가격|예산 안인지', '후기|공통 불만', '보관|둘 곳'), claims: [op('구매 전에 확인할 항목 정리')], reason: '전체 요약표' };
  if (/^항목/.test(role)) return { headline: `확인 ${nth * 2 - 1}·${nth * 2}`, body: L(`☐ 크기 재보기|${nth === 1 ? '둘 곳 확인' : '무게 감당 확인'}`, `☐ 후기 읽기|${nth === 1 ? '공통 불만' : '아쉬운 점'}`), claims: [op('구매 전 확인할 항목')], reason: '체크리스트 항목' };
  if (/핵심|실수/.test(role)) {
    const heads = ['시작은 작게', '기준은 하나만', '기록은 짧게', '비교는 두 개만'];
    const isMistake = /실수/.test(role);
    return {
      headline: isMistake ? `❌ ${['한 번에 사기', '후기 안 읽기', '가격만 보기'][(nth - 1) % 3]}`.slice(0, 16) : heads[(nth - 1) % 4], numberLabel: String(nth),
      body: isMistake ? L('→ 대신 하나씩 비교', '이유: 놓치는 게 줄어요') : L('이유: 부담이 줄어요', '방법: 하나만 먼저'),
      bridge: nth < 3 ? '다음이 핵심' : '', claims: [op('하나씩 비교하면 놓치는 게 줄어요')], reason: '핵심 카드: 번호 + 키워드, 이유·방법 한 줄씩',
    };
  }
  if (/정리/.test(role)) return { headline: '한 줄로 정리하면', body: L('기준 하나, 비교 둘', '천천히 고르기'), claims: [op('기준 하나, 비교 둘, 천천히 고르기')], reason: '정리' };
  if (/Q&A/.test(role)) {
    const qa = [['Q. 처음 써도 괜찮나요?', 'A. 사용법이 간단하다는|후기가 많아요'], ['Q. 무겁지 않나요?', 'A. 조금 있다는 평이|있어요'], ['Q. 어디서 사나요?', 'A. 링크에서 확인하세요'], ['Q. 구성은요?', 'A. 상세 페이지에서|확인해 주세요']][(nth - 1) % 4];
    return { headline: qa[0], numberLabel: `Q${nth}`, body: qa[1].replace('|', '\n'), claims: nth <= 2 ? [fx(qa[1].replace('|', ' '), nth === 1 ? 'f1' : 'f2')] : [op(qa[1].replace('|', ' '))], reason: 'Q&A: 후기 기반 질문' };
  }
  if (/^\d위/.test(role)) {
    const rank = Number(role.match(/^(\d)위/)[1]);
    const names = { 5: '입문용 선택', 4: '가성비 선택', 3: '무난한 선택', 2: '사용성 선택', 1: '이 기준의 1순위' };
    return { headline: `${rank}위 ${names[rank] || '선택'}`.slice(0, 16), numberLabel: `${rank}위`, body: L('기준: 사용 편의성', '이유 한 줄로 정리'), claims: [op(`기준은 사용 편의성 하나`)], reason: '랭킹: 기준 하나로 순위' };
  }
  if (/CTA/.test(role)) return { headline: c.ctaText.slice(0, 16), body: L('필요할 때 꺼내 보세요'), cta: c.ctaCta, claims: [op(c.ctaText)], reason: 'CTA 하나만' };
  return { headline: role.slice(0, 16), body: L('핵심만 짧게', '정리했어요'), claims: [op('핵심만 짧게 정리했어요')], reason: '기본 틀' };
}

function buildCards({ plan, input, fabricate, ctaBank, tease = null }) {
  // 댓글 유도: 번호·색상명을 뺀 이름만 쓰고, 마지막은 "번호는 댓글로". mockLeak 이면 2번 카드에 일부러 번호를 새게 한다(⚠️ 검수 시험용)
  const t = shortTitle(tease?.on ? { ...input, title: tease.keep } : input);
  const ctaText = tease?.on ? `댓글에 "${tease.word || '나도'}" 남겨 주세요` : ((ctaBank?.[plan.purpose] || []).find((x) => !x.includes('○'))?.replace(/["“”]/g, '') || '댓글 남겨 주세요');
  const ctaCta = tease?.on ? `댓글에 "${tease.word || '나도'}"` : /링크/.test(plan.purpose) ? '프로필 링크' : /댓글/.test(plan.purpose) ? '댓글 남기기' : /팔로우/.test(plan.purpose) ? '팔로우' : '저장하기';
  const cards = plan.briefs.map((b, i) => {
    const base = cardText(b.role, { t, t8: t.slice(0, 8), i, count: plan.count, plan, input, fabricate, ctaText, ctaCta });
    return {
      index: i, role: b.role, headline: cleanText(base.headline, 60), body: cleanText(base.body, 320), layout: b.layout, imageSlot: b.imageSlot,
      ...(base.bridge ? { bridge: base.bridge } : {}), ...(base.cta ? { cta: base.cta } : {}), ...(base.numberLabel ? { numberLabel: base.numberLabel } : {}),
      claims: base.claims, reason: base.reason,
    };
  });
  if (tease?.on && tease.leak && tease.hide[0] && cards[1]) cards[1] = { ...cards[1], body: `${tease.hide[0]}번 이게 딱이에요\n${cards[1].body}`.slice(0, 320) };
  // 판매형이 아니거나 후기 카드가 없으면, 3번째 카드에 근거 없는 문장 하나를 심는다
  if (fabricate && !cards.some((c) => c.body.includes('후기 300개 분석'))) {
    const k = Math.min(2, cards.length - 2);
    const lines = cards[k].body.split('\n');
    if (lines.length >= 3) lines[lines.length - 1] = '처리 시간 50% 단축'; else lines.push('처리 시간 50% 단축');
    cards[k] = { ...cards[k], body: lines.join('\n'), claims: [...cards[k].claims, { text: '처리 시간 50% 단축', type: 'fact', fact_id: null }] };
  }
  return cards;
}

async function delayMs() {
  const t = (await store.kvGet('dev:ai', null)) || {};
  return Number.isFinite(Number(t.mockDelayMs)) ? Number(t.mockDelayMs) : 350;
}

async function makePlan({ kn, input, options, hasImages }) {
  const typeDoc = await kn.typeDoc();
  const catDefaults = await kn.categoryDefaults();
  const layoutRules = await kn.layoutRules();
  const hint = guessCategory([...(input.breadcrumb || []), input.title || input.topic || '']);
  const raw = { category: hint || '기타', type: options.type || (input.source === 'topic' ? 'list' : input.source === 'shorts' ? 'list' : 'sales') };
  const plan = normalizePlan(raw, { input, options, typeDoc, catDefaults, layoutRules, hasImages, categoryHint: hint });
  return { plan, typeDoc };
}


// ───────────────────────── 사진 캐러셀 더미 ─────────────────────────

const PHOTO_INNER = [
  ['손에 쏙 들어오는', '가벼운 크기'], ['틈새 구석까지', '쓱 닿아요'], ['버튼 하나로', '바로 시작'], ['선 걱정 없이', '어디서든 쓱'],
  ['정리도 간단해요', '통째로 분리'], ['보관할 때도', '자리 안 차지해요'], ['쓸수록 손이', '덜 가요'], ['한 번 써 보면', '알게 돼요'],
];

function photoHooks(t) {
  const h = t.slice(0, 6).trim();
  return [
    { type: '숫자형', headline: `${h} 고를 때\n이것부터`, body: '' },
    { type: '질문형', headline: `${h} 아직도\n고민 중이세요?`, body: '' },
    { type: '반전형', headline: '비싼 게 답은\n아니었어요', body: '' },
  ];
}

async function photoCardsFor({ plan, input, rules, fabricate, ctaBank, tease = null }) {
  const N = plan.count;
  const hook = plan.hooks[plan.hookPick] || plan.hooks[0];
  const cta = (ctaBank?.[plan.purpose] || []).find((x) => !x.includes('○'))?.replace(/["“”]/g, '') || '저장해 두세요';
  return plan.briefs.map((b, i) => {
    let lines, claims, highlight, pos = i === 0 ? rules.defaultPos.cover : rules.defaultPos.inner;
    if (i === 0) { lines = hook.headline.split('\n'); claims = [{ text: lines.join(' '), type: 'opinion', fact_id: null }]; }
    else if (tease?.on && i === N - 1) { lines = ['궁금하면 댓글에', `"${tease.word || '나도'}" 남겨 주세요`]; claims = [{ text: lines.join(' '), type: 'opinion', fact_id: null }]; highlight = ['댓글에']; }
    else if (tease?.on && tease.leak && i === 1 && tease.hide[0]) { lines = [`${tease.hide[0]}번 발색이`, '딱 이거예요']; claims = [{ text: lines.join(' '), type: 'visual', fact_id: null }]; }
    else if (i === N - 1) { lines = ['마음에 들면', cta.slice(0, 14)]; claims = [{ text: cta, type: 'opinion', fact_id: null }]; }
    else if (fabricate && i === 1) { lines = ['국내 1위 인기', '청소기']; claims = [{ text: '국내 1위 인기', type: 'fact', fact_id: null }]; }
    else { lines = PHOTO_INNER[(i - 1) % PHOTO_INNER.length]; claims = [{ text: `${lines.join(' ')} (사진 속 장면)`, type: 'visual', fact_id: null }]; highlight = [lines[0].split(' ')[0]]; }
    if (i === 2) pos = 'middle';
    const c = buildPhotoCard({ index: i, count: N, imageId: input.imageIds[i], role: b.role, j: { overlay: { lines, position: pos, highlight }, reason: '더미 문장' }, rules });
    return { ...c, claims };
  });
}

async function generatePhoto({ ctx, input, options, hasPartnersLink, settings, prev }) {
  const t0 = Date.now();
  const d = await delayMs();
  const kn = new Knowledge();
  const emit = (e, data) => ctx?.emit?.(e, data);
  const aborted = () => { if (ctx?.signal?.aborted) throw new AppError('요청이 취소되었습니다.', { raw: 'AbortError', where: WHERE.SW, code: 'CANCELLED' }); };
  const typeDoc = await kn.typeDoc();
  const catDefaults = await kn.categoryDefaults();
  const rules = await kn.photoRules();
  const hint = guessCategory([...(input.breadcrumb || []), input.title || input.topic || '']);
  const tease = { ...teaseOf(input, options, null), leak: !!(await store.kvGet('dev:ai', null))?.mockLeak };
  const t = shortTitle(tease.on ? { ...input, title: tease.keep } : input);
  const plan = normalizePhotoPlan({ category: hint || '기타', hooks: photoHooks(t), hookPick: 0 }, { input, options, catDefaults, categoryHint: hint, count: input.imageIds.length });
  const local = buildLocalFacts(input);
  const facts = input.source === 'coupang_page' || input.source === 'manual' ? [...local.facts, ...mockResearchFacts(t)] : [...local.facts];
  const factsInfo = { mode: facts.some((f) => f.id.startsWith('f')) ? 'search' : (local.facts.length ? (input.source === 'coupang_page' ? 'page' : 'user_input') : 'none'), unknown: local.unknown, groundingUrls: [], searchUsed: facts.some((f) => f.id.startsWith('f')) };
  const notices = [NOTICE];
  await sleep(d); aborted();
  emit('plan', { ...plan, elapsedMs: Date.now() - t0, notices: notices.slice() });
  const fabricate = (await store.kvGet('dev:ai', null))?.mockFabricate !== false && plan.count >= 3;
  let cards = (await photoCardsFor({ plan, input, rules, fabricate, ctaBank: typeDoc.ctaBank, tease })).map((c) => ({ ...c, claims: normalizeClaims(c, facts).claims }));
  let firstCardMs = null;
  for (const c of cards) {
    await sleep(d); aborted();
    if (firstCardMs == null) firstCardMs = Date.now() - t0;
    emit('card', { index: c.index, total: plan.count, card: c, elapsedMs: Date.now() - t0 });
  }
  await sleep(d / 2);
  emit('facts', { facts, ...factsInfo, notices: notices.slice() });
  const tags = await kn.hashtagSlice(plan.category);
  const caption = fallbackCaption({ plan, cards, ctaBank: typeDoc.ctaBank, tease });
  const hashtags = assembleHashtags(deriveTitleTags(input, tease.hide), settings.fixedTags, Object.values(tags.pools).flat(), `${input.title || input.topic || ''} ${input.description || ''}`).filter((x) => !tease.on || !findLeak(x, tease.hide));
  await sleep(d); aborted();
  emit('caption', { caption, hashtags });
  const S = { mode: 'photo', overlayStyle: prev?.carousel?.overlayStyle || options.overlayStyle || 'gradient', prev, input, options, hasPartnersLink, settings, plan, facts, factsInfo, cards, caption, hashtags, issues: [], score: null, shorts: null, notices, kn, mock: true, meta: {} };
  S.issues = await ruleReview(buildProject(S), kn, { hasPartnersLink });
  await sleep(d / 2); aborted();
  emit('review', { issues: S.issues, counts: { fact: S.issues.filter((i) => i.level === 'fact').length, format: S.issues.filter((i) => i.level === 'format').length } });
  S.score = computeCarouselScore({ cards, issues: S.issues, mode: 'photo', adLabel: scoreAdLabel(S), tease: !!options.tease, commentWord: plan.commentWord || '' });
  emit('score', S.score);
  await sleep(d); aborted();
  if (settings.makeShorts) { S.shorts = shortsFromCards(cards, plan); S.shorts.issues = await reviewShorts(S.shorts, buildProject(S), kn); emit('shorts', S.shorts); }
  S.meta = { elapsedMs: Date.now() - t0, firstCardMs, models: { main: '(시험용 더미)', lite: '(시험용 더미)' }, parallel: 0, sequentialSwitched: false, mock: true };
  return buildProject(S);
}

export async function generate({ ctx, input, options, hasPartnersLink, settings, prev = null, reuse = false }) {
  if (options.mode === 'photo') return generatePhoto({ ctx, input, options, hasPartnersLink, settings, prev });
  const t0 = Date.now();
  const d = await delayMs();
  const kn = new Knowledge();
  const emit = (e, data) => ctx?.emit?.(e, data);
  const aborted = () => { if (ctx?.signal?.aborted) throw new AppError('요청이 취소되었습니다.', { raw: 'AbortError', where: WHERE.SW, code: 'CANCELLED' }); };
  const hasImages = hasImagesOf(input);
  const { plan, typeDoc } = await makePlan({ kn, input, options, hasImages });
  const local = buildLocalFacts(input);
  const tease = { ...teaseOf(input, options, null), leak: !!(await store.kvGet('dev:ai', null))?.mockLeak };
  const t = shortTitle(tease.on ? { ...input, title: tease.keep } : input);
  const facts = input.source === 'coupang_page' || input.source === 'manual' || input.source === undefined ? [...local.facts, ...mockResearchFacts(t)] : [...local.facts, ...(input.source === 'topic' ? [] : [])];
  const factsInfo = { mode: facts.some((f) => f.id.startsWith('f')) ? 'search' : (local.facts.length ? (input.source === 'shorts' ? 'script' : input.source === 'coupang_page' ? 'page' : 'user_input') : 'none'), unknown: local.unknown, groundingUrls: [], searchUsed: facts.some((f) => f.id.startsWith('f')) };
  const notices = [NOTICE];
  await sleep(d); aborted();
  emit('plan', { ...plan, elapsedMs: Date.now() - t0, notices: notices.slice() });

  const fabricate = (await store.kvGet('dev:ai', null))?.mockFabricate !== false;
  let cards = buildCards({ plan, input, fabricate, ctaBank: typeDoc.ctaBank, tease }).map((c) => normalizeClaims(c, facts));
  // 도착 순서를 살짝 뒤섞는다(실제 병렬 도착처럼): 3·4번째를 맞바꿈
  const order = cards.map((c) => c.index);
  if (order.length >= 5) [order[3], order[4]] = [order[4], order[3]];
  let firstCardMs = null;
  for (const i of order) {
    await sleep(d); aborted();
    if (firstCardMs == null) firstCardMs = Date.now() - t0;
    emit('card', { index: i, total: plan.count, card: cards[i], elapsedMs: Date.now() - t0 });
  }
  await sleep(d / 2);
  emit('facts', { facts, ...factsInfo, notices: notices.slice() });

  const tags = await kn.hashtagSlice(plan.category);
  const caption = fallbackCaption({ plan, cards, ctaBank: typeDoc.ctaBank, tease });
  const hashtags = assembleHashtags(deriveTitleTags(input, tease.hide), settings.fixedTags, Object.values(tags.pools).flat(), `${input.title || input.topic || ''} ${input.description || ''}`).filter((x) => !tease.on || !findLeak(x, tease.hide));
  await sleep(d); aborted();
  emit('caption', { caption, hashtags });

  cards = styleCards(cards, { input });
  if (prev) {
    const kept = carryOverImages(cards, prev.carousel?.cards);
    cards = kept.cards;
    if (kept.notice) notices.push(kept.notice);
  }
  const S = {
    prev, input, options, hasPartnersLink, settings, plan, facts, factsInfo, cards, caption, hashtags, issues: [], score: null, shorts: null,
    notices, kn, mock: true, meta: {},
  };
  const issues = await ruleReview(buildProject(S), kn, { hasPartnersLink });
  S.issues = issues;
  await sleep(d / 2); aborted();
  emit('review', { issues, counts: { fact: issues.filter((i) => i.level === 'fact').length, format: issues.filter((i) => i.level === 'format').length } });
  S.score = computeCarouselScore({ cards, issues, mode: 'cardnews', adLabel: scoreAdLabel(S), tease: !!options.tease, commentWord: plan.commentWord || '' });
  emit('score', S.score);
  await sleep(d); aborted();
  if (settings.makeShorts) { S.shorts = shortsFromCards(cards, plan); S.shorts.issues = await reviewShorts(S.shorts, buildProject(S), kn); emit('shorts', S.shorts); }
  S.meta = { elapsedMs: Date.now() - t0, firstCardMs, models: { main: '(시험용 더미)', lite: '(시험용 더미)' }, parallel: 0, sequentialSwitched: false, mock: true };
  return buildProject(S);
}

/** 부분 재생성 흉내: all 은 처음부터, 나머지는 해당 부분만 (이벤트도 해당 부분만) */
export async function regenerate({ payload, ctx, prev, input, options, settings }) {
  const part = payload.part || 'all';
  if (part === 'all') return generate({ ctx, input, options, hasPartnersLink: prev.carousel.hasPartnersLink, settings, prev });
  const kn = new Knowledge();
  const typeDoc = await kn.typeDoc();
  const d = await delayMs();
  const emit = (e, data) => ctx?.emit?.(e, data);
  const photo = prev.carousel.mode === 'photo';
  const S = {
    mode: photo ? 'photo' : 'cardnews', prev, input, options, hasPartnersLink: prev.carousel.hasPartnersLink, settings, plan: { ...prev.plan }, facts: prev.facts, factsInfo: prev.factsInfo,
    cards: prev.carousel.cards.map((c) => ({ ...c })), caption: prev.caption, hashtags: prev.hashtags, shorts: prev.shorts, issues: prev.issues, score: prev.score,
    notices: [NOTICE], kn, mock: true, meta: {},
  };
  S.brandColor = prev.carousel.brandColor; S.accentColor = prev.carousel.accentColor; S.peek = prev.carousel.peek; S.panorama = prev.carousel.panorama;
  const redo = async (idx, tweak) => {
    await sleep(d);
    if (photo) { // 사진 캐러셀: 훅 변경이면 커버 문장만 교체, 카드 다시 만들기면 다른 문장으로
      const old = S.cards[idx];
      const lines = idx === 0 ? (S.plan.hooks[S.plan.hookPick] || S.plan.hooks[0]).headline.split('\n') : [...PHOTO_INNER[(idx + 3) % PHOTO_INNER.length]];
      S.cards[idx] = syncOverlay({ ...old, headline: lines.join('\n'), claims: [{ text: lines.join(' '), type: 'opinion', fact_id: null }] });
      emit('card', { index: idx, total: S.plan.count, card: S.cards[idx], elapsedMs: 0 });
      return;
    }
    const fresh = buildCards({ plan: S.plan, input, fabricate: false, ctaBank: typeDoc.ctaBank, tease: teaseOf(input, options, S.plan) })[idx];
    const old = S.cards[idx];
    S.cards[idx] = normalizeClaims({ ...fresh, headline: tweak ? `${fresh.headline}`.slice(0, 15) + '!' : fresh.headline, layout: old.layout, imageSlot: old.imageSlot, ...(old.imageId ? { imageId: old.imageId } : {}) }, S.facts);
    emit('card', { index: idx, total: S.plan.count, card: S.cards[idx], elapsedMs: 0 });
  };
  if (part === 'template') {
    const tpl = payload.options?.template;
    if (tpl) S.plan.template = tpl;
  } else if (part === 'hook') {
    S.plan.hookPick = clampInt(payload.hookIndex ?? payload.options?.hookIndex, 0, S.plan.hooks.length - 1, 0);
    await redo(0, false);
    S.caption = fallbackCaption({ plan: S.plan, cards: S.cards, ctaBank: typeDoc.ctaBank, tease: teaseOf(input, options, S.plan) });
    emit('caption', { caption: S.caption, hashtags: S.hashtags });
  } else if (part === 'card') {
    await redo(clampInt(payload.index, 0, S.plan.count - 1, 0), true);
  } else if (part === 'caption') {
    await sleep(d);
    S.caption = fallbackCaption({ plan: S.plan, cards: S.cards, ctaBank: typeDoc.ctaBank, tease: teaseOf(input, options, S.plan) });
    emit('caption', { caption: S.caption, hashtags: S.hashtags });
  } else if (part === 'shorts') {
    await sleep(d);
    S.shorts = shortsFromCards(S.cards, S.plan);
    S.shorts.issues = await reviewShorts(S.shorts, buildProject(S), kn);
    emit('shorts', S.shorts);
    return buildProject(S);
  }
  S.issues = await ruleReview(buildProject(S), kn, { hasPartnersLink: S.hasPartnersLink });
  emit('review', { issues: S.issues, counts: { fact: S.issues.filter((i) => i.level === 'fact').length, format: S.issues.filter((i) => i.level === 'format').length } });
  S.score = computeCarouselScore({ cards: S.cards, issues: S.issues, mode: photo ? 'photo' : 'cardnews', adLabel: scoreAdLabel(S), tease: !!options.tease, commentWord: S.plan.commentWord || '' });
  emit('score', S.score);
  return buildProject(S);
}

/** 재작성 3안 흉내 */
export async function rewriteCard(payload) {
  const project = payload.project;
  const idx = clampInt(payload.index, 0, project.carousel.cards.length - 1, 0);
  const card = project.carousel.cards[idx];
  if (project.carousel.mode === 'photo') {
    const names = { short: '짧게', hook: '센 훅', explain: '설명형', emotional: '센 훅', evidence: '설명형', alt: '다르게' };
    const want = (payload.styles?.length ? payload.styles : ['short', 'hook', 'explain']).map((x) => names[x] || x);
    const base = (card.overlay?.lines || card.headline.split('\n'));
    const mkp = (style) => {
      const lines = style === '짧게' ? [base[0]] : style === '센 훅' ? ['이거 모르면', '손해예요'] : style === '설명형' ? [...base.slice(0, 1), '사진 속 이 부분이 포인트'.slice(0, 14)] : [...base].reverse();
      return { ...syncOverlay({ ...card, headline: lines.filter(Boolean).slice(0, 3).join('\n'), claims: [{ text: lines.join(' '), type: 'visual', fact_id: null }], reason: `${style}(더미)` }) };
    };
    return { index: idx, variants: want.map((s) => ({ style: s, card: mkp(s), factIssues: [] })), model: '(시험용 더미)', mock: true };
  }
  const styles = (payload.styles?.length ? payload.styles : ['short', 'emotional', 'evidence']).map((s) => ({ short: '짧게', emotional: '감성', evidence: '근거형', alt: '다르게' }[s] || s));
  const mk = (style) => {
    const lines = (card.body || '').split('\n');
    if (style === '짧게') return { ...card, headline: `짧게: ${card.headline}`.slice(0, 16), body: lines[0] || '', claims: [{ text: lines[0] || card.headline, type: 'opinion', fact_id: null }], reason: '짧게(더미)' };
    if (style === '감성') return { ...card, headline: `마음 가는 ${card.headline}`.slice(0, 16), body: [...lines.slice(0, 2), '이게 은근 크더라고요'].slice(0, 3).join('\n'), claims: [{ text: '이게 은근 크더라고요', type: 'opinion', fact_id: null }], reason: '감성(더미)' };
    if (style === '근거형') return { ...card, headline: `근거로 본 ${card.headline}`.slice(0, 16), body: ['후기에서 자주 보이는 말', ...lines.slice(0, 1)].join('\n'), claims: [{ text: '후기에서 자주 보이는 말', type: 'fact', fact_id: (project.facts || []).find((f) => f.id === 'f1') ? 'f1' : null }], reason: '근거형(더미)' };
    return { ...card, headline: `다르게 ${card.headline}`.slice(0, 16), body: lines.reverse().join('\n'), claims: card.claims, reason: '다르게(더미)' };
  };
  return { index: idx, variants: styles.map((s) => ({ style: s, card: mk(s), factIssues: [] })), model: '(시험용 더미)', mock: true };
}
