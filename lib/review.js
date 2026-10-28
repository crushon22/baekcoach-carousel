// 검수 — 형식 검수(A5, 정규식·K-금지어) + 사실 검수 1차(규칙, v1 §21) + AI 검수 결과 합치기 + 수정 적용.
// AI 호출이 없는 순수 코드라서 mock/키 없음에서도 똑같이 돈다. 사실 검수의 "1차 방어선"이 이 파일이다:
//   수치·후기 수·수상/인증·순위·수치 비교를 facts 와 대조해서 근거가 없으면 🔎(level:'fact')로 표시한다.
//   AI 사실 검수(A7)는 여기에 보강으로만 합친다(mergeIssues).
// 규칙 데이터(금지어·훅 금지 패턴)는 knowledge 에서 읽는다. 이 파일의 DEFAULT_PATTERNS 는 K-날조패턴.md 가 없을 때의 기본값이다.
// 서비스워커·패널 양쪽에서 import 가능.

import { AppError, WHERE } from './common.js';
import { effectivePhotoRules } from './knowledge.js';

// ───────────────────────── 공용 도구 ─────────────────────────

const hash8 = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
};
const squash = (s) => String(s || '').replace(/[\s​]+/g, '').toLowerCase();
const normNum = (s) => String(s).replace(/,/g, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
export const FIELDS = ['headline', 'body', 'bridge', 'cta'];

/** 카드에서 검사할 줄 목록 [{field, line, text}] */
export function cardLines(card) {
  const out = [];
  for (const f of FIELDS) {
    const v = card?.[f];
    if (typeof v !== 'string' || !v) continue;
    v.split('\n').forEach((line, i) => { if (line.trim()) out.push({ field: f, line: i, text: line.trim() }); });
  }
  return out;
}

const bigrams = (s) => {
  const t = squash(s).replace(/[^0-9a-z가-힣]/g, '');
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
};
/** a 의 2글자 조각 중 b 에도 있는 비율 (0~1) */
export function overlap(a, b) {
  const A = bigrams(a);
  if (!A.size) return 0;
  const B = bigrams(b);
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return n / A.size;
}

// ───────────────────────── 근거 말뭉치 ─────────────────────────

const MONEY_RE = /(\d[\d,]*(?:\.\d+)?)\s*(만\s*원|천\s*원|원)(?!두|단|료|래|산|재|목|칙|인)/g;
const toWon = (num, unit) => Number(normNum(num)) * (unit.startsWith('만') ? 10000 : unit.startsWith('천') ? 1000 : 1);

/** 근거로 쓸 수 있는 모든 텍스트·숫자·가격. facts + 상품(이름·가격·설명) + 사용자 입력. */
export function factCorpus(project) {
  const parts = [];
  for (const f of project.facts || []) {
    if (f.confidence === 'low' && f.source !== 'user_input') continue; // low 는 사실로 쓰지 않는다
    parts.push(f.claim || '', f.quote || '');
  }
  const inp = project.input || {};
  if (inp.source !== 'topic' && inp.source !== 'shorts' && inp.title) parts.push(inp.title || '', inp.priceText || '', (inp.breadcrumb || []).join(' '), inp.description || '');
  if (inp.source === 'topic') parts.push(inp.topic || '');
  if (inp.source === 'shorts') parts.push(inp.script || '');
  const text = parts.join('\n');
  // 후기(구매자 호평) 근거: researcher 가 praise 로 모았거나 근거 텍스트가 후기를 말하는 fact (상품명 fact 는 제외)
  const reviewEvidence = (project.facts || []).some((f) => f.confidence !== 'low' && f.kind !== 'name' && f.kind !== 'price' && (f.kind === 'praise' || /후기|리뷰|상품평|호평|평점|별점/.test(`${f.claim} ${f.quote || ''}`)));
  const nums = new Set((text.match(/\d[\d,]*(?:\.\d+)?/g) || []).map(normNum));
  const prices = [];
  if (Number.isFinite(inp.price)) prices.push(inp.price);
  for (const m of text.matchAll(MONEY_RE)) prices.push(toWon(m[1], m[2]));
  return { reviewEvidence, text, plain: text.replace(/(\d),(?=\d)/g, '$1'), flat: squash(text), nums, prices, mode: inp.source || 'topic' };
}

// ───────────────────────── 이슈 만들기 ─────────────────────────

export const FACT_KINDS = ['unsupported_fact', 'wrong_number', 'invented_review', 'invented_award', 'fake_comparison'];

export function makeIssue({ level, target = 'card', cardIndex = -1, kind, text, why, fix_soften = null, fix_delete = true, source = 'rule', grade = null, key = '' }) {
  const id = `${target}:${cardIndex}:${kind}:${hash8(squash(text) + key)}`;
  return {
    id, level, icon: level === 'fact' ? '🔎' : '⚠️', target, cardIndex, cardNo: cardIndex >= 0 ? cardIndex + 1 : null,
    kind, text, why, fix_soften, fix_delete, source, ...(grade ? { grade } : {}),
  };
}

// ───────────────────────── 사실 검수 1차 (규칙) ─────────────────────────

/** K-날조패턴.md 가 없을 때의 기본 패턴. 위에서부터 줄마다 첫 일치 하나만 채택한다(우선순위 순). */
export const DEFAULT_PATTERNS = [
  { kind: 'invented_review', re: /(?:후기|리뷰|상품평|구매평)\s*약?\s*[\d,]+\s*(?:개|건|명|장|여?\s*개)|[\d,]+\s*(?:개|건|명|여\s*개)\s*(?:의\s*)?(?:후기|리뷰|상품평|구매평)/u,
    why: 'facts·상품 페이지에 없는 후기 수예요', soften: '후기에서 자주 보이는 말' },
  { kind: 'invented_review', re: /(?:후기|리뷰)\s*(?:전부|전수|모두)\s*(?:읽|분석|정리)/u,
    why: '후기를 전부 분석했다는 근거가 없어요', soften: '후기에서 자주 보이는 말' },
  { kind: 'invented_award', re: /어워드|Award|수상|올해의|베스트\s*셀러|명예의\s*전당|굿\s*디자인|인증(?:서|\s*받|\s*획득|\s*완료|\s*제품|\s*마크)|특허|임상|시험\s*성적|입증|KC\s*인증|FDA|식약처|의사\s*(?:추천|권장)|권위자|전문가\s*(?:추천|인정|보증)|셰프\s*추천|교수\s*(?:추천|인정)|연예인\s*(?:추천|착용|사용)|전문의|피부과\s*(?:추천|테스트|검증)|수의사\s*(?:추천|권장)/u,
    why: 'facts에 없는 수상·인증·전문가 보증이에요', soften: null },
  { kind: 'fake_comparison', re: /보다\s*(?:약\s*)?[\d.]+\s*(?:배|%|퍼센트)|[\d.]+\s*배\s*(?:더\s*)?(?:빠|강|오래|넓|가볍|크|많|적|낮|세)|(?:타사|경쟁사|타\s*브랜드|일반\s*제품)\s*(?:대비|보다)\s*[\d.]+/u,
    why: '비교 수치(몇 배·몇 %)에 측정 근거가 없어요', soften: '일반 제품보다 손이 덜 가요' },
  { kind: 'unsupported_fact', re: /완판|품절\s*대란|(?:국내|업계|전국|판매|검색|카테고리|브랜드|전체|시장)\s*(?:1위|최고|최초|유일)|넘버\s*원|No\.?\s*1\b|판매\s*1위|(?:누적\s*)?판매량?\s*[\d,]+\s*(?:만\s*)?(?:개|대|병|박스|건)?|[\d,]+\s*(?:만\s*)?(?:개|대|병|박스|명)\s*(?:판매|돌파|이상\s*팔|가\s*선택|이\s*선택|이\s*구매)/u,
    why: '순위·판매량 같은 사실 주장에 근거가 없어요', soften: '많은 분들이 찾는' },
];

/** 사진 캐러셀에서만 추가로 보는 사실 주장: 순위 단독 표기("1위")도 근거가 필요하다(카드뉴스 랭킹형은 순번 표기라 제외). */
const PHOTO_EXTRA_PATTERNS = [
  { kind: 'unsupported_fact', re: /줄\s*서는|줄서는|웨이팅|오픈런/u, why: '"줄 서는" 같은 인기·대기 표현은 사실 주장이라 근거가 필요해요', soften: '손이 자주 가는', strict: true },
  { kind: 'unsupported_fact', re: /(?<![\d.])1위|No\.?\s*1\b|넘버\s*원|인기\s*1|가장\s*많이\s*팔/u, why: '순위·판매 1위 같은 사실 주장에 근거가 없어요', soften: '많은 분들이 찾는', strict: true },
];

// 수치 규칙: 단위가 붙은 숫자가 facts 에 없으면 🔎
const STRONG_UNIT_RE = /(\d[\d,]*(?:\.\d+)?)\s*(%|퍼센트|배(?![가-힣]{2})|dB|kW|W(?![a-zA-Z])|Wh|mAh|V(?![a-zA-Z])|Hz|kg|mg|g(?![a-zA-Z])|ml|mL|L(?![a-zA-Z])|cm|mm|m(?![a-zA-Z가-힣])|인치|GB|TB|MB|rpm|평|℃)/g;
const TIME_UNIT_RE = /(\d[\d,]*(?:\.\d+)?)\s*(시간|분|초|일|주|개월|년|회)(?![가-힣]*\s*(?:전|후|뒤)에?)/g;
const EFFECT_RE = /단축|줄(?:어|이|여)|절약|절감|빨라|빠르|빠른|만에|이내|늘|증가|향상|높|낮|개선|감소|보증|무상|지속|오래|상승|하락|차이/;

function numericIssues(line, corpus, topicMode) {
  const out = [];
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const supportedUnit = (v, u) => {
    const units = u === '퍼센트' ? ['퍼센트', '%'] : u === '%' ? ['%', '퍼센트'] : [u];
    return units.some((x) => new RegExp(`(?<![\\d.])${esc(normNum(v))}\\s*${esc(x)}`, 'i').test(corpus.plain));
  };
  const hasSameUnit = (u) => new RegExp(`\\d\\s*${u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(corpus.text);
  for (const m of line.matchAll(STRONG_UNIT_RE)) {
    const [whole, v, u] = m;
    if (supportedUnit(v, u)) continue;
    const kind = hasSameUnit(u) ? 'wrong_number' : 'unsupported_fact';
    out.push({ kind, span: whole, why: kind === 'wrong_number' ? `facts에는 ${u} 단위로 다른 수치가 있어요` : `${whole}라는 수치는 facts·상품 페이지에 없어요`, index: m.index });
  }
  for (const m of line.matchAll(TIME_UNIT_RE)) {
    const [whole, v, u] = m;
    if (!topicMode && !EFFECT_RE.test(line)) continue;
    if (supportedUnit(v, u)) continue;
    out.push({ kind: 'unsupported_fact', span: whole, why: `${whole}라는 수치/효과는 facts·상품 페이지에 없어요`, index: m.index });
  }
  // 금액: facts 의 가격과 ±20% 안이거나 같은 만 원대면 통과
  for (const m of line.matchAll(MONEY_RE)) {
    const won = toWon(m[1], m[2]);
    if (corpus.prices.some((p) => p > 0 && ((won / p >= 0.8 && won / p <= 1.25) || Math.floor(won / 10000) === Math.floor(p / 10000)))) continue;
    out.push({ kind: corpus.prices.length ? 'wrong_number' : 'unsupported_fact', span: m[0], why: corpus.prices.length ? '상품 페이지 가격과 달라요' : '가격 근거(상품 페이지 가격)가 없어요', index: m.index });
  }
  return out;
}

/** 줄 하나에 대한 사실 검수 규칙 → {kind, why, span, soften}|null (우선순위 첫 일치) */
function checkFactLine(line, corpus, patterns) {
  const topicMode = corpus.mode === 'topic';
  for (const p of patterns) {
    const m = line.match(p.re);
    if (!m) continue;
    const digits = (m[0].match(/\d[\d,]*(?:\.\d+)?/g) || []).map(normNum);
    const ok = p.strict ? corpus.flat.includes(squash(m[0])) : digits.length ? digits.every((d) => corpus.nums.has(d)) : corpus.flat.includes(squash(m[0]));
    if (ok) continue;
    return { kind: p.kind, why: p.why, span: m[0], soften: p.soften };
  }
  const nums = numericIssues(line, corpus, topicMode);
  if (nums.length) {
    const n = nums[0];
    return { kind: n.kind, why: n.why, span: n.span, soften: null, numeric: true };
  }
  return null;
}

/** span 을 repl 로 바꾼다. span 뒤에 짧은 꼬리(예: " 분석")만 남으면 같이 지워 어색한 문장을 피한다. */
function replaceSpan(text, span, repl) {
  const i = text.indexOf(span);
  if (i < 0) return repl;
  const rest = text.slice(i + span.length);
  const tail = /^[\s가-힣]{0,8}$/.test(rest) ? '' : rest;
  return (text.slice(0, i) + repl + tail).replace(/\s{2,}/g, ' ').trim();
}

/** 수치 완화: 숫자+단위를 "눈에 띄게"로 바꾼 한 줄 (AI 가 없을 때의 임시 제안) */
function softenNumeric(line, span) {
  const replaced = line.replace(span, '눈에 띄게').replace(/\s{2,}/g, ' ').trim();
  return replaced === line ? null : replaced;
}

// ───────────────────────── fact_id 보정 ─────────────────────────

/** 카드 claims 정리: 없는 fact_id 는 null, fact 인데 id 없으면 가장 닮은 fact 에 연결(≥0.55). */
export function normalizeClaims(card, facts) {
  const ids = new Set((facts || []).map((f) => f.id));
  const usable = (facts || []).filter((f) => f.confidence !== 'low');
  const claims = (Array.isArray(card.claims) ? card.claims : [])
    .filter((c) => c && typeof c.text === 'string' && c.text.trim())
    .map((c) => {
      const type = ['fact', 'opinion', 'hype', 'visual'].includes(c.type) ? c.type : 'opinion';
      let fid = c.fact_id && ids.has(c.fact_id) ? c.fact_id : null;
      if (type === 'fact' && !fid) {
        let best = null;
        for (const f of usable) { const s = overlap(c.text, `${f.claim} ${f.quote || ''}`); if (!best || s > best.s) best = { s, id: f.id }; }
        if (best && best.s >= 0.55) fid = best.id;
      }
      return { text: c.text.trim(), type, fact_id: fid };
    });
  return { ...card, claims };
}

// ───────────────────────── 형식 검수 ─────────────────────────

const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F300}-\u{1FAFF}]/gu;
const MARKERS = /[❌☐☑✔✅❓❗→←↑↓▶◀★☆♥♡✓✗①-⑨]/gu; // 목록/강조 기호는 이모지로 세지 않는다(K-유형구조가 헤드라인에 ❌ 를 씀)
const countEmoji = (s) => (String(s || '').replace(MARKERS, '').match(EMOJI_RE) || []).length;

const EXTRA_VARIABLE = ['로켓와우', '새벽 배송', '새벽배송', '당일 배송', '당일배송', '내일 도착', '당일 도착', '무료 반품', '타임딜', '특가', '할인율', '쿠폰'];
const ACTION_GROUPS = [
  ['저장', /저장/], ['댓글', /댓글/], ['링크', /링크|프로필|구매|주문|클릭/], ['팔로우', /팔로우|구독/], ['DM', /DM|디엠|문의|메시지/], ['공유', /공유|태그/],
];
const LINK_CTA_RE = /(?:링크|프로필)[^.\n]{0,8}(?:확인|클릭|구매|들어|눌러|참고|에서)|링크(?:로|에서|는)|구매는?\s*링크|링크\s*남기/;
/** 후기·구매자 이야기를 "사실처럼" 말하는 표현 (후기를 읽어 보라는 조언은 제외) */
const REVIEW_CLAIM_RE = /(?:후기|리뷰|평)(?:에서|가|는|들이|도|를)?\s*(?:많|자주|꼽|공통|나온|보이|좋|극찬|호평|칭찬)|구매자(?:들)?(?:이|가|는|들은|\s*후기)|(?:실제로\s*)?(?:써|사용해|구매해)\s*본\s*(?:사람|분|고객)|실사용자|써본\s*(?:사람|분)|후기\s*(?:모음|인용|\d)/;
const PLACEHOLDER_RE = /○{1,}|\bX{2,}\b|\[[^\]]{1,20}\]|\{[^}]{1,20}\}|000\s*원/;

function pushForbidden(out, lines, forbidden, corpus, { target, cardIndex, type }) {
  for (const { field, text } of lines) {
    for (const f of forbidden) {
      const m = text.match(f.re);
      if (!m) continue;
      if (f.needsEvidence && corpus.flat.includes(squash(f.term))) continue;
      if (type === 'ranking' && /위$/.test(f.term) && field === 'headline' && /^\s*\d+\s*위/.test(text)) continue; // 랭킹 카드의 순번 표기
      if (f.variable) {
        out.push(makeIssue({ level: 'format', target, cardIndex, kind: 'variable_fact', text, why: `"${m[0]}" 같은 배송·가격 변동 사실은 카드에 쓰지 않아요. 캡션의 "배송·가격은 링크에서 확인"이 대신해요`, fix_delete: true, grade: f.grade, key: m[0] }));
        continue;
      }
      const first = (f.replacement || '').split(/[,，]/)[0].replace(/^대체 표현 예:\s*/, '').trim();
      const soft = f.grade === '금지' && first && first.length <= 10 && !/\s|\(|사실|명시|삭제/.test(first) ? text.replace(m[0], first) : null;
      out.push(makeIssue({ level: 'format', target, cardIndex, kind: 'banned_word', text, why: `${f.grade === '금지' ? '금지 표현' : '주의 표현'} "${m[0]}"${f.replacement ? ' → ' + f.replacement : ''} (${f.scope})`, fix_soften: soft, fix_delete: true, grade: f.grade, key: m[0] }));
    }
  }
}

/**
 * 형식 검수 + 사실 검수 1차를 한꺼번에. project: {input, plan, carousel, facts, caption, hashtags}.
 * @returns {Promise<Issue[]>} (중복 제거됨, 🔎 먼저)
 */
export async function ruleReview(project, kn, { hasPartnersLink = false } = {}) {
  const car = project.carousel || { cards: [] };
  const cards = car.cards || [];
  const corpus = factCorpus(project);
  const forbidden = await kn.forbidden(project.plan?.category || '기타');
  const extra = kn.patterns ? await kn.patterns() : null;
  const patterns = [...(extra || DEFAULT_PATTERNS), ...(project.carousel?.mode === 'photo' ? PHOTO_EXTRA_PATTERNS : [])];
  const hookRules = await kn.hookRules();
  const type = project.plan?.type || car.type;
  const photo = car.mode === 'photo';
  const photoRules = photo ? effectivePhotoRules(await kn.photoRules(), car.overlayStyle || 'outline') : null;
  const out = [];
  const seenLine = new Set();

  const factOnLine = (cardIndex, target, text) => {
    const key = `${target}:${cardIndex}:${squash(text)}`;
    if (seenLine.has(key)) return;
    const hit = checkFactLine(text, corpus, patterns);
    if (!hit) return;
    seenLine.add(key);
    let soft = hit.soften ? replaceSpan(text, hit.span, hit.soften) : null;
    if (hit.soften && soft === text) soft = hit.soften;
    if (hit.kind === 'invented_review' && !corpus.reviewEvidence) soft = '고를 때 볼 포인트'; // 후기 근거가 없으면 "후기에서 자주 보이는 말"도 쓸 수 없다
    if (!soft && hit.numeric) soft = softenNumeric(text, hit.span);
    out.push(makeIssue({ level: 'fact', target, cardIndex, kind: hit.kind, text, why: hit.why, fix_soften: soft, fix_delete: true }));
  };

  cards.forEach((card, i) => {
    const lines = cardLines(card);
    // 1) 사실 검수 1차 — 줄 단위
    for (const l of lines) factOnLine(i, 'card', l.text);
    // 2) 사실 검수 — claims 에 fact 표시인데 근거(fact_id) 없는 것
    for (const c of card.claims || []) {
      if (c.type === 'fact' && !c.fact_id) {
        const where = lines.find((l) => squash(l.text).includes(squash(c.text)) || squash(c.text).includes(squash(l.text)));
        const text = where ? where.text : c.text;
        const key = `card:${i}:${squash(text)}`;
        if (seenLine.has(key)) continue;
        seenLine.add(key);
        out.push(makeIssue({ level: 'fact', cardIndex: i, kind: 'unsupported_fact', text, why: '사실로 쓴 문장인데 근거(facts)와 연결되지 않았어요', fix_soften: null, fix_delete: true }));
      }
    }
    // 2-b) 후기 근거 없는 후기 카드·후기 인용 (v1 §21-C "가짜 인용문 금지")
    if (!corpus.reviewEvidence) {
      const roleHit = /후기/.test(card.role || '');
      const hit = lines.find((l) => REVIEW_CLAIM_RE.test(l.text));
      const target = hit ? hit.text : roleHit && /후기|리뷰/.test(`${card.headline || ''} ${card.body || ''}`) ? (card.headline || '').split('\n')[0] : null;
      if (target) {
        const key = `card:${i}:${squash(target)}`;
        if (!seenLine.has(key)) {
          seenLine.add(key);
          out.push(makeIssue({ level: 'fact', cardIndex: i, kind: 'invented_review', text: target, why: '후기 근거(facts)가 없는데 후기·써 본 사람 이야기를 썼어요', fix_soften: '고를 때 볼 포인트', fix_delete: true }));
        }
      }
    }
    // 3) 형식 검수
    if (photo) {
      // 사진 캐러셀: 줄 수·한 줄 글자 수는 지식(K-사진캐러셀)에서 읽은 값으로 검사한다
      const r = i === 0 ? photoRules.cover : i === cards.length - 1 ? photoRules.last : photoRules.inner;
      const ls = (card.overlay?.lines && card.overlay.lines.length ? card.overlay.lines : String(card.headline || '').split('\n')).map((x) => String(x).trim()).filter(Boolean);
      const shown = ls.join('\n');
      if (!card.error) {
        if (ls.length > r.maxLines) out.push(makeIssue({ level: 'format', cardIndex: i, kind: 'overlay_lines', text: shown, why: `사진 위 글이 ${ls.length}줄이에요(${r.minLines}~${r.maxLines}줄)`, fix_delete: false }));
        else if (ls.length < r.minLines) out.push(makeIssue({ level: 'format', cardIndex: i, kind: 'overlay_lines_few', text: shown, why: `사진 위 글이 ${ls.length}줄이에요(${r.minLines}~${r.maxLines}줄)`, fix_delete: false }));
        const longLine = ls.find((x) => x.length > r.maxChars);
        if (longLine) out.push(makeIssue({ level: 'format', cardIndex: i, kind: 'overlay_line_long', text: longLine, why: `한 줄이 ${longLine.length}자예요(${r.maxChars}자 이내)`, fix_delete: false }));
        if (countEmoji(shown) > 0) out.push(makeIssue({ level: 'format', cardIndex: i, kind: 'emoji', text: shown.slice(0, 40), why: '사진 위 글에는 이모지를 쓰지 않아요(테두리 글씨와 어울리지 않음)', fix_delete: false }));
        const hl = Array.isArray(card.overlay?.highlight) ? card.overlay.highlight : [];
        // 강조 단어 개수는 막지 않는다(2026-10-28 사용자 결정: 원하는 만큼). AI 가 처음 쓸 때만 지식 파일의 maxHighlight 를 따른다
        const missing = hl.find((h) => !ls.some((x) => x.includes(h)));
        if (missing) out.push(makeIssue({ level: 'format', cardIndex: i, kind: 'highlight_missing', text: missing, why: '강조 단어가 글에 그대로 들어 있지 않아요', fix_delete: false }));
      }
    } else {
    const hl = (card.headline || '').replace(/\n/g, '');
    if (hl.length > 16) out.push(makeIssue({ level: 'format', cardIndex: i, kind: 'headline_long', text: card.headline, why: `헤드라인이 ${hl.length}자예요(16자 이내)`, fix_delete: false }));
    if ((card.headline || '').split('\n').length > 2) out.push(makeIssue({ level: 'format', cardIndex: i, kind: 'headline_lines', text: card.headline, why: '헤드라인은 최대 2줄이에요', fix_delete: false }));
    const bodyLines = (card.body || '').split('\n').filter((x) => x.trim());
    const maxLines = card.layout === 'table' ? 6 : 3;
    if (bodyLines.length > maxLines) out.push(makeIssue({ level: 'format', cardIndex: i, kind: 'body_lines', text: card.body, why: `본문이 ${bodyLines.length}줄이에요(최대 ${maxLines}줄)`, fix_delete: false }));
    if (card.layout !== 'table') {
      const longLine = bodyLines.find((x) => x.replace(/\s/g, '').length > 18 + 4 || x.length > 22);
      if (longLine) out.push(makeIssue({ level: 'format', cardIndex: i, kind: 'body_line_long', text: longLine, why: `한 줄이 ${longLine.length}자예요(18자 안팎)`, fix_delete: false }));
    } else if (bodyLines.length && !bodyLines.some((x) => x.includes('|'))) {
      out.push(makeIssue({ level: 'format', cardIndex: i, kind: 'table_format', text: card.body, why: '표 카드는 "항목|내용" 줄이어야 해요', fix_delete: false }));
    }
    const emojiTotal = countEmoji(card.headline) + countEmoji(card.body) + countEmoji(card.bridge) + countEmoji(card.cta);
    if (countEmoji(card.headline) > 0 || emojiTotal > 1) out.push(makeIssue({ level: 'format', cardIndex: i, kind: 'emoji', text: `${card.headline || ''} ${card.body || ''}`.trim().slice(0, 40), why: '이모지는 카드당 1개까지, 헤드라인에는 쓰지 않아요', fix_delete: false }));
    }
    for (const l of lines) {
      if (PLACEHOLDER_RE.test(l.text)) out.push(makeIssue({ level: 'format', cardIndex: i, kind: 'placeholder', text: l.text, why: '채워지지 않은 자리표시(○○ 등)가 있어요', fix_delete: false }));
    }
    pushForbidden(out, lines, forbidden, corpus, { target: 'card', cardIndex: i, type });
    for (const w of EXTRA_VARIABLE) {
      const l = lines.find((x) => x.text.includes(w));
      if (l && !out.some((o) => o.cardIndex === i && o.kind === 'variable_fact' && squash(o.text) === squash(l.text))) {
        out.push(makeIssue({ level: 'format', cardIndex: i, kind: 'variable_fact', text: l.text, why: `"${w}" 같은 배송·가격 변동 사실은 카드에 쓰지 않아요`, fix_delete: true }));
      }
    }
    if (!hasPartnersLink) {
      const l = lines.find((x) => LINK_CTA_RE.test(x.text));
      if (l) out.push(makeIssue({ level: 'format', cardIndex: i, kind: 'link_cta_without_link', text: l.text, why: '파트너스 링크가 아직 없는데 링크로 가라는 문구예요. 링크를 넣거나 문구를 바꾸세요', fix_delete: true }));
    }
    if (card.error) out.push(makeIssue({ level: 'format', cardIndex: i, kind: 'card_failed', text: card.headline || '(비어 있음)', why: `이 카드는 AI가 쓰지 못했어요: ${card.error.messageKo || ''}`, fix_delete: false }));
  });

  // 카드 1번 훅 금지 제목 패턴
  const hook = cards[0];
  if (hook?.headline) {
    const bad = hookRules.find((r) => r.re.test(hook.headline.replace(/\n/g, ' ')));
    if (bad) out.push(makeIssue({ level: 'format', cardIndex: 0, kind: 'hook_forbidden', text: hook.headline, why: `훅에 쓰면 안 되는 제목 패턴이에요(${bad.label})`, fix_delete: false }));
  }
  // 마지막 카드 CTA 하나
  const last = cards[cards.length - 1];
  if (last) {
    const t = `${last.headline || ''} ${last.body || ''} ${last.cta || ''}`;
    const groups = ACTION_GROUPS.filter(([, re]) => re.test(t)).map(([n]) => n);
    const linkAndReply = groups.length === 2 && groups.includes('링크') && (groups.includes('댓글') || groups.includes('DM')); // '댓글에 링크 남기면' 은 행동 하나
    if (groups.length >= 2 && !linkAndReply) out.push(makeIssue({ level: 'format', cardIndex: cards.length - 1, kind: 'cta_multi', text: (last.cta || last.headline || '').slice(0, 40), why: `마지막 카드에 행동이 ${groups.length}개(${groups.join('·')})예요. 하나만 남기세요`, fix_delete: false }));
    else if (groups.length === 0) out.push(makeIssue({ level: 'format', cardIndex: cards.length - 1, kind: 'cta_missing', text: (last.headline || '').slice(0, 40), why: '마지막 카드에 행동(저장·댓글·링크 등)이 보이지 않아요', fix_delete: false }));
  }
  // 글자 수 균형 (v1 §20-E)
  const sizes = cards.map((c) => `${c.headline || ''}${c.body || ''}`.replace(/\s/g, '').length).filter((n) => n > 0);
  if (!photo && sizes.length >= 3 && Math.max(...sizes) / Math.min(...sizes) > 2.5) {
    out.push(makeIssue({ level: 'format', cardIndex: -1, target: 'carousel', kind: 'balance', text: '카드별 글자 수', why: '카드마다 글자 수 차이가 커요(최대/최소 2.5배 초과). 긴 카드를 줄이거나 짧은 카드를 보강하세요', fix_delete: false }));
  }

  // 캡션
  const cap = project.caption || '';
  if (cap) {
    const capLines = cap.split('\n').map((t, i) => ({ field: 'caption', line: i, text: t.trim() })).filter((l) => l.text);
    for (const l of capLines) factOnLine(-1, 'caption', l.text);
    pushForbidden(out, capLines, forbidden, corpus, { target: 'caption', cardIndex: -1, type });
    for (const w of EXTRA_VARIABLE) {
      const l = capLines.find((x) => x.text.includes(w));
      if (l) out.push(makeIssue({ level: 'format', target: 'caption', cardIndex: -1, kind: 'variable_fact', text: l.text, why: `"${w}" 같은 변동 사실은 캡션에도 쓰지 않아요("배송·가격은 링크에서 확인"이 자동으로 붙어요)`, fix_delete: true }));
    }
    if (cap.split('\n')[0].length > 125) out.push(makeIssue({ level: 'format', target: 'caption', cardIndex: -1, kind: 'caption_first_long', text: cap.split('\n')[0].slice(0, 40), why: '캡션 첫 줄이 125자를 넘어 "더보기"에 잘려요', fix_delete: false }));
    if (cap.length > 500) out.push(makeIssue({ level: 'format', target: 'caption', cardIndex: -1, kind: 'caption_long', text: `${cap.length}자`, why: '캡션이 500자를 넘어요', fix_delete: false }));
    if (!hasPartnersLink) {
      const l = capLines.find((x) => LINK_CTA_RE.test(x.text));
      if (l) out.push(makeIssue({ level: 'format', target: 'caption', cardIndex: -1, kind: 'link_cta_without_link', text: l.text, why: '파트너스 링크가 아직 없는데 링크로 가라는 문구예요', fix_delete: true }));
    }
  }
  if ((project.hashtags || []).length > 30) out.push(makeIssue({ level: 'format', target: 'caption', cardIndex: -1, kind: 'hashtag_many', text: `${project.hashtags.length}개`, why: '해시태그는 30개까지예요', fix_delete: false }));

  return dedupe(out);
}

/** 쇼츠 대본 한정 검사(사실 1차 + 변동 사실). 이슈의 target 은 'shorts'. */
export async function reviewShorts(shorts, project, kn) {
  if (!shorts) return [];
  const corpus = factCorpus(project);
  const patterns = (kn.patterns ? await kn.patterns() : null) || DEFAULT_PATTERNS;
  const lines = [shorts.hook, shorts.body, shorts.cta, ...(shorts.subtitles || [])].filter(Boolean).flatMap((t) => String(t).split('\n')).map((t) => t.trim()).filter(Boolean);
  const out = [];
  for (const text of lines) {
    const hit = checkFactLine(text, corpus, patterns);
    if (hit) out.push(makeIssue({ level: 'fact', target: 'shorts', kind: hit.kind, text, why: hit.why, fix_soften: hit.soften ? replaceSpan(text, hit.span, hit.soften) : (hit.numeric ? softenNumeric(text, hit.span) : null) }));
    for (const w of EXTRA_VARIABLE) if (text.includes(w)) out.push(makeIssue({ level: 'format', target: 'shorts', kind: 'variable_fact', text, why: `"${w}" 같은 변동 사실은 대본에 쓰지 않아요` }));
  }
  return dedupe(out);
}

function dedupe(list) {
  const map = new Map();
  for (const i of list) {
    const prev = map.get(i.id);
    if (!prev) map.set(i.id, i);
  }
  return [...map.values()].sort((a, b) => (a.level === b.level ? 0 : a.level === 'fact' ? -1 : 1) || a.cardIndex - b.cardIndex);
}

// ───────────────────────── AI 사실 검수 결과 합치기 ─────────────────────────

/** AI(A7) 응답 issues → 내부 형식. 카드 번호는 1부터(설계서 §21-B)로 오므로 0부터로 바꾼다. */
export function fromAiIssues(raw, cards) {
  const arr = Array.isArray(raw?.issues) ? raw.issues : Array.isArray(raw) ? raw : [];
  const out = [];
  for (const r of arr) {
    if (!r || typeof r.text !== 'string' || !r.text.trim()) continue;
    const no = Number(r.card ?? r.cardNo);
    let idx = Number.isFinite(no) ? no - 1 : -1;
    if (idx >= cards.length) idx = -1;
    if (idx < 0) { // 카드 번호가 틀렸거나 없으면 문구로 찾기
      idx = cards.findIndex((c) => cardLines(c).some((l) => squash(l.text).includes(squash(r.text)) || squash(r.text).includes(squash(l.text))));
    }
    if (idx < 0) continue;
    const kind = FACT_KINDS.includes(r.kind) ? r.kind : 'unsupported_fact';
    out.push(makeIssue({
      level: 'fact', cardIndex: idx, kind, text: r.text.trim(), why: String(r.why || '근거를 찾지 못했어요').slice(0, 160),
      fix_soften: typeof r.fix_soften === 'string' && r.fix_soften.trim() ? r.fix_soften.trim() : null,
      fix_delete: r.fix_delete !== false, source: 'ai',
    }));
  }
  return out;
}

/** 규칙 이슈 + AI 이슈. 같은 카드에서 문구가 겹치면 하나로(규칙 이슈 유지, AI 의 완화 문구를 우선). */
export function mergeIssues(ruleIssues, aiIssues) {
  const out = ruleIssues.map((i) => ({ ...i }));
  for (const a of aiIssues || []) {
    const hit = out.find((r) => r.level === 'fact' && r.target === a.target && r.cardIndex === a.cardIndex && (squash(r.text).includes(squash(a.text)) || squash(a.text).includes(squash(r.text))));
    if (hit) {
      if (a.fix_soften) hit.fix_soften = a.fix_soften;
      if (a.why && a.why.length > 4) hit.why = `${hit.why} · ${a.why}`.slice(0, 200);
      hit.source = 'rule+ai';
    } else out.push(a);
  }
  return dedupe(out);
}

export const countFactIssues = (issues) => (issues || []).filter((i) => i.level === 'fact' && !i.resolved).length;

// ───────────────────────── 수정 적용 (완화 / 빼기) ─────────────────────────

/** 이슈 문구가 카드의 어느 필드·구간인지 찾는다. 못 찾으면 null. */
export function locateText(card, text) {
  const t = String(text || '');
  if (!t.trim()) return null;
  for (const f of FIELDS) {
    const v = card[f];
    if (typeof v !== 'string') continue;
    const i = v.indexOf(t);
    if (i >= 0) return { field: f, start: i, end: i + t.length };
  }
  const key = squash(t);
  let best = null;
  for (const f of FIELDS) {
    const v = card[f];
    if (typeof v !== 'string' || !v) continue;
    let pos = 0;
    for (const line of v.split('\n')) {
      const ln = squash(line);
      if (ln) {
        const sc = ln.includes(key) || key.includes(ln) ? 1 : overlap(t, line);
        if (sc >= 0.6 && (!best || sc > best.sc)) best = { sc, field: f, start: pos, end: pos + line.length };
      }
      pos += line.length + 1;
    }
  }
  return best ? { field: best.field, start: best.start, end: best.end } : null;
}

/**
 * 카드에 완화/빼기를 적용한 새 카드를 돌려준다.
 * mode 'soften' 은 issue.fix_soften(없으면 customText) 로 바꾸고, 'delete' 는 그 구간(한 줄이면 줄째)을 지운다.
 */
export function applyFixToCard(card, issue, mode, customText) {
  const span = locateText(card, issue.text);
  if (!span) throw new AppError('이 문장을 카드에서 찾지 못했습니다. 카드 글을 직접 고쳐 주세요.', { raw: `issue.text=${issue.text}`, where: WHERE.SW, code: 'FIX_NOT_FOUND' });
  const v = card[span.field];
  const before = v.slice(span.start, span.end);
  let after;
  if (mode === 'soften') {
    after = (customText ?? issue.fix_soften ?? '').trim();
    if (!after) throw new AppError('완화할 문구가 없습니다. 빼기를 쓰거나 직접 고쳐 주세요.', { raw: 'fix_soften 없음', where: WHERE.SW, code: 'FIX_NO_SOFTEN' });
  } else after = '';
  let next = v.slice(0, span.start) + after + v.slice(span.end);
  next = next.split('\n').map((l) => l.replace(/\s{2,}/g, ' ').trimEnd()).filter((l) => l.trim()).join('\n').trim();
  if (span.field === 'headline' && !next) throw new AppError('헤드라인 전체가 사라집니다. 완화하거나 직접 고쳐 주세요.', { raw: 'headline 비게 됨', where: WHERE.SW, code: 'FIX_EMPTY_HEADLINE' });
  const claims = (card.claims || []).filter((c) => squash(c.text) !== squash(before) && !squash(before).includes(squash(c.text)) && !squash(c.text).includes(squash(before)));
  if (mode === 'soften') claims.push({ text: after, type: 'opinion', fact_id: null });
  let fixed = { ...card, [span.field]: next, claims };
  if (fixed.overlay) fixed = syncOverlay(fixed);
  return { card: fixed, applied: { field: span.field, before, after } };
}

/** 사진 카드: headline 을 고쳤으면 overlay.lines 를 맞추고(headline = lines 합 불변식), 사라진 강조 단어는 뺀다. */
export function syncOverlay(card) {
  if (!card?.overlay) return card;
  const lines = String(card.headline || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3);
  const highlight = (card.overlay.highlight || []).filter((h) => lines.some((l) => l.includes(h)));
  const overlay = { ...card.overlay, lines };
  if (highlight.length) overlay.highlight = highlight; else delete overlay.highlight;
  return { ...card, overlay, headline: lines.join('\n'), body: '' };
}
