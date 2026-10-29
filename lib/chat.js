// 오케스트레이터 (채팅 → 도구 호출) — 이슈 #1: v1 §18-C 가 설계서에 없어 ai-layer 가 최소 세트를 정의했다.
//
// 흐름: 사용자의 말 → ① 규칙 해석(정규식, AI 호출 없음: "3번 짧게", "베이지로", "리스트형으로 바꿔" …) → ② 못 읽은 말만 AI(JSON 도구 호출)
//       → 도구를 순서대로 실행 → 변경된 Project 조각(patch)과 재생성 요청(regenerate)을 돌려준다.
// 규칙 해석을 먼저 두는 이유: 빠르고(0초) 공짜이며, 키가 없거나 devMockAI 일 때도 같은 동작을 보장한다.
// AI 호출·검수는 deps 로 주입받는다(agents.js ↔ chat.js 순환 import 방지). 서비스워커·패널 양쪽에서 import 가능한 순수 로직 위주.

import { AppError, WHERE } from './common.js';
import { TEMPLATES, LAYOUTS } from './knowledge.js';
import { PURPOSES, cleanText, clampInt, hex6, AD_TEXTS, findLeak } from './ai-util.js';
import { syncOverlay } from './review.js';

/** 도구 정의(문서·AI 프롬프트 공용). 카드 번호 index 는 0부터. */
export const TOOLS = [
  { name: 'rewriteCard', args: 'index, style(short|emotional|evidence|alt)', desc: '카드 한 장을 다시 쓴다(3안 중 해당 스타일 1안을 바로 적용). 짧게/감성/근거형/다르게' },
  { name: 'editCardText', args: 'index, headline?, body?, bridge?, cta?', desc: '카드 글을 사용자가 말한 그대로 바꾼다' },
  { name: 'setLayout', args: 'index, layout(title|photo-full|split|number|quote|table|cta)', desc: '카드 레이아웃을 바꾼다' },
  { name: 'setTemplate', args: 'template(basic|warm|dark|pastel|nature|pop)', desc: '디자인 템플릿을 바꾼다. 베이지=warm, 다크=dark, 파스텔=pastel, 자연/초록=nature, 포인트=pop, 기본=basic' },
  { name: 'setAccent', args: 'color(#RRGGBB 또는 "product")', desc: '강조색을 바꾼다. "product" 는 제품 사진 색 사용(패널이 색 추출)' },
  { name: 'setType', args: `type(${'list|sales|problem|checklist|compare|story|reviews|qna|ranking'})`, desc: '캐러셀 유형을 바꾼다 → 전체 재생성' },
  { name: 'setCount', args: 'count(5~8)', desc: '카드 장수를 바꾼다 → 전체 재생성' },
  { name: 'setPurpose', args: `purpose(${PURPOSES.join('|')})`, desc: '목적을 바꾼다 → 전체 재생성' },
  { name: 'setCommentWord', args: 'word(2글자 이내)', desc: '댓글 유도 단어를 바꾼다("댓글 단어 레드로"): 마지막 카드와 캡션의 따옴표 단어를 바꿔 쓴다(AI 호출 없음)' },
  { name: 'setTease', args: 'on(boolean)', desc: '댓글 유도(번호·색상명·모델명 숨기기)를 켜거나 끈다 → 전체 재생성. "번호 보여줘"·"이름 그대로 써"=끄기, "번호 숨겨"·"댓글 유도로"=켜기' },
  { name: 'setHook', args: 'hookIndex(0=숫자형,1=질문형,2=반전형)', desc: '훅을 다른 안으로 바꾼다 → 1번 카드와 캡션만 재생성' },
  { name: 'applyFix', args: 'issueId("all" 이면 🔎 전부), mode(soften|delete)', desc: '🔎 근거 없는 주장을 완화하거나 뺀다' },
  { name: 'regenerateAll', args: '', desc: '같은 설정으로 전체를 처음부터 다시 만든다' },
  { name: 'setColor', args: 'target(카드뉴스: bg|headline|body|accent / 사진 캐러셀: text|stroke|highlight|shade), color(#RRGGBB 또는 색 이름)', desc: '색을 바꾼다("배경 베이지로", "제목 빨강", "강조 노란색", "글씨 검정으로"). 카드뉴스는 carousel.colors, 사진 캐러셀은 carousel.overlayColors' },
  { name: 'resetColors', args: '', desc: '고른 색을 모두 지우고 템플릿/스타일 기본 색으로 되돌린다' },
  { name: 'setAdLabel', args: 'on?(boolean), position?(tl|tr|bl|br), look?(box|shadow|plain|outline), text?([광고]|광고|#광고|유료 광고), size?(s|m|l), color?(#RRGGBB·색 이름 또는 auto=배경에 맞춰 자동)', desc: '광고 표기를 바꾼다("광고 오른쪽 위로", "광고 글자만", "광고 표시 빼줘", "광고를 #광고로", "광고 글자 노랑으로", "광고 색 자동으로")' },
  // 사진 캐러셀(mode:'photo') 전용
  { name: 'setOverlayPosition', args: 'index, position(top|middle|bottom)', desc: '[사진 캐러셀] 사진 위 글 위치를 바꾼다("3번 글 위로")' },
  { name: 'setOverlaySize', args: 'index?(없으면 전체), size(xl|l|m|bigger|smaller)', desc: '[사진 캐러셀] 글씨 크기를 바꾼다("글씨 더 크게")' },
  { name: 'setOverlayStyle', args: 'style(outline|gradient|band|shadow)', desc: '[사진 캐러셀] 글씨 스타일을 바꾼다("띠 스타일로"): 테두리=outline, 그라데이션·왼쪽 정렬·골라봄 스타일=gradient, 띠=band, 그림자=shadow' },
  { name: 'editOverlay', args: 'index, lines(문자열 배열 1~3개)', desc: '[사진 캐러셀] 사진 위 문장을 말한 그대로 바꾼다' },
  { name: 'setHighlight', args: 'index?(없으면 그 단어가 들어 있는 모든 사진), words(사진 위 글에 그대로 있는 단어 배열), mode(add|remove|clear)', desc: '[사진 캐러셀] 강조 단어를 켜거나 끈다("\'끝\' 강조해 줘", "3번 강조 다 빼줘"). 개수 제한 없음. 강조 색은 setColor(target:highlight)' },
];
const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

