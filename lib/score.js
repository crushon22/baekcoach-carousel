// 저장 가능성 점수 (규칙 기반, AI 호출 없음) — v1 §20-F + §21-D.
// 가중치: 훅 공식 적합 20 · 숫자 포함 10 · 한 카드 한 메시지 15 · 글자 수 준수 15 · 실용 정보 밀도 15 · CTA 명확 10 · 요약표 존재 10 · 브릿지 5.
// 🔎 근거 없음 1건당 −15. 감점 사유는 큰 순서로 돌려주고, 가장 큰 감점 1개(top)에 고치는 방법을 붙인다.
// 훅 금지 제목 패턴은 호출자가 knowledge 에서 읽어 hookRules 로 넘긴다(코드에 규칙을 박지 않음).

export const WEIGHTS = { hook: 20, number: 10, oneMessage: 15, length: 15, density: 15, cta: 10, table: 10, bridge: 5 };
const LABELS = {
  hook: '훅 공식 적합', number: '숫자 포함', oneMessage: '한 카드 한 메시지', length: '글자 수 준수',
  density: '실용 정보 밀도', cta: 'CTA 명확', table: '요약표 존재', bridge: '브릿지 문장', fact: '근거 없는 주장(🔎)',
};
const HINTS = {
  hook: '1번 카드 헤드라인을 숫자·질문·반전·결과 중 하나로 다시 쓰세요',
  number: '헤드라인이나 본문에 구체적인 숫자(개수·시간·금액)를 넣으세요',
  oneMessage: '한 카드에 메시지가 둘 이상이에요. 카드를 나누거나 하나만 남기세요',
  length: '헤드라인 16자·본문 한 줄 18자·3줄 안으로 줄이세요',
  density: '항목·숫자·단계처럼 바로 쓸 수 있는 정보를 늘리세요',
  cta: '마지막 카드에 행동 하나(저장·댓글·링크 중 하나)만 남기세요',
  table: '요약표 카드(표 레이아웃) 한 장을 넣어 저장 가치를 높이세요',
  bridge: '핵심 카드 끝에 다음 장이 궁금해지는 한 줄(10자 이내)을 넣으세요',
  fact: '🔎 표시된 문장을 완화하거나 빼거나 근거를 입력하세요',
};
const ACTION = /저장|댓글|링크|프로필|팔로우|DM|디엠|문의|공유|구독|클릭|구매|확인|알려|남겨|물어/;
const FORMULA = [
  [/\d/, '숫자형'], [/\?|까요?$|죠$|세요$|나요$|인가요$/, '질문형'],
  [/할수록|이유|손해|오히려|독이|안\s?됩니다|말고|대신|아닌|반대/, '반전형'], [/바꾸고|하고\s|만에|끝$|끝!|해결/, '결과형'],
];

const round1 = (x) => Math.round(x * 10) / 10;

