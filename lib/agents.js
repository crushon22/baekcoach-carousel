// 에이전트 파이프라인 (서비스워커 전용) — v3 §5 · v1 §14·§21 · v2 §3.
//
//   플래너 1회 ─┬─ 리서처(google_search + 상품 페이지 텍스트 → facts[]) ─┐ (플래너와 동시에 시작, 최대 5초 기다린 뒤 facts 없이도 진행)
//              └─ 카드 작가 × N 병렬(설정 3~7, 429 면 순차 전환) ───────┘
//   → 캡션·태그 ∥ 스타일리스트(AI 없음) → 형식검수(규칙) ∥ 사실검수(규칙 1차 + AI A7 보강) ∥ 점수(규칙) → 쇼츠 대본
//   스트림 이벤트 순서: plan → card(도착 순서대로) → facts → caption → review → score → shorts → done(Project 전체)
//
// 지식은 knowledge.js 로더로 읽어 에이전트마다 필요한 부분만 넣는다(카테고리 1개, 우수사례 ≤3개). 규칙을 코드에 박지 않는다.
// 에이전트당 타임아웃 20초(ai.js), 리서처 15초. 일부가 실패해도 부분 결과를 먼저 보여주고 notices 로 알린다.
// devMockAI 가 켜져 있으면 네트워크 없이 lib/mock-ai.js 의 고정 응답을 같은 이벤트 순서로 흘린다.
// 요청/응답 형식: docs/인터페이스_AI.md

import { AppError, WHERE, sleep } from './common.js';
import * as store from './store.js';
import { generate, generateJson, selectModel, checkKey as aiCheckKey, resetCaches, parseLooseJson } from './ai.js';
import { Knowledge, guessCategory, canonCategory, compactMd, sectionByTitle, effectivePhotoRules } from './knowledge.js';
import {
  syncOverlay, ruleReview, reviewShorts, fromAiIssues, mergeIssues, normalizeClaims, applyFixToCard, locateText, cardLines, factCorpus,
} from './review.js';
import { computeCarouselScore } from './score.js';
/** 점수용 광고 표기 여부: 옵션 → 이전 결과 → 사진 캐러셀 기본 켬 */
const scoreAdLabel = (S) => (typeof S.options?.adLabel === 'boolean' ? S.options.adLabel : typeof S.prev?.carousel?.adLabel === 'boolean' ? S.prev.carousel.adLabel : true);
import { photoParts } from './image.js';
import {
  createStreamScanner, normalizePhotoPlan, buildPhotoCard, assignLayout, carryOverImages, normalizeInput, normalizePlan, buildLocalFacts, factsForPrompt, compactInput, hasImagesOf, styleCards, assembleHashtags, deriveTitleTags, buildProject, teaseOf, findLeak,
  cleanText, str, clampInt, cardBrief, fallbackCaption, shortsFromCards, DEFAULT_BRAND,
} from './ai-util.js';
import * as mock from './mock-ai.js';
import { runChat } from './chat.js';

export const prefix = 'ai.';
export const contentAllowed = [];

const RESEARCH_WAIT_MS = 4000;     // 리서처를 기다리는 최대 시간. 넘으면 facts 없이 진행하고 사후 검수한다
const RESEARCH_TIMEOUT_MS = 12000; // 리서처 자체 제한
const RESEARCH_SKIP_DESC = 80;     // 상품 설명이 이만큼(글자) 있으면 google_search 리서처를 아예 부르지 않는다(무료 키 호출 수 절약)
const COMBINED_TIMEOUT_MS = 25000; // 기획+카드 스트림 전체 제한

// ───────────────────────── 스키마 (responseSchema; 거부되면 ai.js 가 빼고 재시도) ─────────────────────────

const S_ = { type: 'STRING' };
const CLAIMS_SCHEMA = { type: 'ARRAY', items: { type: 'OBJECT', properties: { text: S_, type: S_, fact_id: { type: 'STRING', nullable: true } }, required: ['text', 'type'] } };
const CARD_SCHEMA = {
  type: 'OBJECT',
  properties: { headline: S_, body: S_, bridge: S_, cta: S_, numberLabel: S_, claims: CLAIMS_SCHEMA, reason: S_ },
  required: ['headline', 'body', 'claims'],
};
const CARD_ITEM = { type: 'OBJECT', properties: { role: S_, headline: S_, body: S_, bridge: S_, cta: S_, numberLabel: S_, claims: CLAIMS_SCHEMA, reason: S_ }, required: ['role', 'headline', 'body', 'claims'] };
const COMBINED_SCHEMA = {
  type: 'OBJECT',
  properties: {
    plan: {
      type: 'OBJECT',
      properties: {
        category: S_, type: S_, purpose: S_, target: S_, count: { type: 'INTEGER' }, hookPick: { type: 'INTEGER' }, points: { type: 'ARRAY', items: S_ }, hide: { type: 'ARRAY', items: S_ }, commentWord: S_,
        hooks: { type: 'ARRAY', items: { type: 'OBJECT', properties: { type: S_, headline: S_, body: S_ }, required: ['headline'] } },
      },
      required: ['category', 'type', 'purpose', 'count', 'hooks'],
    },
    cards: { type: 'ARRAY', items: CARD_ITEM },
  },
  required: ['plan', 'cards'],
  propertyOrdering: ['plan', 'cards'],
};
const VARIANTS_SCHEMA = {
  type: 'OBJECT',
  properties: { variants: { type: 'ARRAY', items: { type: 'OBJECT', properties: { style: S_, headline: S_, body: S_, bridge: S_, cta: S_, numberLabel: S_, claims: CLAIMS_SCHEMA, reason: S_ }, required: ['style', 'headline', 'body', 'claims'] } } },
  required: ['variants'],
};
const CAPTION_SCHEMA = { type: 'OBJECT', properties: { caption: S_, hashtags: { type: 'ARRAY', items: S_ } }, required: ['caption', 'hashtags'] };
const ISSUES_SCHEMA = {
  type: 'OBJECT',
  properties: { issues: { type: 'ARRAY', items: { type: 'OBJECT', properties: { card: { type: 'INTEGER' }, text: S_, kind: S_, why: S_, fix_soften: { type: 'STRING', nullable: true }, fix_delete: { type: 'BOOLEAN' } }, required: ['card', 'text', 'kind', 'why'] } } },
  required: ['issues'],
};
const SHORTS_SCHEMA = { type: 'OBJECT', properties: { hook: S_, body: S_, cta: S_, subtitles: { type: 'ARRAY', items: S_ } }, required: ['hook', 'body', 'cta', 'subtitles'] };
const CAPSHORTS_SCHEMA = { type: 'OBJECT', properties: { caption: S_, hashtags: { type: 'ARRAY', items: S_ }, shorts: SHORTS_SCHEMA }, required: ['caption', 'hashtags', 'shorts'] };

const STYLE_KO = { short: '짧게', emotional: '감성', evidence: '근거형', alt: '다르게', hook: '센 훅', explain: '설명형' };
const toStyleKo = (s) => STYLE_KO[s] || (['짧게', '감성', '근거형', '다르게', '센 훅', '설명형'].includes(s) ? s : null);

// ───────────────────────── 공용 ─────────────────────────

const J = (o) => JSON.stringify(o);
const STYLE_KEYS = ['colors', 'overlayColors', 'adLabel', 'adLabelStyle']; // 사용자가 고른 색·광고 표기(생성·재생성이 정하지 않고 유지)
const abortIf = (signal) => { if (signal?.aborted) throw new AppError('요청이 취소되었습니다.', { raw: 'AbortError', where: WHERE.SW, code: 'CANCELLED' }); };

/** 설정(키 값은 빼고 hasKey 만 남긴다). 키는 ai.js 가 store.getSecrets() 로 따로 읽는다. */
async function requireSettings() {
  const all = await store.getSettings();
  const { geminiKey, openaiKey, coupangAccessKey, coupangSecretKey, ...rest } = all;
  return { ...rest, hasKey: !!all[store.aiKeyName(all)] };
}

function toneLine(settings) {
  const t = (settings.tone || '').trim();
  return t ? `말투: ${t} (전 카드·캡션에 일관되게)` : '말투: 존댓말(해요체), 전 카드·캡션에 일관되게';
}

const FACT_RULES = [
  '사실 규칙(가장 중요):',
  '- 사실 주장(수치·기능·구성·가격·비교·후기 내용·수상/인증)은 facts 에 있는 것만 쓴다. 사용한 사실은 claims 에 type:"fact" 와 fact_id(facts 의 id 그대로)로 연결한다.',
  '- facts 에 없는 것을 말하고 싶으면 체감·감정 표현으로 바꿔 쓰고 claims 에 type:"opinion"(또는 "hype"), fact_id:null 로 적는다. 과장은 표현의 영역이라 허용되지만 날조는 안 된다.',
  '- 후기 수·판매량·수상·인증·퍼센트·몇 배 비교·측정 수치는 facts 에 없으면 절대 쓰지 않는다. 가격은 facts 의 가격이 있을 때만 "약 ○만 원대".',
  '- 로켓배송·무료배송·최저가·오늘 도착·할인율·쿠폰 같은 변동 사실은 카드와 캡션에 쓰지 않는다(앱이 "배송·가격은 링크에서 확인"을 붙인다).',
  '- 확인 못 한 것(unknown)은 쓰지 않는다. 모르면 쓰지 않는다.',
].join('\n');

/** 모델 이름 두 개를 한 번에 확정(목록 캐시 사용) */
async function pickModels(signal) {
  const main = await selectModel('main', { signal });
  const lite = await selectModel('lite', { signal });
  return { main, lite };
}

// ───────────────────────── 실행 상태 ─────────────────────────

/** 한 번의 생성/재생성에서 공유하는 상태 S */
async function createState({ input, options, hasPartnersLink, prev = null, ctx }) {
  const settings = await requireSettings();
  const kn = new Knowledge();
  const typeDoc = await kn.typeDoc();
  const catDefaults = await kn.categoryDefaults();
  const layoutRules = await kn.layoutRules();
  const categoryHint = guessCategory([...(input.breadcrumb || []), input.title || input.topic || '']);
  const photoStyle = options.overlayStyle || prev?.carousel?.overlayStyle || 'outline';
  const photoRulesCache = options.mode === 'photo' ? effectivePhotoRules(await kn.photoRules(), photoStyle) : null;
  return {
    photoRulesCache,
    ctx, signal: ctx?.signal, emit: (e, d) => ctx?.emit?.(e, d), t0: Date.now(), settings, kn, typeDoc, catDefaults, layoutRules, categoryHint,
    mode: options.mode === 'photo' ? 'photo' : 'cardnews', overlayStyle: options.overlayStyle || prev?.carousel?.overlayStyle || (options.mode === 'photo' ? 'outline' : undefined), photoCache: new Map(),
    input, options, hasPartnersLink: !!hasPartnersLink, prev, notices: [], facts: [], factsInfo: { mode: 'none', unknown: [], groundingUrls: [], searchUsed: false },
    plan: null, cards: [], caption: '', hashtags: [], issues: [], score: null, shorts: null, models: null, meta: { stageMs: {} },
    brandColor: prev?.carousel?.brandColor || DEFAULT_BRAND, accentColor: prev?.carousel?.accentColor, peek: prev?.carousel?.peek, panorama: prev?.carousel?.panorama,
    parallel: clampInt(settings.parallel, 3, 7, 5), sequential: false,
  };
}
const since = (S) => Date.now() - S.t0;

// ───────────────────────── 댓글 유도(제품 정보 숨기기) ─────────────────────────
// 카드에는 브랜드·종류만, 번호·색상명·모델명은 숨겨 보는 사람이 댓글로 묻게 한다(댓글 → DM 으로 파트너스 링크). 지식: K-댓글유도.md
/** 기획 전에는 규칙(이름의 번호·코드)만, 기획 뒤에는 플래너가 더한 색상명·모델명까지 */
const teaseState = (S) => teaseOf(S.input, S.options, S.plan);
/** 프롬프트에 넣는 규칙 + 지식 본문. 꺼져 있으면 '' */
async function teaseBlock(S, { planner = false } = {}) {
  const t = teaseState(S);
  if (!t.on) return '';
  const text = compactMd((await S.kn.text('K-댓글유도.md', { optional: true })) || '');
  return [
    '', '댓글 유도(제품 정보 숨기기) — 사용자가 켰다. 가장 중요한 규칙:',
    `- 숨길 것(hide): ${t.hide.length ? t.hide.map((x) => `"${x}"`).join(', ') : '(이름에 번호·코드는 없음)'} 와 같은 뜻의 다른 표기(987번 = 987 = No.987), 그리고 색상명·호수·라인명·정확한 모델명. 카드·캡션·쇼츠·해시태그 어디에도 쓰지 않는다. 입력 title 에 있어도 쓰지 않는다.`,
    `- 써도 되는 것: 브랜드·상품 종류·사진에 보이는 특징. 카드에 쓰는 이름은 "${t.keep || '브랜드·종류(사진에서 본 것)'}".`,
    '- 숨긴 정보로 제품을 안다면 그 지식으로 발색·질감·어울리는 상황을 묘사하되 이름·번호는 끝까지 말하지 않는다. "링크는 프로필에"·"구매는 링크"·"저장해 두세요"는 쓰지 않는다.',
    planner
      ? '- plan.hide: 입력(title·description)에서 상품을 특정하는 말(색상명·호수·라인명·모델명)을 더 찾아 배열로 적는다. 브랜드·상품 종류는 넣지 않는다. 없으면 []. plan.commentWord: 보는 사람이 댓글에 남길 단어 하나(2글자 이내, 상품과 바로 이어지는 말. 매트 레드 립스틱 → 매트·립·루즈·입술, 아무 상품이나 → 나도). hide 에 넣은 말(색상명 등)은 댓글 단어로 쓰지 않는다. 마지막 카드는 댓글에 "그 단어" 남겨 주세요 로 끝낸다.'
      : `- 댓글 단어는 "${t.word}": 마지막 카드는 댓글에 "${t.word}" 남겨 주세요, 캡션 CTA 는 "${t.word}" 댓글 남겨 주시면 링크 보내드릴게요 처럼 쓴다.`,
    '', '## 지식: 댓글 유도', text || '(지식 파일 없음: 위 규칙만 따른다)',
  ].filter((x) => x !== null).join('\n');
}
/** 해시태그에 숨길 글자가 들어가면 뺀다 */
const dropLeakTags = (S, tags) => { const t = teaseState(S); return t.on ? tags.filter((x) => !findLeak(x, t.hide)) : tags; };

