// 지식 로더 — knowledge/*.md 를 chrome.runtime.getURL('knowledge/…') 로 읽어 에이전트별로 잘라 준다 (CLAUDE.md 규칙 7).
//  · 카테고리 파일은 선택된 것 하나만, 우수사례는 같은 유형·카테고리 최대 3개만 주입한다.
//  · 금지어·유형 구조·훅 금지 패턴은 마크다운 표/목록에서 읽는다. 코드에는 "읽는 방법"과 마지막 보루용 기본값만 둔다.
//  · 아래 FALLBACK_* 는 지식 파일에 아직 없는 내용(카테고리 기본값·role→레이아웃)이라 코드에 임시로 둔 것이다.
//    같은 내용을 K-카테고리기본값.md / K-레이아웃.md 로 만들면 그 파일이 우선한다(선택 파일, 없으면 기본값).
// 서비스워커·패널 양쪽에서 import 가능(최상위에서 chrome.* 를 부르지 않는다).

import { AppError, WHERE } from './common.js';

// ───────────────────────── 읽기 · 캐시 · 버전 ─────────────────────────

const textCache = new Map(); // 이름 → Promise<string|null>

async function fetchKnowledge(name) {
  try {
    const res = await fetch(chrome.runtime.getURL('knowledge/' + name));
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; }
}

const hash8 = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
};

/** 한 번의 생성에서 읽은 지식을 기록해 knowledgeVersion 을 만든다. */
export class Knowledge {
  constructor() { this.used = new Map(); }

  /** 파일 본문. optional 이면 없을 때 null, 아니면 AppError. */
  async text(name, { optional = false } = {}) {
    if (!textCache.has(name)) textCache.set(name, fetchKnowledge(name));
    const t = await textCache.get(name);
    if (t == null) {
      textCache.delete(name);
      if (optional) return null;
      throw new AppError('지식 파일을 불러오지 못했습니다. 확장을 다시 설치하거나 업데이트해 주세요.', { raw: `knowledge/${name}`, where: WHERE.SW, code: 'KNOWLEDGE_MISSING' });
    }
    this.used.set(name, t);
    return t;
  }

  /** `<확장 버전>-<내용 해시>` — 어떤 지식으로 만들었는지 프로젝트에 남긴다. */
  version() {
    const names = [...this.used.keys()].sort();
    const ver = (typeof chrome !== 'undefined' && chrome.runtime?.getManifest?.().version) || '0';
    return `${ver}-${hash8(names.map((n) => n + '\n' + this.used.get(n)).join('\n'))}`;
  }

  async typeDoc() { return parseTypeDoc(await this.text('K-유형구조.md')); }
  async categoryText(category) {
    const c = canonCategory(category);
    return this.text(`categories/${c.file}.md`, { optional: true });
  }
  async forbidden(category) { return parseForbidden(await this.text('K-금지어.md'), category); }
  async hookRules() { return parseHookRules(await this.text('K-훅공식.md')); }
  async examples({ category, type }, max = 3) { return pickExamples(await this.text('K-우수사례.md'), await this.typeDoc(), { category, type }, max); }
  async hashtagSlice(category) { return sliceHashtags(await this.text('K-해시태그.md'), category); }
  async layoutRules() { return parseLayoutRules(await this.text('K-레이아웃.md', { optional: true })); }
  async categoryDefaults() { return parseCategoryDefaults(await this.text('K-카테고리기본값.md', { optional: true })); }
  async patterns() { return parsePatterns(await this.text('K-날조패턴.md', { optional: true })); }
}

// ───────────────────────── 마크다운 도구 ─────────────────────────

/** `## 제목` 단위로 자른다. 첫 ## 전 본문은 preamble. */
export function splitSections(text, marker = '## ') {
  const lines = String(text || '').split('\n');
  const out = [];
  let cur = { title: '', body: [] };
  const pre = { title: '', body: [] };
  let seenFirst = false;
  for (const line of lines) {
    if (line.startsWith(marker) && !line.startsWith(marker + '#')) {
      if (seenFirst) out.push({ title: cur.title, body: cur.body.join('\n').trim() });
      else { pre.body = cur.body; seenFirst = true; }
      cur = { title: line.slice(marker.length).trim(), body: [] };
    } else cur.body.push(line);
  }
  if (seenFirst) out.push({ title: cur.title, body: cur.body.join('\n').trim() });
  else pre.body = cur.body;
  return { preamble: pre.body.join('\n').trim(), sections: out };
}