/** @returns {{total:number, base:number, deductions:{key,label,points,max,detail,hint}[], parts:object, top:object|null, factPenalty:number}} */
export function computeScore({ cards = [], issues = [], hookRules = [] }) {
  const n = cards.length;
  const parts = {};
  const detail = {};
  if (!n) return { total: 0, base: 0, deductions: [], parts: {}, top: null, factPenalty: 0 };

  // 훅 공식 적합
  const hl = (cards[0].headline || '').replace(/\n/g, ' ').trim();
  const forbidden = hookRules.find((r) => r.re.test(hl));
  const formula = FORMULA.filter(([re]) => re.test(hl)).map(([, name]) => name);
  if (forbidden) { parts.hook = 0; detail.hook = `설명형·빈말 제목 패턴(${forbidden.label})`; }
  else if (formula.length) { parts.hook = hl.replace(/\s/g, '').length > 16 ? 16 : WEIGHTS.hook; detail.hook = hl.replace(/\s/g, '').length > 16 ? '훅이 16자를 넘어요' : `${formula.join('·')} 훅`; }
  else { parts.hook = 10; detail.hook = '숫자·질문·반전·결과 공식이 뚜렷하지 않아요'; }

  // 숫자 포함
  const numHead = cards.filter((c) => /\d/.test(c.headline || '')).length;
  const numBody = cards.filter((c) => /\d/.test(c.body || '')).length;
  parts.number = numHead >= 2 || /\d/.test(cards[0].headline || '') ? WEIGHTS.number : numHead === 1 ? 7 : numBody >= 2 ? 5 : numBody === 1 ? 3 : 0;
  detail.number = `숫자가 있는 헤드라인 ${numHead}장 · 본문 ${numBody}장`;

  // 한 카드 한 메시지
  const oneOk = cards.filter((c) => {
    const claims = (c.claims || []).length;
    const sentences = (c.body || '').split(/[.!?。]\s*|\n/).filter((x) => x.trim()).length;
    return claims <= 3 && sentences <= 4 && (c.headline || '').split('\n').length <= 2;
  }).length;
  parts.oneMessage = (oneOk / n) * WEIGHTS.oneMessage;
  detail.oneMessage = `${n - oneOk}장이 메시지 둘 이상으로 보여요`;

  // 글자 수 준수
  const lenOk = cards.filter((c) => {
    const h = (c.headline || '').replace(/\n/g, '').length;
    const lines = (c.body || '').split('\n').filter((x) => x.trim());
    const table = c.layout === 'table';
    return h <= 16 && lines.length <= (table ? 6 : 3) && (table || lines.every((l) => l.length <= 22));
  }).length;
  parts.length = (lenOk / n) * WEIGHTS.length;
  detail.length = `${n - lenOk}장이 글자 수 기준을 넘었어요`;

  // 실용 정보 밀도
  const items = cards.reduce((sum, c) => sum + ((c.body || '').match(/\d|→|☐|\||:|①|②|③|✓/g) || []).length, 0);
  parts.density = Math.min(1, items / (n * 1.5)) * WEIGHTS.density;
  detail.density = `정보 표시(숫자·단계·항목) ${items}개`;

  // CTA 명확
  const last = cards[n - 1];
  const lastText = `${last.headline || ''} ${last.body || ''} ${last.cta || ''}`;
  const acts = [['저장', /저장/], ['댓글', /댓글/], ['링크', /링크|프로필|구매|클릭/], ['팔로우', /팔로우|구독/], ['DM', /DM|디엠|문의/]].filter(([, re]) => re.test(lastText)).map(([x]) => x);
  if (!ACTION.test(lastText)) { parts.cta = 0; detail.cta = '행동 유도 문구가 보이지 않아요'; }
  else if (acts.length >= 3) { parts.cta = 4; detail.cta = `행동이 ${acts.length}개(${acts.join('·')})예요`; }
  else { parts.cta = WEIGHTS.cta; detail.cta = 'CTA가 분명해요'; }

  // 요약표
  parts.table = cards.some((c) => c.layout === 'table' || /요약/.test(c.role || '')) ? WEIGHTS.table : 0;
  detail.table = parts.table ? '요약표 있음' : '요약표 카드가 없어요';

  // 브릿지
  const mids = cards.slice(1, -1);
  const withBridge = mids.filter((c) => (c.bridge || '').trim()).length;
  parts.bridge = mids.length ? Math.min(1, withBridge / Math.max(1, Math.ceil(mids.length / 2))) * WEIGHTS.bridge : WEIGHTS.bridge;
  detail.bridge = `가운데 카드 ${mids.length}장 중 ${withBridge}장에 브릿지`;

  const base = Object.values(parts).reduce((a, b) => a + b, 0);
  const deductions = [];
  for (const key of Object.keys(WEIGHTS)) {
    const pts = round1(WEIGHTS[key] - parts[key]);
    if (pts > 0.05) deductions.push({ key, label: LABELS[key], points: pts, max: WEIGHTS[key], detail: detail[key], hint: HINTS[key] });
  }
  const facts = (issues || []).filter((i) => i.level === 'fact' && !i.resolved).length;
  const factPenalty = facts * 15;
  if (facts) deductions.push({ key: 'fact', label: LABELS.fact, points: factPenalty, max: factPenalty, detail: `🔎 ${facts}건 × −15`, hint: HINTS.fact });
  deductions.sort((a, b) => b.points - a.points);
  const total = Math.max(0, Math.min(100, Math.round(base - factPenalty)));
  return { total, base: Math.round(base), deductions, parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, round1(v)])), top: deductions[0] || null, factPenalty };
}