// ───────────────────────── 기획 + 카드 (한 번의 스트리밍 호출) ─────────────────────────
// 무료 키는 모델별 분당 한도가 작아 호출 수가 곧 속도다. 플래너와 카드 작가를 한 호출로 합쳐
// {"plan":{…},"cards":[…]} 를 스트리밍으로 받고, plan 이 닫히면 plan 이벤트, 카드가 하나 닫힐 때마다 card 이벤트를 바로 보낸다.

const ROLE_FORMAT_RULES = [
  '카드 형식(role 이름으로 정해짐):',
  '- headline 16자 이내(공백 포함, 최대 2줄), body 한 줄 18자 이내·최대 3줄(줄바꿈 \\n). 이모지는 카드당 1개 이하이고 헤드라인에는 쓰지 않는다. ○○ 같은 자리표시를 남기지 않는다.',
  '- role 이 "가격·구성"·"전체 요약표"·"항목 …" 이면 body 를 "항목|내용" 형식 줄로(최대 6줄, 항목 6자·내용 14자 안팎. 체크리스트는 "☐ 항목|이유").',
  '- role 이 "핵심 …"·"실수 …"·"N위"·"Q&A …" 이면 numberLabel("1","2","5위" 등 짧게)을 넣고 headline 은 키워드로.',
  '- role 이 "공감"·"상황"·"정리"·"후기 …"·"공통점" 이면 body 는 따옴표 없는 한두 줄 말투 문장(실명·원문 복제 금지).',
  '- 마지막 카드(CTA)는 headline 에 요약 한 줄, cta 에 버튼 문구(12자 이내, 행동 하나). bridge 는 핵심 카드에서만 10자 이내(선택), 그 외는 "".',
  '- claims 에는 카드에 실제로 쓴 문장(구)을 문장 단위로 적는다. reason 은 한 줄.',
].join('\n');

async function combinedSystem(S) {
  const { kn, typeDoc, catDefaults, categoryHint, options } = S;
  const hook = compactMd(await kn.text('K-훅공식.md'));
  const types = compactMd(await kn.text('K-유형구조.md'));
  const copy = compactMd(await kn.text('K-카피규칙.md'));
  const catLines = Object.entries(catDefaults).map(([k, v]) => `- ${k}: 기본 타깃 ${v.target} · 추천 유형 ${v.types.join(',')} · ${v.tone}`).join('\n');
  const cat = categoryHint ? compactMd((await kn.categoryText(categoryHint)) || '') : '';
  const exType = options.type && typeDoc.types[options.type] ? options.type : (catDefaults[categoryHint || '기타']?.types || [])[0];
  const ex = categoryHint && exType ? await kn.examples({ category: categoryHint, type: exType }, 2) : [];
  const hasPraise = S.facts.some((f) => f.kind === 'praise');
  return [
    '[역할:기획+작가]',
    '당신은 인스타그램 쇼핑 캐러셀 기획자 겸 카피라이터입니다. 입력(상품 정보·주제·쇼츠 대본)을 보고 사용자에게 묻지 않고 기획을 확정한 뒤 카드를 한 번에 씁니다. JSON 한 덩어리만 출력합니다(코드블록·설명 없이). 짧고 빠르게.',
    '출력 형식(키 순서 중요: plan 을 먼저, cards 를 나중에):',
    '{"plan":{"category":"","type":"","purpose":"","target":"","count":7,"hookPick":0,"points":["핵심 포인트 한 줄"],"hide":[],"commentWord":"","hooks":[{"type":"숫자형","headline":"","body":""},{"type":"질문형","headline":"","body":""},{"type":"반전형","headline":"","body":""}]},',
    ' "cards":[{"role":"","headline":"","body":"","bridge":"","cta":"","numberLabel":"","claims":[{"text":"","type":"fact|opinion|hype","fact_id":null}],"reason":""}, … count 개]}',
    '',
    '기획 규칙',
    '- category: 뷰티|패션|식품|리빙·주방|가전·테크|육아|건강·운동|반려동물|기타 중 하나. 상품에 정확히 맞는 카테고리가 없으면 억지로 가장 가까운 것을 고르지 말고 반드시 "기타". categoryHint 는 쿠팡 분류에서 짐작한 참고값일 뿐이니 상품과 맞을 때만 따른다.',
    '- points: 이 캐러셀이 말할 핵심 포인트 3~5개(각 한 줄, 25자 이내). 캡션·쇼츠를 카드와 동시에 쓰는 재료라서 plan 안에 꼭 넣는다.',
    `- type: ${typeDoc.order.join('|')} 중 하나. input.options.type 이 있으면 그대로. purpose: 저장|링크 클릭|댓글|팔로우|DM·문의 중 하나(options.purpose 가 있으면 그대로, 없으면 유형의 기본 목적). count: 5~8(options.count 가 있으면 그대로, 없으면 유형 기본 장수). target: 독자 한 줄.`,
    '- hooks: 숫자형·질문형·반전형 3안(각 headline 16자 이내, body 1~2줄). hookPick: 가장 강한 안(options.hookIndex 가 있으면 그 번호). 제품판매형 훅에는 제품명을 쓰지 않는다.',
    '- cards: 정확히 count 장. role 은 유형 구조 표의 role 이름과 순서를 그대로. cards[0] 은 hooks[hookPick] 의 headline·body 를 그대로 쓴다. 마지막은 요약+CTA 하나.',
    hasPraise ? '' : '- facts 에 후기(구매자 호평)가 없으니 "후기"·"후기 모음"·"구매자/써 본 사람 이야기"·후기 인용 role 과 문장을 쓰지 않는다. 그 자리는 "이런 분께 맞아요"·체감 포인트·고르는 기준 같은 상품 정보 기반 내용으로 바꾼다.',
    '- 지식 파일의 예시 문장·숫자는 형식을 보여 주는 것이다. 그대로 복사하지 말고, 숫자는 facts 에 있는 것만 쓴다.',
    '', ROLE_FORMAT_RULES, '', FACT_RULES, '', toneLine(S.settings), await teaseBlock(S, { planner: true }),
    '', '## 지식: 훅 공식', hook, '', '## 지식: 유형 구조', types, '', '## 지식: 카피 규칙', copy, '', '## 참고: 카테고리 기본값', catLines,
    cat ? `\n## 지식: ${categoryHint} 카테고리\n${cat}` : '',
    ex.length ? `\n## 우수 사례 (참고용)\n${ex.join('\n\n')}` : '',
  ].join('\n');
}

/** 기획+카드 스트림. 끊기거나 일부만 오면 받은 만큼 살리고 나머지는 카드별 호출로 채운다. 카드는 도착하는 대로 card 이벤트. */
async function runPlanAndCards(S) {
  const t = Date.now();
  const system = await combinedSystem(S);
  const user = J({
    input: compactInput(S.input), options: { type: S.options.type, purpose: S.options.purpose, count: S.options.count, hookIndex: S.options.hookIndex }, categoryHint: S.categoryHint, ...(S.options.tease ? { tease: teaseState(S) } : {}),
    hasProductPhotos: hasImagesOf(S.input), facts: factsForPrompt(S.facts), unknown: S.factsInfo.unknown,
  });
  const cardsOut = [];
  const raws = [];
  const fromRaw = (j) => (j && typeof j === 'object' ? j : null);
  const onPlan = (raw) => {
    if (S.plan) return;
    S.plan = normalizePlan(fromRaw(raw), { input: S.input, options: S.options, typeDoc: S.typeDoc, catDefaults: S.catDefaults, layoutRules: S.layoutRules, hasImages: hasImagesOf(S.input), categoryHint: S.categoryHint });
    S.meta.stageMs.plan = Date.now() - t;
    S.emit('plan', { ...S.plan, elapsedMs: since(S), notices: S.notices.slice() });
    S.onPlanReady?.(); // 캡션·쇼츠를 카드 스트림과 동시에 시작
  };
  const onCard = (i, j) => {
    if (!S.plan || i >= S.plan.count || cardsOut[i]) return;
    let card;
    try { card = finishCard(S, i, j, { role: j.role }); } catch { return; } // 빈 카드는 나중에 채운다
    if (i === 0) { // 1번 카드는 선택된 훅 그대로
      const h = S.plan.hooks[S.plan.hookPick] || S.plan.hooks[0];
      card = { ...card, headline: cleanText(h.headline, 60) || card.headline, body: cleanText(h.body, 320) || card.body };
    }
    cardsOut[i] = card;
    S.cards = cardsOut.filter(Boolean);
    if (S.meta.firstCardMs == null) S.meta.firstCardMs = since(S);
    S.emit('card', { index: i, total: S.plan.count, card, elapsedMs: since(S) });
  };
  let scanner = null, seen = 0, idx = 0;
  const resetScanner = () => { seen = 0; idx = 0; scanner = createStreamScanner((kind, value) => { if (kind === 'plan') onPlan(value); else { raws[idx] = value; onCard(idx, value); idx++; } }); };
  resetScanner();
  let finalText = '';
  try {
    const r = await generate({
      kind: 'main', stream: true, json: true, schema: COMBINED_SCHEMA, system, prompt: user, temperature: 0.8, maxOutputTokens: 4000,
      signal: S.signal, timeoutMs: COMBINED_TIMEOUT_MS, timeoutSwitch: () => !S.plan,
      onText: (_d, full) => { if (full.length < seen) resetScanner(); scanner.feed(full.slice(seen)); seen = full.length; },
    });
    finalText = r.text;
  } catch (e) {
    if (e?.code === 'CANCELLED' || ['KEY_INVALID', 'BILLING', 'NO_KEY', 'FORBIDDEN', 'NETWORK'].includes(e?.code)) throw e;
    S.notices.push(`기획·카드 생성이 중간에 멈췄어요(${e?.messageKo || e?.message || '오류'}). 받은 카드는 그대로 두고 나머지를 채웁니다`);
  }
  // 스캐너가 놓친 것(마지막 카드 등)은 전체 텍스트를 다시 읽어 채운다
  if (finalText) {
    try {
      const all = parseLooseJson(finalText);
      if (all?.plan) onPlan(all.plan);
      (Array.isArray(all?.cards) ? all.cards : []).forEach((c, i) => { if (S.plan && !cardsOut[i] && c && typeof c.body === 'string' && Array.isArray(c.claims)) onCard(i, c); }); // 잘려서 복구된 미완성 카드는 받지 않는다
    } catch { /* 이미 받은 만큼 사용 */ }
  }
  if (!S.plan) { // 기획이 끝내 안 왔다: 기본 기획(실제 문장 훅 + 안내)으로 진행
    S.notices.push('기획 AI가 응답하지 않아 기본 기획으로 진행했어요');
    onPlan({});
  }
  S.cards = new Array(S.plan.count);
  cardsOut.forEach((c, i) => { if (c && i < S.plan.count) S.cards[i] = c; });
  const missing = S.plan.briefs.map((b) => b.index).filter((i) => !S.cards[i]);
  if (missing.length) {
    if (cardsOut.filter(Boolean).length) S.notices.push(`${missing.length}장은 카드별로 다시 썼어요`);
    S.writerSys = await writerSystem(S);
    await writeAllCards(S, missing, (card) => {
      S.cards[card.index] = card;
      if (S.meta.firstCardMs == null) S.meta.firstCardMs = since(S);
      S.emit('card', { index: card.index, total: S.plan.count, card, elapsedMs: since(S) });
    });
  }
  S.cards = S.cards.map((c, i) => c || fallbackCard(S, i, null));
  S.meta.stageMs.cards = Date.now() - t;
  S.meta.stageMs.cardsEnd = since(S);
}

// ───────────────────────── 사진 캐러셀 (mode:'photo') ─────────────────────────
// 사용자가 올린 사진 N장(순서 = 카드 순서)을 축소 JPEG 로 함께 보내 "기획+문장"을 스트리밍 1회로 받는다. 카드 = 사진 + overlay(사진 위 글).
// 규칙(줄 수·글자 수·강조 수·기본 위치)은 knowledge/K-사진캐러셀.md 에서 읽는다.

const OVERLAY_SCHEMA = { type: 'OBJECT', properties: { lines: { type: 'ARRAY', items: S_ }, position: S_, size: S_, highlight: { type: 'ARRAY', items: S_ } }, required: ['lines'] };
const PHOTO_CARD_ITEM = { type: 'OBJECT', properties: { index: { type: 'INTEGER' }, role: S_, overlay: OVERLAY_SCHEMA, claims: CLAIMS_SCHEMA, reason: S_ }, required: ['overlay', 'claims'] };
const PHOTO_COMBINED_SCHEMA = {
  type: 'OBJECT',
  properties: {
    plan: {
      type: 'OBJECT',
      properties: { category: S_, type: S_, purpose: S_, target: S_, count: { type: 'INTEGER' }, hookPick: { type: 'INTEGER' }, points: { type: 'ARRAY', items: S_ }, hide: { type: 'ARRAY', items: S_ }, commentWord: S_, hooks: { type: 'ARRAY', items: { type: 'OBJECT', properties: { type: S_, headline: S_ }, required: ['headline'] } } },
      required: ['category', 'purpose', 'count', 'hooks'],
    },
    cards: { type: 'ARRAY', items: PHOTO_CARD_ITEM },
  },
  required: ['plan', 'cards'],
  propertyOrdering: ['plan', 'cards'],
};
const PHOTO_ONE_SCHEMA = { type: 'OBJECT', properties: { overlay: OVERLAY_SCHEMA, claims: CLAIMS_SCHEMA, reason: S_ }, required: ['overlay', 'claims'] };
const PHOTO_VARIANTS_SCHEMA = { type: 'OBJECT', properties: { variants: { type: 'ARRAY', items: { type: 'OBJECT', properties: { style: S_, overlay: OVERLAY_SCHEMA, claims: CLAIMS_SCHEMA, reason: S_ }, required: ['style', 'overlay', 'claims'] } } }, required: ['variants'] };