const TYPE_WORDS = [
  [/체크\s*리스트/, 'checklist'], [/문제\s*해결/, 'problem'], [/제품\s*판매|판매형/, 'sales'], [/후기\s*모음|후기형/, 'reviews'],
  [/Q\s*&\s*A|큐앤에이|qna/i, 'qna'], [/랭킹|순위/, 'ranking'], [/스토리/, 'story'], [/비교/, 'compare'], [/리스트/, 'list'],
];
const TEMPLATE_WORDS = [
  [/베이지|따뜻|웜톤|웜/, 'warm'], [/다크|어둡|검정|블랙|검은/, 'dark'], [/파스텔|분홍|핑크|연한/, 'pastel'],
  [/초록|그린|자연|네이처/, 'nature'], [/포인트|팝|브랜드\s*색\s*배경|진하게/, 'pop'], [/기본|깔끔|심플|화이트|하얀|밝게/, 'basic'],
];
// 색 이름 → hex. 지식 파일(색 이름표)이 아직 없어 코드 상수로 둔다(임시): 먼저 나온 것이 우선이라 구체적인 이름을 위에 둔다.
const COLOR_WORDS = [
  [/연보라|라벤더/, '#C9B6E4'], [/하늘/, '#87CEEB'], [/연두/, '#9BD65A'], [/베이지/, '#F5E6CC'], [/민트/, '#3EB489'], [/코랄/, '#FF7F6B'],
  [/남색|네이비/, '#1F2A5C'], [/갈색|브라운/, '#8B5A2B'], [/금색|골드/, '#D4AF37'], [/회색|그레이/, '#9E9E9E'],
  [/빨강|빨간|레드/, '#E53935'], [/파랑|파란|블루/, '#1E88E5'], [/노랑|노란|옐로/, '#FBC02D'], [/초록|녹색|그린/, '#43A047'],
  [/주황|오렌지/, '#FB8C00'], [/분홍|핑크/, '#EC407A'], [/보라|퍼플/, '#8E24AA'], [/검정|검은|블랙/, '#212121'], [/하양|하얀|흰색|흰|화이트/, '#FFFFFF'],
];
/** "#RRGGBB"/"#RGB" 또는 색 이름 → "#RRGGBB" (모르면 null) */
export function resolveColor(v) {
  const t = String(v ?? '');
  const h = t.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/);
  if (h) return hex6(h[0]);
  const w = COLOR_WORDS.find(([re]) => re.test(t));
  return w ? w[1] : null;
}
const CARD_COLOR_KEYS = ['bg', 'headline', 'body', 'accent'];
const PHOTO_COLOR_KEYS = ['text', 'stroke', 'highlight', 'shade'];
const COLOR_ALIAS = { card: { text: 'body', stroke: 'body', shade: 'bg', highlight: 'accent' }, photo: { bg: 'shade', headline: 'text', body: 'text', accent: 'highlight' } };
const normAdText = (t) => { const x = String(t ?? '').trim(); return AD_TEXTS.includes(x) ? x : /유료/.test(x) ? '유료 광고' : /#/.test(x) ? '#광고' : /\[/.test(x) ? '[광고]' : /광고/.test(x) ? '광고' : null; };

/** 광고 표기 말: "광고 오른쪽 위로", "광고 글자만", "광고 표시 빼줘", "광고를 #광고로", "광고 크게" */
function parseAd(p) {
  if (!/광고/.test(p)) return null;
  const a = {};
  if (/(빼|없애|없음|끄|꺼|제거|지워|숨기)/.test(p) && !/(켜|넣어|추가|보이게)/.test(p)) a.on = false;
  else if (/(켜|넣어|넣고|추가|보이게|표시해)/.test(p)) a.on = true;
  if (/(왼쪽|좌)\s*(위|상단)|좌상단/.test(p)) a.position = 'tl';
  else if (/(오른쪽|우)\s*(위|상단)|우상단/.test(p)) a.position = 'tr';
  else if (/(왼쪽|좌)\s*(아래|하단)|좌하단/.test(p)) a.position = 'bl';
  else if (/(오른쪽|우)\s*(아래|하단)|우하단/.test(p)) a.position = 'br';
  if (/(글자|글씨|텍스트)만/.test(p)) a.look = 'plain';
  else if (/그림자/.test(p)) a.look = 'shadow';
  else if (/테두리|외곽선/.test(p)) a.look = 'outline';
  else if (/박스|상자|바탕/.test(p)) a.look = 'box';
  const t = p.match(/광고(?:를|은|는)?\s*["“']?(#광고|\[광고\]|유료\s*광고|광고)["”']?\s*(?:로|으로)/);
  if (t) a.text = normAdText(t[1]);
  if (/(크게|키워|커지)/.test(p)) a.size = 'l'; else if (/(작게|줄여|작아)/.test(p)) a.size = 's'; else if (/(보통|중간)\s*크기/.test(p)) a.size = 'm';
  // 글자색: "광고 글자 노랑으로", "광고 색 자동으로". "검은 상자"는 모양 말이라 색으로 읽지 않는다
  if (/(색|컬러)\s*(을|를)?\s*(자동|기본|원래)|자동\s*색/.test(p)) a.color = 'auto';
  else if (!/(제목|본문|배경|강조|헤드라인)/.test(p)) { const col = resolveColor(p.replace(/(검은|검정|까만)\s*(상자|박스|바탕)/g, '').replace(/#광고/g, '')); if (col) a.color = col; }
  return Object.keys(a).length ? [{ name: 'setAdLabel', args: a }] : null;
}

/** 색 말: "배경 베이지로", "제목 빨강", "강조 노란색", "글씨 검정으로", "색 초기화" (색 이름이 있을 때만 — "그림자 스타일로"는 스타일 말) */
function parseColor(p, photo) {
  if (/(색|컬러)\s*(초기화|리셋|되돌|원래)|원래\s*색|기본\s*색으로/.test(p)) return [{ name: 'resetColors', args: {} }];
  const color = resolveColor(p);
  if (!color) return null;
  const targets = photo
    ? [[/테두리|외곽선|아웃라인/, 'stroke'], [/강조/, 'highlight'], [/띠|그라데이션|바탕|배경|그림자|음영/, 'shade'], [/글씨|글자|텍스트|문장|제목|본문/, 'text']]
    : [[/배경|바탕/, 'bg'], [/제목|헤드라인|타이틀/, 'headline'], [/본문|내용/, 'body'], [/강조|포인트|액센트/, 'accent'], [/글씨|글자|텍스트|문장/, 'body']];
  const hit = targets.find(([re]) => re.test(p));
  return hit ? [{ name: 'setColor', args: { target: hit[1], color } }] : null;
}
const LAYOUT_WORDS = [
  [/표/, 'table'], [/인용|후기\s*스타일/, 'quote'], [/숫자|번호/, 'number'], [/사진\s*(크게|전체)|풀\s*사진|전체\s*사진|꽉\s*차게/, 'photo-full'],
  [/반반|분할|사진\s*(옆|오른쪽)|옆에\s*사진/, 'split'], [/제목\s*(만|크게)|크게\s*제목|제목형|타이틀/, 'title'], [/버튼|CTA/i, 'cta'],
];
const STYLE_WORDS = [
  ['hook', /센\s*훅|세게|강하게|자극적|확\s*잡/], ['explain', /설명형|설명하듯|차분하게|자세히/],
  ['short', /짧게|간단|줄여|짧은|간결|압축/], ['emotional', /감성|따뜻하게|부드럽게|감정|공감되게|말랑/], ['evidence', /근거|출처|구체적|숫자로|사실로|믿음/],
  ['alt', /다시\s*써|다시\s*작성|다르게|바꿔\s*줘|새로\s*써|새롭게/],
];

const LAYOUT_SLOT = { 'photo-full': 'hero', split: 'side' };
const HEX = /^#[0-9a-fA-F]{6}$/;

/** 규칙으로 말을 도구 호출 목록으로. {calls, unparsed[]} */
export function parseCommands(text, project) {
  const n = project?.carousel?.cards?.length || 0;
  let parts = String(text || '').split(/[,，;\n]+|\s+그리고\s+|\s+및\s+|(?<=고)\s+(?=\d+\s*번|\S+(?:으로|로)(?:\s|$))/).map((s) => s.trim()).filter(Boolean);
  parts = parts.flatMap((p) => ((p.match(/\d+\s*번/g) || []).length >= 2 ? p.split(/(?=\d+\s*번)/).map((x) => x.trim()).filter(Boolean) : [p]));
  const calls = [];
  const unparsed = [];
  for (const p of parts) {
    const photo = project?.carousel?.mode === 'photo';
    const found = parseAd(p) || parseColor(p, photo) || (photo ? parsePhotoPart(p, n, project) : parsePart(p, n, project));
    if (found.length) calls.push(...found); else unparsed.push(p);
  }
  return { calls, unparsed };
}

const POS_WORDS = [[/위로|위쪽|위에|상단|올려/, 'top'], [/아래로|아래쪽|밑으로|밑에|하단|내려/, 'bottom'], [/가운데|중앙|중간/, 'middle']];
const SIZE_STEPS = ['m', 'l', 'xl'];

/** 사진 캐러셀 전용 해석: 위치·크기·스타일·문장 직접 수정. 나머지(다시 쓰기·훅·목적·🔎 일괄)는 공용 규칙을 쓴다. */
function parsePhotoPart(p, n, project) {
  const idxM = p.match(/(\d+)\s*번(?:째)?/);
  const idx = idxM ? Number(idxM[1]) - 1 : null;
  if (idx != null && (idx < 0 || idx >= n)) return [{ name: 'noop', args: { why: `${idx + 1}번 사진은 없어요(1~${n}번)` } }];
  // 강조 단어: "'끝' 강조해 줘", "3번 '분위기' 강조 빼", "강조 다 지워" (색은 parseColor 가 먼저 읽는다)
  if (/강조/.test(p)) {
    const words = [...p.matchAll(/["“'‘]([^"”'’]+)["”'’]/g)].map((m) => m[1].trim()).filter(Boolean);
    const off = /(빼|끄|꺼|지워|없애|취소|해제)/.test(p);
    const at = idx != null ? { index: idx } : {};
    if (words.length) return [{ name: 'setHighlight', args: { ...at, words, mode: off ? 'remove' : 'add' } }];
    if (off && /(강조\s*(단어\s*)?(다|모두|전부)|모든\s*강조|강조\s*(단어\s*)?(를|을)?\s*(빼|지워|없애|꺼|끄))/.test(p)) return [{ name: 'setHighlight', args: { ...at, words: [], mode: 'clear' } }];
  }
  const edit = p.match(/(?:글|문장|제목|헤드라인|문구)\s*(?:을|를|은|는)?\s*["“'‘](.+?)["”'’]\s*(?:로|으로|라고)/);
  if (idx != null && edit) return [{ name: 'editOverlay', args: { index: idx, lines: edit[1].split(/\s*[\/\n]\s*|\\n/).filter(Boolean) } }];
  if (/(스타일|모양|느낌|로|으로|바꿔)/.test(p) && idx == null) {
    if (/그라데이션|왼쪽\s*정렬|골라봄|gradient/i.test(p)) return [{ name: 'setOverlayStyle', args: { style: 'gradient' } }];
    if (/띠|밴드|band/i.test(p)) return [{ name: 'setOverlayStyle', args: { style: 'band' } }];
    if (/그림자|shadow/i.test(p)) return [{ name: 'setOverlayStyle', args: { style: 'shadow' } }];
    if (/테두리|아웃라인|outline/i.test(p)) return [{ name: 'setOverlayStyle', args: { style: 'outline' } }];
  }
  if (/(글씨|글자|폰트|크기|문장)/.test(p) && /(크게|키워|커지|확대|더 크)/.test(p)) return [{ name: 'setOverlaySize', args: { ...(idx != null ? { index: idx } : {}), size: 'bigger' } }];
  if (/(글씨|글자|폰트|크기|문장)/.test(p) && /(작게|줄여|작아|축소|더 작)/.test(p)) return [{ name: 'setOverlaySize', args: { ...(idx != null ? { index: idx } : {}), size: 'smaller' } }];
  if (idx != null) {
    const pos = POS_WORDS.find(([re]) => re.test(p));
    if (pos && /(글|문장|글씨|위치|자막|텍스트|위로|아래로|가운데|중앙|올려|내려)/.test(p)) return [{ name: 'setOverlayPosition', args: { index: idx, position: pos[1] } }];
  }
  // 공용 규칙: 다시 쓰기 스타일 · 훅 · 목적 · 🔎 일괄 · 전체 다시
  const rest = parsePart(p, n, project).filter((c) => ['rewriteCard', 'setHook', 'setPurpose', 'setTease', 'setCommentWord', 'applyFix', 'regenerateAll', 'noop'].includes(c.name));
  return rest;
}

function parsePart(p, n, project) {
  const idxM = p.match(/(\d+)\s*번(?:째)?/);
  const idx = idxM ? Number(idxM[1]) - 1 : null;
  const out = [];
  // 글 직접 바꾸기: 3번 제목을 "…"로
  const edit = p.match(/(헤드라인|제목|본문|내용)\s*(?:을|를|은|는)?\s*["“'‘](.+?)["”'’]\s*(?:로|으로|라고)/);
  if (idx != null && edit) {
    const field = /본문|내용/.test(edit[1]) ? 'body' : 'headline';
    return [{ name: 'editCardText', args: { index: idx, [field]: edit[2].replace(/\\n/g, '\n') } }];
  }
  // 근거 없는 주장 한꺼번에
  if (/(근거\s*없|🔎|날조|지어낸|주장)/.test(p) && /(빼|삭제|지워|없애)/.test(p)) return [{ name: 'applyFix', args: { issueId: 'all', mode: 'delete' } }];
  if (/(근거\s*없|🔎|날조|지어낸|주장)/.test(p) && /(완화|부드럽게|순화|고쳐)/.test(p)) return [{ name: 'applyFix', args: { issueId: 'all', mode: 'soften' } }];
  // 전체 다시
  if (/(처음부터|전체|전부|모두)\s*(다시|새로)\s*(만들|생성|써)/.test(p)) return [{ name: 'regenerateAll', args: {} }];
  // 유형
  for (const [re, key] of TYPE_WORDS) {
    if (re.test(p) && /(형|타입|유형)/.test(p) && /(바꿔|로|으로|만들|해\s*줘|해줘|변경)/.test(p) && idx == null) return [{ name: 'setType', args: { type: key } }];
  }
  // 장수
  const cnt = p.match(/(\d+)\s*장/);
  if (cnt && idx == null && /(으로|만|줄여|늘려|바꿔|만들|해\s*줘|해줘|로)/.test(p)) return [{ name: 'setCount', args: { count: clampInt(cnt[1], 5, 8, 7) } }];
  // 댓글 단어 바꾸기: "댓글 단어 레드로", "댓글에 '립' 남기게"
  const cw = p.match(/댓글\s*(?:단어|말|키워드)\s*(?:을|를|은|는)?\s*["'“‘]?([가-힣A-Za-z0-9]{1,2}?)["'”’]?\s*(?:으로|로)(?![가-힣])/) || p.match(/댓글에\s*["'“‘]([가-힣A-Za-z0-9]{1,2})["'”’]\s*(?:남기게|남게|으로|로)/);
  if (cw && idx == null && !/강조/.test(p)) return [{ name: 'setCommentWord', args: { word: cw[1] } }];
  // 댓글 유도(제품 정보 숨기기) 켜기/끄기
  if (idx == null && !/강조/.test(p) && !/(뭐|무엇|뭔가|어떻게|왜|\?)/.test(p)) {   // 질문("댓글 유도가 뭐야")은 도구가 아니라 AI 답변으로
    const what = /(번호|이름|제품명|상품명|모델명?|색상명?|제품\s*정보|상품\s*정보)/;
    if (what.test(p) && /(숨기지\s*마|가리지\s*마|보여|그대로|공개|밝혀|드러내)/.test(p)) return [{ name: 'setTease', args: { on: false } }];
    if (what.test(p) && /(숨겨|숨기|가려|가리|감춰|빼\s*줘|빼줘|빼)/.test(p)) return [{ name: 'setTease', args: { on: true } }];
    if (/댓글\s*유도/.test(p) && /(끄|꺼|해제|그만|없이)/.test(p)) return [{ name: 'setTease', args: { on: false } }];
    if (/댓글\s*유도/.test(p) && /(켜|로\s*(?:만들|해|바꿔)|모드|하게|되게|으로)/.test(p)) return [{ name: 'setTease', args: { on: true } }];
  }
  // 목적
  const pur = p.match(/(저장|링크\s*클릭|링크|댓글|팔로우|DM|디엠|문의)\s*(?:유도|목적|을\s*목적)/) || (/목적/.test(p) && p.match(/(저장|링크\s*클릭|링크|댓글|팔로우|DM|디엠|문의)/));
  if (pur && idx == null && !/(뭐|무엇|뭔가|뭔지|어떻게|왜|인가요|\?)/.test(p)) {   // "댓글 유도가 뭐야?" 같은 질문은 목적 변경이 아니다
    const w = pur[1].replace(/\s/g, '');
    const purpose = /저장/.test(w) ? '저장' : /링크/.test(w) ? '링크 클릭' : /댓글/.test(w) ? '댓글' : /팔로우/.test(w) ? '팔로우' : 'DM·문의';
    return [{ name: 'setPurpose', args: { purpose } }];
  }
  // 훅
  const hookNo = p.match(/훅\s*(\d)\s*(?:번|안)|(\d)\s*번\s*훅/);
  const hookKind = p.match(/(숫자형|질문형|반전형)\s*(?:훅|으로)/);
  if (hookNo) return [{ name: 'setHook', args: { hookIndex: clampInt(Number(hookNo[1] || hookNo[2]) - 1, 0, 2, 0) } }];
  if (hookKind) return [{ name: 'setHook', args: { hookIndex: { 숫자형: 0, 질문형: 1, 반전형: 2 }[hookKind[1]] } }];
  // 강조색
  if (/제품\s*색/.test(p)) return [{ name: 'setAccent', args: { color: 'product' } }];
  if (/(강조|포인트|액센트)/.test(p) && idx == null) {
    const col = resolveColor(p);
    if (col) return [{ name: 'setColor', args: { target: 'accent', color: col } }];
  }
  // 템플릿
  if (idx == null && /(로|으로|색|톤|템플릿|디자인|바꿔|해\s*줘|해줘|스타일)/.test(p)) {
    const t = TEMPLATE_WORDS.find(([re]) => re.test(p));
    if (t) return [{ name: 'setTemplate', args: { template: t[1] } }];
  }
  if (idx != null && idx >= 0 && idx < n) {
    const lay = LAYOUT_WORDS.find(([re]) => re.test(p) && new RegExp(re.source + '\\s*(?:형|으로|로|레이아웃|스타일|처럼|만)').test(p));
    if (lay) out.push({ name: 'setLayout', args: { index: idx, layout: lay[1] } });
    const st = STYLE_WORDS.find(([, re]) => re.test(p));
    if (st && !lay) out.push({ name: 'rewriteCard', args: { index: idx, style: st[0] } });
    else if (!lay && /(바꿔|고쳐|수정)/.test(p)) out.push({ name: 'rewriteCard', args: { index: idx, style: 'alt' } });
  } else if (idx != null) {
    return [{ name: 'noop', args: { why: `${idx + 1}번 카드는 없어요(1~${n}번)` } }];
  }
  return out;
}

// ───────────────────────── 실행 ─────────────────────────

const cloneProject = (p) => (typeof structuredClone === 'function' ? structuredClone(p) : JSON.parse(JSON.stringify(p)));

function validateCall(c, n, project) {
  if (!c || !TOOL_NAMES.has(c.name)) return null;
  const a = c.args && typeof c.args === 'object' ? c.args : {};
  const idx = a.index == null ? null : clampInt(a.index, 0, n - 1, -1);
  switch (c.name) {
    case 'rewriteCard': return idx >= 0 && idx != null ? { name: c.name, args: { index: idx, style: ['short', 'emotional', 'evidence', 'alt'].includes(a.style) ? a.style : 'alt' } } : null;
    case 'editCardText': { const o = { index: idx }; for (const k of ['headline', 'body', 'bridge', 'cta']) if (typeof a[k] === 'string') o[k] = a[k]; return idx >= 0 && idx != null && Object.keys(o).length > 1 ? { name: c.name, args: o } : null; }
    case 'setLayout': return idx >= 0 && idx != null && LAYOUTS.includes(a.layout) ? { name: c.name, args: { index: idx, layout: a.layout } } : null;
    case 'setTemplate': return TEMPLATES.includes(a.template) ? c : null;
    case 'setAccent': return a.color === 'product' || HEX.test(a.color || '') ? { name: c.name, args: { color: a.color } } : null;
    case 'setType': return Object.keys({ list: 1, sales: 1, problem: 1, checklist: 1, compare: 1, story: 1, reviews: 1, qna: 1, ranking: 1 }).includes(a.type) ? c : null;
    case 'setCount': return Number.isFinite(Number(a.count)) ? { name: c.name, args: { count: clampInt(a.count, 5, 8, 7) } } : null;
    case 'setPurpose': return PURPOSES.includes(a.purpose) ? c : null;
    case 'setTease': return typeof a.on === 'boolean' ? c : null;
    case 'setCommentWord': { const w = String(a.word || '').replace(/["'“”‘’#]/g, '').trim(); return /^[가-힣A-Za-z0-9]{1,2}$/.test(w) ? { name: c.name, args: { word: w } } : null; }
    case 'setHook': return { name: c.name, args: { hookIndex: clampInt(a.hookIndex, 0, 2, 0) } };
    case 'applyFix': return ['soften', 'delete'].includes(a.mode) && (a.issueId === 'all' || (project.issues || []).some((i) => i.id === a.issueId)) ? { name: c.name, args: { issueId: a.issueId, mode: a.mode } } : null;
    case 'regenerateAll': return { name: c.name, args: {} };
    case 'resetColors': return { name: c.name, args: {} };
    case 'setColor': { const col = resolveColor(a.color); return col && typeof a.target === 'string' ? { name: c.name, args: { target: a.target, color: col } } : null; }
    case 'setAdLabel': {
      const o = {};
      if (typeof a.on === 'boolean') o.on = a.on;
      if (['tl', 'tr', 'bl', 'br'].includes(a.position)) o.position = a.position;
      if (['box', 'shadow', 'plain', 'outline'].includes(a.look)) o.look = a.look;
      const tx = a.text == null ? null : normAdText(a.text); if (tx) o.text = tx;
      if (['s', 'm', 'l'].includes(a.size)) o.size = a.size;
      if (a.color === 'auto' || a.color === null) o.color = 'auto'; else if (a.color != null) { const col = resolveColor(a.color); if (col) o.color = col; }
      return Object.keys(o).length ? { name: c.name, args: o } : null;
    }
    case 'setOverlayPosition': return idx >= 0 && idx != null && ['top', 'middle', 'bottom'].includes(a.position) ? { name: c.name, args: { index: idx, position: a.position } } : null;
    case 'setOverlaySize': return ['xl', 'l', 'm', 'bigger', 'smaller'].includes(a.size) ? { name: c.name, args: { ...(idx != null && idx >= 0 ? { index: idx } : {}), size: a.size } } : null;
    case 'setOverlayStyle': return ['outline', 'gradient', 'band', 'shadow'].includes(a.style) ? { name: c.name, args: { style: a.style } } : null;
    case 'setHighlight': {
      const words = (Array.isArray(a.words) ? a.words : []).map((w) => cleanText(w, 20)).filter(Boolean).slice(0, 12);
      const mode = ['add', 'remove', 'clear'].includes(a.mode) ? a.mode : 'add';
      return mode === 'clear' || words.length ? { name: c.name, args: { ...(idx != null && idx >= 0 ? { index: idx } : {}), words, mode } } : null;
    }
    case 'editOverlay': { const lines = (Array.isArray(a.lines) ? a.lines : []).map((l) => cleanText(l, 40)).filter(Boolean).slice(0, 3); return idx >= 0 && idx != null && lines.length ? { name: c.name, args: { index: idx, lines } } : null; }
    default: return null;
  }
}

/**
 * @param payload {text, project}
 * @param deps {settings, mock, rewriteCard(payload), applyFix(payload), recompute(project), aiParse(text, project, tools)}
 * @returns {reply, calls:[{name,args,ok,note}], patch, regenerate, accentFrom, counts}
 */
export async function runChat(payload, ctx, deps) {
  const text = String(payload?.text || '').trim();
  const project = payload?.project;
  if (!text) throw new AppError('수정할 내용을 입력해 주세요. 예: "3번 짧게", "베이지로", "리스트형으로 바꿔"', { raw: 'text 비어 있음', where: WHERE.SW, code: 'NO_TEXT' });
  if (!project?.carousel?.cards?.length) throw new AppError('먼저 캐러셀을 만들어 주세요.', { raw: 'project 없음', where: WHERE.SW, code: 'NO_PROJECT' });
  const n = project.carousel.cards.length;

  let { calls, unparsed } = parseCommands(text, project);
  let aiReply = '';
  let usedAi = false;
  if ((!calls.length || unparsed.length) && deps.aiParse) {
    try {
      const ai = await deps.aiParse(unparsed.length && calls.length ? unparsed.join(', ') : text, project, TOOLS);
      if (ai) {
        usedAi = true;
        aiReply = typeof ai.reply === 'string' ? ai.reply.slice(0, 200) : '';
        const extra = (Array.isArray(ai.calls) ? ai.calls : []).map((c) => validateCall(c, n, project)).filter(Boolean);
        if (extra.length) { calls.push(...extra); unparsed = []; }
      }
    } catch (e) {
      if (e?.code === 'CANCELLED') throw e;
      aiReply = '';
    }
  }
  calls = calls.filter((c) => c.name !== 'noop' || c.args.why);
  if (!calls.length) {
    return { reply: aiReply || '무슨 말씀인지 못 알아들었어요. 예: "3번 짧게", "5번 표로", "베이지로", "리스트형으로 바꿔", "6장으로", "댓글 단어 레드로"', calls: [], patch: {}, regenerate: null, accentFrom: null, usedAi };
  }

  const P = cloneProject(project);
  const touched = new Set();
  const results = [];
  const patch = { carousel: {}, cards: {}, plan: {} };
  const regen = { part: null, options: {}, hookIndex: null };
  let accentFrom = null;
  let factsOrCaption = false;

  for (const c of calls) {
    const a = c.args;
    const r = { name: c.name, args: a, ok: true, note: '' };
    try {
      if (P.carousel.mode === 'photo' && ['setLayout', 'setTemplate', 'setType', 'setCount', 'setAccent'].includes(c.name)) throw new AppError('사진 캐러셀에서는 쓸 수 없는 기능이에요', { raw: c.name, where: WHERE.SW });
      if (P.carousel.mode !== 'photo' && ['setOverlayPosition', 'setOverlaySize', 'setOverlayStyle', 'editOverlay'].includes(c.name)) throw new AppError('카드뉴스에서는 쓸 수 없는 기능이에요', { raw: c.name, where: WHERE.SW });
      if (c.name === 'noop') { r.ok = false; r.note = a.why; }
      else if (c.name === 'editOverlay' || (c.name === 'editCardText' && P.carousel.mode === 'photo')) {
        const lines = c.name === 'editOverlay' ? a.lines : String(a.headline ?? '').split('\n').map((l) => cleanText(l, 40)).filter(Boolean).slice(0, 3);
        if (!lines.length) throw new AppError('바꿀 문장이 없어요', { raw: 'lines 비어 있음', where: WHERE.SW });
        P.carousel.cards[a.index] = syncOverlay({ ...P.carousel.cards[a.index], headline: lines.join('\n') }); touched.add(a.index);
        r.note = `${a.index + 1}번 사진의 글을 바꿨어요`;
      } else if (c.name === 'setOverlayPosition') {
        const old = P.carousel.cards[a.index];
        P.carousel.cards[a.index] = { ...old, overlay: { ...old.overlay, position: a.position } }; touched.add(a.index);
        r.note = `${a.index + 1}번 사진의 글을 ${{ top: '위', middle: '가운데', bottom: '아래' }[a.position]}로 옮겼어요`;
      } else if (c.name === 'setOverlaySize') {
        const targets = a.index != null ? [a.index] : P.carousel.cards.map((x) => x.index);
        for (const t of targets) {
          const old = P.carousel.cards[t];
          const cur = SIZE_STEPS.indexOf(old.overlay?.size || (t === 0 ? 'xl' : 'l'));
          const next = a.size === 'bigger' ? SIZE_STEPS[Math.min(2, cur + 1)] : a.size === 'smaller' ? SIZE_STEPS[Math.max(0, cur - 1)] : a.size;
          P.carousel.cards[t] = { ...old, overlay: { ...old.overlay, size: next } }; touched.add(t);
        }
        r.note = a.index != null ? `${a.index + 1}번 사진의 글씨 크기를 바꿨어요` : '모든 사진의 글씨 크기를 바꿨어요';
      } else if (c.name === 'setHighlight') {
        if (P.carousel.mode !== 'photo') throw new AppError('강조 단어는 사진 캐러셀에서 쓸 수 있어요. 카드뉴스는 "강조 빨강"처럼 강조색을 바꿔 주세요.', { raw: 'setHighlight: mode!=photo', where: WHERE.SW });
        const targets = a.index != null ? [a.index] : P.carousel.cards.map((_, k) => k);
        let hit = 0;
        for (const t of targets) {
          const old = P.carousel.cards[t];
          const lines = old.overlay?.lines?.length ? old.overlay.lines : String(old.headline || '').split('\n');
          let set = [...(old.overlay?.highlight || [])];
          if (a.mode === 'clear') { if (!set.length) continue; set = []; }
          else if (a.mode === 'remove') { const before = set.length; set = set.filter((w) => !a.words.includes(w)); if (set.length === before) continue; }
          else { const add = a.words.filter((w) => lines.some((l) => l.includes(w)) && !set.includes(w)); if (!add.length) continue; set.push(...add); }
          const ov = { ...(old.overlay || {}), lines };
          if (set.length) ov.highlight = set; else delete ov.highlight;
          P.carousel.cards[t] = { ...old, overlay: ov }; touched.add(t); hit++;
        }
        const quoted = a.words.map((w) => `"${w}"`).join(', ');
        r.ok = hit > 0;
        r.note = !hit ? (a.mode === 'add' ? `${quoted}는 사진 위 글에 없어요` : '끌 강조가 없어요')
          : `${a.mode === 'clear' ? '강조를 지웠어요' : a.mode === 'remove' ? `${quoted} 강조를 껐어요` : `${quoted}를 강조했어요`}${a.index == null ? ` (${hit}장)` : ''}`;
      } else if (c.name === 'setOverlayStyle') {
        patch.carousel.overlayStyle = a.style; P.carousel.overlayStyle = a.style; r.note = `글씨 스타일을 ${{ outline: '테두리', gradient: '그라데이션', band: '띠', shadow: '그림자' }[a.style]}로 바꿨어요`;
      } else if (c.name === 'editCardText') {
        const old = P.carousel.cards[a.index];
        const next = { ...old };
        for (const k of ['headline', 'body', 'bridge', 'cta']) if (typeof a[k] === 'string') next[k] = cleanText(a[k], k === 'body' ? 320 : 60);
        const all = [next.headline, next.body, next.bridge, next.cta].join('\n');
        next.claims = (old.claims || []).filter((cl) => all.includes(cl.text));
        P.carousel.cards[a.index] = next; touched.add(a.index); r.note = `${a.index + 1}번 카드 글을 바꿨어요`;
      } else if (c.name === 'setLayout') {
        const old = P.carousel.cards[a.index];
        P.carousel.cards[a.index] = { ...old, layout: a.layout, imageSlot: LAYOUT_SLOT[a.layout] || 'none' }; touched.add(a.index);
        r.note = `${a.index + 1}번 카드를 ${a.layout} 레이아웃으로 바꿨어요`;
        if ((a.layout === 'photo-full' || a.layout === 'split') && !(P.input?.images?.length || P.input?.imageIds?.length)) r.note += ' (상품 사진이 없어 사진 자리는 비어 있어요)';
        if (a.layout === 'table' && !(old.body || '').includes('|')) r.note += ' (표는 "항목|내용" 줄이어야 예쁘게 나와요. 본문을 고쳐 주세요)';
      } else if (c.name === 'setTemplate') {
        patch.carousel.template = a.template; patch.plan.template = a.template; P.carousel.template = a.template; P.plan.template = a.template; r.note = `${a.template} 템플릿으로 바꿨어요`;
      } else if (c.name === 'setColor') {
        const photoM = P.carousel.mode === 'photo';
        const key = photoM ? 'overlayColors' : 'colors';
        const t = (photoM ? PHOTO_COLOR_KEYS : CARD_COLOR_KEYS).includes(a.target) ? a.target : COLOR_ALIAS[photoM ? 'photo' : 'card'][a.target];
        if (!t) throw new AppError('이 모드에서는 바꿀 수 없는 색이에요', { raw: `target=${a.target}`, where: WHERE.SW });
        P.carousel[key] = { ...(P.carousel[key] || {}), [t]: a.color }; patch.carousel[key] = P.carousel[key];
        if (!photoM && t === 'accent') { P.carousel.accentColor = a.color; patch.carousel.accentColor = a.color; } // 기존 강조색 필드도 같이
        r.note = `${{ bg: '배경', headline: '제목', body: '본문', accent: '강조', text: '글씨', stroke: '테두리', highlight: '강조 단어', shade: '띠·그라데이션' }[t]} 색을 ${a.color}로 바꿨어요`;
      } else if (c.name === 'resetColors') {
        const key = P.carousel.mode === 'photo' ? 'overlayColors' : 'colors';
        P.carousel[key] = {}; patch.carousel[key] = {}; r.note = '색을 기본으로 되돌렸어요';
      } else if (c.name === 'setAdLabel') {
        const { on, ...styleArgs } = a;
        const style = { ...(P.carousel.adLabelStyle || {}), ...styleArgs };
        if (style.color === 'auto') delete style.color;   // 자동: 렌더러가 배경에 맞춰 고른다
        if (Object.keys(styleArgs).length) { P.carousel.adLabelStyle = style; patch.carousel.adLabelStyle = style; }
        const turnOn = on ?? (Object.keys(styleArgs).length ? true : undefined);
        if (turnOn !== undefined) { P.carousel.adLabel = turnOn; patch.carousel.adLabel = turnOn; }
        r.note = turnOn === false ? '광고 표시를 껐어요' : '광고 표시를 바꿨어요' + (styleArgs.position ? `(${{ tl: '왼쪽 위', tr: '오른쪽 위', bl: '왼쪽 아래', br: '오른쪽 아래' }[styleArgs.position]})` : '') + (styleArgs.color ? (styleArgs.color === 'auto' ? ' · 글자색 자동' : ` · 글자색 ${styleArgs.color}`) : '');
      } else if (c.name === 'setAccent') {
        if (a.color === 'product') { accentFrom = 'product'; r.note = '제품 사진 색으로 맞출게요'; }
        else { patch.carousel.accentColor = a.color; P.carousel.accentColor = a.color; r.note = `강조색을 ${a.color}로 바꿨어요`; }
      } else if (c.name === 'rewriteCard') {
        const res = await deps.rewriteCard({ project: P, index: a.index, styles: [a.style] });
        const v = res.variants?.[0];
        if (!v) throw new AppError('다시 쓰기 결과가 없어요', { raw: 'variants 비어 있음', where: WHERE.SW });
        P.carousel.cards[a.index] = v.card; touched.add(a.index);
        r.note = `${a.index + 1}번 카드를 ${v.style}으로 다시 썼어요`;
      } else if (c.name === 'applyFix') {
        const targets = a.issueId === 'all' ? (P.issues || []).filter((i) => i.level === 'fact' && !i.resolved) : (P.issues || []).filter((i) => i.id === a.issueId);
        if (!targets.length) { r.note = '고칠 항목이 없어요'; }
        let done = 0;
        for (const issue of targets) {
          try {
            const fixed = await deps.applyFix({ project: P, issueId: issue.id, mode: a.mode });
            Object.entries(fixed.patch.cards || {}).forEach(([i, card]) => { P.carousel.cards[i] = card; touched.add(Number(i)); });
            if (fixed.patch.caption != null) { P.caption = fixed.patch.caption; patch.caption = P.caption; factsOrCaption = true; }
            P.issues = fixed.patch.issues; P.score = fixed.patch.score; done++;
          } catch (e) { r.note += `${r.note ? ' · ' : ''}${issue.cardNo ? issue.cardNo + '번: ' : ''}${e.messageKo || e.message}`; }
        }
        r.note = `${done}건 ${a.mode === 'soften' ? '완화' : '삭제'}했어요${r.note ? ' · ' + r.note : ''}`;
        r.ok = done > 0 || !targets.length;
      } else if (c.name === 'setType') { regen.part = 'all'; regen.options.type = a.type; r.note = '유형을 바꿔 다시 만들어요'; }
      else if (c.name === 'setCount') { regen.part = 'all'; regen.options.count = a.count; r.note = `${a.count}장으로 다시 만들어요`; }
      else if (c.name === 'setPurpose') { regen.part = 'all'; regen.options.purpose = a.purpose; r.note = `목적을 ${a.purpose}(으)로 바꿔 다시 만들어요`; }
      else if (c.name === 'setCommentWord') {
        // 마지막 카드와 캡션의 따옴표 안 옛 단어를 새 단어로(AI 없이). 옛 단어가 없으면 마지막 카드 끝 줄을 댓글 문장으로
        const old = P.plan?.commentWord || '';
        const re = old ? new RegExp(`(["“'‘])${old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(["”'’])`, 'g') : null;
        const li = P.carousel.cards.length - 1;
        const last = P.carousel.cards[li];
        const has = (s) => !!re && new RegExp(re.source, 'i').test(String(s || ''));
        const swap = (s) => String(s || '').replace(re, `$1${a.word}$2`);
        if (last) {
          let card = { ...last };
          let changed = false;
          // 카드뉴스는 CTA 가 headline·body·cta 어디에나 있다. 사진 카드는 headline(=줄) 하나
          for (const f of ['headline', 'body', 'cta']) if (has(card[f])) { card[f] = swap(card[f]); changed = true; }
          if (!changed && last.overlay) {
            // 따옴표 단어가 없으면, 마지막 줄이 댓글 문장일 때만 그 줄을 바꾼다(다른 문장은 건드리지 않는다)
            const lines = (last.overlay.lines || String(last.headline || '').split('\n')).filter(Boolean);
            if (lines.length && /댓글|남겨/.test(lines[lines.length - 1])) { card.headline = [...lines.slice(0, -1), `댓글에 "${a.word}" 남겨 주세요`].join('\n'); changed = true; }
          }
          if (changed) { P.carousel.cards[li] = card.overlay ? syncOverlay(card) : card; touched.add(li); }
          else r.note = '마지막 카드에 댓글 문장이 없어 카드는 그대로 두고 ';
        }
        if (has(P.caption)) { P.caption = swap(P.caption); patch.caption = P.caption; factsOrCaption = true; }
        // 새 단어가 숨김 목록에 있으면 거기서 뺀다(안 그러면 CTA 가 ⚠️)
        const hide = (P.plan?.hide || []).filter((h) => !findLeak(a.word, [h]) && !findLeak(h, [a.word]));
        P.plan = { ...(P.plan || {}), commentWord: a.word, ...(P.plan?.hide ? { hide } : {}) };
        patch.plan.commentWord = a.word; if (P.plan.hide) patch.plan.hide = hide;
        if (hide.length !== (P.plan.hide || hide).length) factsOrCaption = true;
        r.note = `${r.note || ''}댓글 단어를 "${a.word}"로 바꿨어요`;
      }
      else if (c.name === 'setTease') {
        if (!!P.options?.tease === a.on) r.note = a.on ? '이미 댓글 유도가 켜져 있어요' : '이미 댓글 유도가 꺼져 있어요';   // 같은 상태면 다시 만들지 않는다
        else { regen.part = 'all'; regen.options.tease = a.on; r.note = a.on ? '번호·색상명을 숨기고 댓글로 묻게 다시 만들어요' : '번호·이름을 그대로 쓰고 다시 만들어요'; }
      }
      else if (c.name === 'regenerateAll') { regen.part = 'all'; r.note = '처음부터 다시 만들어요'; }
      else if (c.name === 'setHook') { if (regen.part !== 'all') regen.part = 'hook'; regen.hookIndex = a.hookIndex; regen.options.hookIndex = a.hookIndex; r.note = '훅을 바꿔 1번 카드와 캡션을 다시 써요'; }
    } catch (e) {
      if (e?.code === 'CANCELLED') throw e;
      r.ok = false; r.note = e?.messageKo || e?.message || '실행하지 못했어요';
    }
    results.push(r);
  }

  for (const i of touched) patch.cards[i] = P.carousel.cards[i];
  // 카드 글이 바뀌었으면 규칙 검수·점수를 다시 낸다(AI 검수 결과는 문구가 남아 있으면 유지)
  if (touched.size || factsOrCaption || patch.caption != null) {
    const r = await deps.recompute(P);
    patch.issues = r.issues; patch.score = r.score;
  }
  if (!Object.keys(patch.carousel).length) delete patch.carousel;
  if (!Object.keys(patch.plan).length) delete patch.plan;
  if (!Object.keys(patch.cards).length) delete patch.cards;
  const regenerate = regen.part ? { part: regen.part, options: regen.options, ...(regen.part === 'hook' ? { hookIndex: regen.hookIndex } : {}) } : null;
  const notes = results.map((r) => (r.ok ? r.note : `(${r.note || '실행 못 함'})`)).filter(Boolean);
  if (unparsed.length && !usedAi) notes.push(`못 알아들은 부분: "${unparsed.join('", "')}"`);
  return { reply: [aiReply, notes.join('. ')].filter(Boolean).join(' — ') || '바꿨어요', calls: results, patch, regenerate, accentFrom, usedAi };
}
