// 접었다 펴는 섹션 카드. 화면을 깨끗하게 두려고 자주 쓰지 않는 것은 접어 둔다. 펼침 상태는 화면을 다시 그려도 기억한다.
import { h } from './dom.js';
import { icon } from './icons.js';
import { S } from './app.js';

const state = new Map();

/** fold({id, icon, title, open}, ...children) → <details id=… class="fold"> */
export function fold({ id, icon: ic, title, open = false }, ...children) {
  const d = h('details', { class: 'fold', id, open: !!(S.unfold || (state.has(id) ? state.get(id) : open)) });
  d.append(h('summary', null, ic ? icon(ic, { size: 20 }) : null, h('span', { class: 'fold-title' }, title)), h('div', { class: 'fold-body' }, ...children));
  d.addEventListener('toggle', () => state.set(id, d.open));
  return d;
}