const PHOTO_FACT_RULES = [
  '사진·사실 규칙(가장 중요):',
  '- 글은 그 사진에 실제로 보이는 것 + 그래서 좋은 점만 쓴다. 사진에 없는 장면·부속품·기능을 지어내지 않는다. 사진에 보이는 것을 짚은 문장은 claims 에 type:"visual" 로 적는다.',
  '- 수치·성분·인증·순위("1위")·후기·판매량·"권위자 추천"·"완판" 같은 사실 주장은 facts 에 있을 때만 쓰고 type:"fact" + fact_id 로 연결한다. 없으면 체감 표현(type:"opinion")으로 바꾼다.',
  '- 로켓배송·무료배송·최저가·오늘 도착·할인율·쿠폰 같은 변동 사실은 쓰지 않는다.',
].join('\n');

const ruleLine = (r, label) => `${label}: ${r.minLines}~${r.maxLines}줄, 한 줄 ${r.maxChars}자 이내`;

/** 사용자가 고른 글씨 스타일에 맞춰 줄 수·길이를 조절하라는 지시(스타일은 사용자가 정하고 플래너는 정하지 않는다). */
function styleLine(S) {
  const st = S.overlayStyle || 'outline';
  const raw = S.photoStyles || { gradient: { lines: 3, minChars: 10, maxChars: 13 }, outline: { lines: 2 } };
  if (st === 'gradient') return `- 사용자가 고른 글씨 스타일은 "그라데이션"(아래 어두운 그라데이션 + 왼쪽 정렬 흰 글씨): 모든 카드를 ${raw.gradient.lines}줄 꽉 채워 쓰고 줄당 ${raw.gradient.minChars}~${raw.gradient.maxChars}자로 맞춘다.`;
  if (st === 'outline') return `- 사용자가 고른 글씨 스타일은 "테두리"(가운데 정렬 굵은 글씨): ${raw.outline.lines}줄로 짧게 쓴다.`;
  return `- 사용자가 고른 글씨 스타일은 "${st === 'band' ? '띠' : '그림자'}": 짧고 또렷하게 쓴다.`;
}

async function photoSystem(S, N) {
  const { kn, categoryHint } = S;
  const rules = S.photoRulesCache;
  const photoText = compactMd((await kn.photoText()) || '');
  const hook = compactMd(await kn.text('K-훅공식.md'));
  const factSec = compactMd(sectionByTitle(await kn.text('K-카피규칙.md'), /과장은 되지만/));
  const cat = categoryHint ? compactMd((await kn.categoryText(categoryHint)) || '') : '';
  const hasPraise = S.facts.some((f) => f.kind === 'praise');
  return [
    '[역할:사진기획+작가]',
    `당신은 인스타그램 "사진 캐러셀" 기획자 겸 카피라이터입니다. 사용자가 올린 사진 ${N}장(입력 순서 = 카드 순서)을 직접 보고, 사진마다 사진 위에 얹을 문장(overlay)을 씁니다. 사용자에게 묻지 않습니다. JSON 한 덩어리만 출력합니다(코드블록·설명 없이). 짧고 빠르게.`,
    '출력 형식(키 순서 중요: plan 을 먼저, cards 를 나중에):',
    '{"plan":{"category":"","type":"photo","purpose":"","target":"","count":N,"hookPick":0,"points":["핵심 포인트 한 줄"],"hide":[],"commentWord":"","hooks":[{"type":"숫자형","headline":"줄1\\n줄2"},{"type":"질문형","headline":""},{"type":"반전형","headline":""}]},',
    ' "cards":[{"index":1,"role":"커버|포인트|마무리","overlay":{"lines":["",""],"position":"top|middle|bottom","size":"xl|l|m","highlight":["강조단어"]},"claims":[{"text":"","type":"visual|fact|opinion|hype","fact_id":null}],"reason":""}, … N개]}',
    '',
    '규칙',
    `- count 는 반드시 ${N}(사진 수), cards 도 정확히 ${N}장이고 cards[i] 는 i번째 사진이다. category: 뷰티|패션|식품|리빙·주방|가전·테크|육아|건강·운동|반려동물|기타(맞는 게 없으면 억지로 고르지 말고 반드시 "기타"; categoryHint 는 참고값일 뿐 상품과 맞을 때만). points: 이 캐러셀이 말할 핵심 포인트 3~5개(한 줄씩; 캡션·쇼츠를 동시에 쓰는 재료). purpose: 저장|링크 클릭|댓글|팔로우|DM·문의(options.purpose 가 있으면 그대로).`,
    `- hooks: 커버 문장 후보 3안(숫자형·질문형·반전형). 각 headline 은 줄바꿈(\\n)으로 나눈 ${rules.cover.minLines}~${rules.cover.maxLines}줄. hookPick: 가장 강한 안(options.hookIndex 가 있으면 그 번호). cards[0].overlay.lines 는 hooks[hookPick] 의 줄을 그대로 쓴다.`,
    `- ${ruleLine(rules.cover, '커버(1번 사진)')} / ${ruleLine(rules.inner, '안쪽 사진')} / ${ruleLine(rules.last, '마지막 사진')}. 강조(highlight)는 한 장에 ${rules.maxHighlight}단어까지이며 각 줄에 그대로 들어 있는 문자열. 이모지 금지.`,
    `- position 은 사진의 주인공(제품·얼굴·손)을 가리지 않는 곳. 확신이 없으면 커버 ${rules.defaultPos.cover}, 안쪽 ${rules.defaultPos.inner}. size 는 커버 xl, 안쪽 l, 글이 길면 m.`,
    '- 마지막 사진은 정리 한 줄 + 행동 하나. 파트너스 링크가 없으면(input.hasPartnersLink=false) "링크로 가라"는 말 대신 저장·댓글을 유도한다. 앞 장과 같은 말 반복 금지, 넘기고 싶게 이어지게.',
    hasPraise ? '' : '- facts 에 후기(구매자 호평)가 없으니 후기·구매자·"써 본 사람" 이야기는 쓰지 않는다.',
    styleLine(S),
    toneLine(S.settings), '', PHOTO_FACT_RULES, await teaseBlock(S, { planner: true }), '',
    '## 지식: 사진 캐러셀', photoText || '(지식 파일 없음: 위 규칙만 따른다)', '', '## 지식: 훅 공식', hook, '', '## 지식: 사실 검수 기준', factSec,
    cat ? `\n## 지식: ${categoryHint} 카테고리\n${cat}` : '',
  ].join('\n');
}

/** 사진 parts 캐시(같은 사진을 여러 번 축소하지 않는다). 반환: [{text}, {inline_data}] 한 쌍 */
async function photoPartsFor(S, indices) {
  const need = indices.filter((i) => !S.photoCache.has(i));
  if (need.length) {
    const parts = await photoParts(need.map((i) => S.input.imageIds[i]));
    need.forEach((i, k) => S.photoCache.set(i, [{ text: `사진 ${i + 1}/${S.input.imageIds.length}:` }, parts[k * 2 + 1]]));
  }
  return indices.flatMap((i) => S.photoCache.get(i));
}

function finishPhotoCard(S, i, j) {
  const c = buildPhotoCard({ index: i, count: S.plan.count, imageId: S.input.imageIds[i], role: S.plan.briefs[i]?.role, j, rules: S.photoRulesCache });
  if (!c) throw new AppError('사진 위 글이 비어 있습니다.', { raw: J(j).slice(0, 200), where: WHERE.SW, code: 'EMPTY' });
  c.claims = normalizeClaims({ claims: j.claims }, S.facts).claims;
  return c;
}

const hookLines = (S) => cleanText((S.plan.hooks[S.plan.hookPick] || S.plan.hooks[0]).headline, 80).split('\n').filter(Boolean).slice(0, 3);
const linesOfCard = (c) => (c?.overlay?.lines || String(c?.headline || '').split('\n')).filter(Boolean);

/** 사진 1장 카드 쓰기(스트림 복구·카드 다시 만들기). 앞뒤 카드 문장을 함께 줘서 이어지게 한다. */
async function writePhotoCard(S, i, { style = null } = {}) {
  const rules = S.photoRulesCache;
  const hook = S.plan.hooks[S.plan.hookPick] || S.plan.hooks[0];
  const user = J({
    task: '사진 1장의 overlay 만 쓴다', index: i + 1, of: S.plan.count, role: S.plan.briefs[i]?.role, hook: hookLines(S), ...(style ? { style } : {}),
    prevLines: i > 0 ? linesOfCard(S.cards[i - 1]) : null, nextLines: S.cards[i + 1] ? linesOfCard(S.cards[i + 1]) : null, purpose: S.plan.purpose,
    rule: ruleLine(i === 0 ? rules.cover : i === S.plan.count - 1 ? rules.last : rules.inner, '이 카드'), product: S.input.title ? { title: S.input.title, price: S.input.priceText } : { topic: S.input.topic || null },
    facts: factsForPrompt(S.facts), unknown: S.factsInfo.unknown, hasPartnersLink: S.hasPartnersLink,
  });
  const system = ['[역할:사진카드작가]', '당신은 사진 캐러셀 카피라이터입니다. 아래 사진 1장 위에 얹을 문장만 씁니다. JSON 만: {"overlay":{"lines":[…],"position":"top|middle|bottom","size":"xl|l|m","highlight":[…]},"claims":[{"text":"","type":"visual|fact|opinion|hype","fact_id":null}],"reason":""}', i === 0 ? '이 카드는 커버다. overlay.lines 는 hook 의 줄을 그대로 쓴다.' : '', toneLine(S.settings), '', PHOTO_FACT_RULES, await teaseBlock(S)].filter(Boolean).join('\n');
  const parts = [{ text: user }, ...(await photoPartsFor(S, [i]))];
  const r = await generateJson({ kind: 'main', spread: i, system, parts, schema: PHOTO_ONE_SCHEMA, temperature: 0.8, maxOutputTokens: 700, signal: S.signal });
  void hook;
  const card = finishPhotoCard(S, i, r.json);
  return i === 0 ? forceHook(S, card) : card;
}

/** 커버는 선택된 훅 문장 그대로 */
function forceHook(S, card) {
  const lines = hookLines(S);
  return lines.length ? syncOverlay({ ...card, headline: lines.join('\n') }) : card;
}

async function runPhotoPlanAndCards(S) {
  const t = Date.now();
  const N = S.input.imageIds.length;
  S.photoStyles = (await S.kn.photoRules()).styles;
  const system = await photoSystem(S, N);
  const user = J({
    input: compactInput(S.input), options: { purpose: S.options.purpose, hookIndex: S.options.hookIndex }, categoryHint: S.categoryHint, photoCount: N, ...(S.options.tease ? { tease: teaseState(S) } : {}),
    hasPartnersLink: S.hasPartnersLink, facts: factsForPrompt(S.facts), unknown: S.factsInfo.unknown,
  });
  const photoPartsAll = await photoPartsFor(S, S.input.imageIds.map((_, i) => i));
  const cardsOut = [];
  const onPlan = (raw) => {
    if (S.plan) return;
    S.plan = normalizePhotoPlan(raw && typeof raw === 'object' ? raw : {}, { input: S.input, options: S.options, catDefaults: S.catDefaults, categoryHint: S.categoryHint, count: N });
    S.meta.stageMs.plan = Date.now() - t;
    S.emit('plan', { ...S.plan, elapsedMs: since(S), notices: S.notices.slice() });
    S.onPlanReady?.(); // 캡션·쇼츠를 카드 스트림과 동시에 시작
  };
  const onCard = (i, j) => {
    if (!S.plan || i >= N || cardsOut[i]) return;
    let card;
    try { card = finishPhotoCard(S, i, j); } catch { return; }
    if (i === 0) card = forceHook(S, card);
    cardsOut[i] = card;
    S.cards = cardsOut.filter(Boolean);
    if (S.meta.firstCardMs == null) S.meta.firstCardMs = since(S);
    S.emit('card', { index: i, total: N, card, elapsedMs: since(S) });
  };
  let scanner = null, seen = 0, idx = 0;
  const resetScanner = () => { seen = 0; idx = 0; scanner = createStreamScanner((kind, value) => { if (kind === 'plan') onPlan(value); else { onCard(idx, value); idx++; } }); };
  resetScanner();
  let finalText = '';
  try {
    const r = await generate({
      kind: 'main', stream: true, json: true, schema: PHOTO_COMBINED_SCHEMA, system, parts: [{ text: user }, ...photoPartsAll], temperature: 0.8, maxOutputTokens: 3000,
      signal: S.signal, timeoutMs: COMBINED_TIMEOUT_MS, timeoutSwitch: () => !S.plan,
      onText: (_d, full) => { if (full.length < seen) resetScanner(); scanner.feed(full.slice(seen)); seen = full.length; },
    });
    finalText = r.text;
  } catch (e) {
    if (e?.code === 'CANCELLED' || ['KEY_INVALID', 'BILLING', 'NO_KEY', 'FORBIDDEN', 'NETWORK'].includes(e?.code)) throw e;
    S.notices.push(`기획·문장 생성이 중간에 멈췄어요(${e?.messageKo || e?.message || '오류'}). 받은 카드는 그대로 두고 나머지를 채웁니다`);
  }
  if (finalText) {
    try {
      const all = parseLooseJson(finalText);
      if (all?.plan) onPlan(all.plan);
      (Array.isArray(all?.cards) ? all.cards : []).forEach((c, i) => { if (S.plan && !cardsOut[i] && c && c.overlay && Array.isArray(c.claims)) onCard(i, c); });
    } catch { /* 이미 받은 만큼 사용 */ }
  }
  if (!S.plan) { S.notices.push('기획 AI가 응답하지 않아 기본 기획으로 진행했어요'); onPlan({}); }
  S.cards = new Array(N);
  cardsOut.forEach((c, i) => { if (c && i < N) S.cards[i] = c; });
  const missing = S.plan.briefs.map((b) => b.index).filter((i) => !S.cards[i]);
  if (missing.length) {
    if (cardsOut.filter(Boolean).length) S.notices.push(`${missing.length}장은 사진별로 다시 썼어요`);
    await writeAllCards(S, missing, (card) => {
      S.cards[card.index] = card;
      if (S.meta.firstCardMs == null) S.meta.firstCardMs = since(S);
      S.emit('card', { index: card.index, total: N, card, elapsedMs: since(S) });
    }, (i) => writePhotoCard(S, i));
  }
  S.cards = S.cards.map((c, i) => c || fallbackCard(S, i, null));
  S.meta.stageMs.cards = Date.now() - t;
  S.meta.stageMs.cardsEnd = since(S);
}