function tableRows(body) {
  const rows = [];
  for (const line of String(body || '').split('\n')) {
    if (!/^\s*\|/.test(line)) continue;
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    rows.push(cells);
  }
  return rows;
}

const backticks = (s) => [...String(s || '').matchAll(/`([^`]+)`/g)].map((m) => m[1]);

// ───────────────────────── 카테고리 ─────────────────────────

/** 표시 이름 · 파일 이름 · 쿠팡 breadcrumb 힌트 · v1 §4 기본값. */
export const CATEGORIES = [
  { name: '뷰티', file: '뷰티', hint: /뷰티|화장품|스킨|향수|헤어|바디|메이크업/ },
  { name: '패션', file: '패션', hint: /패션|의류|잡화|신발|가방|언더웨어|액세서리/ },
  { name: '식품', file: '식품', hint: /식품|신선|가공|간편|과일|건강식|생수|음료|커피|과자|정육|수산/ },
  { name: '리빙·주방', file: '리빙주방', hint: /주방|생활용품|홈인테리어|가구|청소|세탁|욕실|수납|침구/ },
  { name: '가전·테크', file: '가전테크', hint: /가전|디지털|컴퓨터|노트북|휴대폰|카메라|모니터|청소기|이어폰/ },
  { name: '육아', file: '육아', hint: /출산|유아|아기|기저귀|완구|장난감|분유|아동/ },
  { name: '건강·운동', file: '건강운동', hint: /스포츠|레져|레저|건강|운동|헬스|캠핑|등산|골프|비타민/ },
  { name: '반려동물', file: '반려동물', hint: /반려|애완|펫|강아지|고양이/ },
  { name: '기타', file: '기타', hint: null },
];

const normName = (s) => String(s || '').replace(/[\s·ㆍ,/()]/g, '');

/** 아무 표기("건강운동", "리빙 주방" …)나 표준 카테고리로. 모르면 기타. */
export function canonCategory(name) {
  const n = normName(name);
  return CATEGORIES.find((c) => normName(c.name) === n || c.file === n || (n && (normName(c.name).includes(n) || n.includes(normName(c.name))))) || CATEGORIES[CATEGORIES.length - 1];
}

// 힌트 검사 순서: 겹치기 쉬운 것(청소기 = 가전 vs 청소 = 리빙)을 구체적인 쪽부터
const HINT_ORDER = ['반려동물', '육아', '뷰티', '가전·테크', '패션', '식품', '건강·운동', '리빙·주방'];

/** 쿠팡 breadcrumb·상품명에서 카테고리 추정(플래너 힌트). 못 정하면 null. */
export function guessCategory(parts) {
  const s = (parts || []).filter(Boolean).join(' ');
  if (!s) return null;
  for (const name of HINT_ORDER) { const c = CATEGORIES.find((x) => x.name === name); if (c.hint.test(s)) return c.name; }
  return null;
}

const FALLBACK_CATEGORY_DEFAULTS = {
  '뷰티': { target: '20~30대 여성', types: ['compare', 'sales'], template: 'pastel', tone: '사용감·전후 변화·성분' },
  '패션': { target: '20~30대', types: ['list', 'sales'], template: 'basic', tone: '코디·핏·가성비' },
  '식품': { target: '30~40대 주부', types: ['list', 'problem'], template: 'warm', tone: '맛·보관·간편함' },
  '리빙·주방': { target: '30~40대', types: ['checklist', 'compare'], template: 'warm', tone: '수납·정리·시간 절약' },
  '가전·테크': { target: '20~40대', types: ['sales', 'compare'], template: 'dark', tone: '스펙을 체감 효용으로 번역' },
  '육아': { target: '30대 엄마', types: ['checklist', 'problem'], template: 'pastel', tone: '안전·편리·월령' },
  '건강·운동': { target: '20~40대', types: ['problem', 'list'], template: 'nature', tone: '습관·루틴·실천' },
  '반려동물': { target: '20~40대 반려인', types: ['list', 'problem'], template: 'pastel', tone: '반려인 공감·안전' },
  '기타': { target: '20~30대 초보자', types: ['list'], template: 'basic', tone: '일반' },
};

/** K-카테고리기본값.md 표: | 카테고리 | 기본 타깃 | 추천 유형(키,쉼표) | 추천 템플릿 키 | 톤 힌트 | */
export function parseCategoryDefaults(text) {
  const out = { ...FALLBACK_CATEGORY_DEFAULTS };
  if (!text) return out;
  for (const c of tableRows(text)) {
    if (c.length < 5 || c[0] === '카테고리') continue;
    out[canonCategory(c[0]).name] = { target: c[1], types: c[2].split(/[,\s]+/).filter(Boolean), template: c[3], tone: c[4] };
  }
  return out;
}

export const TEMPLATES = ['basic', 'warm', 'dark', 'pastel', 'nature', 'pop'];

// ───────────────────────── 유형 구조 (K-유형구조.md) ─────────────────────────

const CIRCLED = '①②③④⑤⑥⑦⑧⑨';

/** 한 표 행("3~5 | 핵심 ①②③")을 카드 role 이름 여러 개로 펼친다. */
function expandRole(num, role) {
  const range = String(num).match(/^(\d+)\s*[~-]\s*(\d+)$/);
  const n = range ? Number(range[2]) - Number(range[1]) + 1 : 1;
  if (n === 1) return [role];
  const rank = role.match(/^(\d+)위\s*→\s*(\d+)위/);
  if (rank) return Array.from({ length: n }, (_, i) => `${Number(rank[1]) - i}위`);
  const rng = role.match(/^(.*?)\s*([①-⑨])\s*~\s*([①-⑨])/);
  if (rng) { const a = CIRCLED.indexOf(rng[2]); return Array.from({ length: n }, (_, i) => `${rng[1]} ${CIRCLED[a + i]}`); }
  const seq = role.match(/^(.*?)\s*([①-⑨]{2,})/);
  if (seq) return [...seq[2]].slice(0, n).map((c) => `${seq[1]} ${c}`);
  return Array.from({ length: n }, (_, i) => `${role} ${i + 1}`);
}

/** → {types:{key:{key,name,count,purpose,roles:[{role,what,slot}],text}}, order:[key], common, ctaBank:{목적:[문장]}, rewrite} */
export function parseTypeDoc(text) {
  const { preamble, sections } = splitSections(text);
  const types = {};
  const order = [];
  let ctaBank = {};
  let rewrite = '';
  for (const s of sections) {
    const head = s.title.match(/^(.+?)\s*`(\w+)`\s*[—-]\s*기본\s*(\d+)\s*장\s*,?\s*기본 목적:\s*(.+)$/);
    if (head) {
      const roles = [];
      for (const c of tableRows(s.body)) {
        if (c[0] === '#' || c.length < 4) continue;
        const slot = (c[3].match(/hero|side|none/) || ['none'])[0];
        for (const role of expandRole(c[0], c[1])) roles.push({ role, what: c[2], slot });
      }
      types[head[2]] = { key: head[2], name: head[1].trim(), count: Number(head[3]), purpose: head[4].trim(), roles, text: `## ${s.title}\n${s.body}` };
      order.push(head[2]);
    } else if (/CTA 문장 은행/.test(s.title)) {
      for (const line of s.body.split('\n')) {
        const m = line.match(/^-\s*([^:]+):\s*(.+)$/);
        if (m) ctaBank[m[1].trim()] = backticks(m[2]);
      }
      ctaBank = { ...ctaBank };
    } else if (/재작성 규칙/.test(s.title)) rewrite = `## ${s.title}\n${s.body}`;
  }
  return { types, order, common: preamble, ctaBank, rewrite };
}

