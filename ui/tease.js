// 댓글 유도(제품 정보 숨기기) 스위치 — 시작 화면 이름 칸 아래.
// 켜면 카드·캡션에 브랜드·종류만 쓰고 번호·색상명·모델명은 숨긴다. 보는 사람이 댓글로 물어보면 DM 으로 파트너스 링크를 보내는 흐름(2026-10-29 사용자 결정, 지식 K-댓글유도).
// 기본은 켬. 마지막 선택을 기억한다(panel.mode.tease). 숨길 글자는 lib/ai-util 의 규칙으로 미리 보여 주고, 색상명·모델명은 만들 때 AI 가 더 찾는다.
import { identityTokens, keepTitle } from '../lib/ai-util.js';
import { h, setChildren } from './dom.js';
import { S, fn } from './app.js';

export const teaseOn = () => S.tease !== false;

function detailText(title) {
  const t = String(title || '').trim();
  if (!teaseOn()) return '끔 — 이름이 카드에 그대로 나와요.';
  const hide = identityTokens(t);
  if (hide.length) return `숨길 것: ${hide.join(', ')} · 카드엔 "${keepTitle(t, hide) || '브랜드·종류'}"만 나와요. 색상명·모델명도 AI가 알아보면 숨겨요.`;
  if (t) return '이름에 번호·코드는 없어요. 색상명·모델명은 AI가 알아보면 숨겨요.';
  return '번호·색상명·모델명은 카드에 안 나와요. 브랜드·종류만 보여 줘요.';
}

/** 이름 칸 아래 줄. title: 지금 이름(규칙으로 숨길 글자를 미리 보여 준다) */
export function teaseRow({ title }) {
  const on = teaseOn();
  const sw = h('button', { type: 'button', role: 'switch', 'aria-checked': String(on), class: 'tease-switch', id: 'tease-switch', 'aria-label': '댓글 유도' }, h('span', { class: 'tease-knob', 'aria-hidden': 'true' }));
  sw.addEventListener('click', () => { S.tease = !teaseOn(); fn.saveModePrefs?.(); fn.renderStage?.(); });
  return h('div', { class: 'tease-row', id: 'tease-row', 'data-on': String(on) },
    h('div', { class: 'tease-head' }, sw,
      h('div', { class: 'tease-text' },
        h('label', { class: 'tease-label', for: 'tease-switch' }, '댓글 유도'),
        h('span', { class: 'tease-sub' }, on ? '번호·색상명은 숨기고 댓글로 묻게' : '이름을 그대로 써요'))),
    h('p', { class: 'muted small tease-detail', id: 'tease-detail' }, detailText(title)),
    on ? h('p', { class: 'muted small tease-flow' }, '댓글이 달리면 DM으로 쿠팡 파트너스 링크를 보내 주세요. 카드와 캡션에는 링크를 넣지 않아요.') : null);
}

/** 이름을 치는 중에 "숨길 것" 줄만 바꾼다(화면 전체를 다시 그리지 않는다) */
export function refreshTeaseDetail(title) {
  const d = document.getElementById('tease-detail');
  if (d) setChildren(d, detailText(title));
}
