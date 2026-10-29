// 이미지 생성 (서비스워커 전용) — v3 §12·§12-E.
//  · 글도 이미지도 설정에서 고른 AI 하나(Gemini 또는 GPT, 수강생 본인 키). ai.js generate 가 고른 쪽으로 넘긴다. 그 밖의 이미지 API 금지.
//  · 모델은 목록에서 이미지 생성 지원 모델을 자동 선택(ai.js selectModel('image'): image 포함, preview/exp 는 안정판이 없을 때만).
//  · 참고 이미지는 inline_data 로 보낸다(제품 사진 → 배경·조명 변경). 제품 형태 변경 금지.
//  · 이미지 안에 글자 금지: 프롬프트에 "no text, no letters, no watermark" 고정. 모든 글자는 캔버스가 얹는다.
//  · 생성은 사용자가 누를 때만(자동 생성 없음). 결과 Blob 은 IndexedDB images 에 넣고 imageId 만 돌려준다(imageIsGenerated:true).
//  · 한도(429·무료 키 이미지 불가)·잔액 없음(BILLING)·GPT 조직 인증 필요(403)면 오류 대신 {fallback:'template'} 으로 돌려 템플릿 배경으로 대체하게 하고 안내 한 줄을 준다.
//  · 옵션 거부 자동 복구(400)·오류 번역은 ai.js 의 generate 가 똑같이 적용한다.
//
// 요청: image.generate {projectId?, purpose:'background'|'product'|'cover', chips?:['더 밝게'|'따뜻하게'|'미니멀'|…], referenceImageId?,
//        category?, productTitle?, facts?:[{claim}] | string[], extraPrompt?, cardIndex?, aspect?:'4:5'}
// 응답: {imageId, mime, imageIsGenerated:true, disclosureText, model, purpose, cardIndex, prompt, note}
//        또는 {fallback:'template', imageId:null, messageKo, raw, where, code}
//
// 요청: image.transform {imageId, kind:'recreate'|'background'|'style'|'enhance'|'extend'|'custom', option?, extra?, aspect?, productTitle?, projectId?}
//        — AI 사진 바꾸기. 원본 사진을 inline_data 로 보내고 고른 것만 바꾼다(요청문은 lib/imageprompt.js). 직접 쓰기는 extra 필수.
//        결과 비율: 늘리기는 aspect(기본 4:5), 나머지는 원본에 가장 가까운 지원 비율.
// 응답: {imageId, mime, imageIsGenerated:true, model, kind, option, aspect, prompt, promptKo, note, sourceImageId}
//        또는 한도·무료 키면 {fallback:'manual', imageId:null, messageKo, promptKo, raw, where, code} — 패널이 요청문 복사·직접 올리기를 안내

import { AppError, WHERE, base64ToBlob, blobToBase64 } from './common.js';
import * as store from './store.js';
import { generate, generateJson } from './ai.js';
import { canonCategory } from './knowledge.js';
import { buildTransformPrompt, nearestAspect, ASPECTS, TRANSFORM_KEYS } from './imageprompt.js';

export const prefix = 'image.';
export const contentAllowed = [];

/** 프롬프트에 항상 붙는 고정 문구(글자 금지). 바꾸지 말 것. */
export const NO_TEXT_RULE = 'No text, no letters, no numbers, no watermark, no logo, no caption, no user interface. Do not draw any writing in any language.';

