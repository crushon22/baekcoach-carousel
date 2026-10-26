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
import { Knowledge, guessCategory, canonCategory, compactMd, sectionByTitle } from './knowledge.js';
import {
  ruleReview, reviewShorts, fromAiIssues, mergeIssues, normalizeClaims, applyFixToCard, locateText, cardLines, factCorpus,
} from './review.js';
import { computeScore } from './score.js';
import {
  carryOverImages, normalizeInput, normalizePlan, buildLocalFacts, factsForPrompt, compactInput, hasImagesOf, styleCards, assembleHashtags, buildProject,
  cleanText, str, clampInt, cardBrief, fallbackCaption, shortsFromCards, DEFAULT_BRAND,
} from './ai-util.js';
import * as mock from './mock-ai.js';
import { runChat } from './chat.js';

export const prefix = 'ai.';
export const contentAllowed = [];

const RESEARCH_WAIT_MS = 5000;     // 리서처를 기다리는 최대 시간(플래너 시작부터). 넘으면 facts 없이 진행하고 사후 검수한다
const RESEARCH_TIMEOUT_MS = 12000; // 리서처 자체 제한
const RESEARCH_SKIP_FACTS = 4;     // 상품 페이지 본문에서 뽑은 사실이 이만큼 있으면 리서처를 기다리지 않는다(첫 카드 속도)

// ───────────────────────── 스키마 (responseSchema; 거부되면 ai.js 가 빼고 재시도) ─────────────────────────

