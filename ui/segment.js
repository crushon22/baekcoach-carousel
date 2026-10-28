// 아이콘/글자 세그먼트 스위치: 연회색 트랙 위 흰 썸. 위에 작은 회색 라벨. (쇼츠비서 생성 화면 방식을 차분한 토큰에 맞춤)
import { h } from './dom.js';
import { icon } from './icons.js';

/**
 * items: [{value, label(한글, aria-label), icon?, text?}]  — icon 이 있으면 아이콘만, 없으면 text(없으면 label) 글자.
 * 반환 요소는 id 를 가지며, 버튼마다 data-value·aria-pressed 가 있다(시험·접근성).
 */
export function segment({ id, label, items, value, onPick }) {
  const track = h('div', { class: 'seg-track', id, role: 'group', 'aria-label': label },
    ...items.map((it) => h('button', {
      type: 'button', class: 'seg-btn', 'data-value': it.value, 'aria-pressed': String(it.value === value), 'aria-label': it.label, title: it.label,
      onclick: () => onPick(it.value),
    }, it.icon ? icon(it.icon, { size: 20 }) : (it.text ?? it.label))));
  return h('div', { class: 'seg-group' }, label ? h('span', { class: 'seg-label' }, label) : null, track);
}
