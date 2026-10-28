// PC 웹 왼쪽 메뉴 아래 "연결된 AI": Gemini·GPT 각각 키가 있는지·연결 확인 결과를 보여 주고,
// 키가 있는 쪽을 누르면 그 AI 로 만든다(settings.aiProvider). 연결 결과는 설정의 "키 연결 확인"이 남긴 settings.aiCheck.
import { request } from '../lib/bus.js';
import { h, setChildren, toast } from './dom.js';
import { S } from './app.js';
import { showError } from './errors.js';

const PROVIDERS = [['gemini', 'Gemini', 'geminiKey'], ['openai', 'GPT', 'openaiKey']];

/** {cls, text}: ok 연결됨 · bad 연결 안 됨 · wait 확인 전 · none 키 없음 */
function stateOf(s, pv, field) {
  if (!s?.has?.[field]) return { cls: 'none', text: '키 없음' };
  const c = s.aiCheck?.[pv];
  if (c?.ok) return { cls: 'ok', text: '연결됨' };
  if (c) return { cls: 'bad', text: '연결 안 됨' };
  return { cls: 'wait', text: '확인 전' };
}

async function pick(pv, name) {
  try {
    S.settings = await request('core.saveSettings', { aiProvider: pv });
    renderAiStatus();
    toast(`이제 ${name}로 글과 사진을 만들어요.`);
  } catch (e) { showError(e); }
}

export function renderAiStatus() {
  const host = document.getElementById('nav-ai');
  const s = S.settings;
  if (!host || !s) return;
  const cur = s.aiProvider === 'openai' ? 'openai' : 'gemini';
  const rows = PROVIDERS.map(([pv, name, field]) => {
    const st = stateOf(s, pv, field);
    const inner = [h('span', { class: 'nav-ai-name' }, name), h('span', { class: `nav-ai-state ${st.cls}` }, st.text)];
    // 키가 있는 쪽만 누를 수 있다(골라 쓰기). 키가 없으면 회색 줄
    return st.cls === 'none'
      ? h('div', { class: 'nav-ai-row is-off', 'data-ai': pv, 'aria-current': cur === pv ? 'true' : null }, ...inner)
      : h('button', { type: 'button', class: 'nav-ai-row', 'data-ai': pv, 'aria-pressed': String(cur === pv), 'aria-label': `${name} 로 만들기 (${st.text})`, onclick: () => (cur === pv ? null : pick(pv, name)) }, ...inner);
  });
  const c = stateOf(s, cur, cur === 'openai' ? 'openaiKey' : 'geminiKey');
  const curName = cur === 'openai' ? 'GPT' : 'Gemini';
  const other = PROVIDERS.find(([pv, , f]) => pv !== cur && s.has?.[f]);
  const note = c.cls === 'ok' ? `${curName}로 만들어요${s.aiCheck[cur].model ? ` · ${s.aiCheck[cur].model}` : ''}`
    : c.cls === 'wait' ? `설정에서 "키 연결 확인"을 눌러 ${curName} 키를 확인해 주세요.`
      : c.cls === 'bad' ? `${curName} 키 연결에 실패했어요. 설정에서 키를 확인해 주세요.`
        : other ? `${curName} 키가 없어요. 위에서 ${other[1]}를 누르거나 설정에서 키를 넣어 주세요.` : '아직 AI 키가 없어요. 설정에서 Gemini 또는 GPT 키를 넣어 주세요.';
  setChildren(host,
    h('div', { class: 'nav-ai-head' }, '연결된 AI'),
    h('div', { class: 'nav-ai-rows' }, ...rows),
    h('p', { class: 'nav-ai-note', id: 'nav-ai-note' }, note));
}
