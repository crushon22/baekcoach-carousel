// 직접 만든 인라인 아이콘 세트 (둥근 선 2px, 끝 둥글게). 외부 아이콘 라이브러리·CDN 없음.
// <svg> 를 xmlns 없이 HTML 로 파싱하면 브라우저가 SVG 이름공간을 자동으로 붙인다(그래서 http 주소 문자열이 필요 없다).
import { logoSvg } from './brand.js';
const PATHS = {
  home: '<path d="M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/>',
  photo: '<rect x="3" y="6" width="18" height="14" rx="4"/><circle cx="12" cy="13" r="3.5"/><path d="M8.5 6l1.2-2h4.6l1.2 2"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="4"/><circle cx="9" cy="10" r="1.8"/><path d="M4 18l5-5 4 3 3-3 4 4"/>',
  text: '<path d="M3.5 19l5-13 5 13M5.4 14.5h6.2"/><path d="M15.5 19l2.8-7 2.8 7M16.5 17h3.6"/>',
  pen: '<path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19z"/><path d="M14.5 6.5l3 3"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1.6 0 2.2-1 1.7-2.1s0-2.1 1.6-2.1H18a3 3 0 0 0 3-3C21 7.4 17 3 12 3z"/><circle cx="8" cy="11" r="1"/><circle cx="12" cy="7.5" r="1"/><circle cx="16" cy="11" r="1"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  bubble: '<path d="M6 4.5h12A3 3 0 0 1 21 7.5v7a3 3 0 0 1-3 3h-6.5L7 21v-3.5H6a3 3 0 0 1-3-3v-7a3 3 0 0 1 3-3z"/><path d="M8 9.5h8M8 13h5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1"/>',
  download: '<path d="M12 4v11M7.5 11L12 15.5 16.5 11"/><path d="M5 19.5h14"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M18.5 5.5l-2.1 2.1M7.6 16.4l-2.1 2.1"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  sparkle: '<path d="M11 3l1.9 5.6L18.5 10.5l-5.6 1.9L11 18l-1.9-5.6L3.5 10.5l5.6-1.9z"/><path d="M19 15.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  send: '<path d="M21 3L10.5 13.5"/><path d="M21 3l-6.5 18-3.8-7.7L3 9.5z"/>',
  cards: '<rect x="4" y="3.5" width="13" height="17" rx="3.2"/><path d="M20 7.5v9.5a2.5 2.5 0 0 1-2.5 2.5"/><path d="M8 8h5M8 12h5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  up: '<path d="M12 19V6M6.5 11.5L12 6l5.5 5.5"/>',
  down: '<path d="M12 5v13M6.5 12.5L12 18l5.5-5.5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12.5L20 4M16.5 7.5l2.5 2.5M14 10l2 2"/>',
  shield: '<path d="M12 3l7.5 3v5.5c0 4.5-3.2 8-7.5 9.5-4.3-1.5-7.5-5-7.5-9.5V6z"/><path d="M8.8 12l2.4 2.4L15.5 10"/>',
  heart: '<path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z"/>',
  backup: '<path d="M12 4v11M7.5 8.5L12 4l4.5 4.5"/><path d="M5 15v3.5a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5V15"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.4 9.4a2.7 2.7 0 1 1 3.8 2.5c-.8.4-1.2 1-1.2 1.8"/><path d="M12 17.2h.01"/>',
  arrowRight: '<path d="M5 12h14M13.5 6.5L19 12l-5.5 5.5"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  arrowLeft: '<path d="M19 12H5M10.5 6.5L5 12l5.5 5.5"/>',
};

/** icon('gear', {size: 22}) → <svg> 노드 (색은 글자색을 따라간다) */
export function icon(name, { size = 22, cls = '' } = {}) {
  const t = document.createElement('template');
  t.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" class="ico ${cls}">${PATHS[name] || ''}</svg>`;
  return t.content.firstElementChild;
}

/** 앱바 로고 마크 — 모양·색은 ui/brand.js(카드 겹침, 하늘 파랑) */
export function logoMark(size = 30) {
  const t = document.createElement('template');
  t.innerHTML = logoSvg(size);
  return t.content.firstElementChild;
}

/** 이 요소 안의 [data-icon] 자리에 아이콘을 채운다 (정적 html 용) */
export function decorateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    if (el.dataset.iconDone) return;
    el.prepend(icon(el.dataset.icon, { size: Number(el.dataset.iconSize) || 22 }));
    el.dataset.iconDone = '1';
  });
}

/** 아이콘이 붙은 소제목 */
export function h3i(name, text) { const e = document.createElement('h3'); e.append(icon(name, { size: 20 }), text); return e; }