/** 사진 카드 다시 쓰기 3안(짧게/센 훅/설명형). 그 사진 1장 + 앞뒤 카드 문장을 준다. */
async function rewritePhotoCard(S, idx, want, ctx) {
  const rules = S.photoRulesCache;
  const card = S.cards[idx];
  const hook = S.plan.hooks[S.plan.hookPick] || S.plan.hooks[0];
  const system = [
    '[역할:사진재작성]',
    '당신은 사진 캐러셀 카피라이터입니다. 아래 사진 1장 위에 얹는 문장을 요청된 스타일별로 1안씩 새로 씁니다. JSON 만 출력합니다.',
    '- 짧게: 줄 수와 글자를 줄여 핵심만. 센 훅: 멈추게 하는 한 방(숫자·반전·질문). 설명형: 사진에 보이는 것을 짚고 이점을 붙여 차분하게. 다르게: 완전히 다른 각도.',
    `- ${ruleLine(idx === 0 ? rules.cover : idx === S.plan.count - 1 ? rules.last : rules.inner, '이 카드')}. 강조는 ${rules.maxHighlight}단어까지, 이모지 금지. 앞뒤 장과 이어지고 같은 말을 반복하지 않는다.`,
    `출력: {"variants":[{"style":"${want.join('|')}","overlay":{"lines":[…],"position":"top|middle|bottom","size":"xl|l|m","highlight":[…]},"claims":[{"text":"","type":"visual|fact|opinion|hype","fact_id":null}],"reason":""}]}  (요청된 스타일 순서대로 ${want.length}개)`,
    toneLine(S.settings), '', PHOTO_FACT_RULES, await teaseBlock(S),
  ].join('\n');
  const user = J({
    index: idx + 1, of: S.plan.count, now: { lines: linesOfCard(card), position: card.overlay?.position, size: card.overlay?.size }, styles: want, hook: hookLines(S), purpose: S.plan.purpose,
    prevLines: idx > 0 ? linesOfCard(S.cards[idx - 1]) : null, nextLines: S.cards[idx + 1] ? linesOfCard(S.cards[idx + 1]) : null,
    product: S.input.title ? { title: S.input.title } : { topic: S.input.topic || null }, facts: factsForPrompt(S.facts), hasPartnersLink: S.hasPartnersLink,
  });
  void hook;
  const parts = [{ text: user }, ...(await photoPartsFor(S, [idx]))];
  const r = await generateJson({ kind: 'main', system, parts, schema: PHOTO_VARIANTS_SCHEMA, temperature: 0.9, maxOutputTokens: 1400, signal: ctx?.signal });
  const out = [];
  for (const v of (Array.isArray(r.json.variants) ? r.json.variants : []).slice(0, 4)) {
    try {
      const prevOv = card.overlay || {};
      const c = buildPhotoCard({ index: idx, count: S.plan.count, imageId: card.imageId, role: card.role, j: { ...v, overlay: { position: prevOv.position, size: prevOv.size, ...v.overlay } }, rules });
      if (!c) continue;
      c.claims = normalizeClaims({ claims: v.claims }, S.facts).claims;
      const trial = S.cards.map((x) => (x.index === idx ? c : x));
      const iss = (await ruleReview({ ...projectFor(S, trial), caption: '' }, S.kn, { hasPartnersLink: S.hasPartnersLink })).filter((i) => i.cardIndex === idx && i.level === 'fact');
      out.push({ style: toStyleKo(v.style) || v.style, card: c, factIssues: iss });
    } catch { /* 빈 안은 건너뜀 */ }
  }
  if (!out.length) throw new AppError('다시 쓰기 결과를 읽지 못했습니다. 한 번 더 눌러 주세요.', { raw: J(r.json).slice(0, 300), where: WHERE.SW, code: 'EMPTY' });
  return { index: idx, variants: out, model: r.model };
}

// ───────────────────────── 리서처 ─────────────────────────

async function runResearcher(S) {
  const { input } = S;
  const system = [
    '[역할:리서처]',
    '당신은 쇼핑 상품 사실 조사원입니다. 구글 검색과 아래 입력으로, 카드 문구에 써도 되는 사실만 모읍니다. 찾지 못한 것은 지어내지 말고 unknown 에 적습니다.',
    '출력은 JSON 한 덩어리만(코드블록·설명 없이):',
    '{"facts":[{"id":"f1","claim":"한 문장 사실","source":"coupang_page 또는 검색에서 확인한 출처 URL","quote":"출처 문장 요지","confidence":"high|medium|low","kind":"spec|praise|cons|other"}],"unknown":["확인 못 한 것"]}',
    '규칙: 사실 8~12개. 수치는 출처에 있는 그대로. 후기 수·판매량·수상·인증은 출처에 명시된 것만. 구매자 호평(kind:praise) 2~3개와 아쉬운 점(kind:cons) 1~2개는 요지로 재서술(실명·원문 복제 금지). 로켓배송·무료배송·최저가·할인 같은 변동 사실은 제외. 출처를 못 찾으면 confidence 를 low 로.',
  ].join('\n');
  const user = J({ input: compactInput(input, 1500), pageFactsAlreadyKnown: S.facts.filter((f) => f.id.startsWith('p')).map((f) => f.claim).slice(0, 8) });
  const r = await generate({ kind: 'main', system, prompt: user, search: true, rate: false, noReselect: true, temperature: 0.2, maxOutputTokens: 2000, signal: S.signal, timeoutMs: RESEARCH_TIMEOUT_MS, parse: false });
  let parsed;
  try { parsed = parseLooseJson(r.text); } catch { parsed = { facts: [], unknown: ['검색 결과를 읽지 못했어요'] }; }
  return { parsed, grounding: r.grounding, dropped: r.dropped };
}

const hostOf = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return ''; } };

/** 리서처 출력 → facts. 출처 URL 은 groundingChunks 로 검증하고, 못 찾으면 low. */
function normalizeResearch({ parsed, grounding }, startIndex = 1, { pageOk = true } = {}) {
  const chunks = grounding?.chunks || [];
  const chunkHosts = chunks.map((c) => ({ ...c, host: hostOf(c.uri), title: (c.title || '').replace(/^www\./, '') }));
  const facts = [];
  let n = startIndex;
  for (const f of (Array.isArray(parsed?.facts) ? parsed.facts : []).slice(0, 14)) {
    const claim = str(f?.claim, 200);
    if (!claim) continue;
    let source = str(f?.source, 300);
    let sourceTitle = '';
    let confidence = ['high', 'medium', 'low'].includes(f?.confidence) ? f.confidence : 'medium';
    if (source === 'coupang_page' && !pageOk) source = ''; // 상품 페이지가 없는데 페이지 출처라고 한 것은 믿지 않는다
    if (source !== 'coupang_page' && !chunks.length) { source = ''; confidence = 'low'; } // 검색 근거(groundingChunks)가 없으면 출처를 확인할 수 없다
    else if (source !== 'coupang_page') {
      let hit = null;
      if (/^https?:/i.test(source)) {
        const h = hostOf(source);
        hit = chunkHosts.find((c) => (h && (c.title.includes(h) || h.includes(c.title) || c.host === h)));
      }
      if (!hit && chunks.length) { // 근거 문장 ↔ groundingSupports 대조
        const sup = (grounding.supports || []).map((s) => ({ s, sc: overlapScore(claim + ' ' + (f?.quote || ''), s.text) })).sort((a, b) => b.sc - a.sc)[0];
        if (sup && sup.sc >= 0.35 && sup.s.idx.length) hit = chunkHosts[sup.s.idx[0]];
      }
      if (hit) { source = hit.uri; sourceTitle = hit.title || hit.host; } else { source = ''; confidence = 'low'; }
    }
    facts.push({ id: `f${n++}`, claim, source: source || 'unverified', quote: str(f?.quote, 200), confidence, kind: ['spec', 'praise', 'cons', 'other'].includes(f?.kind) ? f.kind : 'other', ...(sourceTitle ? { sourceTitle } : {}) });
  }
  return { facts, unknown: (Array.isArray(parsed?.unknown) ? parsed.unknown : []).map((x) => str(x, 100)).filter(Boolean).slice(0, 8), groundingUrls: chunks.map((c) => ({ uri: c.uri, title: c.title })).slice(0, 12) };
}
const overlapScore = (a, b) => {
  const bg = (s) => { const t = String(s).replace(/[^0-9a-zA-Z가-힣]/g, ''); const set = new Set(); for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2)); return set; };
  const A = bg(a), B = bg(b);
  if (!A.size || !B.size) return 0;
  let n = 0; for (const x of B) if (A.has(x)) n++;
  return n / B.size;
};

/** 리서처를 시작해 Promise 를 돌려준다(절대 reject 하지 않음: {ok, ...}). */
function startResearch(S) {
  if (S.input.source === 'shorts') return Promise.resolve({ ok: false, skipped: true });
  const t = Date.now();
  return runResearcher(S).then((r) => {
    S.meta.stageMs.research = Date.now() - t;
    return { ok: true, ...normalizeResearch(r, 1, { pageOk: S.input.source === 'coupang_page' }), searchDropped: (r.dropped || []).includes('tools') };
  }, (e) => ({ ok: false, error: e }));
}

function applyResearch(S, res) {
  const local = S.facts.filter((f) => !f.id.startsWith('f'));
  if (res?.ok) {
    S.facts = [...local, ...res.facts];
    S.factsInfo.unknown = [...new Set([...(S.factsInfo.unknown || []), ...res.unknown])];
    S.factsInfo.groundingUrls = res.groundingUrls;
    S.factsInfo.searchUsed = !res.searchDropped && (res.groundingUrls.length > 0 || res.facts.length > 0);
    if (res.searchDropped) S.notices.push('이 키/모델에서는 구글 검색을 쓸 수 없어 검색 없이 작성했어요 — 기능·수치 주장이 없습니다');
  } else if (res && !res.skipped) {
    if (res.error?.code === 'CANCELLED') throw res.error;
    if (['KEY_INVALID', 'BILLING', 'FORBIDDEN'].includes(res.error?.code)) throw res.error;
    S.notices.push(`오늘은 검색 없이 작성했어요 — 기능·수치 주장이 없습니다 (${res.error?.messageKo || '검색 실패'})`);
  }
  S.factsInfo.mode = S.factsInfo.searchUsed ? 'search' : local.length ? (S.input.source === 'shorts' ? 'script' : S.input.source === 'topic' ? 'none' : S.input.source === 'coupang_page' ? 'page' : 'user_input') : 'none';
  if (S.input.source === 'topic' && !S.factsInfo.searchUsed) S.notices.push('주제만 있고 검색 근거가 없어 수치 주장은 모두 뺐어요');
}

// ───────────────────────── 카드 작가 ─────────────────────────

const LAYOUT_RULES_TEXT = [
  '레이아웃별 쓰는 법(card.layout):',
  '- title: 헤드라인 중심, body 는 1줄. photo-full: 사진 위 큰 헤드라인, body 1줄. split: 왼쪽 글(body 2~3줄)·오른쪽 사진.',
  '- number: numberLabel("1","①","5위" 등 짧게) 필수, headline 은 키워드, body 는 이유 한 줄+방법 한 줄.',
  '- quote: body 는 후기·공감 요지를 재서술한 한두 줄(따옴표 넣지 않음, 실명·원문 복제 금지). bridge·cta 비움.',
  '- table: body 는 "항목|내용" 형식 줄 최대 6줄(항목 6자·내용 14자 안팎). 체크리스트는 "☐ 항목|이유".',
  '- cta: headline 에 요약 한 줄, cta 에 버튼 문구(12자 이내, 행동 하나), body 1~2줄.',
].join('\n');

async function writerSystem(S) {
  const { kn, plan, typeDoc } = S;
  const copy = compactMd(await kn.text('K-카피규칙.md'));
  const typeText = typeDoc.types[plan.type].text;
  const cta = (typeDoc.ctaBank[plan.purpose] || []).filter((x) => !x.includes('○')).map((x) => `"${x}"`).join(' / ');
  const cat = compactMd((await kn.categoryText(plan.category)) || '');
  const ex = await kn.examples({ category: plan.category, type: plan.type }, 3);
  return [
    '[역할:카드작가]',
    '당신은 인스타그램 쇼핑 캐러셀의 카드 1장을 쓰는 카피라이터입니다. 입력의 card 한 장만 씁니다. JSON만 출력합니다(코드블록·설명 없이).',
    '출력: {"headline":"","body":"","bridge":"","cta":"","numberLabel":"","claims":[{"text":"","type":"fact|opinion|hype","fact_id":null}],"reason":""}',
    '- headline 16자 이내(공백 포함, 최대 2줄), body 한 줄 18자 이내·최대 3줄(줄바꿈 \\n). 이모지는 카드당 1개 이하이고 헤드라인에는 쓰지 않는다. ○○ 같은 자리표시를 남기지 않는다.',
    '- bridge 는 핵심 카드에서만 10자 이내(선택), 그 외는 "". cta 는 layout 이 cta 일 때만.',
    '- claims 에는 카드에 실제로 쓴 문장(구)을 문장 단위로 적는다. reason 은 한 줄(어떤 공식·지식을 썼는지).',
    '- 지식 파일의 예시 문장·숫자는 형식을 보여 주는 것이다. 그대로 복사하지 말고, 숫자는 facts 에 있는 것만 쓴다.',
    '- input.fixed 가 있으면 headline·body 를 그대로 쓰고 claims·reason 만 채운다.',
    LAYOUT_RULES_TEXT, '', FACT_RULES, '',
    toneLine(S.settings), `독자: ${plan.target} · 목적: ${plan.purpose} · 유형: ${plan.typeName} · 카테고리: ${plan.category}`,
    cta ? `CTA 문장 은행(${plan.purpose}): ${cta}` : '', await teaseBlock(S),
    '', '## 지식: 카피 규칙', copy, '', `## 지식: 유형 구조 (${plan.typeName})`, typeText,
    cat ? `\n## 지식: ${plan.category} 카테고리\n${cat}` : '',
    ex.length ? `\n## 우수 사례 (같은 유형·카테고리)\n${ex.join('\n\n')}` : '',
  ].join('\n');
}

