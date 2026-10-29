// 사진 보고 상품 이름 알아보기(ai.identifyProduct).
// 이름 칸이 비어 있는데 사진이 들어오면 바로 알아보고, 사람이 이름을 확인해야 만들기가 켜진다.
//  · busy(알아보는 중) → ask(이게 맞나요? [맞아요][이름 고치기]) → ok
//  · unknown(모르겠어요): 이름을 적으면 ok. 사진 캐러셀은 [이름 없이 만들기]도 된다(이름은 지어내지 않는다)
//  · failed(키·네트워크 문제): 만들기를 막지 않는다
//  · 사람이 이름 칸에 직접 적으면 그 이름이 확인된 이름이다(늦게 온 결과는 버린다)
import { request } from '../lib/bus.js';
import { h, setChildren } from './dom.js';
import { S, fn } from './app.js';
import { showError } from './errors.js';
import { icon } from './icons.js';

const pct = (c) => `${Math.round((Number(c) || 0) * 100)}%`;
const sigOf = (ids) => (ids || []).slice(0, 3).join(',');
const hasTitle = () => !!(S.manual.title || '').trim();
let token = 0;

/** 만들기를 막는 이유(없으면 '') */
export function identBlock() {
  const st = S.ident?.status;
  if (st === 'busy') return '사진 속 상품을 알아보는 중이에요. 잠시만요.';
  if (st === 'ask') return '위에서 상품 이름을 확인하면 만들 수 있어요.';
  if (st === 'unknown' && !hasTitle()) return S.ident.optional ? '상품 이름을 적거나 [이름 없이 만들기]를 눌러 주세요.' : '상품 이름을 적어 주세요.';
  return '';
}

/** 사람이 이름 칸에 직접 적었을 때(입력 이벤트에서 부른다) */
export function identTyped() {
  if (!S.ident || S.ident.status === 'ok' || S.ident.status === 'failed') return;
  if (S.ident.status === 'unknown' && !hasTitle()) return;
  S.ident.status = 'ok';
  S.ident.note = '';
  token++;   // 알아보는 중이었으면 그 결과는 버린다
  sync();
}

/** 새 상품으로 시작할 때 */
export function resetIdent() { token++; S.ident = null; }

/** 이름 칸 아래 줄. ids: 지금 사진 목록, inputId: 채울 칸, optional: 이름 없이도 만들 수 있는지(사진 캐러셀) */
export function identifyRow({ ids, inputId, optional = false }) {
  if (!ids?.length) { if (S.ident) resetIdent(); return null; }
  const sig = sigOf(ids);
  const cur = S.ident;
  // 이름이 비어 있는데 새 사진이 들어왔다 → 바로 알아본다(모르겠다·실패였으면 사진이 바뀔 때 다시)
  if (!hasTitle() && (!cur || (cur.sig !== sig && (cur.status === 'unknown' || cur.status === 'failed')))) run(ids, { inputId, optional });
  else if (cur) Object.assign(cur, { inputId, optional });
  return rowEl();
}

function rowEl() {
  const st = S.ident?.status;
  const row = h('div', { class: 'identify-row', id: 'identify-row', 'aria-live': 'polite', 'data-state': st || 'idle' });
  setChildren(row, ...rowKids(st));
  return row;
}