/** 계획 장수에 맞게 role 목록을 늘이고 줄인다(플래너 출력이 어긋났을 때의 보정). 첫 장과 마지막 장은 지킨다. */
export function fitRoles(roles, count) {
  const list = roles.map((r) => ({ ...r }));
  if (list.length === count) return list;
  if (list.length > count) {
    while (list.length > count && list.length > 2) list.splice(list.length - 2, 1); // CTA 바로 앞 핵심부터 줄임
    return list;
  }
  while (list.length < count) {
    const core = list[Math.max(1, list.length - 2)];
    list.splice(list.length - 1, 0, { ...core, role: core.role.replace(/\s*[①-⑨\d]+$/, '') + ` ${list.length}` });
  }
  return list;
}

// ───────────────────────── 레이아웃 (v1 §20-A) ─────────────────────────

const FALLBACK_LAYOUT_RULES = [
  // [role 정규식, layout]  — 위에서부터 첫 일치. 사진이 필요한 layout 은 스타일리스트가 사진 유무로 낮춘다.
  [/^훅/, 'title'],
  [/제품 등장|등장/, 'photo-full'],
  [/요약\s*\+?\s*CTA|^CTA/i, 'cta'],
  [/전체 요약표|가격|구성|^항목/, 'table'],
  [/후기\s*[①-⑨\d]|후기\/비교|^후기$/, 'quote'],
  [/^Q&A|^Q\./i, 'number'],
  [/특징|비포|애프터|^A$|^B$|결과|전환|공통점|차이 포인트/, 'split'],
  [/핵심|실수|\d위/, 'number'],
  [/공감|상황|갈등|왜 필요|정리|교훈/, 'quote'],
];