function finishCard(S, i, j, { keepFrom, role } = {}) {
  let b = S.plan.briefs[i];
  const base = keepFrom || {};
  if (role && !keepFrom) { // 기획+카드 한 호출: 모델이 쓴 role 로 레이아웃을 다시 배정(사진 없으면 낮춤)
    const r = cleanText(role, 20) || b.role;
    const slot = S.typeDoc.types[S.plan.type]?.roles.find((x) => x.role === r)?.slot || 'none';
    const { layout, imageSlot } = assignLayout(r, i, S.plan.count, slot, S.layoutRules, hasImagesOf(S.input));
    b = { ...b, role: r, layout, imageSlot };
  }
  const headline = cleanText(j.headline, 60);
  if (!headline) throw new AppError('카드 제목이 비어 있습니다.', { raw: J(j).slice(0, 200), where: WHERE.SW, code: 'EMPTY' });
  const card = {
    index: i, role: b.role, headline, body: cleanText(j.body, 320), layout: base.layout || b.layout, imageSlot: base.imageSlot || b.imageSlot,
    ...(cleanText(j.bridge, 20) ? { bridge: cleanText(j.bridge, 20) } : {}),
    ...(cleanText(j.cta, 30) ? { cta: cleanText(j.cta, 30) } : {}),
    ...(cleanText(j.numberLabel, 8) ? { numberLabel: cleanText(j.numberLabel, 8) } : {}),
    ...(base.imageId ? { imageId: base.imageId } : {}), ...(base.imageIsGenerated ? { imageIsGenerated: true } : {}),
    claims: [], reason: cleanText(j.reason, 120),
  };
  if (card.layout === 'cta' && !card.cta) {
    const last = (S.typeDoc.ctaBank[S.plan.purpose] || []).find((x) => !x.includes('○'));
    if (last) card.cta = last.replace(/["“”]/g, '').slice(0, 12);
  }
  card.claims = normalizeClaims({ claims: j.claims }, S.facts).claims;
  if (role && !keepFrom) S.plan.briefs[i] = { ...S.plan.briefs[i], role: b.role, layout: b.layout, imageSlot: b.imageSlot };
  return card;
}

async function writeCard(S, i, { fixed = null, style = null } = {}) {
  const { plan } = S;
  const b = plan.briefs[i];
  const hook = plan.hooks[plan.hookPick] || plan.hooks[0];
  const user = J({
    card: { index: i + 1, of: plan.count, role: b.role, brief: b.brief, layout: b.layout, imageSlot: b.imageSlot },
    prev: plan.briefs[i - 1] ? { role: plan.briefs[i - 1].role, brief: plan.briefs[i - 1].brief } : null,
    next: plan.briefs[i + 1] ? { role: plan.briefs[i + 1].role, brief: plan.briefs[i + 1].brief } : null,
    hook: { headline: hook.headline, body: hook.body },
    ...(fixed ? { fixed } : {}), ...(style ? { style } : {}),
    product: S.input.title ? { title: S.input.title, price: S.input.priceText } : { topic: S.input.topic || null },
    facts: factsForPrompt(S.facts), unknown: S.factsInfo.unknown,
    ...(S.hasPartnersLink ? {} : { note: '파트너스 링크는 아직 없음' }),
  });
  const tun = (await store.kvGet('dev:ai', null)) || {};
  const r = await generateJson({ kind: 'main', spread: i, system: S.writerSys, prompt: user, schema: CARD_SCHEMA, temperature: 0.8, maxOutputTokens: 1000, signal: S.signal, stream: tun.streamCards === true });
  return finishCard(S, i, r.json);
}

/** 카드를 못 썼을 때의 자리 채움. 플래너 브리프·역할 지시문은 화면에 새지 않게 안내 문구만 둔다(card.error 가 있으면 패널이 "다시 쓰기"를 보여 준다). 1번 카드는 플래너가 정한 훅(실제 문장). */
function fallbackCard(S, i, err) {
  if (S.mode === 'photo') {
    const hook = S.plan.hooks[S.plan.hookPick] || S.plan.hooks[0];
    const lines = i === 0 ? String(hook.headline).split('\n') : ['아직 못 쓴 카드예요', '다시 쓰기를 눌러 주세요'];
    const c = buildPhotoCard({ index: i, count: S.plan.count, imageId: S.input.imageIds[i], role: S.plan.briefs[i]?.role, j: { overlay: { lines } }, rules: S.photoRulesCache });
    return { ...c, error: { messageKo: err?.messageKo || '카드를 쓰지 못했어요', raw: err?.raw || '', code: err?.code || null } };
  }
  const b = S.plan.briefs[i];
  const hook = S.plan.hooks[S.plan.hookPick] || S.plan.hooks[0];
  return {
    index: i, role: b.role, headline: i === 0 ? hook.headline : '아직 못 쓴 카드예요', body: i === 0 ? hook.body : '다시 쓰기를 눌러 주세요',
    layout: b.layout, imageSlot: b.imageSlot, claims: [], reason: '', error: { messageKo: err?.messageKo || '카드를 쓰지 못했어요', raw: err?.raw || '', code: err?.code || null },
  };
}

/** 카드 N장을 병렬(설정 3~7)로. 429 면 순차 전환 후 재시도. 도착 순서대로 onCard 호출. */
async function writeAllCards(S, indices, onCard, writer = null) {
  const pending = indices.slice();
  const attempts = {};
  let running = 0, firstErr = null;
  await new Promise((resolve, reject) => {
    const pump = () => {
      if (S.signal?.aborted) return reject(new AppError('요청이 취소되었습니다.', { raw: 'AbortError', where: WHERE.SW, code: 'CANCELLED' }));
      if (!pending.length && running === 0) return resolve();
      while (pending.length && running < (S.sequential ? 1 : S.parallel)) {
        const i = pending.shift();
        running++;
        const fixed = i === 0 ? { headline: (S.plan.hooks[S.plan.hookPick] || S.plan.hooks[0]).headline, body: (S.plan.hooks[S.plan.hookPick] || S.plan.hooks[0]).body } : null;
        (writer ? writer(i) : writeCard(S, i, { fixed })).then(
          (card) => onCard(card),
          (e) => {
            if (e?.code === 'CANCELLED') return reject(e);
            if (['KEY_INVALID', 'BILLING', 'FORBIDDEN', 'NO_KEY'].includes(e?.code)) { firstErr = firstErr || e; return onCard(fallbackCard(S, i, e)); }
            attempts[i] = (attempts[i] || 0) + 1;
            if (e?.code === 'RATE_LIMIT' && attempts[i] <= 2) {
              if (!S.sequential) { S.sequential = true; S.meta.sequentialSwitched = true; S.notices.push('무료 한도(분당 요청)에 걸려 카드를 한 장씩 쓰는 중이에요'); }
              pending.unshift(i);
              return undefined;
            }
            return onCard(fallbackCard(S, i, e));
          },
        ).finally(() => { running--; pump(); });
      }
    };
    pump();
  });
  if (firstErr && S.cards.every((c) => c.error)) throw firstErr;
}

// ───────────────────────── 캡션 · 쇼츠 · 사실검수(AI) ─────────────────────────

async function runCaption(S) {
  const t = Date.now();
  const { kn, plan } = S;
  const rules = compactMd(await kn.text('K-캡션규칙.md'));
  const tags = await kn.hashtagSlice(plan.category);
  const cta = (S.typeDoc.ctaBank[plan.purpose] || []).filter((x) => !x.includes('○')).join(' / ');
  const system = [
    '[역할:캡션]',
    '당신은 인스타그램 캡션·해시태그 작가입니다. 캐러셀 카드를 보고 캡션과 해시태그를 씁니다. JSON만 출력합니다.',
    '출력: {"caption":"…","hashtags":["#…"]}',
    '- 캡션은 첫 줄(125자 이내, 훅을 다른 표현으로) + 빈 줄 + 요약 3~5줄 + 빈 줄 + CTA 한 줄. 총 500자 이내. 해시태그는 caption 에 넣지 않는다.',
    '- hashtags: 이 상품·용도·대상에 맞는 태그 3~7개를 배열 원소 하나에 "#단어" 하나씩(원소 하나에 # 여러 개 금지, 공백·숫자 꼬리·구분자 없이). 카테고리 태그 풀에서는 상품과 관련 있는 것만 고른다.',
    '- 쿠팡 파트너스 고지 문구, "가격·구성은 변동될 수 있어요", 배송·가격·링크 안내, #광고 줄은 쓰지 않는다. CTA 는 저장이 아니라 댓글 유도.',
    toneLine(S.settings), `목적: ${plan.purpose} · CTA 문장 은행: ${cta}`, '', FACT_RULES, await teaseBlock(S), '',
    '## 지식: 캡션 규칙', rules, '', '## 지식: 해시태그', tags.text,
  ].join('\n');
  const user = J({
    hook: plan.hooks[plan.hookPick] || plan.hooks[0], product: S.input.title ? { title: S.input.title } : { topic: S.input.topic || null },
    cards: S.cards.map((c) => ({ n: c.index + 1, role: c.role, headline: c.headline, body: c.body })), facts: factsForPrompt(S.facts),
  });
  try {
    const r = await generateJson({ kind: 'main', system, prompt: user, schema: CAPTION_SCHEMA, temperature: 0.8, maxOutputTokens: 1200, signal: S.signal });
    S.caption = String(r.json.caption || '').replace(/\r/g, '').trim().slice(0, 600);
    S.hashtags = dropLeakTags(S, assembleHashtags(r.json.hashtags, S.settings.fixedTags, Object.values(tags.pools).flat(), tagContext(S)));
  } catch (e) {
    if (e?.code === 'CANCELLED') throw e;
    S.notices.push(`캡션을 AI로 쓰지 못해 카드 요약으로 대신했어요(${e?.messageKo || '오류'})`);
    S.caption = fallbackCaption({ plan, cards: S.cards, ctaBank: S.typeDoc.ctaBank, tease: teaseState(S) });
    S.hashtags = dropLeakTags(S, assembleHashtags(deriveTitleTags(S.input, teaseState(S).hide), S.settings.fixedTags, Object.values(tags.pools).flat(), tagContext(S)));
  }
  S.meta.stageMs.caption = Date.now() - t;
}

async function runShorts(S) {
  const t = Date.now();
  const { plan } = S;
  const system = [
    '[역할:쇼츠]',
    '당신은 쇼츠(세로 영상) 대본 작가입니다. 완성된 캐러셀 카드를 쇼츠 대본으로 바꿉니다. JSON만 출력합니다.',
    '출력: {"hook":"0~3초 훅 한 문장","body":"3~20초 본문(가운데 카드 3장의 요지를 이어서, 말하듯)","cta":"마지막 CTA 한 문장(예: 링크는 프로필)","subtitles":["자막 한 줄(14자 이내)", … 정확히 15개]}',
    '- 카드에 없는 사실·수치를 새로 만들지 않는다. 카드의 문장을 그대로 재사용해도 좋다.', toneLine(S.settings), '', FACT_RULES, await teaseBlock(S),
  ].join('\n');
  const user = J({ plan: { type: plan.typeName, purpose: plan.purpose }, hook: plan.hooks[plan.hookPick] || plan.hooks[0], cards: S.cards.map((c) => ({ n: c.index + 1, role: c.role, headline: c.headline, body: c.body })), facts: factsForPrompt(S.facts) });
  try {
    const r = await generateJson({ kind: 'lite', system, prompt: user, schema: SHORTS_SCHEMA, temperature: 0.7, maxOutputTokens: 1200, signal: S.signal });
    const j = r.json;
    S.shorts = { hook: cleanText(j.hook, 120), body: cleanText(j.body, 500), cta: cleanText(j.cta, 80), subtitles: (Array.isArray(j.subtitles) ? j.subtitles : []).map((x) => cleanText(x, 30)).filter(Boolean).slice(0, 15) };
  } catch (e) {
    if (e?.code === 'CANCELLED') throw e;
    S.notices.push('쇼츠 대본을 AI로 쓰지 못해 카드 요약으로 대신했어요');
    S.shorts = shortsFromCards(S.cards, plan);
  }
  S.shorts.issues = await reviewShorts(S.shorts, projectOf(S), S.kn);
  S.meta.stageMs.shorts = Date.now() - t;
}

/** 캡션·해시태그 + 쇼츠 대본을 lite 모델 한 호출로. 실패하면 카드 요약으로 대신한다(AI 없음). */
/** 태그 풀이 상품과 이어지는지 볼 글: 상품 이름·설명·주제·훅·핵심 포인트·카드 문구(쿠팡 분류 경로는 카테고리를 잘못 짐작하게 한 원인이라 뺀다) */
function tagContext(S) {
  const i = S.input;
  return [i.title, i.topic, (i.description || '').slice(0, 600), ...(S.plan?.hooks || []).map((h) => h.headline), ...(S.plan?.points || []), ...(S.cards || []).filter(Boolean).flatMap((c) => [c.headline, c.body])].filter(Boolean).join(' ');
}

/**
 * 캡션·태그+쇼츠 대본을 lite 한 호출로 — plan 이 나오는 즉시 카드 스트림과 동시에 시작한다(카드 본문 대신 훅·핵심 포인트·facts 가 재료).
 * 결과 원본 {caption, hashtags, shorts} 만 돌려주고, S.caption 등은 카드가 끝난 뒤 finishCaptionShorts 가 채운다.
 */
async function captionShortsCall(S) {
  const t = Date.now();
  const { kn, plan } = S;
  const withShorts = !!S.settings.makeShorts;   // 기본 끔(2026-10-29): 이미지 캐러셀이라 대본은 만들지 않는다 → 토큰·시간 절약
  const rules = compactMd(await kn.text('K-캡션규칙.md'));
  const tags = await kn.hashtagSlice(plan.category);
  const cta = (S.typeDoc.ctaBank[plan.purpose] || []).filter((x) => !x.includes('○')).join(' / ');
  const system = [
    withShorts ? '[역할:캡션+쇼츠]' : '[역할:캡션]',
    withShorts
      ? '당신은 인스타그램 캡션·해시태그 작가이자 쇼츠(세로 영상) 대본 작가입니다. 캐러셀이 만들어지는 동안 동시에 씁니다: 입력의 훅(hook)·핵심 포인트(points)·facts 가 재료이고, cards 가 있으면 그 문구도 참고합니다. JSON만 출력합니다.'
      : '당신은 인스타그램 캡션·해시태그 작가입니다. 캐러셀이 만들어지는 동안 동시에 씁니다: 입력의 훅(hook)·핵심 포인트(points)·facts 가 재료이고, cards 가 있으면 그 문구도 참고합니다. JSON만 출력합니다.',
    withShorts
      ? '출력: {"caption":"…","hashtags":["#…"],"shorts":{"hook":"0~3초 훅 한 문장","body":"3~20초 본문(핵심 포인트 3개 요지를 말하듯 이어서)","cta":"마지막 CTA 한 문장","subtitles":["자막 한 줄(14자 이내)", … 정확히 15개]}}'
      : '출력: {"caption":"…","hashtags":["#…"]}',
    '- 캡션은 첫 줄(125자 이내, 훅을 다른 표현으로) + 빈 줄 + 요약 3~5줄 + 빈 줄 + CTA 한 줄. 총 500자 이내. 해시태그는 caption 에 넣지 않는다.',
    '- hashtags: 이 상품·용도·대상에 맞는 태그 3~7개를 배열 원소 하나에 "#단어" 하나씩(원소 하나에 # 여러 개 금지, 공백·숫자 꼬리·구분자 없이). 카테고리 태그 풀에서는 상품과 관련 있는 것만 고른다.',
    '- 쿠팡 파트너스 고지 문구, "가격·구성은 변동될 수 있어요", 배송·가격·링크 안내, #광고 줄은 쓰지 않는다. CTA 는 저장이 아니라 댓글 유도. facts·points 에 없는 사실·수치를 새로 만들지 않는다.',
    toneLine(S.settings), `목적: ${plan.purpose} · CTA 문장 은행: ${cta}`, '', FACT_RULES, await teaseBlock(S), '',
    '## 지식: 캡션 규칙', rules, '', '## 지식: 해시태그', tags.text,
  ].join('\n');
  const ready = S.cards.length === plan.count && S.cards.every(Boolean);
  const user = J({
    hook: plan.hooks[plan.hookPick] || plan.hooks[0], plan: { type: plan.typeName, purpose: plan.purpose, category: plan.category, target: plan.target }, points: plan.points,
    product: S.input.title ? { title: S.input.title } : { topic: S.input.topic || null }, ...(ready ? { cards: S.cards.map((c) => ({ n: c.index + 1, role: c.role, headline: c.headline, body: c.body })) } : { roles: plan.briefs.map((b) => b.role) }),
    facts: factsForPrompt(S.facts),
  });
  const r = await generateJson({ kind: 'lite', system, prompt: user, schema: withShorts ? CAPSHORTS_SCHEMA : CAPTION_SCHEMA, temperature: 0.8, maxOutputTokens: withShorts ? 1800 : 900, signal: S.signal });
  const j = r.json;
  if (!String(j.caption || '').trim()) throw new AppError('캡션이 비어 있습니다.', { raw: J(j).slice(0, 200), where: WHERE.SW, code: 'EMPTY' });
  S.meta.stageMs.caption = Date.now() - t;
  return { caption: j.caption, hashtags: j.hashtags, shorts: withShorts ? j.shorts : null, withShorts, pool: Object.values(tags.pools).flat() };
}

/** 캡션·쇼츠 결과를 카드가 끝난 뒤 정리(해시태그 정규화·상품 관련 풀만, 쇼츠 검수). 실패(res.ok=false)면 카드 요약으로 대신한다. */
async function finishCaptionShorts(S, res) {
  const { plan } = S;
  const pool = res.ok ? res.r.pool : Object.values((await S.kn.hashtagSlice(plan.category)).pools).flat();
  if (res.ok) {
    const j = res.r;
    S.caption = String(j.caption).replace(/\r/g, '').trim().slice(0, 600);
    S.hashtags = dropLeakTags(S, assembleHashtags(j.hashtags, S.settings.fixedTags, pool, tagContext(S)));
    const sh = j.shorts || {};
    S.shorts = !j.withShorts ? null : sh.hook ? { hook: cleanText(sh.hook, 120), body: cleanText(sh.body, 500), cta: cleanText(sh.cta, 80), subtitles: (Array.isArray(sh.subtitles) ? sh.subtitles : []).map((x) => cleanText(x, 30)).filter(Boolean).slice(0, 15) } : shortsFromCards(S.cards, plan);
  } else {
    if (res.e?.code === 'CANCELLED') throw res.e;
    S.notices.push(`캡션을 AI로 쓰지 못해 카드 요약으로 대신했어요(${res.e?.messageKo || '오류'})`);
    S.caption = fallbackCaption({ plan, cards: S.cards, ctaBank: S.typeDoc.ctaBank, tease: teaseState(S) });
    S.hashtags = dropLeakTags(S, assembleHashtags(deriveTitleTags(S.input, teaseState(S).hide), S.settings.fixedTags, pool, tagContext(S)));
    S.shorts = S.settings.makeShorts ? shortsFromCards(S.cards, plan) : null;
  }
  if (S.shorts) S.shorts.issues = await reviewShorts(S.shorts, projectOf(S), S.kn);
}

async function runFactCheck(S, signal = S.signal) {
  const system = [
    '[역할:사실검수]',
    '당신은 쇼핑 카드 문구의 사실 검수자입니다. 카드 문장을 하나씩 보고 facts·상품 정보에 근거가 없는 "사실 주장"을 찾아냅니다. JSON만 출력합니다.',
    '허용(과장·강조): 체감·감정 표현("아침이 달라져요", "손목이 편해요"), facts 에 호평이 있을 때 "후기에서 자주 보이는 말".',
    '금지(날조): facts 에 없는 수치("건조 시간 50% 단축"), 후기 수("후기 300개 분석"), 수상·인증("○○ 어워드 수상", "피부과 추천"), 비교 결과("A보다 2배 빠름"), 임의 할인율·"최저가", 없는 부속품·용량·무게, 가짜 인용문.',
    '카드의 claims 가 opinion 이어도 실제로는 사실 주장이면(예: "국내 판매 1위") 잡습니다. 감정·체감 표현은 잡지 않습니다.',
    '출력: {"issues":[{"card":카드번호(1부터),"text":"카드에 적힌 그대로의 문구","kind":"unsupported_fact|wrong_number|invented_review|invented_award|fake_comparison","why":"한 줄","fix_soften":"그 문구를 체감 표현으로 바꾼 한 줄(바꿀 수 없으면 null)","fix_delete":true}]}. 문제가 없으면 {"issues":[]}.',
    '', compactMd(sectionByTitle(await S.kn.text('K-카피규칙.md'), /과장은 되지만/)),
  ].join('\n');
  const user = J({
    cards: S.cards.map((c) => ({ card: c.index + 1, headline: c.headline, body: c.body, bridge: c.bridge || '', cta: c.cta || '', claims: c.claims })),
    facts: factsForPrompt(S.facts), product: S.input.title ? { title: S.input.title, price: S.input.priceText } : { topic: S.input.topic || null }, mode: S.factsInfo.mode,
  });
  const t = Date.now();
  const r = await generateJson({ kind: 'lite', system, prompt: user, schema: ISSUES_SCHEMA, temperature: 0.1, maxOutputTokens: 1400, signal });
  S.meta.stageMs.factCheck = Date.now() - t;
  return fromAiIssues(r.json, S.cards);
}

// ───────────────────────── 검수 · 점수 ─────────────────────────

/** 현재 상태를 Project 모양으로(검수 함수 입력용) */
function projectOf(S) { return buildProject(S); }

async function combineReview(S, aiIssues) {
  const rule = await ruleReview(projectOf(S), S.kn, { hasPartnersLink: S.hasPartnersLink });
  S.issues = mergeIssues(rule, aiIssues || []);
  const hookRules = await S.kn.hookRules();
  S.score = computeCarouselScore({ cards: S.cards, issues: S.issues, mode: S.mode, adLabel: scoreAdLabel(S), tease: !!S.options?.tease, commentWord: S.plan?.commentWord || '' });
  void hookRules;
}

// ───────────────────────── 오케스트레이션: ai.generate / ai.regenerate ─────────────────────────

function newMeta(S) {
  S.meta = { ...S.meta, elapsedMs: since(S), models: S.models, parallel: S.parallel, sequentialSwitched: !!S.meta.sequentialSwitched, mock: !!S.mock };
}

async function setupModels(S) {
  S.models = await pickModels(S.signal);
}

/**
 * 저호출 파이프라인(무료 키 기준, Gemini 호출 3~4회):
 *   [리서처 0~1회: 상품 설명이 80자 미만일 때만] → 기획+카드 스트리밍 1회 → 캡션·태그·쇼츠 1회(lite) ∥ 사실 검수 1회(lite) → 규칙 검수·점수(호출 없음)
 * 이벤트를 흘리고 Project 를 돌려준다.
 */
async function generateFlow(S, { reuseFacts = null } = {}) {
  S.plan = null; S.cards = []; // 다시 만들 때 이전 기획이 남아 새 기획을 막지 않게
  await setupModels(S);
  abortIf(S.signal);
  const local = buildLocalFacts(S.input);
  S.facts = reuseFacts ? reuseFacts : local.facts;
  S.factsInfo.unknown = local.unknown;
  // 리서처: 근거가 없을 때만(상품 설명이 충분하면 google_search 를 부르지 않는다). 쇼츠 대본은 대본이 근거.
  const needResearch = !reuseFacts && S.input.source !== 'shorts' && (S.input.description || '').length < RESEARCH_SKIP_DESC;
  const researchP = needResearch ? startResearch(S) : Promise.resolve({ ok: false, skipped: true });
  let researchRes = null;
  if (needResearch) {
    researchRes = await Promise.race([researchP, sleep(RESEARCH_WAIT_MS).then(() => null)]);
    if (researchRes) applyResearch(S, researchRes);
  } else if (!reuseFacts) applyResearch(S, { ok: false, skipped: true });
  if (reuseFacts) S.factsInfo = { ...(S.prev?.factsInfo || S.factsInfo) };
  abortIf(S.signal);

  // 캡션+쇼츠는 plan 이 나오는 즉시 카드 스트림과 동시에 시작한다(보관했다가 순서대로 내보냄). 사실 검수는 카드·facts 확정 후.
  let capP = null;
  S.onPlanReady = () => { S.meta.stageMs.captionStart = since(S); if (!capP) capP = captionShortsCall(S).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e })); };
  await (S.mode === 'photo' ? runPhotoPlanAndCards(S) : runPlanAndCards(S)); // plan · card 이벤트는 여기서 흘러 나간다
  S.onPlanReady = null;
  abortIf(S.signal);
  if (!capP) capP = captionShortsCall(S).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e }));
  if (needResearch && !researchRes) applyResearch(S, await researchP); // 아직 안 끝난 리서처를 마저 기다린다(자체 12초 제한)
  S.cards = S.cards.map((c) => (c.error ? c : { ...c, ...normalizeClaims(c, S.facts) }));
  S.emit('facts', { facts: S.facts, ...S.factsInfo, notices: S.notices.slice() });
  const a7P = runFactCheck(S).catch((e) => {
    if (e?.code === 'CANCELLED') throw e;
    S.notices.push(`AI 사실 검수가 응답하지 않아 규칙 검수 결과만 보여드려요(${e?.messageKo || '오류'})`);
    return [];
  });
  a7P.catch(() => {});

  await finishCaptionShorts(S, await capP);
  S.emit('caption', { caption: S.caption, hashtags: S.hashtags });
  const aiIssues = await a7P;
  if (S.mode !== 'photo') S.cards = styleCards(S.cards, { input: S.input });
  if (S.prev && S.mode !== 'photo') { // 전체 재생성: 사용자가 카드별로 고른 사진은 유지
    const kept = carryOverImages(S.cards, S.prev.carousel?.cards);
    S.cards = kept.cards;
    if (kept.notice) S.notices.push(kept.notice);
  }
  await combineReview(S, aiIssues);
  S.emit('review', { issues: S.issues, counts: countIssues(S.issues) });
  S.emit('score', S.score);
  if (S.shorts) S.emit('shorts', S.shorts);   // 쇼츠 끔(makeShorts=false)이면 이벤트도 없다
  newMeta(S);
  const project = projectOf(S);
  project.meta.elapsedMs = since(S);
  return project;
}

