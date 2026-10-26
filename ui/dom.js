// 패널 공용 DOM 도우미 — innerHTML 을 쓰지 않고 노드를 직접 만든다(외부 글이 HTML 로 해석되지 않게).

/** h('button', {class:'btn', onclick: fn, disabled:true}, '글자', 자식노드…) */
export function h(tag, attrs, ...children) {
  const e = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'dataset') Object.assign(e.dataset, v);
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') e.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'readOnly' || k === 'selected') e[k] = !!v;
      else e.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(e, children);
  return e;
}

export function append(parent, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    parent.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return parent;
}

export function setChildren(parent, ...children) {
  parent.replaceChildren();
  return append(parent, children);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const debounce = (fn, ms) => {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); return fn(...a); };
  d.cancel = () => clearTimeout(t);
  return d;
};

/** 클립보드 복사. 실패하면 임시 textarea 로 대체. */
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* 아래로 */ }
  try {
    const ta = h('textarea', { style: { position: 'fixed', left: '-9999px', top: '0' } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

let toastTimer;
/** 화면 아래에 잠깐 뜨는 한 줄 안내 */
export function toast(message, { ms = 2600, kind = 'info' } = {}) {
  let t = document.getElementById('toast');
  if (!t) { t = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' }); document.body.append(t); }
  t.textContent = message;
  t.className = `toast toast-${kind} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

export function fmtDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 파일 → 이미지 선택창을 열고 File 을 돌려준다(취소하면 null). */
export function pickImageFile() {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', style: { display: 'none' } });
    let done = false;
    input.addEventListener('change', () => { done = true; resolve(input.files[0] || null); input.remove(); });
    input.addEventListener('cancel', () => { if (!done) { done = true; resolve(null); input.remove(); } });
    document.body.append(input);
    input.click();
  });
}

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
export const deepClone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

/** 여러 장 선택 (웹 버전 사진 올리기). 취소하면 빈 배열 */
export function pickImageFiles() {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', multiple: true, accept: 'image/png,image/jpeg,image/webp,image/gif', style: { display: 'none' } });
    let done = false;
    input.addEventListener('change', () => { done = true; resolve([...input.files]); input.remove(); });
    input.addEventListener('cancel', () => { if (!done) { done = true; resolve([]); input.remove(); } });
    document.body.append(input);
    input.click();
  });
}