const S_ = { type: 'STRING' };
const PLAN_SCHEMA = {
  type: 'OBJECT',
  properties: {
    category: S_, type: S_, purpose: S_, target: S_, count: { type: 'INTEGER' },
    hooks: { type: 'ARRAY', items: { type: 'OBJECT', properties: { type: S_, headline: S_, body: S_ }, required: ['headline'] } },
    hookPick: { type: 'INTEGER' },
    briefs: { type: 'ARRAY', items: { type: 'OBJECT', properties: { role: S_, brief: S_ }, required: ['role', 'brief'] } },
  },
  required: ['category', 'type', 'purpose', 'count', 'hooks', 'briefs'],
};
const CLAIMS_SCHEMA = { type: 'ARRAY', items: { type: 'OBJECT', properties: { text: S_, type: S_, fact_id: { type: 'STRING', nullable: true } }, required: ['text', 'type'] } };
const CARD_SCHEMA = {
  type: 'OBJECT',
  properties: { headline: S_, body: S_, bridge: S_, cta: S_, numberLabel: S_, claims: CLAIMS_SCHEMA, reason: S_ },
  required: ['headline', 'body', 'claims'],
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

const STYLE_KO = { short: '짧게', emotional: '감성', evidence: '근거형', alt: '다르게' };
const toStyleKo = (s) => STYLE_KO[s] || (['짧게', '감성', '근거형', '다르게'].includes(s) ? s : null);

// ───────────────────────── 공용 ─────────────────────────

const J = (o) => JSON.stringify(o);
const abortIf = (signal) => { if (signal?.aborted) throw new AppError('요청이 취소되었습니다.', { raw: 'AbortError', where: WHERE.SW, code: 'CANCELLED' }); };

/** 설정(키 값은 빼고 hasKey 만 남긴다). 키는 ai.js 가 store.getSecrets() 로 따로 읽는다. */
async function requireSettings() {
  const { geminiKey, coupangAccessKey, coupangSecretKey, ...rest } = await store.getSettings();
  return { ...rest, hasKey: !!geminiKey };
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
  return {
    ctx, signal: ctx?.signal, emit: (e, d) => ctx?.emit?.(e, d), t0: Date.now(), settings, kn, typeDoc, catDefaults, layoutRules, categoryHint,
    input, options, hasPartnersLink: !!hasPartnersLink, prev, notices: [], facts: [], factsInfo: { mode: 'none', unknown: [], groundingUrls: [], searchUsed: false },
    plan: null, cards: [], caption: '', hashtags: [], issues: [], score: null, shorts: null, models: null, meta: { stageMs: {} },
    brandColor: prev?.carousel?.brandColor || DEFAULT_BRAND, accentColor: prev?.carousel?.accentColor, peek: prev?.carousel?.peek, panorama: prev?.carousel?.panorama,
    parallel: clampInt(settings.parallel, 3, 7, 5), sequential: false,
  };
}
const since = (S) => Date.now() - S.t0;

// ───────────────────────── 플래너 ─────────────────────────

async function plannerSystem(S) {
  const { kn, typeDoc, catDefaults, categoryHint } = S;
  const hook = compactMd(await kn.text('K-훅공식.md'));
  const types = compactMd(await kn.text('K-유형구조.md'));
  const catLines = Object.entries(catDefaults).map(([k, v]) => `- ${k}: 기본 타깃 ${v.target} · 추천 유형 ${v.types.join(',')} · ${v.tone}`).join('\n');
  const hint = categoryHint ? compactMd((await kn.categoryText(categoryHint)) || '') : '';
  return [
    '[역할:플래너]',
    '당신은 인스타그램 쇼핑 캐러셀 기획자입니다. 입력(상품 정보·주제·쇼츠 대본)을 보고 사용자에게 묻지 않고 기획을 한 번에 확정합니다. JSON만 출력합니다.',
    '',
    '결정할 것',
    `- category: 뷰티|패션|식품|리빙·주방|가전·테크|육아|건강·운동|반려동물|기타 중 하나 (categoryHint 가 있으면 우선 고려)`,
    `- type: ${typeDoc.order.join('|')} 중 하나. options.type 이 있으면 그대로 따릅니다.`,
    '- purpose: 저장|링크 클릭|댓글|팔로우|DM·문의 중 하나. options.purpose 가 있으면 그대로, 없으면 유형의 기본 목적.',
    '- target: 독자를 한 줄로(예: "30대 엄마").',
    '- count: 5~8 정수. options.count 가 있으면 그대로, 없으면 유형의 기본 장수.',
    '- hooks: 숫자형·질문형·반전형 3안. 각 {type, headline(16자 이내), body(1~2줄, 줄바꿈 \\n)}. 훅 공식을 지키고, 제품판매형 훅에는 제품명을 쓰지 않습니다.',
    '- hookPick: 0~2. 이 상품·목적에 가장 강한 훅 번호.',
    '- briefs: count 개. 유형 구조 표의 role 이름과 순서를 따르고 각 {role, brief(그 카드가 말할 것 한 줄, 30자 이내)}. 첫 카드는 선택한 훅, 마지막은 요약+CTA 하나.',
    '',
    '규칙: 입력에 근거가 없는 수치·후기 수·수상은 훅과 brief 에 쓰지 않습니다. 주제만 있으면 수치를 전혀 쓰지 않습니다. 로켓배송·무료배송·최저가·할인율 금지. 짧게 답하세요.',
    '지식 파일의 예시 문장·숫자는 형식을 보여 주는 것입니다. 그대로 복사하지 말고, 숫자는 입력 상품 정보(가격 등)에 있는 것만 쓰세요.',
    '',
    '## 지식: 훅 공식', hook, '', '## 지식: 유형 구조', types, '', '## 참고: 카테고리 기본값', catLines,
    hint ? `\n## 참고: ${categoryHint} 카테고리 지식\n${hint}` : '',
  ].join('\n');
}

async function runPlanner(S) {
  const t = Date.now();
  const system = await plannerSystem(S);
  const user = J({ input: compactInput(S.input), options: { type: S.options.type, purpose: S.options.purpose, count: S.options.count }, categoryHint: S.categoryHint, hasProductPhotos: hasImagesOf(S.input) });
  let raw = null;
  try {
    const r = await generateJson({ kind: 'main', system, prompt: user, schema: PLAN_SCHEMA, temperature: 0.7, maxOutputTokens: 1600, signal: S.signal });
    raw = r.json;
  } catch (e) {
    if (e?.code === 'CANCELLED' || ['KEY_INVALID', 'BILLING', 'NO_KEY', 'FORBIDDEN', 'NETWORK'].includes(e?.code)) throw e;
    S.notices.push(`기획 AI가 응답하지 않아 기본 기획으로 진행했어요(${e?.messageKo || e?.message || '알 수 없는 오류'})`);
  }
  S.plan = normalizePlan(raw, { input: S.input, options: S.options, typeDoc: S.typeDoc, catDefaults: S.catDefaults, layoutRules: S.layoutRules, hasImages: hasImagesOf(S.input), categoryHint: S.categoryHint });
  S.meta.stageMs.plan = Date.now() - t;
  return S.plan;
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
  const r = await generate({ kind: 'main', system, prompt: user, search: true, temperature: 0.2, maxOutputTokens: 2000, signal: S.signal, timeoutMs: RESEARCH_TIMEOUT_MS, parse: false });
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
    cta ? `CTA 문장 은행(${plan.purpose}): ${cta}` : '',
    '', '## 지식: 카피 규칙', copy, '', `## 지식: 유형 구조 (${plan.typeName})`, typeText,
    cat ? `\n## 지식: ${plan.category} 카테고리\n${cat}` : '',
    ex.length ? `\n## 우수 사례 (같은 유형·카테고리)\n${ex.join('\n\n')}` : '',
  ].join('\n');
}