const CATEGORY_MOOD = {
  '뷰티': 'soft clean skincare mood, gentle pastel light, fresh and dewy',
  '패션': 'stylish editorial mood, neutral tones, natural daylight',
  '식품': 'appetizing warm kitchen table mood, natural light, fresh ingredients feel',
  '리빙·주방': 'tidy cozy home interior mood, warm wood and soft daylight',
  '가전·테크': 'modern sleek tech mood, cool clean lighting, minimal desk setting',
  '육아': 'soft safe nursery mood, pastel tones, gentle daylight',
  '건강·운동': 'energetic fresh healthy-routine mood, bright natural light, greens',
  '반려동물': 'friendly bright home mood with a pet-safe cozy feel',
  '기타': 'clean neutral modern mood, soft natural light',
};
const CHIP_WORDS = [
  [/밝|bright/i, 'brighter, airy, high-key lighting'], [/따뜻|warm/i, 'warm, cozy, golden light'], [/미니멀|minimal/i, 'minimal, simple, uncluttered, lots of empty space'],
  [/시원|cool/i, 'cool, crisp light'], [/차분|calm/i, 'calm, muted tones'],
];
const PURPOSE_TEXT = {
  background: 'an atmospheric background scene (no specific product) with a lot of empty space',
  product: 'a product photo of the attached product placed in a new setting',
  cover: 'a striking cover background that works behind a large headline',
};

function buildPrompt(p, category) {
  const purpose = ['background', 'product', 'cover'].includes(p.purpose) ? p.purpose : 'background';
  const hasRef = !!p.referenceImageId && purpose !== 'background';
  const chips = (Array.isArray(p.chips) ? p.chips : []).map((c) => CHIP_WORDS.find(([re]) => re.test(String(c)))?.[1]).filter(Boolean);
  const facts = (Array.isArray(p.facts) ? p.facts : []).map((f) => (typeof f === 'string' ? f : f?.claim)).filter(Boolean).slice(0, 6);
  const lines = [
    `Create ${PURPOSE_TEXT[purpose]} for an Instagram shopping carousel card. Vertical ${p.aspect || '4:5'} aspect ratio.`,
    p.productTitle ? `Product (for context only): "${String(p.productTitle).slice(0, 80)}".` : '',
    `Mood: ${CATEGORY_MOOD[category] || CATEGORY_MOOD['기타']}${chips.length ? ', ' + chips.join(', ') : ''}.`,
    hasRef
      ? 'Use the attached product photo as the reference. Keep the product shape, proportions, color and details exactly the same; only replace the background, lighting and surroundings. Do not add accessories or parts that the product does not have.'
      : 'Do not show a specific branded product; show only the atmosphere or scene.',
    facts.length ? `Only depict what is consistent with these facts, and do not invent extra features, accessories or usage scenes: ${facts.join(' / ')}.` : 'Do not invent product features, accessories or usage scenes.',
    p.extraPrompt ? `Extra direction: ${String(p.extraPrompt).slice(0, 160)}.` : '',
    NO_TEXT_RULE,
  ].filter(Boolean);
  return { prompt: lines.join('\n'), purpose, hasRef };
}

async function mockImage(p, settings) {
  const w = 540, h = 675; // 4:5
  const cv = new OffscreenCanvas(w, h);
  const g = cv.getContext('2d');
  const grad = g.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, '#fde68a'); grad.addColorStop(1, '#93c5fd');
  g.fillStyle = grad; g.fillRect(0, 0, w, h);
  g.fillStyle = 'rgba(255,255,255,0.35)';
  g.beginPath(); g.arc(w * 0.7, h * 0.3, 120, 0, Math.PI * 2); g.fill();
  const blob = await cv.convertToBlob({ type: 'image/png' });
  const imageId = await store.putImage(blob, { kind: 'generated', projectId: p.projectId || null, width: w, height: h, meta: { mock: true, purpose: p.purpose || 'background' } });
  return { imageId, mime: 'image/png', imageIsGenerated: true, disclosureText: settings.imageDisclosureText || '연출 이미지', model: '(시험용 더미)', purpose: p.purpose || 'background', cardIndex: p.cardIndex ?? null, prompt: '(시험용 더미)', note: '시험용 더미 이미지입니다', mock: true };
}