const countIssues = (issues) => ({ fact: issues.filter((i) => i.level === 'fact').length, format: issues.filter((i) => i.level === 'format').length });

/** ai.regenerate 의 부분 재생성. */
async function regenerateFlow(S, payload) {
  const prev = S.prev;
  const part = payload.part || 'all';
  await setupModels(S);
  S.plan = prev.plan; S.facts = prev.facts || []; S.factsInfo = prev.factsInfo || S.factsInfo; S.cards = prev.carousel.cards.map((c) => ({ ...c }));
  S.caption = prev.caption; S.hashtags = prev.hashtags; S.shorts = prev.shorts; S.issues = prev.issues || []; S.score = prev.score; S.notices = [];

  if (part === 'template') { // AI 없음
    S.plan = { ...prev.plan, template: TEMPLATE_OK(payload.options?.template) || prev.plan.template };
  } else if (part === 'all') {
    return generateFlow(S, { reuseFacts: prev.facts && prev.facts.length ? prev.facts : null });
  } else if (S.mode === 'photo' && (part === 'hook' || part === 'card')) {
    const idx = part === 'hook' ? 0 : clampInt(payload.index, 0, S.plan.count - 1, 0);
    if (part === 'hook') S.plan = { ...S.plan, hookPick: clampInt(payload.hookIndex ?? payload.options?.hookIndex, 0, S.plan.hooks.length - 1, 0) };
    let card;
    try { card = part === 'hook' ? forceHook(S, S.cards[0]) : await writePhotoCard(S, idx, { style: '지금과 다른 표현으로' }); } // 훅 변경은 AI 없이 커버 문장만 교체
    catch (e) { if (e?.code === 'CANCELLED') throw e; card = { ...prev.carousel.cards[idx], error: { messageKo: e?.messageKo || '다시 쓰지 못했어요', raw: e?.raw || '' } }; S.notices.push(`${idx + 1}번 카드를 다시 쓰지 못했어요`); }
    const old = prev.carousel.cards[idx];
    card = { ...card, imageId: old.imageId, ...(old.imageIsGenerated ? { imageIsGenerated: true } : {}), ...(old.photoFit ? { photoFit: old.photoFit } : {}), ...(old.photoFocus ? { photoFocus: old.photoFocus } : {}), ...(card.error ? {} : { claims: part === 'hook' ? [{ text: card.headline.replace(/\n/g, ' '), type: 'opinion', fact_id: null }] : card.claims }) };
    S.cards[idx] = card;
    S.emit('card', { index: idx, total: S.plan.count, card, elapsedMs: since(S) });
    if (part === 'hook') { await runCaption(S); S.emit('caption', { caption: S.caption, hashtags: S.hashtags }); }
  } else if (part === 'hook' || part === 'card') {
    const idx = part === 'hook' ? 0 : clampInt(payload.index, 0, S.plan.count - 1, 0);
    if (part === 'hook') {
      const hp = clampInt(payload.hookIndex ?? payload.options?.hookIndex, 0, S.plan.hooks.length - 1, 0);
      S.plan = { ...S.plan, hookPick: hp };
    }
    S.writerSys = await writerSystem(S);
    const hook = S.plan.hooks[S.plan.hookPick];
    let card;
    try { card = await writeCard(S, idx, { fixed: idx === 0 ? { headline: hook.headline, body: hook.body } : null, style: part === 'card' ? '지금과 다른 표현으로' : null }); }
    catch (e) { if (e?.code === 'CANCELLED') throw e; card = { ...prev.carousel.cards[idx], error: { messageKo: e?.messageKo || '다시 쓰지 못했어요', raw: e?.raw || '' } }; S.notices.push(`${idx + 1}번 카드를 다시 쓰지 못했어요`); }
    const old = prev.carousel.cards[idx];
    card = { ...card, layout: old.layout, imageSlot: old.imageSlot, ...(old.imageId ? { imageId: old.imageId } : {}), ...(old.imageIsGenerated ? { imageIsGenerated: true } : {}) };
    S.cards[idx] = card;
    S.cards = S.cards.map((c) => (c.error ? c : { ...c, ...normalizeClaims(c, S.facts) }));
    S.emit('card', { index: idx, total: S.plan.count, card: S.cards[idx], elapsedMs: since(S) });
    if (part === 'hook') { await runCaption(S); S.emit('caption', { caption: S.caption, hashtags: S.hashtags }); }
  } else if (part === 'caption') {
    await runCaption(S);
    S.emit('caption', { caption: S.caption, hashtags: S.hashtags });
  } else if (part === 'shorts') {
    await runShorts(S);
    if (S.shorts) S.emit('shorts', S.shorts);   // 쇼츠 끔(makeShorts=false)이면 이벤트도 없다
    newMeta(S);
    return projectOf(S);
  }
  // 공통 마무리: 검수·점수 (AI 사실 검수는 카드가 바뀐 경우에만)
  let aiIssues = [];
  if (part === 'hook' || part === 'card') {
    aiIssues = await runFactCheck(S).catch((e) => { if (e?.code === 'CANCELLED') throw e; S.notices.push('AI 사실 검수가 응답하지 않아 규칙 검수만 했어요'); return []; });
  } else aiIssues = (prev.issues || []).filter((i) => i.source === 'ai');
  await combineReview(S, aiIssues);
  S.emit('review', { issues: S.issues, counts: countIssues(S.issues) });
  S.emit('score', S.score);
  newMeta(S);
  return projectOf(S);
}
const TEMPLATE_OK = (t) => (['basic', 'warm', 'dark', 'pastel', 'nature', 'pop'].includes(t) ? t : null);

