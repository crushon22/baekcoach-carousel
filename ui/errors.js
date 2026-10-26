// 오류 표시 — 한국어 안내 + 발생 위치 + 원문(접어서). CLAUDE.md 규칙 9.
import { toErrorPayload, WHERE } from '../lib/common.js';
import { h } from './dom.js';

/** 어떤 예외든 화면용 {messageKo, raw, where, code?} 로 */
export const normalizeError = (e, where = WHERE.PANEL) => toErrorPayload(e, where);

/** 오류 상자 노드 (닫기 버튼 포함). 원문은 접혀 있다. */
export function errorBox(err, { onClose, title } = {}) {
  const e = err && typeof err.messageKo === 'string' ? err : normalizeError(err);
  return h('div', { class: 'error-box', role: 'alert' },
    h('div', { class: 'error-head' },
      h('strong', null, title || e.messageKo),
      onClose ? h('button', { type: 'button', class: 'btn btn-quiet', 'aria-label': '오류 닫기', onclick: onClose }, '닫기') : null),
    title ? h('p', null, e.messageKo) : null,
    h('p', { class: 'error-where' }, `발생 위치: ${e.where || WHERE.PANEL}`),
    e.raw ? h('details', null, h('summary', null, '원문 보기'), h('pre', { class: 'raw' }, e.raw)) : null);
}

/** #alerts 영역에 오류를 띄운다. 같은 내용이면 덮어쓴다. */
export function showError(err, opts = {}) {
  const host = document.getElementById('alerts');
  const e = normalizeError(err);
  if (!host) { console.warn('[panel] 오류', e.messageKo, e.where); return e; }
  const box = errorBox(e, { ...opts, onClose: () => box.remove() });
  box.dataset.msg = e.messageKo;
  host.querySelectorAll('.error-box').forEach((b) => { if (b.dataset.msg === e.messageKo) b.remove(); });
  host.prepend(box);
  while (host.children.length > 3) host.lastElementChild.remove();
  box.scrollIntoView?.({ block: 'nearest' });
  return e;
}

export function clearErrors() { document.getElementById('alerts')?.replaceChildren(); }