/** K-레이아웃.md 표: | role 정규식 | layout | */
export function parseLayoutRules(text) {
  if (!text) return FALLBACK_LAYOUT_RULES;
  const rows = [];
  for (const c of tableRows(text)) {
    if (c.length < 2 || /^role/i.test(c[0])) continue;
    try { rows.push([new RegExp(c[0]), c[1]]); } catch { /* 잘못된 정규식 줄은 무시 */ }
  }
  return rows.length ? rows : FALLBACK_LAYOUT_RULES;
}

export const LAYOUTS = ['title', 'photo-full', 'split', 'number', 'quote', 'table', 'cta'];

// ───────────────────────── 금지어 (K-금지어.md) ─────────────────────────

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function termToRegex(term) {
  const body = escRe(term).replace(/○+/g, '[^\\s]{1,4}').replace(/\s+/g, '\\s*');
  const digitStart = /^\d/.test(term) ? '(?<![\\d.])' : '';
  return new RegExp(digitStart + body, 'u');
}

/** K-금지어 표 → [{grade, term, re, needsEvidence, replacement, variable, scope, note}]. category 는 해당 절 + 공통만. */
export function parseForbidden(text, category) {
  const cat = normName(canonCategory(category).name);
  const { sections } = splitSections(text);
  const out = [];
  for (const s of sections) {
    const scope = normName(s.title.replace(/\(.*$/, ''));
    if (/검수자동작/.test(scope)) continue;
    const common = scope.startsWith('공통');
    if (!common && !(cat && (scope.includes(cat) || cat.includes(scope)))) continue;
    const repl = backticks((s.body.match(/^대체:\s*(.+)$/m) || [])[1] || '');
    for (const c of tableRows(s.body)) {
      const grade = c[0];
      if (!/^(금지|주의)$/.test(grade)) continue; // '표기' 는 안내 행이라 단어 검사에서 제외
      const cell = c[1] || '';
      const rowRepl = c[2] || '';
      const variable = /캡션/.test(rowRepl) && /(로켓|무료배송|오늘 도착|최저가)/.test(cell);
      const terms = cell.split(/[,，]/).flatMap((t) => {
        const note = (t.match(/\(([^)]*)\)/) || [])[1] || '';
        const bare = t.replace(/\([^)]*\)/g, '').trim();
        if (!bare) return [];
        const pieces = bare.includes('·') ? bare.split('·').map((x) => x.trim()) : [bare];
        return pieces.filter((p) => p.length >= 2).map((p) => ({ term: p, note }));
      });
      for (const { term, note } of terms) {
        out.push({
          grade, term, re: termToRegex(term), scope: common ? '공통' : s.title.replace(/\(.*$/, '').trim(),
          needsEvidence: /근거|인증|출처|없을 때|미기재|사실일 때/.test(note),
          replacement: rowRepl || (repl.length ? `대체 표현 예: ${repl.join(', ')}` : ''),
          variable, note,
        });
      }
    }
  }
  return out;
}

// ───────────────────────── 훅 · 사례 · 해시태그 ─────────────────────────

/** K-훅공식 "금지 제목 패턴" → [{re, label}] (설명형·빈말·낚시어). */
export function parseHookRules(text) {
  const { sections } = splitSections(text);
  const sec = sections.find((s) => /금지 제목 패턴/.test(s.title));
  const out = [];
  for (const line of (sec?.body || '').split('\n')) {
    if (/브랜드명만/.test(line)) continue;
    for (const item of backticks(line)) {
      const parts = item.split('~').map((p) => p.trim());
      let re;
      if (parts.length === 2 && parts[0] === '' && parts[1]) re = new RegExp(escRe(parts[1]) + '\\s*$');
      else if (parts.length === 2 && parts[0] && parts[1] === '') re = new RegExp('^' + escRe(parts[0]));
      else re = new RegExp(parts.map(escRe).join('.*'));
      out.push({ re, label: item });
    }
  }
  return out;
}

