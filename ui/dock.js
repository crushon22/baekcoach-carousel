// 맨 아래 줄: 말로 수정(채팅) + 🎤 + 내보내기.
import { request } from '../lib/bus.js';
import { extractColorsFromImageId } from '../lib/render.js';
import * as store from '../lib/store.js';
import { h, setChildren, toast } from './dom.js';
import { S, fn, el, applyPatch, refreshAll, mainImageId, runReview, scheduleSave } from './app.js';
import { showError } from './errors.js';

let busy = false;
let recog = null;

export function renderChatLog() {
  const log = document.getElementById('chat-log');
  if (!log) return;
  const msgs = S.chat.slice(-6);
  log.hidden = !msgs.length;
  setChildren(log, ...msgs.map((m) => h('div', { class: `bubble bubble-${m.role}`, 'data-role': m.role }, m.text)));
  log.scrollTop = log.scrollHeight;
}

/** 입력칸 위 "이렇게 말해 보세요" 짧은 예시(누르면 그대로 보낸다). PC 화면에서만 보인다(CSS). */
const HINTS = {
  photo: ['글씨 더 크게', '강조 분홍으로', '2번 글 위로', '띠 스타일로'],
  cardnews: ['3번 짧게', '베이지로', '강조 빨강', '훅 2번으로'],
};
export function renderChatHints() {
  const box = document.getElementById('chat-hints');
  if (!box) return;
  const list = S.project ? HINTS[S.project.carousel?.mode === 'photo' ? 'photo' : 'cardnews'] : [];
  box.hidden = !list.length;
  setChildren(box, ...list.map((t) => h('button', { type: 'button', class: 'chat-hint', 'data-hint': t, onclick: () => { const inp = document.getElementById('chat-input'); if (!inp || busy) return; inp.value = t; send(); } }, t)));
}

function push(role, text) {
  S.chat.push({ role, text, at: Date.now() });
  renderChatLog();
}

async function send() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text || busy || !S.project || S.phase !== 'ready' || S.stream) return;
  input.value = '';
  push('user', text);
  setBusy(true);
  try {
    const r = await request('ai.chat', { text, project: S.project });
    push('assistant', r.reply || '바꿨어요.');
    if (r.patch && Object.keys(r.patch).length) applyPatch(r.patch);
    if (r.accentFrom === 'product') {
      const id = mainImageId();
      const colors = id ? await extractColorsFromImageId(id) : [];
      if (colors.length) { S.project.carousel.accentColor = colors[0]; refreshAll(); scheduleSave(); } else toast('상품 사진에서 색을 뽑지 못했어요.', { kind: 'warn' });
    }
    fn.renderDecision?.();
    fn.renderTab?.();
    if (r.regenerate) await fn.regenerate(r.regenerate.part, { options: r.regenerate.options, hookIndex: r.regenerate.hookIndex, label: '말씀하신 대로 다시 만드는 중' });
    else if (r.patch?.cards || r.patch?.caption !== undefined) runReview();
    scheduleSave();
  } catch (e) {
    push('assistant', '앗, 처리하지 못했어요. 위쪽 오류 안내를 확인해 주세요.');
    showError(e);
  }
  setBusy(false);
}

function setBusy(b) {
  busy = b;
  const input = document.getElementById('chat-input');
  const btn = document.getElementById('chat-send');
  if (input) input.disabled = b;
  document.querySelectorAll('.chat-hint').forEach((x) => { x.disabled = b; });
  if (btn) { btn.disabled = b; const l = btn.querySelector('.lbl'); if (l) l.textContent = b ? '처리 중' : '보내기'; }
}

const MIC_ERRORS = {
  'not-allowed': '마이크를 쓸 수 없어요. 브라우저의 마이크 허용을 확인하거나, 글로 입력해 주세요.',
  'service-not-allowed': '이 브라우저에서는 음성 입력을 쓸 수 없어요. 글로 입력해 주세요.',
  'no-speech': '말소리가 들리지 않았어요. 다시 눌러서 말해 보세요.',
  network: '음성 인식 서버에 연결하지 못했어요. 글로 입력해 주세요.',
  'audio-capture': '마이크를 찾지 못했어요. 마이크 연결을 확인해 주세요.',
};

function setupMic() {
  const btn = document.getElementById('chat-mic');
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { btn.hidden = true; return; }
  btn.hidden = false;
  btn.addEventListener('click', () => {
    if (recog) { try { recog.stop(); } catch { /* 이미 멈춤 */ } return; }
    const r = new SR();
    r.lang = 'ko-KR'; r.interimResults = false; r.maxAlternatives = 1;
    recog = r;
    btn.setAttribute('aria-pressed', 'true'); btn.querySelector('.mic-lbl').hidden = false;
    r.onresult = (e) => {
      const t = Array.from(e.results).map((x) => x[0].transcript).join(' ').trim();
      const input = document.getElementById('chat-input');
      input.value = (input.value ? input.value + ' ' : '') + t;
    };
    r.onerror = (e) => toast(MIC_ERRORS[e.error] || `음성 입력 오류(${e.error}). 글로 입력해 주세요.`, { kind: 'warn', ms: 4000 });
    r.onend = () => { recog = null; btn.setAttribute('aria-pressed', 'false'); btn.querySelector('.mic-lbl').hidden = true; };
    try { r.start(); } catch (err) { recog = null; btn.querySelector('.mic-lbl').hidden = true; toast('음성 입력을 시작하지 못했어요.', { kind: 'warn' }); }
  });
}

export function initDock() {
  document.getElementById('chat-form').addEventListener('submit', (e) => { e.preventDefault(); send(); });
  document.getElementById('btn-export').addEventListener('click', () => fn.openExport());
  setupMic();
}

export function showDock(show) {
  el.dock.hidden = !show;
  document.body.classList.toggle('has-dock', !!show);
  if (show) { renderChatLog(); renderChatHints(); }
}

/** 열린 작업의 대화를 불러온다 */
export async function loadChat(projectId) {
  try { S.chat = projectId ? (await store.getChat(projectId)) || [] : []; } catch { S.chat = []; }
}