// ───────────────────────── 생성 사진 검증(가짜 확인) ─────────────────────────
// AI 가 그린 사진이 원본과 같은 제품인지(본체 색·부품·형태·로고) 가벼운 모델에게 두 사진을 함께 보여 묻는다(2026-10-29 사용자 요청:
// "빨간 몸통이 어디서 나왔나" — 원본은 검정 본체였다). 다르면 한 번 더 그리고, 그래도 다르면 check.same=false 로 돌려 패널이 안 쓰게 한다.
// 원본이 사용 장면(입술·손에 든 모습)이고 새 사진은 제품만 따로 찍은 식의 "연출 차이"는 거절 사유가 아니다 — 대조할 게 없으면 comparable:false, same:null 로 두고
// 이름으로 찾은 제품 모습(productRef)이 있으면 그것과 모순되는지로 대신 본다.
const VERIFY_SYS = [
  '[역할:사진검증]',
  '첫 번째 사진은 원본(참고), 두 번째 사진은 AI 가 새로 만든 사진입니다. 두 사진 속 "제품 자체"가 같은 제품인지만 판단합니다. JSON만 출력합니다.',
  '출력: {"same":true|false|null,"comparable":true|false,"confidence":0~1,"differences":["무엇이 어떻게 달라졌는지 한 줄"],"summary":"한 줄"}',
  '- 본체·뚜껑·부품의 색, 전체 형태와 비율, 재질·마감, 로고·인쇄의 위치가 원본과 모순되지 않으면 same:true. 촬영 각도·배경·조명·구도·크기·소품이 다른 것은 상관없다.',
  '- 원본은 사용 장면(얼굴·입술·손에 든 모습·일부만 보임)이고 새 사진은 제품만 따로 찍은 식으로 연출이 다른 것은 차이가 아니다. 원본에서 보이는 부분만 대조하고, 원본에서 안 보이는 부분(가려진 면·뚜껑 속)은 틀렸다고 하지 않는다.',
  '- 원본에 보이는 색·부품과 분명히 모순될 때만 same:false(예: 검정 본체 → 빨강, 없던 부품이 생김, 부품이 사라짐). differences 에는 "검정 본체 → 빨강"처럼 구체적으로 적는다.',
  '- 원본에서 제품이 너무 작거나 거의 안 보여 대조할 것이 없으면 comparable:false, same:null. 단 제품 설명이 함께 오면 설명과 모순되는지로 판단한다(그때는 comparable:true).',
  '- 제품 설명이 함께 오면 새 사진이 그 설명(색·부품·로고)과 모순되는지도 본다. 모순되면 same:false.',
  '- 확실하지 않으면 confidence 를 낮춘다. 보이지 않는 것을 지어내지 않는다.',
].join('\n');
async function verifyGenerated(src, outBlob, { look, ref } = {}, signal) {
  const out = await shrinkForAI(outBlob, 768, 0.8);
  const desc = [];
  if (look) desc.push(`원본 사진에서 본 제품 모습: ${String(look).slice(0, 200)}`);
  if (ref?.look) desc.push(`이름으로 찾은 제품 모습: ${String(ref.look).slice(0, 240)}${ref.mustKeep?.length ? ` (꼭 지킬 것: ${ref.mustKeep.slice(0, 5).join(', ')})` : ''}`);
  const parts = [{ text: '원본 상품 사진:' }, { inline_data: { mime_type: src.mime, data: src.data } }, { text: 'AI가 새로 만든 사진:' }, { inline_data: { mime_type: out.mime, data: out.data } },
    { text: `${desc.length ? `제품 설명:\n${desc.join('\n')}\n` : ''}같은 제품인가요?` }];
  const r = await generateJson({ kind: 'lite', system: VERIFY_SYS, parts, temperature: 0.1, maxOutputTokens: 300, signal });
  const j = r.json || {};
  const differences = (Array.isArray(j.differences) ? j.differences : []).map((x) => String(x || '').trim()).filter(Boolean).slice(0, 4);
  const comparable = j.comparable !== false;
  return { same: comparable && typeof j.same === 'boolean' ? j.same : null, comparable, confidence: Math.max(0, Math.min(1, Number(j.confidence) || 0)), differences, summary: String(j.summary || '').slice(0, 120) };
}
const mockCheck = async () => (((await store.kvGet('dev:ai', null)) || {}).mockBadImage ? { same: false, confidence: 0.9, differences: ['검정 본체 → 빨강(시험용)'], summary: '시험용: 원본과 다름' } : { same: true, confidence: 0.95, differences: [], summary: '시험용: 같은 제품' });

