// AI 사진 바꾸기(이미지 변환) 요청문 — 서비스워커(image.transform)와 패널(다른 AI 에 붙여 넣을 요청문 복사)이 같이 쓴다.
//  · 상품 사진의 모양·비율·색·제품에 인쇄된 글씨는 그대로 두고, 고른 것만 바꾼다(배경·그림체·보정·비율 늘리기·직접 쓰기).
//  · 사진 위에 새 글자·로고·워터마크를 넣지 않는다. 카드 글은 캔버스가 얹는다.
//  · 영어 요청문은 Gemini 로 보내고, 한국어 요청문은 사용자가 Gemini 앱·ChatGPT 에 직접 붙여 넣을 때 쓴다.

export const TRANSFORMS = [
  // 새로 그리기(중복 피하기, 2026-10-28 사용자 요청): 판매처 사진을 그대로 올리지 않고, 같은 상품을 다른 각도·구도·배경·조명의 새 사진으로.
  { key: 'recreate', label: '새로 그리기', options: [
    { key: 'studio', label: '깔끔한 연출', en: 'a clean, bright studio product shot on a seamless background with soft shadows', ko: '깔끔하고 밝은 스튜디오 연출' },
    { key: 'lifestyle', label: '생활 속 연출', en: 'a natural lifestyle scene in a fitting real-life setting, with no recognizable people', ko: '어울리는 생활 공간 속 자연스러운 연출(사람 얼굴 없이)' },
    { key: 'angle', label: '다른 각도', en: 'a noticeably different camera angle (for example a three-quarter view or a low angle) with fresh lighting', ko: '눈에 띄게 다른 촬영 각도(비스듬히·아래에서 등)와 새 조명' },
    { key: 'flatlay', label: '위에서 본 구도', en: 'a top-down flat-lay composition with a few simple, relevant props', ko: '위에서 내려다본 구도에 어울리는 소품 몇 개' },
  ] },
  { key: 'background', label: '배경 바꾸기', options: [
    { key: 'white', label: '깔끔한 흰 배경', en: 'a clean seamless white studio background with a soft natural shadow under the product', ko: '깔끔한 흰색 스튜디오 배경(제품 아래 자연스러운 그림자)' },
    { key: 'home', label: '집 안', en: 'a bright cozy living room interior, softly blurred, warm daylight from a window', ko: '햇살이 드는 아늑한 거실(배경은 살짝 흐리게)' },
    { key: 'kitchen', label: '주방·식탁', en: 'a tidy kitchen counter or dining table, natural morning light, softly blurred background', ko: '정돈된 주방 조리대나 식탁, 아침 햇살' },
    { key: 'outdoor', label: '야외·자연', en: 'an outdoor nature setting with soft green bokeh and gentle sunlight', ko: '초록 잎이 흐릿하게 보이는 야외, 부드러운 햇빛' },
    { key: 'desk', label: '책상·카페', en: 'a minimal wooden desk or cafe table with soft afternoon light', ko: '나무 책상이나 카페 테이블, 오후 햇살' },
    { key: 'pastel', label: '파스텔 단색', en: 'a smooth pastel colored backdrop with soft studio lighting', ko: '부드러운 파스텔 단색 배경과 스튜디오 조명' },
  ] },
  { key: 'style', label: '그림체로', options: [
    { key: 'illust', label: '따뜻한 일러스트', en: 'a warm hand-drawn editorial illustration', ko: '따뜻한 손그림 일러스트' },
    { key: 'watercolor', label: '수채화', en: 'a soft watercolor painting', ko: '부드러운 수채화' },
    { key: '3d', label: '미니멀 3D', en: 'a clean minimal 3D render with soft shadows', ko: '깔끔한 미니멀 3D 렌더' },
    { key: 'film', label: '필름 사진', en: 'a film photograph with gentle grain and warm faded tones', ko: '잔잔한 입자감의 필름 사진' },
  ] },
  { key: 'enhance', label: '보정', options: [
    { key: 'bright', label: '밝고 선명하게', en: 'brighter, cleaner and sharper, with balanced white balance and gentle contrast', ko: '더 밝고 선명하게, 색 균형을 맞추고 대비는 은은하게' },
    { key: 'warm', label: '따뜻한 색감', en: 'with a warm, cozy color grade and soft golden light', ko: '따뜻하고 아늑한 색감, 부드러운 금빛 조명' },
    { key: 'cool', label: '시원한 색감', en: 'with a cool, crisp and fresh color grade', ko: '시원하고 산뜻한 색감' },
  ] },
  { key: 'extend', label: '비율 늘리기', options: [] },
  { key: 'custom', label: '직접 쓰기', options: [] },
];
export const TRANSFORM_KEYS = TRANSFORMS.map((t) => t.key);
export const transformOf = (key) => TRANSFORMS.find((t) => t.key === key) || TRANSFORMS[0];
export const optionOf = (kind, opt) => { const t = transformOf(kind); return t.options.find((o) => o.key === opt) || t.options[0] || null; };

