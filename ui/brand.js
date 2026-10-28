// 백코치 캐러셀 로고(2026-10-28 새로 만듦 — 쇼츠비서 고리와 다르게, 캐러셀 "카드 겹침" 모양 + 보라 파랑).
// 모양·색을 바꾸려면 이 파일만 고치고 `npm run icons` 로 확장 아이콘 PNG 를 다시 만든다.
// DOM 없이 SVG 문자열만 만든다(앱바·설정·아이콘 생성 스크립트가 같이 쓴다). xmlns 는 쓰지 않는다(HTML 안 인라인 SVG).
export const BRAND_FROM = '#3B82F6'; // 파랑
export const BRAND_TO = '#8B5CF6';   // 보라
const SPARK = '#FFE14D';

let seq = 0;
const grad = (id) => `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${BRAND_FROM}"/><stop offset="1" stop-color="${BRAND_TO}"/></linearGradient></defs>`;
const sparkle = (x, y, s, c = SPARK) => `<path d="M${x} ${y - s}C${x + s * 0.18} ${y - s * 0.18} ${x + s * 0.18} ${y - s * 0.18} ${x + s} ${y}C${x + s * 0.18} ${y + s * 0.18} ${x + s * 0.18} ${y + s * 0.18} ${x} ${y + s}C${x - s * 0.18} ${y + s * 0.18} ${x - s * 0.18} ${y + s * 0.18} ${x - s} ${y}C${x - s * 0.18} ${y - s * 0.18} ${x - s * 0.18} ${y - s * 0.18} ${x} ${y - s}Z" fill="${c}"/>`;

/** 앱바·문서용 로고 마크(투명 바탕): 뒤 카드(옅게, 기울임) + 앞 카드(그라데이션) + 노란 반짝이 */
export function logoSvg(size = 30, cls = 'logo-mark') {
  const id = `bclg${++seq}`;
  return `<svg viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true" focusable="false" class="${cls}">${grad(id)}`
    + `<rect x="5" y="7" width="16" height="20" rx="4.5" fill="url(#${id})" opacity=".32" transform="rotate(-12 13 17)"/>`
    + `<rect x="11" y="5" width="16" height="20" rx="4.5" fill="url(#${id})"/>${sparkle(23.5, 9.5, 3.2)}</svg>`;
}

/** 앱 아이콘(확장 툴바·브라우저 탭): 둥근 사각 그라데이션 바탕 + 흰 카드 겹침 + 반짝이. 작은 크기에서도 잘 보이게 꽉 찬 모양 */
export function appIconSvg(size = 128) {
  const id = `bcai${++seq}`;
  return `<svg viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true" focusable="false">${grad(id)}`
    + `<rect x="1" y="1" width="30" height="30" rx="8" fill="url(#${id})"/>`
    + `<rect x="7.5" y="8.5" width="12.5" height="15.5" rx="3" fill="#fff" opacity=".45" transform="rotate(-10 13.75 16.25)"/>`
    + `<rect x="12" y="7.5" width="12.5" height="15.5" rx="3" fill="#fff"/>${sparkle(23.2, 8.6, 2.8)}</svg>`;
}