/** 시험용 더미 변환: 원본에 필터를 씌워 "바뀐 것처럼" 보이게 한다(네트워크 없음) */
async function mockTransform(blob, p, aspect, built, signal) {
  // 시험용 지연(kv 'dev:ai'.mockImageMs) — 멈추기(취소)를 시험할 때만 쓴다. 취소되면 바로 끝낸다
  const wait = Number(((await store.kvGet('dev:ai', null)) || {}).mockImageMs) || 0;
  if (wait) {
    await new Promise((res, rej) => {
      const t = setTimeout(res, wait);
      signal?.addEventListener('abort', () => { clearTimeout(t); rej(new AppError('요청이 취소되었습니다.', { raw: 'AbortError', where: WHERE.SW, code: 'CANCELLED' })); }, { once: true });
    });
  }
  const bmp = await createImageBitmap(blob);
  const [ax, ay] = aspect.split(':').map(Number);
  const w = 540, h = Math.round((w * ay) / ax);
  const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const g = cv.getContext('2d');
  g.fillStyle = '#E0F2FE'; g.fillRect(0, 0, w, h);
  g.filter = { style: 'sepia(0.7) saturate(1.4)', enhance: 'brightness(1.2) contrast(1.05)', background: 'none' }[built.kind] || 'hue-rotate(40deg)';
  const k = Math.min(w / bmp.width, h / bmp.height) * (built.kind === 'background' ? 0.7 : 1);
  g.drawImage(bmp, (w - bmp.width * k) / 2, (h - bmp.height * k) / 2, bmp.width * k, bmp.height * k);
  bmp.close?.();
  const out = cv.convertToBlob ? await cv.convertToBlob({ type: 'image/png' }) : await new Promise((r) => cv.toBlob(r, 'image/png'));
  const imageId = await store.putImage(out, { kind: 'generated', projectId: p.projectId || null, width: w, height: h, meta: { mock: true, purpose: 'transform', kind: built.kind, option: built.option, source: p.imageId } });
  return { imageId, mime: 'image/png', imageIsGenerated: true, model: '(시험용 더미)', kind: built.kind, option: built.option, aspect, prompt: built.prompt, promptKo: built.promptKo, note: '시험용 더미 변환입니다', sourceImageId: p.imageId, check: await mockCheck(), mock: true };
}

// ───────────────────────── 사진 캐러셀: AI 에 보낼 축소 JPEG ─────────────────────────

/**
 * 사진 Blob → 긴 변 maxSide(기본 768px) JPEG(품질 0.8) base64. 서비스워커는 OffscreenCanvas, 없으면(웹 버전 페이지) 일반 canvas.
 * 원본은 건드리지 않는다(카드 렌더는 원본 imageId 를 쓴다). 투명 PNG 는 흰 바탕에 올린다.
 */
export async function shrinkForAI(blob, maxSide = 768, quality = 0.8) {
  let bmp;
  try { bmp = await createImageBitmap(blob); } catch (e) {
    throw new AppError('사진을 읽지 못했습니다. 다른 사진으로 바꿔 주세요.', { raw: e?.message || String(e), where: WHERE.SW, code: 'PHOTO_UNREADABLE' });
  }
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
  let out;
  if (typeof OffscreenCanvas !== 'undefined') {
    const cv = new OffscreenCanvas(w, h);
    const g = cv.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(bmp, 0, 0, w, h);
    out = await cv.convertToBlob({ type: 'image/jpeg', quality });
  } else {
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const g = cv.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(bmp, 0, 0, w, h);
    out = await new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('toBlob 실패'))), 'image/jpeg', quality));
  }
  bmp.close?.();
  return { mime: 'image/jpeg', data: await blobToBase64(out), width: w, height: h, bytes: out.size };
}