function finishCard(S, i, j, { keepFrom } = {}) {
  const b = S.plan.briefs[i];
  const base = keepFrom || {};
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
  const r = await generateJson({ kind: 'main', system: S.writerSys, prompt: user, schema: CARD_SCHEMA, temperature: 0.8, maxOutputTokens: 1000, signal: S.signal, stream: tun.streamCards === true });
  return finishCard(S, i, r.json);
}

function fallbackCard(S, i, err) {
  const b = S.plan.briefs[i];
  const hook = S.plan.hooks[S.plan.hookPick] || S.plan.hooks[0];
  return {
    index: i, role: b.role, headline: i === 0 ? hook.headline : b.role.slice(0, 16), body: i === 0 ? hook.body : b.brief.slice(0, 40),
    layout: b.layout, imageSlot: b.imageSlot, claims: [], reason: '', error: { messageKo: err?.messageKo || '카드를 쓰지 못했어요', raw: err?.raw || '', code: err?.code || null },
  };
}

/** 카드 N장을 병렬(설정 3~7)로. 429 면 순차 전환 후 재시도. 도착 순서대로 onCard 호출. */
async function writeAllCards(S, indices, onCard) {
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
        writeCard(S, i, { fixed }).then(
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
    '- 쿠팡 파트너스 고지 문구, "가격·구성은 변동될 수 있어요", 배송·가격 안내, #광고 줄은 쓰지 않는다(앱이 내보낼 때 자동으로 붙인다).',
    toneLine(S.settings), `목적: ${plan.purpose} · CTA 문장 은행: ${cta}`, '', FACT_RULES, '',
    '## 지식: 캡션 규칙', rules, '', '## 지식: 해시태그', tags.text,
  ].join('\n');
  const user = J({
    hook: plan.hooks[plan.hookPick] || plan.hooks[0], product: S.input.title ? { title: S.input.title } : { topic: S.input.topic || null },
    cards: S.cards.map((c) => ({ n: c.index + 1, role: c.role, headline: c.headline, body: c.body })), facts: factsForPrompt(S.facts),
  });
  try {
    const r = await generateJson({ kind: 'main', system, prompt: user, schema: CAPTION_SCHEMA, temperature: 0.8, maxOutputTokens: 1200, signal: S.signal });
    S.caption = String(r.json.caption || '').replace(/\r/g, '').trim().slice(0, 600);
    S.hashtags = assembleHashtags(r.json.hashtags, S.settings.fixedTags, Object.values(tags.pools).flat());
  } catch (e) {
    if (e?.code === 'CANCELLED') throw e;
    S.notices.push(`캡션을 AI로 쓰지 못해 카드 요약으로 대신했어요(${e?.messageKo || '오류'})`);
    S.caption = fallbackCaption({ plan, cards: S.cards, ctaBank: S.typeDoc.ctaBank });
    S.hashtags = assembleHashtags([], S.settings.fixedTags, Object.values(tags.pools).flat());
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
    '- 카드에 없는 사실·수치를 새로 만들지 않는다. 카드의 문장을 그대로 재사용해도 좋다.', toneLine(S.settings), '', FACT_RULES,
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
  S.score = computeScore({ cards: S.cards, issues: S.issues, hookRules: await S.kn.hookRules() });
}

// ───────────────────────── 오케스트레이션: ai.generate / ai.regenerate ─────────────────────────

function newMeta(S) {
  S.meta = { ...S.meta, elapsedMs: since(S), models: S.models, parallel: S.parallel, sequentialSwitched: !!S.meta.sequentialSwitched, mock: !!S.mock };
}

async function setupModels(S) {
  S.models = await pickModels(S.signal);
}

/** 플래너 → (리서처 ∥ 작가) → … 전체 흐름. 이벤트를 흘리고 Project 를 돌려준다. */
async function generateFlow(S, { reuseFacts = null } = {}) {
  await setupModels(S);
  abortIf(S.signal);
  // 로컬 facts 는 즉시, 리서처는 플래너와 동시에 시작
  const local = buildLocalFacts(S.input);
  S.facts = reuseFacts ? reuseFacts : local.facts;
  S.factsInfo.unknown = local.unknown;
  const descFacts = local.facts.filter((f) => f.kind === 'desc' || f.kind === 'script').length;
  const researchStart = Date.now();
  const researchP = reuseFacts ? Promise.resolve({ ok: false, skipped: true }) : startResearch(S);
  await runPlanner(S);
  abortIf(S.signal);
  S.emit('plan', { ...S.plan, elapsedMs: since(S), notices: S.notices.slice() });
  S.writerSys = await writerSystem(S);

  // 리서처를 최대 5초(플래너 시작 기준) 기다린다. 페이지 본문 사실이 충분하면 기다리지 않는다.
  let researchRes = null;
  if (!reuseFacts && descFacts < RESEARCH_SKIP_FACTS && S.input.source !== 'shorts') {
    const left = Math.max(0, RESEARCH_WAIT_MS - (Date.now() - researchStart));
    researchRes = await Promise.race([researchP, sleep(left).then(() => null)]);
    if (researchRes) applyResearch(S, researchRes);
  }
  if (reuseFacts) { S.factsInfo = { ...(S.prev?.factsInfo || S.factsInfo) }; }

  // 카드 병렬
  const tCards = Date.now();
  const cards = new Array(S.plan.count);
  S.cards = [];
  await writeAllCards(S, S.plan.briefs.map((b) => b.index), (card) => {
    cards[card.index] = card;
    S.cards = cards.filter(Boolean);
    if (S.meta.firstCardMs == null) S.meta.firstCardMs = since(S);
    S.emit('card', { index: card.index, total: S.plan.count, card, elapsedMs: since(S) });
  });
  S.cards = cards;
  S.meta.stageMs.cards = Date.now() - tCards;

  // 캡션·쇼츠는 카드가 끝나면 바로 시작(사실 검수는 facts 확정 후)
  const captionP = runCaption(S);
  const shortsP = runShorts(S).catch((e) => { if (e?.code === 'CANCELLED') throw e; S.notices.push('쇼츠 대본 생성에 실패했어요'); S.shorts = shortsFromCards(S.cards, S.plan); });
  captionP.catch(() => {}); shortsP.catch(() => {});

  // facts 확정: 아직 안 끝난 리서처를 마저 기다린다(자체 15초 제한)
  if (!reuseFacts && !researchRes) applyResearch(S, await researchP);
  S.cards = S.cards.map((c) => (c.error ? c : { ...c, ...normalizeClaims(c, S.facts) }));
  S.emit('facts', { facts: S.facts, ...S.factsInfo, notices: S.notices.slice() });
  const a7P = runFactCheck(S).catch((e) => {
    if (e?.code === 'CANCELLED') throw e;
    S.notices.push(`AI 사실 검수가 응답하지 않아 규칙 검수 결과만 보여드려요(${e?.messageKo || '오류'})`);
    return [];
  });
  a7P.catch(() => {});

  await captionP;
  S.emit('caption', { caption: S.caption, hashtags: S.hashtags });
  const aiIssues = await a7P;
  S.cards = styleCards(S.cards, { input: S.input });
  if (S.prev) { // 전체 재생성: 사용자가 카드별로 고른 사진은 유지
    const kept = carryOverImages(S.cards, S.prev.carousel?.cards);
    S.cards = kept.cards;
    if (kept.notice) S.notices.push(kept.notice);
  }
  await combineReview(S, aiIssues);
  S.emit('review', { issues: S.issues, counts: countIssues(S.issues) });
  S.emit('score', S.score);
  await shortsP;
  S.shorts = S.shorts || shortsFromCards(S.cards, S.plan);
  S.emit('shorts', S.shorts);
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
    S.emit('shorts', S.shorts);
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
    const { input, options } = normalizeInput({ product: prev.input, options: o });
    if (settings.devMockAI) return mock.regenerate({ payload, ctx, prev, input, options, settings });
    const S = await createState({ input, options, hasPartnersLink: payload.hasPartnersLink ?? prev.carousel.hasPartnersLink, prev, ctx });
    return regenerateFlow(S, { ...payload, options: o });
  }
  const { input, options, hasPartnersLink } = normalizeInput(payload);
  if (settings.devMockAI) return mock.generate({ ctx, input, options, hasPartnersLink, settings });
  if (!settings.hasKey) throw new AppError('Gemini 키가 없습니다. 옵션 화면에서 키를 입력하고 "키 연결 확인"을 눌러 주세요.', { raw: 'geminiKey 없음', where: WHERE.SW, code: 'NO_KEY' });
  const S = await createState({ input, options, hasPartnersLink, ctx });
  return generateFlow(S);
}