function rowKids(st) {
  const it = S.ident || {};
  if (st === 'busy') {
    return [h('p', { class: 'identify-busy' }, h('span', { class: 'identify-dot', 'aria-hidden': 'true' }), '사진 속 상품을 알아보는 중…')];
  }
  if (st === 'ask') {
    return [h('div', { class: 'identify-ask', id: 'identify-ask' },
      h('p', { class: 'identify-q' }, '사진 속 상품, 이게 맞나요?'),
      h('p', { class: 'identify-name', id: 'identify-name' }, it.name),
      h('p', { class: 'muted small identify-why' }, [`확신 ${pct(it.confidence)}`, it.evidence].filter(Boolean).join(' · ')),
      h('div', { class: 'identify-acts' },
        h('button', { type: 'button', class: 'btn btn-primary', id: 'btn-ident-ok', onclick: confirm }, icon('check', { size: 16 }), '맞아요'),
        h('button', { type: 'button', class: 'btn', id: 'btn-ident-edit', onclick: editName }, '이름 고치기')))];
  }
  if (st === 'unknown' && !hasTitle()) {
    return [h('div', { class: 'identify-ask identify-unknown', id: 'identify-ask' },
      h('p', { class: 'identify-q' }, '사진만으로는 어떤 상품인지 모르겠어요'),
      h('p', { class: 'muted small identify-why' }, it.why ? `${it.why} 이름을 직접 적어 주세요.` : '이름을 직접 적어 주세요.'),
      h('div', { class: 'identify-acts' },
        h('button', { type: 'button', class: 'btn', id: 'btn-ident-edit', onclick: editName }, '이름 적기'),
        it.optional ? h('button', { type: 'button', class: 'btn', id: 'btn-ident-skip', onclick: skip }, '이름 없이 만들기') : null))];
  }
  return [
    h('button', { type: 'button', class: 'btn', id: 'btn-identify', onclick: () => run(currentIds(), { inputId: it.inputId, optional: it.optional, manual: true }) },
      icon('sparkle', { size: 16 }), hasTitle() && it.status !== 'failed' ? '사진으로 이름 다시 찾기' : '사진 보고 이름 찾기'),
    h('p', { class: 'muted small identify-note', id: 'identify-note' }, it.note || ''),
  ];
}

function currentIds() { return S.ident?.ids || []; }

async function run(ids, { inputId, optional, manual = false }) {
  const my = ++token;
  S.ident = { sig: sigOf(ids), ids: ids.slice(0, 3), status: 'busy', inputId, optional, manual };
  queueMicrotask(sync);
  let r;
  try {
    r = await request('ai.identifyProduct', { imageIds: ids.slice(0, 3) }, { timeoutMs: 30000 });
  } catch (e) {
    if (my !== token) return;
    if (manual || ['NO_KEY', 'KEY_INVALID', 'BILLING', 'FORBIDDEN'].includes(e?.code)) showError(e);
    Object.assign(S.ident, { status: 'failed', note: '사진으로 이름을 알아보지 못했어요. 이름을 직접 적어 주세요.' });
    sync();
    return;
  }
  if (my !== token) return;
  if (r.known) {
    S.manual.title = r.name;
    const inp = document.getElementById(S.ident.inputId);
    if (inp) inp.value = r.name;
    Object.assign(S.ident, { status: 'ask', name: r.name, confidence: r.confidence, evidence: r.evidence || '' });
    fn.schedulePreview?.(200);
  } else {
    Object.assign(S.ident, { status: 'unknown', why: r.why || '' });
  }
  sync();
}

function confirm() {
  if (!S.ident) return;
  Object.assign(S.ident, { status: 'ok', note: `사진으로 찾은 이름이에요 (확신 ${pct(S.ident.confidence)}).` });
  sync();
  document.getElementById('btn-make')?.focus();
}

function editName() {
  const inp = document.getElementById(S.ident?.inputId);
  if (!inp) return;
  inp.focus();
  inp.select?.();
}

function skip() {
  if (!S.ident) return;
  Object.assign(S.ident, { status: 'ok', note: '이름 없이 사진만 보고 글을 써요.' });
  sync();
}

/** 화면을 다시 그리지 않고 이름 줄·만들기 버튼만 맞춘다(입력 중인 칸의 커서를 지키려고) */
function sync() {
  const row = document.getElementById('identify-row');
  if (row) { row.dataset.state = S.ident?.status || 'idle'; setChildren(row, ...rowKids(S.ident?.status)); }
  fn.updateMakeEnabled?.();
}
