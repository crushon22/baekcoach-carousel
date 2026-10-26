// AI 계층 공용 순수 함수 — agents.js · mock-ai.js · chat.js 가 함께 쓴다(네트워크·chrome.* 없음).
// 입력 정규화 · 로컬 facts · 기획 보정 · 레이아웃 배정 · 스타일리스트(사진 배정) · 해시태그 합치기 · Project 조립.

import { AppError, WHERE } from './common.js';
import { canonCategory, fitRoles, TEMPLATES, LAYOUTS } from './knowledge.js';

export const DEFAULT_BRAND = '#2F5BEA';
export const PURPOSES = ['저장', '링크 클릭', '댓글', '팔로우', 'DM·문의'];

/** "댓글·DM" 같은 표기를 목적 목록의 값으로 맞춘다 */
export function normPurpose(p) {
  const s = String(p || '');
  if (/저장/.test(s)) return '저장';
  if (/링크/.test(s)) return '링크 클릭';
  if (/댓글/.test(s)) return '댓글';
  if (/팔로우/.test(s)) return '팔로우';
  if (/DM|문의/i.test(s)) return 'DM·문의';
  return '저장';
}

export const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
export const clampInt = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

/** 마크다운 기호·빈 줄을 정리한 카드 글 */
export function cleanText(t, max = 300) {
  return String(t ?? '').replace(/\r/g, '').replace(/\*\*|__|`/g, '').replace(/^#+\s*/gm, '')
    .split('\n').map((l) => l.trim()).filter(Boolean).join('\n').slice(0, max);
}

export function shortTitle(input) {
  const t = input?.title || input?.topic || (input?.script ? input.script.split(/\n|[.!?]/)[0] : '') || '';
  return t.replace(/\s+/g, ' ').replace(/[,\[(].*$/, '').trim().slice(0, 18) || '이 상품';
}

// ───────────────────────── 입력 정규화 ─────────────────────────

/** 주제·쇼츠 입력에도 사진(imageIds)을 받는다 — 사진 카드 배정용. 수치 금지 등 주제 모드 규칙은 그대로. */
function pickImages(raw) {
  const ids = Array.isArray(raw.imageIds) ? raw.imageIds.filter((u) => typeof u === 'string').slice(0, 8) : [];
  const urls = Array.isArray(raw.images) ? raw.images.filter((u) => typeof u === 'string').slice(0, 8) : [];
  return ids.length || urls.length ? { images: urls, imageIds: ids } : {};
}

/**
 * ai.generate 의 payload 를 {input, options, hasPartnersLink} 로.
 * 받는 모양: {product|input, options?, hasPartnersLink?} 또는 Product/Topic/Shorts 자체(+ options).
 */
export function normalizeInput(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const raw = p.product || p.input || (p.source ? p : null);
  if (!raw || typeof raw !== 'object') throw new AppError('만들 상품이나 주제가 없습니다. 상품 페이지에서 시작하거나 주제를 입력해 주세요.', { raw: 'payload 에 product/topic/script 없음', where: WHERE.SW, code: 'NO_INPUT' });
  const o = (p.options && typeof p.options === 'object' ? p.options : raw.options) || {};
  const options = {
    type: str(o.type, 20) || null, purpose: str(o.purpose, 20) || null, template: str(o.template, 20) || null,
    count: o.count == null || o.count === '' ? null : clampInt(o.count, 5, 8, null),
    hookIndex: o.hookIndex == null ? null : clampInt(o.hookIndex, 0, 2, 0),
  };
  let input;
  if (raw.source === 'topic') {
    const topic = str(raw.topic, 200);
    if (!topic) throw new AppError('주제를 입력해 주세요.', { raw: 'topic 비어 있음', where: WHERE.SW, code: 'NO_INPUT' });
    input = { source: 'topic', topic, ...pickImages(raw) };
  } else if (raw.source === 'shorts') {
    const script = str(raw.script, 4000);
    if (script.length < 10) throw new AppError('쇼츠 대본이 너무 짧습니다. 대본을 붙여 넣어 주세요.', { raw: `script ${script.length}자`, where: WHERE.SW, code: 'NO_INPUT' });
    input = { source: 'shorts', script, ...pickImages(raw) };
  } else {
    const title = str(raw.title, 200);
    if (!title) throw new AppError('상품 이름을 읽지 못했습니다. 상품 이름을 직접 입력해 주세요.', { raw: 'title 없음', where: WHERE.SW, code: 'NO_INPUT' });
    input = {
      source: raw.source || 'coupang_page', url: str(raw.url, 400) || null, productId: raw.productId ?? null, itemId: raw.itemId ?? null, vendorItemId: raw.vendorItemId ?? null,
      title, price: Number(raw.price) > 0 ? Number(raw.price) : null, priceText: str(raw.priceText, 40) || null,
      images: Array.isArray(raw.images) ? raw.images.filter((u) => typeof u === 'string').slice(0, 8) : [],
      imageIds: Array.isArray(raw.imageIds) ? raw.imageIds.filter((u) => typeof u === 'string').slice(0, 8) : [],
      description: str(raw.description, 3000), breadcrumb: Array.isArray(raw.breadcrumb) ? raw.breadcrumb.map((x) => str(x, 40)).filter(Boolean).slice(0, 8) : [],
      capturedAt: raw.capturedAt ?? null,
    };
  }
  return { input, options, hasPartnersLink: p.hasPartnersLink === true };
}

export const hasImagesOf = (input) => !!(input && ((input.imageIds || []).length || (input.images || []).length));

/** 프롬프트에 넣는 입력 요약(길이를 줄여 속도 확보) */
export function compactInput(input, descMax = 700) {
  if (input.source === 'topic') return { source: 'topic', topic: input.topic };
  if (input.source === 'shorts') return { source: 'shorts', script: input.script.slice(0, 1800) };
  return { source: input.source, title: input.title, price: input.priceText || (input.price ? `${input.price.toLocaleString('ko-KR')}원` : null), breadcrumb: input.breadcrumb, description: (input.description || '').slice(0, descMax) };
}

// ───────────────────────── 로컬 facts (AI 없이 즉시) ─────────────────────────

const VOLATILE_LINE = /로켓|배송|무료|쿠폰|할인|최저가|적립|카드|결제|반품|교환|고객센터|판매자|사업자|통신판매|전화|문의|이벤트|혜택|포인트|캐시백|지금\s*구매/;

const splitSentences = (text) => String(text || '')
  .split(/\n+|(?<=[.!?。])\s+|[•·■▶▷◆●]/)
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter((s) => s.length >= 6 && s.length <= 140 && /[가-힣\d]/.test(s) && !VOLATILE_LINE.test(s));

/** 입력에서 바로 만들 수 있는 사실. p=상품 페이지, u=사용자 입력(쇼츠 대본). 주제만 있으면 없음. */
export function buildLocalFacts(input) {
  const facts = [];
  const unknown = [];
  if (input.source === 'topic') return { facts, unknown: ['주제만 입력돼 확인된 사실이 없습니다(수치 금지)'] };
  if (input.source === 'shorts') {
    splitSentences(input.script).slice(0, 14).forEach((s, i) => facts.push({ id: `u${i + 1}`, claim: s, source: 'user_input', quote: s, confidence: 'high', kind: 'script' }));
    return { facts, unknown };
  }
  let n = 1;
  // 출처 값: 쿠팡 페이지에서 읽은 것만 'coupang_page', 사용자가 직접 입력한 것('manual')은 'user_input' (v1 §21-A ③)
  const SRC = input.source === 'coupang_page' ? 'coupang_page' : 'user_input';
  const manual = SRC === 'user_input';
  facts.push({ id: `p${n++}`, claim: `상품명: ${input.title}`, source: SRC, quote: input.title, confidence: 'high', kind: 'name' });
  if (input.price || input.priceText) {
    const t = input.priceText || `${input.price.toLocaleString('ko-KR')}원`;
    facts.push({ id: `p${n++}`, claim: manual ? `입력한 가격 ${t} (변동될 수 있음)` : `표시 가격 ${t} (페이지 기준, 변동될 수 있음)`, source: SRC, quote: t, confidence: 'high', kind: 'price' });
  } else unknown.push('가격을 읽지 못했습니다(가격은 링크에서 확인으로 대신)');
  if (input.breadcrumb?.length) facts.push({ id: `p${n++}`, claim: `카테고리 경로: ${input.breadcrumb.join(' > ')}`, source: SRC, quote: input.breadcrumb.join(' > '), confidence: 'high', kind: 'category' });
  const seen = new Set();
  for (const s of splitSentences(input.description)) {
    const k = s.replace(/\s/g, '');
    if (seen.has(k)) continue;
    seen.add(k);
    facts.push({ id: `p${n++}`, claim: s, source: SRC, quote: s, confidence: 'medium', kind: 'desc' });
    if (seen.size >= 12) break;
  }
  if (seen.size === 0) unknown.push('상품 설명 본문을 읽지 못했습니다(기능·구성 주장 금지)');
  return { facts, unknown };
}

/** 프롬프트용 facts (low 제외, 짧게) */
export const factsForPrompt = (facts) => (facts || []).filter((f) => f.confidence !== 'low' || f.source === 'user_input')
  .map((f) => ({ id: f.id, claim: f.claim, source: f.source === 'coupang_page' || f.source === 'user_input' ? f.source : String(f.sourceTitle || f.source).slice(0, 40), ...(f.kind === 'praise' || f.kind === 'cons' ? { kind: f.kind } : {}) }));

// ───────────────────────── 기획 보정 · 레이아웃 ─────────────────────────

/** role 이름 → 레이아웃 (규칙은 knowledge 에서 읽은 layoutRules). 사진이 없으면 사진 레이아웃을 낮춘다. */
export function assignLayout(role, index, count, slot, rules, hasImages) {
  let layout;
  if (index === 0) layout = slot === 'hero' && hasImages ? 'photo-full' : 'title';
  else if (index === count - 1) layout = 'cta';
  else {
    const hit = rules.find(([re]) => re.test(role));
    layout = hit && LAYOUTS.includes(hit[1]) ? hit[1] : 'quote';
  }
  if (!hasImages && (layout === 'photo-full' || layout === 'split')) layout = 'title';
  const imageSlot = layout === 'photo-full' ? 'hero' : layout === 'split' ? 'side' : 'none';
  return { layout, imageSlot };
}

/** 플래너가 실패했을 때의 최소 훅: 상품명(짧게)으로 만든 실제 문장. 숫자·템플릿 지시문(○, →)은 쓰지 않는다. */
export function fallbackHooks(input) {
  const t = shortTitle(input).slice(0, 8).trim();
  return [
    { type: '숫자형', headline: `${t} 사기 전에`.slice(0, 16), body: '먼저 확인하면\n후회가 줄어요' },
    { type: '질문형', headline: `${t}, 아직 고민 중?`.slice(0, 16), body: '고르는 기준부터\n정리해 봤어요' },
    { type: '반전형', headline: '비싼 게 답은 아니에요', body: '써 본 사람들이\n먼저 챙긴 것' },
  ];
}

/** 지식 표의 "쓰는 것" 설명(○·→·같은 구조 같은 지시문)은 화면에 보일 수 있는 brief 로 쓰지 않는다. */
export function plainBrief(what, role) {
  const w = String(what || '').trim();
  return !w || /[○→*]|같은 구조|\|/.test(w) ? `${role} 내용을 상품 정보로 쓰기` : w.slice(0, 60);
}

/** 플래너 원본 출력(또는 {})을 검증·보정해 plan 으로. 실패해도 항상 쓸 수 있는 plan 을 돌려준다. */
export function normalizePlan(raw, { input, options, typeDoc, catDefaults, layoutRules, hasImages, categoryHint }) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const category = canonCategory(r.category || categoryHint || '기타').name;
  const cd = catDefaults[category] || catDefaults['기타'];
  const wanted = options.type || r.type;
  const typeKey = typeDoc.types[wanted] ? wanted : (cd.types.find((t) => typeDoc.types[t]) || typeDoc.order[0]);
  const info = typeDoc.types[typeKey];
  const count = options.count || clampInt(r.count, 5, 8, info.count);
  const purpose = options.purpose ? normPurpose(options.purpose) : (PURPOSES.includes(r.purpose) ? r.purpose : normPurpose(info.purpose));
  const roles = fitRoles(info.roles, count);
  const given = Array.isArray(r.briefs) ? r.briefs : [];
  const briefs = roles.map((def, i) => {
    const g = given.length === count ? given[i] : given.find((x) => x && str(x.role, 30) === def.role);
    const role = (given.length === count && str(g?.role, 30)) || def.role;
    const { layout, imageSlot } = assignLayout(role, i, count, def.slot, layoutRules, hasImages);
    return { index: i, role, brief: str(g?.brief, 80) || plainBrief(def.what, role), layout, imageSlot };
  });
  let hooks = (Array.isArray(r.hooks) ? r.hooks : []).filter((h) => h && str(h.headline, 40)).slice(0, 3)
    .map((h, i) => ({ type: str(h.type, 6) || ['숫자형', '질문형', '반전형'][i], headline: cleanText(h.headline, 40), body: cleanText(h.body, 80) }));
  if (!hooks.length) hooks = fallbackHooks(input);
  const hookPick = clampInt(options.hookIndex ?? r.hookPick, 0, hooks.length - 1, 0);
  const template = TEMPLATES.includes(options.template) ? options.template : (TEMPLATES.includes(cd.template) ? cd.template : 'basic');
  return {
    category, type: typeKey, typeName: info.name, purpose, target: str(r.target, 40) || cd.target, count, template,
    hooks, hookPick, briefs, categoryHint: categoryHint || null,
  };
}

// ───────────────────────── 스타일리스트 (AI 없음) ─────────────────────────

/** 사진 배정: 사진 레이아웃 카드에 imageIds 를 돌려 가며 붙인다. 표시용 필드만 만지고 글은 건드리지 않는다. */
export function styleCards(cards, { input }) {
  const ids = input.imageIds || [];
  let k = 0;
  let nth = 0;
  return cards.map((c) => {
    const out = { ...c };
    if (ids.length && c.imageSlot !== 'none') { out.imageId = ids[k % ids.length]; k++; }
    else delete out.imageId;
    if (out.layout === 'number') {
      nth++;
      if (!out.numberLabel) { // role 의 ①~⑨ · N위 · 숫자, 없으면 number 카드끼리의 순번
        const circ = (c.role || '').match(/[①-⑨]/);
        const num = (c.role || '').match(/(\d+)\s*위|(\d+)/);
        out.numberLabel = circ ? String('①②③④⑤⑥⑦⑧⑨'.indexOf(circ[0]) + 1) : num ? String(num[1] || num[2]) : String(nth);
      }
    }
    return out;
  });
}

// ───────────────────────── 해시태그 ─────────────────────────

const normTag = (t) => { const s = String(t || '').trim().replace(/\s+/g, '').replace(/^#*/, ''); return s ? `#${s}` : ''; };

/** AI 태그 + 고정 태그 합치기: 중복 제거(대소문자 무시), 고정 태그 우선 보존, 30개 상한. */
export function assembleHashtags(aiTags, fixedTags, poolTags = []) {
  const fixed = [];
  const seen = new Set();
  const take = (t, into) => { const x = normTag(t); const k = x.toLowerCase(); if (x && x.length > 1 && !seen.has(k)) { seen.add(k); into.push(x); } };
  for (const t of fixedTags || []) take(t, fixed);
  const ai = [];
  for (const t of aiTags || []) take(t, ai);
  if (ai.length < 12) for (const t of poolTags) { if (ai.length >= 18) break; take(t, ai); }
  const room = Math.max(0, 30 - fixed.length);
  return [...ai.slice(0, room), ...fixed].slice(0, 30);
}

// ───────────────────────── Project 조립 ─────────────────────────

/** 실행 상태 S → Project (JSON 가능). */
export function buildProject(S) {
  const plan = S.plan;
  const carousel = {
    type: plan.type, template: plan.template, brandColor: S.brandColor || DEFAULT_BRAND, ...(S.accentColor ? { accentColor: S.accentColor } : {}),
    accountName: S.settings?.accountName || '', ...(S.settings?.logoImageId ? { logoImageId: S.settings.logoImageId } : {}),
    peek: !!S.peek, panorama: !!S.panorama, hasPartnersLink: !!S.hasPartnersLink, cards: S.cards,
  };
  const title = S.prev?.title || `${shortTitle(S.input)} · ${plan.typeName}`;
  return {
    ...(S.prev?.id ? { id: S.prev.id } : {}), title,
    input: S.input, options: S.options,
    plan, carousel, facts: S.facts, factsInfo: S.factsInfo, caption: S.caption || '', hashtags: S.hashtags || [],
    issues: S.issues || [], score: S.score || null, shorts: S.shorts || null,
    notices: [...new Set(S.notices || [])], knowledgeVersion: S.kn?.version?.() || null,
    meta: S.meta || {}, ...(S.mock ? { mock: true } : {}),
    ...(S.prev?.link ? { link: S.prev.link } : {}), // 패널이 붙인 파트너스 링크 등은 재생성해도 그대로
  };
}

/** 카드 → 줄 단위 요약 문자열(프롬프트용) */
export const cardBrief = (c) => `${c.index + 1}. [${c.role}] ${c.headline.replace(/\n/g, ' ')} / ${(c.body || '').replace(/\n/g, ' ⏎ ')}`;

// ───────────────────────── AI 없이 만드는 대체물 (AI 실패·mock 공용) ─────────────────────────

/** 캡션 대체: 훅 → 카드 요지 → CTA. 쿠팡 고지·가격 문구는 넣지 않는다(내보낼 때 composeCaption 이 붙인다). */
export function fallbackCaption({ plan, cards, ctaBank }) {
  const hook = plan.hooks[plan.hookPick] || plan.hooks[0];
  const first = `${(hook?.body || '').replace(/\n/g, ' ')} ${hook?.headline || ''}`.trim().slice(0, 120);
  const mids = cards.slice(1, -1).slice(0, 5).map((c) => c.headline.replace(/\n/g, ' '));
  const cta = (ctaBank?.[plan.purpose] || []).find((x) => !x.includes('○')) || '저장해 두고 비교하세요';
  return [first || cards[0]?.headline || '', '', ...mids, '', cta].join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 쇼츠 대본 대체(v2 §9-D): 0~3초 훅 / 3~20초 본문(가운데 카드 요지) / CTA / 자막 줄 15개. */
export function shortsFromCards(cards, plan) {
  const hook = plan.hooks[plan.hookPick] || plan.hooks[0] || { headline: cards[0]?.headline || '', body: '' };
  const mids = cards.slice(1, -1);
  const pick = mids.length > 3 ? mids.slice(Math.floor((mids.length - 3) / 2), Math.floor((mids.length - 3) / 2) + 3) : mids;
  const last = cards[cards.length - 1];
  const lines = [];
  for (const c of cards) {
    for (const l of [c.headline.replace(/\n/g, ' '), ...(c.layout === 'table' ? [] : (c.body || '').split('\n'))]) {
      const t = l.trim();
      if (t && t.length <= 18 && !lines.includes(t)) lines.push(t);
    }
  }
  return {
    hook: `${hook.headline.replace(/\n/g, ' ')} ${(hook.body || '').replace(/\n/g, ' ')}`.trim(),
    body: pick.map((c) => `${c.headline.replace(/\n/g, ' ')} ${(c.body || '').split('\n')[0] || ''}`.trim()).join(' / '),
    cta: '링크는 프로필에서 확인하세요' + (last?.cta ? `(${last.cta})` : ''),
    subtitles: lines.slice(0, 15),
  };
}

// ───────────────────────── 다시 만들 때 사용자가 고른 것 유지 (ai.regenerate part:'all') ─────────────────────────

/** 같은 index 이면서 새 카드도 사진 칸(imageSlot≠none)이면 사용자가 고른 사진(imageId)을 유지. 안 맞으면 버리고 안내 문구를 돌려준다. */
export function carryOverImages(cards, prevCards) {
  const dropped = [];
  const out = cards.map((c) => {
    const old = prevCards?.[c.index];
    if (!old?.imageId) return c;
    if (c.imageSlot !== 'none') return { ...c, imageId: old.imageId, ...(old.imageIsGenerated ? { imageIsGenerated: true } : {}) };
    dropped.push(c.index + 1);
    return c;
  });
  return { cards: out, notice: dropped.length ? `구성이 바뀌어 ${dropped.join('·')}번 카드에 고른 사진은 빠졌어요. 필요하면 다시 골라 주세요` : null };
}

// ───────────────────────── 스트리밍 JSON 증분 스캐너 ─────────────────────────

/**
 * 모델이 {"plan":{…},"cards":[{…},{…}]} 를 흘려 보낼 때, 닫힌 값이 생기는 즉시 알려 준다.
 * onValue(kind, value): kind='plan'(최상위 키 plan 의 객체가 닫힘) · 'cards'(cards 배열의 원소 객체가 하나 닫힘, 순서대로).
 * 깨진 조각은 건너뛴다(마지막에 전체를 다시 파싱해 빠진 것을 채운다).
 */
export function createStreamScanner(onValue) {
  let text = '', i = 0, depth = 0, inStr = false, esc = false, strStart = -1, expectKey = false;
  let curKey = '', valKey = '', valStart = -1, elemStart = -1;
  const fire = (kind, a, b) => { try { onValue(kind, JSON.parse(text.slice(a, b + 1))); } catch { /* 건너뜀 */ } };
  return {
    feed(chunk) {
      text += chunk;
      for (; i < text.length; i++) {
        const c = text[i];
        if (inStr) {
          if (esc) esc = false;
          else if (c === '\\') esc = true;
          else if (c === '"') {
            inStr = false;
            if (depth === 1 && expectKey) { try { curKey = JSON.parse(text.slice(strStart, i + 1)); } catch { curKey = ''; } expectKey = false; }
          }
          continue;
        }
        if (c === '"') { inStr = true; strStart = i; continue; }
        if (c === '{' || c === '[') {
          depth++;
          if (depth === 1) expectKey = true;
          else if (depth === 2) { valStart = i; valKey = curKey; }
          else if (depth === 3 && valKey === 'cards') elemStart = i;
          continue;
        }
        if (c === '}' || c === ']') {
          if (depth === 3 && valKey === 'cards' && elemStart >= 0) { fire('cards', elemStart, i); elemStart = -1; }
          else if (depth === 2 && valKey === 'plan') fire('plan', valStart, i);
          depth--;
          continue;
        }
        if (c === ',' && depth === 1) expectKey = true;
      }
    },
  };
}
