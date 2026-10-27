// 카드 글씨체 고르기: 가로로 밀어 보는 칩. 각 칩은 그 글꼴로 이름·샘플을 보여 준다(불러오는 동안 스켈레톤).
// 고르면 AI 호출 없이 carousel.font 만 바꿔 다시 그린다. 마지막 선택은 kv panel.mode 에 기억한다.
import { CARD_FONTS, ensureCardFont, fontByKey, DEFAULT_FONT } from '../lib/fonts.js';
import { h } from './dom.js';
import { icon } from './icons.js';
import { S, fn, refreshAll, scheduleSave } from './app.js';

export { CARD_FONTS, fontByKey, DEFAULT_FONT, ensureCardFont };

/** 칩 줄. lazy:true 면 load() 를 부를 때까지 글꼴 파일을 받지 않는다(첫 화면 로딩을 가볍게). */
function buildChips({ value, onPick, id }) {
  const wrap = h('div', { class: 'font-scroll', id, role: 'group', 'aria-label': '글씨체 고르기' });
  const loaders = [];
  for (const f of CARD_FONTS) {
    const sample = h('span', { class: 'font-sample', style: { fontFamily: `"${f.family}", sans-serif`, fontWeight: String(f.weight === 700 ? 700 : 400) } }, '가나다 1.2kg');
    const btn = h('button', { type: 'button', class: 'font-chip loading', 'data-font': f.key, 'aria-pressed': String(value === f.key), 'aria-label': `${f.name} — ${f.desc}`, onclick: () => onPick(f.key) },
      h('span', { class: 'font-skel', 'aria-hidden': 'true' }),
      sample,
      h('span', { class: 'font-name' }, f.name), h('span', { class: 'font-desc' }, f.desc));
    wrap.append(btn);
    loaders.push(() => ensureCardFont(f.key).then(() => btn.classList.remove('loading')));
  }
  return { wrap, load: () => Promise.all(loaders.map((l) => l())) };
}

/** 접었다 펴는 글씨체 고르기. 펼칠 때 처음으로 글꼴 파일을 받는다. 지금 글꼴 이름이 제목줄에 보인다. */
export function fontDetails({ value, onPick, id = 'font-picker', cls = '', open = false }) {
  const { wrap, load } = buildChips({ value, onPick, id });
  const det = h('details', { class: `font-details ${cls}`, open });
  det.append(h('summary', null, icon('text', { size: 20 }), `글씨체 · 지금 ${fontByKey(value).name}`), wrap);
  let started = false;
  const go = () => { if (started) return; started = true; load(); };
  det.addEventListener('toggle', () => { if (det.open) go(); });
  if (open) go();
  return det;
}

/** 시작 화면에서 고른 글씨체를 기억 */
export function pickStartFont(key) {
  S.font = key;
  fn.saveModePrefs?.();
  S.fontOpen = true;
  fn.renderStage();
}

/** 결과 화면에서 글씨체 바꾸기 (AI 호출 없음) */
export async function setProjectFont(key) {
  const p = S.project;
  if (!p) return;
  S.font = key;
  fn.saveModePrefs?.();
  await ensureCardFont(key);
  p.carousel.font = key;
  p.options = { ...(p.options || {}), font: key };
  S.fontOpen = true;
  refreshAll();
  scheduleSave();
  fn.renderTab?.();
}