async function startRun(payload, ctx, partial) {
  const settings = await requireSettings();
  if (partial) {
    const prev = payload?.project;
    if (!prev?.plan || !prev?.carousel?.cards?.length) throw new AppError('다시 만들 작업이 없습니다. 먼저 캐러셀을 만들어 주세요.', { raw: 'project.plan/carousel 없음', where: WHERE.SW, code: 'NO_PROJECT' });
    const o = { ...(prev.options || {}), ...(payload.options || {}) };
    for (const k of Object.keys(o)) if (o[k] === '' || o[k] === undefined) o[k] = null;
    const photoMode = prev.carousel.mode === 'photo';
    if (photoMode) o.mode = 'photo';
    for (const k of STYLE_KEYS) if (payload.options?.[k] === undefined) o[k] = prev.carousel[k] ?? null; // 채팅·패널에서 고친 색·광고 표기가 이전 옵션보다 최신
    // 사진 캐러셀: 사용자가 순서를 바꿨을 수 있으니 카드의 사진 순서를 입력 사진으로 쓴다(사진 유지)
    const raw = photoMode ? { ...prev.input, imageIds: prev.carousel.cards.map((c) => c.imageId).filter(Boolean) } : prev.input;
    const { input, options } = normalizeInput({ product: raw, options: o });
    if (settings.devMockAI) return mock.regenerate({ payload, ctx, prev, input, options, settings });
    const S = await createState({ input, options, hasPartnersLink: payload.hasPartnersLink ?? prev.carousel.hasPartnersLink, prev, ctx });
    return regenerateFlow(S, { ...payload, options: o });
  }
  const { input, options, hasPartnersLink } = normalizeInput(payload);
  if (settings.devMockAI) return mock.generate({ ctx, input, options, hasPartnersLink, settings });
  if (!settings.hasKey) throw new AppError(settings.aiProvider === 'openai' ? 'GPT 키가 없습니다. 설정에서 키를 입력하고 "키 연결 확인"을 눌러 주세요.' : 'Gemini 키가 없습니다. 옵션 화면에서 키를 입력하고 "키 연결 확인"을 눌러 주세요.', { raw: `${store.aiKeyName(settings)} 없음`, where: WHERE.SW, code: 'NO_KEY' });
  const S = await createState({ input, options, hasPartnersLink, ctx });
  return generateFlow(S);
}

// ───────────────────────── 재작성 3안 · 수정 적용 · 검수 다시 ─────────────────────────

/** 저장된 Project 로 상태 S 를 복원(검수·재작성용). 네트워크 없음. */
async function stateFromProject(project, ctx) {
  if (!project?.plan || !project?.carousel?.cards) throw new AppError('작업 내용이 없습니다.', { raw: 'project 없음', where: WHERE.SW, code: 'NO_PROJECT' });
  const photoMode = project.carousel.mode === 'photo';
  const { input, options } = normalizeInput({ product: photoMode ? { ...project.input, imageIds: project.carousel.cards.map((c) => c.imageId).filter(Boolean) } : project.input, options: { ...(project.options || {}), ...(photoMode ? { mode: 'photo' } : {}), ...Object.fromEntries(STYLE_KEYS.map((k) => [k, project.carousel[k] ?? null])) }, skipPhotoCheck: true });
  const S = await createState({ input, options, hasPartnersLink: project.carousel.hasPartnersLink, prev: project, ctx });
  S.plan = project.plan; S.facts = project.facts || []; S.factsInfo = project.factsInfo || S.factsInfo; S.cards = project.carousel.cards;
  S.caption = project.caption || ''; S.hashtags = project.hashtags || []; S.shorts = project.shorts || null; S.issues = project.issues || []; S.notices = [];
  return S;
}

async function rewriteCard(payload, ctx) {
  const settings = await requireSettings();
  const idx = clampInt(payload?.index, 0, 99, -1);
  const project = payload?.project;
  if (!project?.carousel?.cards?.[idx]) throw new AppError('다시 쓸 카드를 찾지 못했습니다.', { raw: `index=${payload?.index}`, where: WHERE.SW, code: 'NO_CARD' });
  if (settings.devMockAI) return mock.rewriteCard(payload);
  const S = await stateFromProject(project, ctx);
  await setupModels(S);
  if (S.mode === 'photo') {
    const wantP = (Array.isArray(payload.styles) && payload.styles.length ? payload.styles : ['short', 'hook', 'explain']).map(toStyleKo).filter(Boolean);
    return rewritePhotoCard(S, idx, wantP, ctx);
  }
  const want = (Array.isArray(payload.styles) && payload.styles.length ? payload.styles : ['short', 'emotional', 'evidence']).map(toStyleKo).filter(Boolean);
  const card = S.cards[idx];
  const copy = compactMd(await S.kn.text('K-카피규칙.md'));
  const system = [
    '[역할:재작성]',
    '당신은 쇼핑 캐러셀 카드 재작성 카피라이터입니다. 대상 카드 1장을 같은 role·같은 메시지 범위에서 표현만 바꿔 요청된 스타일별로 1안씩 씁니다. JSON만 출력합니다.',
    '- 짧게: 글자를 절반 가까이 줄여 핵심만. 감성: 독자의 감정·장면을 살린 부드러운 표현. 근거형: facts 에 있는 사실·숫자를 하나 이상 연결(fact_id). facts 에 없으면 숫자를 쓰지 않는다. 다르게: 완전히 다른 각도의 표현.',
    '- 앞뒤 카드 흐름이 끊기면 안 되고, 기존 헤드라인과 첫 3글자가 같으면 안 된다. 글자 수·줄 수 규칙과 layout 규칙은 동일하다.',
    `출력: {"variants":[{"style":"${want.join('|')}","headline":"","body":"","bridge":"","cta":"","numberLabel":"","claims":[{"text":"","type":"fact|opinion|hype","fact_id":null}],"reason":""}]}  (요청된 스타일 순서대로 ${want.length}개)`,
    LAYOUT_RULES_TEXT, '', FACT_RULES, '', toneLine(settings), await teaseBlock(S), '', '## 지식: 카피 규칙', copy, '', `## 지식: 유형 구조 (${S.plan.typeName})`, S.typeDoc.types[S.plan.type].text, '', S.typeDoc.rewrite,
  ].join('\n');
  const user = J({
    target: { index: idx + 1, role: card.role, layout: card.layout, headline: card.headline, body: card.body, bridge: card.bridge || '', cta: card.cta || '' }, styles: want,
    context: S.cards.map(cardBrief), brief: S.plan.briefs[idx]?.brief, facts: factsForPrompt(S.facts), product: S.input.title ? { title: S.input.title } : { topic: S.input.topic || null },
  });
  const r = await generateJson({ kind: 'main', system, prompt: user, schema: VARIANTS_SCHEMA, temperature: 0.9, maxOutputTokens: 1600, signal: ctx?.signal });
  const out = [];
  for (const v of (Array.isArray(r.json.variants) ? r.json.variants : []).slice(0, 4)) {
    try {
      const c = finishCard(S, idx, v, { keepFrom: card });
      const trial = S.cards.map((x) => (x.index === idx ? c : x));
      const iss = (await ruleReview({ ...projectFor(S, trial), caption: '' }, S.kn, { hasPartnersLink: S.hasPartnersLink })).filter((i) => i.cardIndex === idx && i.level === 'fact');
      out.push({ style: toStyleKo(v.style) || v.style, card: c, factIssues: iss });
    } catch { /* 빈 안은 건너뜀 */ }
  }
  if (!out.length) throw new AppError('다시 쓰기 결과를 읽지 못했습니다. 한 번 더 눌러 주세요.', { raw: J(r.json).slice(0, 300), where: WHERE.SW, code: 'EMPTY' });
  return { index: idx, variants: out, model: r.model };
}
function projectFor(S, cards) { const keep = S.cards; S.cards = cards; const p = projectOf(S); S.cards = keep; return p; }

/** 규칙 검수(+선택적으로 이전 AI 검수 결과 유지) 후 점수까지. */
async function recompute(S, { keepAi = true, extraAi = [] } = {}) {
  const prevAi = keepAi ? (S.issues || []).filter((i) => i.source === 'ai' && i.target === 'card' && cardHasText(S.cards[i.cardIndex], i.text)) : [];
  await combineReview(S, [...prevAi, ...extraAi]);
  return { issues: S.issues, score: S.score };
}
const cardHasText = (card, t) => !!card && FIELDS_.some((f) => typeof card[f] === 'string' && card[f].includes(t));
const FIELDS_ = ['headline', 'body', 'bridge', 'cta'];

