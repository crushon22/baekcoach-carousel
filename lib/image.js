// 이미지 생성 (Gemini만, 서비스워커 전용) — v3 §12.
//  · 글도 이미지도 Gemini 하나(수강생 본인 키). 다른 이미지 API 금지.
//  · 모델은 목록에서 이미지 생성 지원 모델을 자동 선택(ai.js selectModel('image'): image 포함, preview/exp 는 안정판이 없을 때만).
//  · 참고 이미지는 inline_data 로 보낸다(제품 사진 → 배경·조명 변경). 제품 형태 변경 금지.
//  · 이미지 안에 글자 금지: 프롬프트에 "no text, no letters, no watermark" 고정. 모든 글자는 캔버스가 얹는다.
//  · 생성은 사용자가 누를 때만(자동 생성 없음). 결과 Blob 은 IndexedDB images 에 넣고 imageId 만 돌려준다(imageIsGenerated:true).
//  · 한도(429·무료 키 이미지 불가)면 오류 대신 {fallback:'template'} 으로 돌려 템플릿 배경으로 대체하게 하고 안내 한 줄을 준다.
//  · 옵션 거부 자동 복구(400)·오류 번역은 ai.js 의 generate 가 똑같이 적용한다.
//
// 요청: image.generate {projectId?, purpose:'background'|'product'|'cover', chips?:['더 밝게'|'따뜻하게'|'미니멀'|…], referenceImageId?,
//        category?, productTitle?, facts?:[{claim}] | string[], extraPrompt?, cardIndex?, aspect?:'4:5'}
// 응답: {imageId, mime, imageIsGenerated:true, disclosureText, model, purpose, cardIndex, prompt, note}
//        또는 {fallback:'template', imageId:null, messageKo, raw, where, code}

import { AppError, WHERE, base64ToBlob, blobToBase64 } from './common.js';
import * as store from './store.js';
import { generate } from './ai.js';
import { canonCategory } from './knowledge.js';

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

export const handlers = {
  'image.generate': async (payload, ctx) => {
    const p = payload || {};
    const { geminiKey, coupangAccessKey, coupangSecretKey, ...settings } = await store.getSettings();
    if (settings.devMockAI) return mockImage(p, settings);
    if (!geminiKey) throw new AppError('Gemini 키가 없습니다. 옵션 화면에서 키를 입력해 주세요.', { raw: 'geminiKey 없음', where: WHERE.SW, code: 'NO_KEY' });

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
      if (e instanceof AppError && ['RATE_LIMIT', 'QUOTA'].includes(e.code)) {
        return {
          fallback: 'template', imageId: null, purpose, cardIndex: p.cardIndex ?? null,
          messageKo: '이미지 생성 한도에 걸렸어요(무료 키는 이미지 생성이 제한될 수 있어요). 템플릿 배경으로 대신 채웠어요. 잠시 뒤 다시 시도할 수 있어요.',
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

export const portHandlers = {};