/** imageId 목록 → Gemini parts: [{text:'사진 1/N:'},{inline_data}, …]. 사진을 못 찾으면 PHOTO_MISSING. */
export async function photoParts(imageIds) {
  const shrunk = await Promise.all(imageIds.map(async (id) => {
    const blob = await store.getImageBlob(id);
    if (!blob) throw new AppError('올린 사진 중 하나를 찾지 못했습니다. 사진을 다시 올려 주세요.', { raw: `imageId=${id}`, where: WHERE.SW, code: 'PHOTO_MISSING' });
    return shrinkForAI(blob);
  }));
  return shrunk.flatMap((p, i) => [{ text: `사진 ${i + 1}/${imageIds.length}:` }, { inline_data: { mime_type: p.mime, data: p.data } }]);
}

/** 한도·잔액 때문에 이미지를 못 만들 때의 안내(고른 AI 에 맞춰). then: 뒤에 붙일 다음 할 일 */
const LIMIT_CODES = ['RATE_LIMIT', 'QUOTA', 'BILLING'];
// GPT 이미지 모델은 조직 인증(403 verify)이 필요할 수 있다 → 이것도 오류로 끊지 않고 대신 길(요청문 복사·템플릿)을 준다
const isLimited = (e) => e instanceof AppError && (LIMIT_CODES.includes(e.code) || (e.code === 'FORBIDDEN' && /verif/i.test(e.raw || '')));
function limitMessage(e, provider, then) {
  if (e.code === 'BILLING' || e.code === 'FORBIDDEN') return `${e.messageKo} ${then}`;
  const why = provider === 'openai' ? '이미지 생성 한도에 걸렸어요(잠시 뒤 다시 시도할 수 있어요).' : '이미지 생성 한도에 걸렸어요(무료 키는 이미지 생성이 막혀 있을 수 있어요).';
  return `${why} ${then}`;
}

export const handlers = {
  'image.generate': async (payload, ctx) => {
    const p = payload || {};
    const all = await store.getSettings();
    const { geminiKey, openaiKey, coupangAccessKey, coupangSecretKey, ...settings } = all;
    const aiKey = all[store.aiKeyName(all)];
    if (settings.devMockAI) return mockImage(p, settings);
    if (!aiKey) throw new AppError(all.aiProvider === 'openai' ? 'GPT 키가 없습니다. 설정에서 키를 입력해 주세요.' : 'Gemini 키가 없습니다. 옵션 화면에서 키를 입력해 주세요.', { raw: `${store.aiKeyName(all)} 없음`, where: WHERE.SW, code: 'NO_KEY' });

    const category = canonCategory(p.category || '기타').name;
    const { prompt, purpose, hasRef } = buildPrompt(p, category);
    const parts = [{ text: prompt }];
    if (hasRef) {
      const blob = await store.getImageBlob(p.referenceImageId);
      if (!blob) throw new AppError('참고할 상품 사진을 찾지 못했습니다. 사진을 다시 선택해 주세요.', { raw: `referenceImageId=${p.referenceImageId}`, where: WHERE.SW, code: 'NOT_FOUND' });
      parts.push({ inline_data: { mime_type: blob.type || 'image/png', data: await blobToBase64(blob) } });
    }
    let res;
    try {
      res = await generate({
        kind: 'image', parts, responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: p.aspect || '4:5' },
        temperature: 1, thinking: false, rate: false, timeoutMs: 60000, signal: ctx?.signal,
      });
    } catch (e) {
      // 한도·무료 키로 쓸 수 없는 이미지 모델: 오류로 끊지 않고 템플릿 배경으로 대체하도록 알린다
      if (isLimited(e)) {
        return {
          fallback: 'template', imageId: null, purpose, cardIndex: p.cardIndex ?? null,
          messageKo: limitMessage(e, all.aiProvider, '템플릿 배경으로 대신 채웠어요.'),
          raw: e.raw, where: WHERE.SW, code: e.code,
        };
      }
      throw e;
    }
    const img = res.images[0];
    if (!img?.data) {
      throw new AppError('이미지가 만들어지지 않았어요. 문구를 바꿔 다시 눌러 주세요.', { raw: `model=${res.model} finishReason=${res.finishReason} text=${(res.text || '').slice(0, 200)}`, where: WHERE.SW, code: 'IMAGE_NO_OUTPUT' });
    }
    const blob = base64ToBlob(img.data, img.mime || 'image/png');
    const imageId = await store.putImage(blob, { kind: 'generated', projectId: p.projectId || null, meta: { model: res.model, purpose, cardIndex: p.cardIndex ?? null, category } });
    return {
      imageId, mime: blob.type, imageIsGenerated: true, disclosureText: settings.imageDisclosureText || '연출 이미지',
      model: res.model, purpose, cardIndex: p.cardIndex ?? null, prompt, note: (res.text || '').slice(0, 200), dropped: res.dropped,
    };
  },
};

