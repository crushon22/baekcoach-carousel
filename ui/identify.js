// 사진 보고 상품 이름 알아보기(ai.identifyProduct): 이름 칸 아래 작은 버튼 + 결과 한 줄.
// 만들기를 누를 때 이름이 비어 있으면 sidepanel 이 autoIdentify 로 한 번 알아본다. 모르면 모른다고 알려 주고 이름을 지어내지 않는다.
import { request } from '../lib/bus.js';
import { h, setChildren, toast } from './dom.js';
import { S, fn } from './app.js';
import { showError } from './errors.js';
import { icon } from './icons.js';

const pct = (c) => `${Math.round((Number(c) || 0) * 100)}%`;
const knownNote = (r) => `사진으로 추정한 이름이에요 (확신 ${pct(r.confidence)}). 틀리면 고쳐 주세요.`;
const unknownNote = '사진만으로는 어떤 상품인지 모르겠어요. 이름을 직접 적어 주세요.';

/** 이름 칸 아래 줄. ids: 지금 사진 목록, inputId: 채울 칸 */
export function identifyRow({ ids, inputId }) {
  if (!ids?.length) return null;
  const note = h('p', { class: 'muted small identify-note', id: 'identify-note', 'aria-live': 'polite' }, S.identifyNote || '');
  const btn = h('button', { type: 'button', class: 'btn', id: 'btn-identify' }, icon('sparkle', { size: 16 }), '사진 보고 이름 찾기');
  btn.addEventListener('click', async () => {
    btn.disabled = true; btn.lastChild.textContent = '사진을 보는 중…';
    try {
      const r = await request('ai.identifyProduct', { imageIds: ids.slice(0, 3) }, { timeoutMs: 60000 });
      if (r.known) {
        S.manual.title = r.name;
        const inp = document.getElementById(inputId);
        if (inp) { inp.value = r.name; inp.dispatchEvent(new Event('input')); }
        S.identifyNote = knownNote(r);
      } else S.identifyNote = r.why ? `${unknownNote} (${r.why})` : unknownNote;
      note.textContent = S.identifyNote;
    } catch (e) { showError(e); }
    btn.disabled = false; btn.lastChild.textContent = '사진 보고 이름 찾기';
  });
  return h('div', { class: 'identify-row' }, btn, note);
}

/** 만들기 직전: 이름이 비어 있으면 사진으로 알아본다. 알아낸 이름(또는 null) */
export async function autoIdentify(ids) {
  if (!ids?.length) return null;
  toast('사진 속 상품을 알아보는 중…', { ms: 4000 });
  try {
    const r = await request('ai.identifyProduct', { imageIds: ids.slice(0, 3) }, { timeoutMs: 30000 });
    if (r.known) { S.manual.title = r.name; S.identifyNote = knownNote(r); toast(`사진 속 상품: ${r.name} (추정 · 틀리면 고쳐 주세요)`, { ms: 5000 }); return r.name; }
    S.identifyNote = unknownNote;
    return null;
  } catch (e) {
    if (e?.code === 'NO_KEY' || e?.code === 'KEY_INVALID' || e?.code === 'BILLING') showError(e);
    return null;   // 못 알아봐도 만들기는 계속한다
  } finally { fn.renderStage?.(); }
}