// ───────────────────────── 재작성 3안 · 수정 적용 · 검수 다시 ─────────────────────────

/** 저장된 Project 로 상태 S 를 복원(검수·재작성용). 네트워크 없음. */
async function stateFromProject(project, ctx) {
  if (!project?.plan || !project?.carousel?.cards) throw new AppError('작업 내용이 없습니다.', { raw: 'project 없음', where: WHERE.SW, code: 'NO_PROJECT' });
  const { input, options } = normalizeInput({ product: project.input, options: project.options || {} });
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
  const want = (Array.isArray(payload.styles) && payload.styles.length ? payload.styles : ['short', 'emotional', 'evidence']).map(toStyleKo).filter(Boolean);
  const card = S.cards[idx];
  const copy = compactMd(await S.kn.text('K-카피규칙.md'));
  const system = [
    '[역할:재작성]',
    '당신은 쇼핑 캐러셀 카드 재작성 카피라이터입니다. 대상 카드 1장을 같은 role·같은 메시지 범위에서 표현만 바꿔 요청된 스타일별로 1안씩 씁니다. JSON만 출력합니다.',
    '- 짧게: 글자를 절반 가까이 줄여 핵심만. 감성: 독자의 감정·장면을 살린 부드러운 표현. 근거형: facts 에 있는 사실·숫자를 하나 이상 연결(fact_id). facts 에 없으면 숫자를 쓰지 않는다. 다르게: 완전히 다른 각도의 표현.',
    '- 앞뒤 카드 흐름이 끊기면 안 되고, 기존 헤드라인과 첫 3글자가 같으면 안 된다. 글자 수·줄 수 규칙과 layout 규칙은 동일하다.',
    `출력: {"variants":[{"style":"${want.join('|')}","headline":"","body":"","bridge":"","cta":"","numberLabel":"","claims":[{"text":"","type":"fact|opinion|hype","fact_id":null}],"reason":""}]}  (요청된 스타일 순서대로 ${want.length}개)`,
    LAYOUT_RULES_TEXT, '', FACT_RULES, '', toneLine(settings), '', '## 지식: 카피 규칙', copy, '', `## 지식: 유형 구조 (${S.plan.typeName})`, S.typeDoc.types[S.plan.type].text, '', S.typeDoc.rewrite,
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

async function checkKeyHandler(payload) {
  const settings = await requireSettings();
  if (settings.devMockAI) return { ok: true, mock: true, model: '(시험용 더미)', liteModel: '(시험용 더미)', imageModel: null, modelCount: 0, reply: '시험용 더미 응답', ms: 1 };
  return aiCheckKey({ key: str(payload?.key, 200) || undefined });
}

export const handlers = {
  'ai.checkKey': checkKeyHandler,
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