/** → 같은 유형·카테고리 사례를 max 개 프롬프트용 텍스트로. 유형이 같고 카테고리가 같은 것만. */
export function pickExamples(text, typeDoc, { category, type }, max = 3) {
  const { sections } = splitSections(text);
  const typeName = typeDoc.types[type]?.name;
  const cat = normName(canonCategory(category).name);
  const found = [];
  for (const s of sections) {
    if (!/^사례/.test(s.title) || /비워 둠/.test(s.body)) continue;
    const meta = s.body.match(/카테고리:\s*([^/\n]+)\/\s*유형:\s*([^/\n]+)/);
    if (!meta) continue;
    if (normName(meta[1]) !== cat || meta[2].trim() !== typeName) continue;
    const why = (s.body.match(/왜 잘됐나[^:]*:\s*(.+)/) || [])[1] || '';
    const rows = tableRows(s.body).filter((c) => /^\d+$/.test(c[0])).map((c) => `${c[0]}. [${c[1]}] ${c[2]} / ${c[3].replace(/\\n/g, ' ⏎ ')}`);
    found.push(`### ${s.title} (${meta[1].trim()} · ${meta[2].trim()})\n왜 잘됐나: ${why}\n${rows.join('\n')}`);
    if (found.length >= max) break;
  }
  return found;
}

/** K-해시태그: 구성 규칙 + 해당 카테고리 풀 + 공통 풀. pools 는 대/중/소형 배열(폴백 태그용). */
export function sliceHashtags(text, category) {
  const { sections } = splitSections(text);
  const rules = sections.find((s) => /구성 규칙/.test(s.title));
  const pool = sections.find((s) => /카테고리별 태그 풀/.test(s.title));
  const subs = splitSections(pool?.body || '', '### ').sections;
  const cname = canonCategory(category).name;
  const pick = (re) => subs.find((s) => re.test(normName(s.title)));
  const mine = pick(new RegExp('^' + normName(cname).replace(/[()]/g, ''))) || pick(/^기타/);
  const common = pick(/^기타/);
  const pools = { 대형: [], 중형: [], 소형: [] };
  for (const s of [mine, common].filter(Boolean)) {
    for (const line of s.body.split('\n')) {
      const m = line.match(/^(대형|중형|소형):\s*(.+)$/);
      if (m) pools[m[1]].push(...m[2].split(/\s+/).filter((t) => t.startsWith('#')));
    }
  }
  const textOut = [rules ? `## ${rules.title}\n${rules.body}` : '', mine ? `### ${mine.title}\n${mine.body}` : '', common && common !== mine ? `### ${common.title}\n${common.body}` : ''].filter(Boolean).join('\n\n');
  return { text: textOut, pools };
}

/** K-카피규칙의 한 절(제목 일부로 찾기). 사실 검수·재작성 프롬프트가 필요한 부분만 쓰려고. */
export function sectionByTitle(text, re) {
  const s = splitSections(text).sections.find((x) => re.test(x.title));
  return s ? `## ${s.title}\n${s.body}` : '';
}

// ───────────────────────── 날조 패턴 (선택 파일 K-날조패턴.md) ─────────────────────────

/** | kind | 정규식 | 설명 | 완화 문구(없으면 -) | */
export function parsePatterns(text) {
  if (!text) return null;
  const out = [];
  for (const c of tableRows(text)) {
    if (c.length < 3 || c[0] === 'kind') continue;
    try { out.push({ kind: c[0], re: new RegExp(c[1].replace(/^`|`$/g, ''), 'u'), why: c[2], soften: c[3] && c[3] !== '-' ? c[3] : null }); } catch { /* 무시 */ }
  }
  return out.length ? out : null;
}

// ───────────────────────── 공용 ─────────────────────────

/** 지식 본문을 프롬프트용으로 다듬는다(표 구분선 등 토큰 낭비 제거). */
export function compactMd(text) {
  return String(text || '').replace(/\n{3,}/g, '\n\n').replace(/^\s*\|[-:\s|]+\|\s*$/gm, '').trim();
}