/** Gemini imageConfig 가 받는 비율 */
export const ASPECTS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9'];
/** 가로·세로 → 가장 가까운 지원 비율 */
export function nearestAspect(w, h) {
  if (!(w > 0 && h > 0)) return '4:5';
  const r = Math.log(w / h);
  let best = '4:5', d = Infinity;
  for (const a of ASPECTS) { const [x, y] = a.split(':').map(Number); const e = Math.abs(Math.log(x / y) - r); if (e < d) { d = e; best = a; } }
  return best;
}

const KEEP_EN = 'Keep the product (the main subject) exactly the same: same shape, proportions, size, color, material and the printing or labels on it. Do not add accessories or parts it does not have.';
const KEEP_KO = '상품(주인공)의 모양·비율·크기·색·재질, 제품에 원래 인쇄된 글씨는 그대로 두세요. 없는 부품이나 소품을 더하지 마세요.';
/** 바꾼 사진에 새 글자를 넣지 않는다(제품에 원래 있는 인쇄는 유지) */
export const NO_NEW_TEXT = 'Do not add any new text, letters, numbers, captions, logos, stickers or watermarks to the image.';
const NO_NEW_TEXT_KO = '사진에 새 글자·숫자·로고·스티커·워터마크는 넣지 마세요.';

/**
 * 변환 요청문. kind: background|style|enhance|extend|custom, option: 위 options 의 key, extra: 덧붙일 말(직접 쓰기면 필수),
 * aspect: 결과 비율(늘리기의 목표 비율), productTitle: 참고용 상품 이름.
 * 반환 {prompt(영어, Gemini 용), promptKo(한국어, 다른 AI 에 붙여 넣기용), kind, option}
 */
export function buildTransformPrompt({ kind, option, extra, aspect = '4:5', productTitle } = {}) {
  const t = transformOf(kind);
  const o = optionOf(t.key, option);
  const more = String(extra || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const title = productTitle ? String(productTitle).slice(0, 80) : '';
  const en = [], ko = [];
  if (t.key === 'recreate') {
    en.push(`Create a completely new, original product photograph of the product shown in the attached photo. Use the attached photo only as a reference for what the product looks like. Do not copy or trace the original photo: use a different camera angle, a different composition and framing, a new background and new lighting so the result is clearly a different photo. Style: ${o.en}.`, KEEP_EN);
    ko.push(`첨부한 사진은 상품 생김새 참고용으로만 쓰고, 완전히 새로운 상품 사진을 만들어 주세요. 원본 사진을 그대로 따라 하지 말고 촬영 각도·구도·배경·조명을 모두 바꿔서 분명히 다른 사진이 되게 해 주세요. 연출: ${o.ko}.`, KEEP_KO);
  } else if (t.key === 'background') {
    en.push(`Edit the attached photo: replace only the background with ${o.en}. Match the lighting and shadows of the product naturally to the new scene.`, KEEP_EN);
    ko.push(`첨부한 사진에서 배경만 ${o.ko}(으)로 바꿔 주세요. 새 배경에 맞게 조명과 그림자를 자연스럽게 맞춰 주세요.`, KEEP_KO);
  } else if (t.key === 'style') {
    en.push(`Redraw the attached photo as ${o.en}. Keep the same composition, and keep the product clearly recognizable with its real shape and colors.`);
    ko.push(`첨부한 사진을 ${o.ko} 느낌으로 다시 그려 주세요. 구도는 그대로 두고, 상품은 실제 모양과 색을 알아볼 수 있게 해 주세요.`);
  } else if (t.key === 'enhance') {
    en.push(`Retouch the attached photo to look ${o.en}. Do not add, remove or move any object; keep the composition identical.`, KEEP_EN);
    ko.push(`첨부한 사진을 ${o.ko} 보정해 주세요. 물건을 더하거나 빼거나 옮기지 말고 구도는 그대로 두세요.`, KEEP_KO);
  } else if (t.key === 'extend') {
    en.push(`Extend the attached photo outward so it fills a ${aspect} frame without cropping anything. Keep the original photo unchanged in the middle and continue the background naturally into the new area.`, KEEP_EN);
    ko.push(`첨부한 사진을 자르지 말고 ${aspect} 비율이 되도록 바깥으로 늘려 주세요. 원래 사진은 가운데에 그대로 두고, 늘어난 부분은 배경을 자연스럽게 이어 그려 주세요.`, KEEP_KO);
  } else {
    en.push(`Edit the attached photo as requested: ${more || 'make it look better for a social media post'}.`, KEEP_EN);
    ko.push(`첨부한 사진을 이렇게 바꿔 주세요: ${more || 'SNS 게시물에 어울리게'}.`, KEEP_KO);
  }
  if (more && t.key !== 'custom') { en.push(`Extra direction: ${more}.`); ko.push(`추가로: ${more}.`); }
  if (title) en.push(`Product (for context only): "${title}".`);
  en.push(`Output aspect ratio ${aspect}.`, NO_NEW_TEXT);
  ko.push(`결과 비율은 ${aspect}로 해 주세요.`, NO_NEW_TEXT_KO);
  return { prompt: en.join('\n'), promptKo: ko.join('\n'), kind: t.key, option: o?.key || null };
}
