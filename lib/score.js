// 캐러셀 점수 (규칙 기반, AI 호출 없음) — 2026-10-29 사용자 결정: "얼추 괜찮으면 100점".
// 100점에서 시작해 보는 사람에게 실제로 문제가 되는 것만 뺀다:
//   광고 표기 없음 · 숨긴 제품 정보(번호·색상명)가 새어 나옴 · 글이 칸을 넘침(줄 수·글자 수) · 사진 속 색·질감·장면을 짚은 문장이 적음(사진 캐러셀)
//   · 빈 카드 · 마지막 카드에 행동(댓글) 없음 · 앞 장과 같은 말 반복.
// 근거 없는 주장(🔎)·훅 공식·숫자 포함 같은 옛 항목은 점수에 넣지 않는다. 감점 사유는 큰 순서로 돌려주고, 가장 큰 것(top)에 고치는 방법을 붙인다.

const ACTION = /저장|댓글|링크|프로필|팔로우|DM|디엠|문의|공유|구독|클릭|구매|확인|알려|남겨|물어/;
// 글이 칸을 넘치는 ⚠️ 종류(lib/review.js 의 kind) — 이것만 "글이 칸을 넘침"으로 센다
const OVERFLOW_KINDS = new Set(['headline_long', 'headline_lines', 'body_lines', 'body_line_long', 'overlay_lines', 'overlay_lines_few', 'overlay_line_long', 'table_format']);
// 점수의 다른 항목이 이미 보는 것(이중 감점 방지): 숨긴 정보(leak) · CTA(cta) · 빈 카드(empty)
const SKIP_KINDS = new Set(['identity_leak', 'cta_missing', 'cta_multi', 'card_failed']);
const linesOf = (c) => (c?.overlay?.lines?.length ? c.overlay.lines : String(c?.headline || '').split('\n')).map((l) => String(l).trim()).filter(Boolean);
const textOf = (c) => `${linesOf(c).join(' ')} ${c?.body || ''} ${c?.cta || ''}`.trim();

/**
 * @param {{cards:object[], issues?:object[], mode?:'photo'|'cardnews', adLabel?:boolean, tease?:boolean, commentWord?:string}} arg
 * @returns {{total:number, base:number, deductions:{key,label,points,max,detail,hint}[], parts:object, top:object|null, factPenalty:number, mode:string}}
 */
export function computeCarouselScore({ cards = [], issues = [], mode = 'cardnews', adLabel = true, tease = false, commentWord = '' }) {
  const n = cards.length;
  if (!n) return { total: 0, base: 0, deductions: [], parts: {}, top: null, factPenalty: 0, mode };
  const open = (issues || []).filter((i) => !i.resolved);
  const d = [];
  const push = (key, label, points, detail, hint) => { if (points > 0) d.push({ key, label, points, max: points, detail, hint }); };

  // 광고 표기 — 파트너스 글이라 표기는 꼭 있어야 한다
  if (!adLabel) push('adlabel', '광고 표기', 20, '카드에 [광고] 표기가 없어요', '옵션의 "광고 표기"를 켜 주세요');

  // 숨긴 제품 정보(댓글 유도)가 그대로 나옴
  const leaks = open.filter((i) => i.kind === 'identity_leak').length;
  if (leaks) push('leak', '숨긴 제품 정보 새어 나옴', Math.min(30, leaks * 10), `번호·색상명이 ${leaks}곳에 그대로 있어요`, '검수의 "…로 바꾸기"를 눌러 그 글자를 빼세요');

  // 글이 칸을 넘침(줄 수·글자 수) — 넘침 종류만 센다. CTA 없음·빈 카드는 아래에서 따로 보므로 여기서 또 깎지 않는다
  const cardFmt = open.filter((i) => i.level === 'format' && i.target !== 'caption' && i.target !== 'shorts');
  const fmt = cardFmt.filter((i) => OVERFLOW_KINDS.has(i.kind)).length;
  if (fmt) push('format', '글이 칸을 넘침', Math.min(15, fmt * 3), `줄 수·글자 수 기준을 넘은 곳이 ${fmt}건이에요`, '그 카드의 글을 줄이거나 "다시 쓰기 → 짧게"를 쓰세요');
  // 그 밖의 형식 규칙(금지어·이모지·자리표시·강조 단어 없음·표 형식 …)
  const rules = cardFmt.filter((i) => !OVERFLOW_KINDS.has(i.kind) && !SKIP_KINDS.has(i.kind)).length;
  if (rules) push('rules', '형식 규칙 어김', Math.min(10, rules * 2), `금지어·이모지·자리표시 같은 ⚠️가 ${rules}건이에요`, '검수의 ⚠️ 점검에서 그 줄을 고치세요');

  // 빈 카드
  const empty = cards.filter((c) => !c || c.error || !linesOf(c).length).length;
  if (empty) push('empty', '빈 카드', Math.min(15, empty * 5), `${empty}장에 글이 없어요`, '그 카드를 다시 만들거나 직접 적어 주세요');

  // 사진 캐러셀: 제품의 색·질감·장면을 짚었는지 — 커버를 뺀 카드 중 사진에 보이는 것(visual)을 쓴 비율
  if (mode === 'photo' && n > 1) {
    const inner = cards.slice(1).filter(Boolean);
    const visual = inner.filter((c) => (c.claims || []).some((cl) => cl.type === 'visual')).length;
    if (inner.length && visual / inner.length < 0.5) push('visual', '제품 색·질감 설명', 10, `사진 속 모습을 짚은 문장이 ${visual}/${inner.length}장이에요`, '"다시 쓰기 → 설명형"으로 사진에 보이는 색·질감·장면을 짚으세요');
  }

  // 마지막 카드의 행동 — 댓글 유도가 켜져 있으면 "댓글"이 들어가야 한다
  const last = textOf(cards[n - 1]);
  if (!ACTION.test(last)) push('cta', '행동 유도 없음', 10, '마지막 카드에 행동 문구가 없어요', '마지막 카드를 "댓글 남겨 주세요" 한 줄로 끝내세요');
  else if (tease && !/댓글/.test(last)) push('cta', '댓글 유도 없음', 10, '댓글 유도를 켰는데 마지막 카드에 "댓글"이 없어요', `마지막 카드를 댓글에 "${commentWord || '나도'}" 남겨 주세요 로 바꾸세요`);

  // 앞 장과 같은 말 반복
  let rep = 0;
  for (let i = 1; i < n; i++) { const a = linesOf(cards[i]).join('|'); if (a && a === linesOf(cards[i - 1]).join('|')) rep++; }
  if (rep) push('repeat', '같은 말 반복', Math.min(10, rep * 5), `앞 장과 똑같은 카드가 ${rep}장이에요`, '그 카드를 "다시 쓰기 → 다르게"로 바꾸세요');

  d.sort((a, b) => b.points - a.points);
  const total = Math.max(0, Math.min(100, 100 - d.reduce((s, x) => s + x.points, 0)));
  return { total, base: 100, deductions: d, parts: {}, top: d[0] || null, factPenalty: 0, mode };
}

/** 사진 캐러셀 (옛 호출 모양 유지) */
export const computePhotoScore = (o) => computeCarouselScore({ ...o, mode: 'photo' });
/** 카드뉴스 (옛 호출 모양 유지) */
export const computeScore = (o) => computeCarouselScore({ ...o, mode: 'cardnews' });