async function reviewHandler(payload, ctx) {
  const settings = await requireSettings();
  const S = await stateFromProject(payload?.project, ctx);
  let extra = [];
  if (payload.withAI && !settings.devMockAI && settings.hasKey) {
    await setupModels(S);
    extra = await runFactCheck(S).catch((e) => { S.notices.push(`AI 사실 검수 실패: ${e?.messageKo || ''}`); return []; });
  }
  const r = await recompute(S, { keepAi: !payload.withAI, extraAi: extra });
  return { ...r, counts: countIssues(r.issues), notices: S.notices };
}

async function applyFixHandler(payload, ctx) {
  const project = payload?.project;
  const S = await stateFromProject(project, ctx);
  const issue = (project.issues || []).find((i) => i.id === payload.issueId) || payload.issue;
  if (!issue) throw new AppError('수정할 항목을 찾지 못했습니다. 검수 목록을 새로 고쳐 주세요.', { raw: `issueId=${payload?.issueId}`, where: WHERE.SW, code: 'NO_ISSUE' });
  const mode = payload.mode;
  let usedMode = mode;
  const patch = {};
  if (mode === 'evidence') {
    const note = str(payload.evidence, 300);
    if (!note) throw new AppError('근거(출처 URL이나 메모)를 입력해 주세요.', { raw: 'evidence 비어 있음', where: WHERE.SW, code: 'NO_EVIDENCE' });
    const id = `u${(S.facts.filter((f) => f.source === 'user_input').length + 1)}`;
    S.facts = [...S.facts, { id, claim: issue.text, source: 'user_input', quote: note, confidence: 'high', kind: 'user', byUser: true }];
    patch.facts = S.facts;
  } else if (mode === 'soften' || mode === 'delete') {
    let fixIssue = issue;
    if (mode === 'soften' && !issue.fix_soften && !payload.customText) {
      const settings = await requireSettings();
      if (!settings.devMockAI && settings.hasKey) fixIssue = { ...issue, fix_soften: await softenOne(S, issue, ctx).catch(() => null) };
    }
    if (issue.target === 'caption') {
      const pseudo = { headline: '-', body: S.caption, claims: [] };
      const { card } = applyFixToCard(pseudo, fixIssue, mode, payload.customText);
      S.caption = card.body; patch.caption = S.caption;
    } else if (issue.target === 'card') {
      let card;
      try { ({ card } = applyFixToCard(S.cards[issue.cardIndex], fixIssue, mode, payload.customText)); }
      catch (e) { // 헤드라인 전체가 문제 문장이면 빼기 대신 완화로 대체
        if (!(mode === 'delete' && e?.code === 'FIX_EMPTY_HEADLINE' && fixIssue.fix_soften)) throw e;
        ({ card } = applyFixToCard(S.cards[issue.cardIndex], fixIssue, 'soften', payload.customText)); usedMode = 'soften';
      }
      S.cards = S.cards.map((c) => (c.index === issue.cardIndex ? card : c));
      patch.cards = { [issue.cardIndex]: card };
    } else throw new AppError('이 항목은 여기서 고칠 수 없어요. 쇼츠 대본은 "다시 만들기"를 눌러 주세요.', { raw: `target=${issue.target}`, where: WHERE.SW, code: 'FIX_UNSUPPORTED' });
  } else throw new AppError('알 수 없는 수정 방식입니다.', { raw: `mode=${mode}`, where: WHERE.SW, code: 'BAD_MODE' });
  const r = await recompute(S, { keepAi: true }); // 사용자 근거는 S.facts 에 들어 있어 규칙 검수가 그걸 근거로 본다
  return { patch: { ...patch, issues: r.issues, score: r.score }, counts: countIssues(r.issues), usedMode, resolvedIssueId: issue.id, stillOpen: r.issues.some((i) => i.id === issue.id) };
}

async function softenOne(S, issue, ctx) {
  await setupModels(S);
  const r = await generateJson({
    kind: 'lite', signal: ctx?.signal, temperature: 0.5, maxOutputTokens: 200,
    system: `[역할:완화]\n근거 없는 사실 주장을 체감·감정 표현으로 바꿔 주세요. 수치·후기 수·수상·인증을 빼고 의미는 비슷하게, 같은 길이로. JSON {"text":"바꾼 문구"}만.\n${FACT_RULES}`,
    prompt: J({ text: issue.text, why: issue.why, facts: factsForPrompt(S.facts).slice(0, 8) }),
  });
  return str(r.json.text, 120) || null;
}

async function convertShortsHandler(payload, ctx) {
  const settings = await requireSettings();
  const S = await stateFromProject(payload?.project, ctx);
  if (settings.devMockAI) { S.shorts = shortsFromCards(S.cards, S.plan); S.shorts.issues = await reviewShorts(S.shorts, projectOf(S), S.kn); return { shorts: S.shorts, mock: true }; }
  await setupModels(S);
  await runShorts(S);
  return { shorts: S.shorts, notices: S.notices };
}

/**
 * 사진만 보고 어떤 상품인지 알아본다(사진 1~3장, 가벼운 모델). 모르면 모른다고 돌려준다 — 이름을 지어내지 않는다.
 * 응답: {known:true, name, category, confidence(0~1), evidence} 또는 {known:false, why}
 */
// 사진 속 브랜드: 로고·상표 글자가 보이면(from:logo) 이름 앞에 붙이고, 모양만 보고 짐작한 것(from:shape)은 이름에 넣지 않고 추정으로만 돌려준다
function brandOf(j) {
  const brand = cleanText(j.brand, 20);
  if (!brand || /^(없음|모름|알 수 없음|unknown|none|n\/a)$/i.test(brand)) return null;
  const from = j.brandFrom === 'logo' ? 'logo' : j.brandFrom === 'shape' ? 'shape' : null;
  const confidence = Math.max(0, Math.min(1, Number(j.brandConfidence) || 0));
  if (!from || confidence < (from === 'logo' ? 0.5 : 0.6)) return null;
  return { brand, model: cleanText(j.model, 20), from, confidence, evidence: cleanText(j.brandEvidence, 80) };
}

/** 브랜드·모델을 일반 이름 앞에 붙인다(이미 들어 있으면 그대로). ui/identify.js 에도 같은 것이 있다 */
function withBrand(base, b) {
  if (!b) return base;
  const head = [b.brand, b.model].filter((x) => x && !base.includes(x)).join(' ');
  return cleanText(head ? `${head} ${base}` : base, 40);
}

async function identifyProductHandler(payload, ctx) {
  const settings = await requireSettings();
  const ids = (Array.isArray(payload?.imageIds) ? payload.imageIds : []).filter(Boolean).slice(0, 3);
  if (!ids.length) throw new AppError('먼저 사진을 올려 주세요.', { raw: 'imageIds 비어 있음', where: WHERE.SW, code: 'BAD_INPUT' });
  if (settings.devMockAI) {
    const over = ((await store.kvGet('dev:ai', null)) || {}).mockIdentify;
    return over || { known: true, name: '시험용 화이트 스니커즈', base: '시험용 화이트 스니커즈', brand: null, category: '패션', confidence: 0.8, evidence: '(시험용 더미 응답)', mock: true };
  }
  if (!settings.hasKey) throw new AppError(settings.aiProvider === 'openai' ? 'GPT 키가 없습니다. 설정에서 키를 넣어 주세요.' : 'Gemini 키가 없습니다. 설정에서 키를 넣어 주세요.', { raw: `${store.aiKeyName(settings)} 없음`, where: WHERE.SW, code: 'NO_KEY' });
  const system = [
    '[역할:상품알아보기]',
    '쇼핑 게시물용 사진을 보고 어떤 상품인지, 어느 브랜드인지 알아봅니다. JSON만 출력합니다.',
    '출력: {"known":true|false,"name":"일반 이름","category":"패션|뷰티|식품|리빙·주방|가전·테크|육아|건강·운동|반려동물|기타","confidence":0~1,"evidence":"무엇을 보고 알았는지 한 줄",',
    ' "brand":"브랜드 또는 빈칸","model":"모델명 또는 빈칸","brandFrom":"logo|shape|","brandConfidence":0~1,"brandEvidence":"브랜드를 무엇으로 알았는지 한 줄"}',
    '- name 은 브랜드를 뺀 한국어 25자 이내 일반 이름, "색·소재·종류" 중심(예: "화이트 레트로 스니커즈", "스테인리스 전기 주전자").',
    '- 브랜드를 꼭 찾아본다: 로고, 상표 글자, 라벨·태그, 포장 문구, 각인을 사진 구석까지 살핀다. 보이면 brandFrom:"logo", brand 는 한국에서 흔히 쓰는 표기(예: 나이키, 다이슨, 삼성).',
    '- 모델명(model)은 사진 속 글자로 보일 때만 넣는다.',
    '- 로고·글자는 안 보이지만 그 브랜드만의 아주 독특한 모양이면 brandFrom:"shape" 로 하고 brandConfidence 를 낮게 준다. 흔한 모양이면 브랜드를 비운다.',
    '- 짐작으로 브랜드·모델·용량·성분을 지어내지 않는다. 브랜드가 안 보이면 brand 는 빈칸.',
    '- 사진마다 다른 물건이거나, 상품이 잘 안 보이거나, 무엇인지 확신이 없으면 known:false 로 하고 name 은 비운다.',
  ].join('\n');
  const parts = [{ text: `사진 ${ids.length}장을 보고 어떤 상품인지, 브랜드는 무엇인지 알려 주세요.` }, ...(await photoParts(ids))];
  const r = await generateJson({ kind: 'lite', system, parts, temperature: 0.2, maxOutputTokens: 400, signal: ctx?.signal });
  const j = r.json || {};
  const base = cleanText(j.name, 40);
  const confidence = Math.max(0, Math.min(1, Number(j.confidence) || 0));
  if (!j.known || !base || confidence < 0.5) return { known: false, why: cleanText(j.evidence, 120) || '사진만으로는 어떤 상품인지 확실하지 않아요.', confidence };
  const b = brandOf(j);
  // 로고로 확인된 브랜드만 이름에 넣는다. 모양 추정은 사람이 [브랜드 넣기]를 눌러야 들어간다
  const name = b?.from === 'logo' ? withBrand(base, b) : base;
  return { known: true, name, base, brand: b, category: cleanText(j.category, 20), confidence, evidence: cleanText(j.evidence, 120) };
}

async function checkKeyHandler(payload) {
  const settings = await requireSettings();
  if (settings.devMockAI) return { ok: true, mock: true, model: '(시험용 더미)', liteModel: '(시험용 더미)', imageModel: null, modelCount: 0, reply: '시험용 더미 응답', ms: 1 };
  const provider = ['gemini', 'openai'].includes(payload?.provider) ? payload.provider : undefined;
  const typed = str(payload?.key, 300) || undefined;
  // 저장된 키로 확인했을 때만 결과를 남긴다(메뉴의 "연결된 AI" 표시용). 저장 전 키 시험은 남기지 않는다
  const record = async (rec) => {
    if (typed) return;
    const pv = provider || (settings.aiProvider === 'openai' ? 'openai' : 'gemini');
    const cur = (await store.getPublicSettings()).aiCheck || {};
    await store.saveSettings({ aiCheck: { ...cur, [pv]: { at: Date.now(), ...rec } } }).catch(() => {});
  };
  try {
    const r = await aiCheckKey({ key: typed, provider });
    await record({ ok: true, model: r.model, imageModel: r.imageModel });
    return r;
  } catch (e) {
    if (e?.code !== 'CANCELLED' && e?.code !== 'NO_KEY') await record({ ok: false, code: e?.code || 'ERROR' });
    throw e;
  }
}

export const handlers = {
  'ai.checkKey': checkKeyHandler,
  'ai.identifyProduct': identifyProductHandler,
  'ai.rewriteCard': rewriteCard,
  'ai.applyFix': applyFixHandler,
  'ai.review': reviewHandler,
  'ai.convertShorts': convertShortsHandler,
  'ai.chat': async (payload, ctx) => {
    const settings = await requireSettings();
    return runChat(payload, ctx, {
      settings, mock: !!settings.devMockAI,
      rewriteCard: (p) => rewriteCard(p, ctx),
      applyFix: (p) => applyFixHandler(p, ctx),
      recompute: async (project) => { const S = await stateFromProject(project, ctx); const r = await recompute(S, { keepAi: true }); return { ...r, counts: countIssues(r.issues) }; },
      aiParse: async (text, project, tools) => aiParseCommand(text, project, tools, settings, ctx),
    });
  },
  'ai.resetCaches': async () => { await resetCaches(); return { ok: true }; },
};

export const portHandlers = {
  'ai.generate': (payload, ctx) => startRun(payload, ctx, false),
  'ai.regenerate': (payload, ctx) => startRun(payload, ctx, true),
};

// ───────────────────────── 오케스트레이터 AI 해석 (규칙으로 못 읽은 말) ─────────────────────────

async function aiParseCommand(text, project, tools, settings, ctx) {
  if (settings.devMockAI || !settings.hasKey) return null;
  const S = await stateFromProject(project, ctx);
  await setupModels(S);
  const system = [
    '[역할:채팅]',
    '당신은 캐러셀 편집 비서입니다. 사용자의 한국어 요청을 아래 도구 호출 목록으로 바꿉니다. JSON만 출력합니다.',
    '출력: {"reply":"사용자에게 할 한 줄 답","calls":[{"name":"도구이름","args":{…}}]}',
    '카드 번호는 사용자가 말하는 1부터의 번호를 index(0부터)로 바꿔 넣습니다. 할 수 없는 요청이면 calls 를 비우고 reply 로 이유를 설명합니다.',
    '도구:', ...tools.map((t) => `- ${t.name}(${t.args}) — ${t.desc}`),
  ].join('\n');
  const user = J({ text, cards: S.cards.map(cardBrief), plan: { type: S.plan.type, template: S.plan.template, count: S.plan.count }, issues: (project.issues || []).filter((i) => i.level === 'fact').map((i) => ({ id: i.id, card: i.cardNo, text: i.text })) });
  const r = await generateJson({ kind: 'lite', system, prompt: user, temperature: 0.2, maxOutputTokens: 800, signal: ctx?.signal });
  return r.json;
}