handlers['image.transform'] = async (payload, ctx) => {
  const p = payload || {};
  if (!TRANSFORM_KEYS.includes(p.kind)) throw new AppError('바꾸는 방법을 골라 주세요.', { raw: `kind=${p.kind}`, where: WHERE.SW, code: 'BAD_INPUT' });
  if (p.kind === 'custom' && !String(p.extra || '').trim()) throw new AppError('어떻게 바꿀지 한 줄로 적어 주세요.', { raw: 'custom: extra 없음', where: WHERE.SW, code: 'BAD_INPUT' });
  const blob = await store.getImageBlob(p.imageId);
  if (!blob) throw new AppError('바꿀 사진을 찾지 못했어요. 사진을 다시 올려 주세요.', { raw: `imageId=${p.imageId}`, where: WHERE.SW, code: 'NOT_FOUND' });
  let aspect = ASPECTS.includes(p.aspect) ? p.aspect : '4:5';
  if (p.kind !== 'extend') {
    try { const b = await createImageBitmap(blob); aspect = nearestAspect(b.width, b.height); b.close?.(); } catch { /* 못 읽으면 기본 비율 */ }
  }
  const ref = p.productRef && typeof p.productRef === 'object' && p.productRef.look ? { look: String(p.productRef.look).slice(0, 240), mustKeep: (Array.isArray(p.productRef.mustKeep) ? p.productRef.mustKeep : []).map(String).slice(0, 5), avoid: (Array.isArray(p.productRef.avoid) ? p.productRef.avoid : []).map(String).slice(0, 3) } : null;
  let built = buildTransformPrompt({ kind: p.kind, option: p.option, extra: p.extra, aspect, productTitle: p.productTitle, productLook: p.productLook, productRef: ref });
  const all = await store.getSettings();
  const { geminiKey, openaiKey, coupangAccessKey, coupangSecretKey, ...settings } = all;
  const aiKey = all[store.aiKeyName(all)];
  if (settings.devMockAI) return mockTransform(blob, p, aspect, built, ctx?.signal);
  if (!aiKey) throw new AppError(all.aiProvider === 'openai' ? 'GPT 키가 없습니다. 설정에서 키를 입력해 주세요.' : 'Gemini 키가 없습니다. 옵션 화면에서 키를 입력해 주세요.', { raw: `${store.aiKeyName(all)} 없음`, where: WHERE.SW, code: 'NO_KEY' });
  // 큰 사진은 긴 변 1536px JPEG 로 줄여 보낸다(요청 크기·시간 줄이기). 원본은 그대로 남는다.
  const src = await shrinkForAI(blob, 1536, 0.9);
  const draw = async (prompt) => {
    const res = await generate({
      kind: 'image', parts: [{ text: prompt }, { inline_data: { mime_type: src.mime, data: src.data } }],
      responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: aspect }, padToAspect: p.kind === 'extend',
      temperature: 1, thinking: false, rate: false, timeoutMs: 90000, signal: ctx?.signal,
    });
    const img = res.images[0];
    if (!img?.data) throw new AppError('사진이 만들어지지 않았어요. 다른 방법을 고르거나 요청을 바꿔 다시 눌러 주세요.', { raw: `model=${res.model} finishReason=${res.finishReason} text=${(res.text || '').slice(0, 200)}`, where: WHERE.SW, code: 'IMAGE_NO_OUTPUT' });
    return { res, out: base64ToBlob(img.data, img.mime || 'image/png') };
  };
  // 검증: 같은 제품인지(본체 색·부품·형태). 확실히 다르면 달라진 점을 적어 한 번 더 그린다. 검증 자체가 실패하면(한도 등) 사진은 돌려주되 check 는 모름(null)
  const verify = async (out) => {
    if (p.verify === false || built.kind === 'custom') return null;
    try { return await verifyGenerated(src, out, { look: p.productLook, ref }, ctx?.signal); } catch (e) { if (e?.code === 'CANCELLED') throw e; return { same: null, confidence: 0, differences: [], summary: '', error: e?.messageKo || '검증 못 함' }; }
  };
  let drawn, check;
  try {
    drawn = await draw(built.prompt);
    check = await verify(drawn.out);
    if (check && check.same === false && check.confidence >= 0.6) {
      const retryPrompt = buildTransformPrompt({ kind: p.kind, option: p.option, extra: p.extra, aspect, productTitle: p.productTitle, productLook: p.productLook, productRef: ref, fixNotes: check.differences.length ? check.differences : [check.summary] });
      built = retryPrompt;
      const again = await draw(retryPrompt.prompt);
      const check2 = await verify(again.out);
      if (!check2 || check2.same !== false) { drawn = again; check = check2 ? { ...check2, retried: true } : { same: null, confidence: 0, differences: [], summary: '', retried: true }; }
      else check = { ...check2, retried: true };
    }
  } catch (e) {
    if (isLimited(e)) {
      return {
        fallback: 'manual', imageId: null, kind: built.kind, option: built.option, aspect, promptKo: built.promptKo,
        messageKo: limitMessage(e, all.aiProvider, '아래 요청문을 복사해 Gemini 앱이나 ChatGPT에서 만든 뒤 "만든 사진 올리기"로 넣을 수 있어요.'),
        raw: e.raw, where: WHERE.SW, code: e.code,
      };
    }
    throw e;
  }
  const { res, out } = drawn;
  const imageId = await store.putImage(out, { kind: 'generated', projectId: p.projectId || null, meta: { model: res.model, purpose: 'transform', kind: built.kind, option: built.option, source: p.imageId, ...(check ? { check } : {}) } });
  return {
    imageId, mime: out.type, imageIsGenerated: true, model: res.model, kind: built.kind, option: built.option, aspect,
    prompt: built.prompt, promptKo: built.promptKo, note: (res.text || '').slice(0, 200), sourceImageId: p.imageId, dropped: res.dropped, check,
  };
};

// 같은 변환을 포트로도 받는다: 패널이 멈추기(cancel)·닫기를 하면 ctx.signal 로 GPT/Gemini 요청까지 끊긴다(사진 전부 새로 그리기용)
export const portHandlers = { 'image.transformStream': (payload, ctx) => handlers['image.transform'](payload, ctx) };
