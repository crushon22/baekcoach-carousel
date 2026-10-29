// 사용 방법 = "1분 따라 하기": 실제 렌더러·앱 부품으로 보여 주는 슬라이드 4장 + 자주 묻는 질문 탭. 첫 방문 띠(한 줄).
// 패널(sidepanel)과 설정 화면(options) 모두 쓴다. 장면은 슬라이드마다 하나만 움직이고, 벗어나거나 닫으면 타이머를 모두 정리한다.
// 시연 카드는 가이드 안의 고정 샘플(상품 "무선 핸디 청소기", 캔버스로 만든 단색·그라데이션 '사진')이며 외부 사진은 쓰지 않는다.
import * as store from '../lib/store.js';
import { IS_WEB } from '../lib/platform.js';
import { renderCard, mountPhoneFrame } from '../lib/render.js';
import { h } from './dom.js';
import { icon } from './icons.js';

const PRODUCT = '무선 핸디 청소기';

// ───────────────────────── 타이머 관리 (누수 확인용 카운터 포함) ─────────────────────────
let liveTimers = 0;
const countTimers = (d) => { liveTimers += d; document.documentElement.dataset.guideTimers = String(liveTimers); };
function makeScene() {
  const ids = new Set();
  let stopped = false;
  return {
    get stopped() { return stopped; },
    later(fn, ms) {
      const id = setTimeout(() => { ids.delete(id); countTimers(-1); if (!stopped) fn(); }, ms);
      ids.add(id); countTimers(1);
    },
    stop() { stopped = true; ids.forEach((id) => { clearTimeout(id); countTimers(-1); }); ids.clear(); },
  };
}
const reduced = () => !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// ───────────────────────── 샘플 카드 ─────────────────────────
const cnCarousel = (cards) => ({ type: 'sales', template: 'basic', brandColor: '#2F5BEA', accountName: 'baekcoach', mode: 'cardnews', font: 'pretendard', hasPartnersLink: false, cards });
const COVER = { index: 0, role: '훅', headline: '청소기 무겁다면\n이거 보세요', body: '1.2kg 무선 핸디형', layout: 'title' };
const FEATURE = { index: 1, role: '특징', headline: '틈새까지 쓱', body: '노즐을 바꿔 끼우면\n구석도 깔끔해요', layout: 'title' };
const TABLE_LONG = { index: 2, role: '요약표', headline: '한눈에 정리', body: '무게|약 1.2kg\n사용|최대 30분\n구성|본체·노즐', layout: 'table' };
const TABLE_SHORT = { ...TABLE_LONG, body: '무게|약 1.2kg\n사용|최대 30분' };

/** 캔버스로 만든 단색·그라데이션 '사진' 3장 (IndexedDB 에 한 번만 넣는다) */
async function guidePhotos() {
  const palettes = [['#BAE6FD', '#FDE68A', '#0F172A'], ['#FBCFE8', '#FEF3C7', '#7C2D12'], ['#BBF7D0', '#BAE6FD', '#14532D']];
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const id = `guide-photo-${i + 1}`;
    if (!(await store.getImage(id))) {
      const c = document.createElement('canvas'); c.width = 800; c.height = 1000;
      const g = c.getContext('2d');
      const grad = g.createLinearGradient(0, 0, 800, 1000); grad.addColorStop(0, palettes[i][0]); grad.addColorStop(1, palettes[i][1]);
      g.fillStyle = grad; g.fillRect(0, 0, 800, 1000);
      g.fillStyle = 'rgba(255,255,255,.35)'; g.beginPath(); g.arc(600, 260, 150, 0, 7); g.fill();
      g.fillStyle = palettes[i][2]; g.beginPath(); g.roundRect(270, 400, 260, 480, 70); g.fill();           // 제품처럼 보이는 단순한 모양
      g.fillStyle = 'rgba(255,255,255,.55)'; g.beginPath(); g.roundRect(310, 450, 60, 300, 30); g.fill();
      await store.putImage(await new Promise((r) => c.toBlob(r, 'image/png')), { id, kind: 'upload' });
    }
    ids.push(id);
  }
  return ids;
}

async function draw(host, carousel, idx, scene) {
  try {
    const canvas = await renderCard(carousel, idx, { size: '4x5', scale: 0.5, total: carousel.cards.length });
    if (scene.stopped || !host.isConnected) return;
    canvas.className = 'guide-canvas';
    host.replaceChildren(canvas);
  } catch (e) { console.warn('[guide] 카드를 그리지 못했어요', e); }
}

// ───────────────────────── 장면 4개 ─────────────────────────
// 각 장면: (stage, scene, {still}) → 즉시 완성 상태를 그리고, still 이 아니면 반복 재생을 시작한다.

function sceneKey(stage, scene, { still }) {
  const badge = h('span', { class: 'badge badge-no', id: 'guide-key-badge' }, '아직 없음');
  const dots = h('span', { class: 'mock-dots' });
  const save = h('span', { class: 'btn btn-primary mock-btn' }, '키 저장');
  stage.replaceChildren(h('div', { class: 'mock-panel', 'aria-hidden': 'true' },
    h('div', { class: 'mock-row' }, h('strong', { class: 'mock-title' }, 'AI 키'), badge),
    h('div', { class: 'mock-input mock-key' }, dots),
    h('div', { class: 'mock-row mock-end' }, save)));
  const full = '•••• •••• ••••';
  const done = () => { dots.textContent = full; badge.className = 'badge badge-ok'; badge.replaceChildren(icon('check', { size: 16 }), '저장됨'); };
  const reset = () => { dots.textContent = ''; badge.className = 'badge badge-no'; badge.textContent = '아직 없음'; save.classList.remove('is-pressed'); };
  if (still) { done(); return; }
  const loop = () => {
    reset();
    let n = 0;
    const type = () => {
      n++; dots.textContent = full.slice(0, n);
      if (n < full.length) scene.later(type, 110);
      else scene.later(() => { save.classList.add('is-pressed'); scene.later(() => { save.classList.remove('is-pressed'); done(); scene.later(loop, 1600); }, 220); }, 500);
    };
    scene.later(type, 700);
  };
  loop();
}

function sceneTyping(stage, scene, { still }) {
  const typed = h('span', { class: 'typed' });
  const host = h('div', { class: 'guide-card-host' });
  stage.replaceChildren(h('div', { class: 'guide-split', 'aria-hidden': 'true' },
    h('div', { class: 'mock-panel' }, h('div', { class: 'mock-label' }, '상품 이름'), h('div', { class: 'mock-input' }, typed, h('span', { class: 'caret' }))),
    host));
  const render = (text) => draw(host, cnCarousel([{ index: 0, role: '훅', headline: text || '상품 이름이\n여기 들어가요', body: '', layout: 'title' }]), 0, scene);
  if (still) { typed.textContent = PRODUCT; render(PRODUCT); return; }
  const loop = () => {
    typed.textContent = ''; render('');
    let n = 0;
    const step = () => {
      n++; typed.textContent = PRODUCT.slice(0, n); render(typed.textContent);
      if (n < PRODUCT.length) scene.later(step, 200); else scene.later(loop, 2200);
    };
    scene.later(step, 900);
  };
  loop();
}

async function sceneModes(stage, scene, { still }) {
  const photoIds = await guidePhotos();
  if (scene.stopped) return;
  const tab = (name, on) => h('span', { class: 'mode-tab', 'aria-selected': String(on) }, name);
  const a = tab('카드뉴스', true), b = tab('사진 캐러셀', false);
  const host = h('div', { class: 'guide-card-host' });
  stage.replaceChildren(h('div', { class: 'guide-split guide-col', 'aria-hidden': 'true' }, h('div', { class: 'mode-tabs mock-seg' }, a, b), host));
  const cn = cnCarousel([{ index: 0, role: '훅', headline: PRODUCT, body: '먼저 확인하면\n후회가 줄어요', layout: 'title' }]);
  const photo = { type: 'sales', template: 'basic', brandColor: '#2F5BEA', accountName: 'baekcoach', mode: 'photo', overlayStyle: 'outline', adLabel: true, font: 'pretendard', hasPartnersLink: false,
    cards: [{ index: 0, role: '커버', layout: 'overlay', imageSlot: 'hero', imageId: photoIds[0], headline: '청소기 무겁다면\n이거 보세요', body: '', overlay: { lines: ['청소기 무겁다면', '이거 보세요'], position: 'top', size: 'xl' } }] };
  const show = (isPhoto) => { a.setAttribute('aria-selected', String(!isPhoto)); b.setAttribute('aria-selected', String(isPhoto)); draw(host, isPhoto ? photo : cn, 0, scene); };
  show(false);
  if (still) return;
  let isPhoto = false;
  const flip = () => { isPhoto = !isPhoto; show(isPhoto); scene.later(flip, 2600); };
  scene.later(flip, 2000);
}

async function sceneEdit(stage, scene, { still }) {
  const pfHost = h('div', { class: 'guide-phone' });
  const typed = h('span', { class: 'typed' });
  const bubble = h('div', { class: 'bubble bubble-user mock-bubble', hidden: true }, '3번 짧게');
  const done = h('span', { class: 'badge badge-ok mock-done', hidden: true }, icon('check', { size: 16 }), 'zip 저장 완료');
  const exp = h('span', { class: 'btn btn-primary mock-btn' }, '내보내기');
  stage.replaceChildren(h('div', { class: 'guide-split guide-col', 'aria-hidden': 'true' }, pfHost,
    h('div', { class: 'mock-chat' }, bubble, h('div', { class: 'mock-input mock-chatbox' }, typed, h('span', { class: 'caret' }))),
    h('div', { class: 'mock-row mock-end' }, done, exp)));
  const car = cnCarousel([COVER, FEATURE, TABLE_LONG]);
  const pf = mountPhoneFrame(pfHost, { carousel: car, total: 3, scale: 0.5, caption: '' });
  const origStop = scene.stop; scene.stop = () => { origStop(); try { pf.destroy(); } catch { /* 이미 정리됨 */ } };
  await pf.whenIdle();
  if (scene.stopped) return;
  const finalState = () => { pf.goTo(2, { animate: false }); pf.setCard(2, TABLE_SHORT); bubble.hidden = false; done.hidden = false; };
  if (still) { finalState(); return; }
  const text = '3번 짧게';
  const loop = () => {
    typed.textContent = ''; bubble.hidden = true; done.hidden = true; exp.classList.remove('is-pressed');
    pf.setCard(2, TABLE_LONG); pf.goTo(0, { animate: false });
    scene.later(() => pf.goTo(1), 1500);
    scene.later(() => pf.goTo(2), 3000);
    scene.later(() => {
      let n = 0;
      const type = () => { n++; typed.textContent = text.slice(0, n); if (n < text.length) scene.later(type, 140); else scene.later(() => { typed.textContent = ''; bubble.hidden = false; scene.later(() => pf.setCard(2, TABLE_SHORT), 700); }, 450); };
      type();
    }, 4600);
    scene.later(() => exp.classList.add('is-pressed'), 7600);
    scene.later(() => { exp.classList.remove('is-pressed'); done.hidden = false; }, 7850);
    scene.later(loop, 10200);
  };
  loop();
}

// ───────────────────────── 슬라이드 ─────────────────────────
function slides() {
  return [
    { id: 'step-1', title: '키는 한 번만 넣어요', text: '설정에서 Gemini(무료로 시작) 또는 GPT를 고르고 키를 넣으면 끝이에요. 키는 이 브라우저에만 저장돼요.', link: true, scene: sceneKey },
    { id: 'step-2', title: '이름만 넣어도 카드가 보여요', text: IS_WEB ? '상품 이름을 적으면 첫 카드가 바로 그려져요.' : '상품 이름을 적으면 첫 카드가 바로 그려져요. 쿠팡 상품 페이지에서 "캐러셀 만들기"를 누르면 자동으로 채워져요.', scene: sceneTyping },
    { id: 'step-3', title: '버전을 골라요', text: '글로 정리할지, 사진 위에 글만 얹을지 골라요.', scene: sceneModes },
    { id: 'step-4', title: '말로 고치고 내보내요', text: '"3번 짧게"처럼 말하면 고쳐 주고, 내보내기를 누르면 zip이 저장돼요.', scene: sceneEdit },
  ];
}

const FAQ = [
  ['faq-key', '키는 어디서 만드나요?', 'aistudio.google.com/apikey 에서 결제를 연결하지 않은 새 프로젝트로 만들면 무료예요. 만든 키를 설정에 붙여넣고 "키 연결 확인"을 눌러요.'],
  ['faq-402', '"결제·크레딧"(402) 오류가 나요', '크레딧이 소진된 프로젝트의 키예요. 결제를 연결하지 않은 새 프로젝트에서 키를 새로 만들어 바꿔 보세요.'],
  ['faq-429', '"요청이 너무 많아요"(429)가 나와요', '무료 키는 분당 요청 수가 제한돼요. 잠시 뒤 다시 눌러 보세요. 막히면 앱이 알아서 한 장씩 만들기로 바꿔 이어가요.'],
  ['faq-safe', '키는 안전한가요?', '키는 이 브라우저에만 저장되고 개발자나 다른 서버로 보내지 않아요. 공용 컴퓨터에서는 다 쓴 뒤 설정에서 "저장된 키 지우기"를 눌러 주세요.'],
  ['faq-disclosure', '파트너스 고지 문구는 어디에 들어가나요?', '캡션에는 넣지 않아요. 대신 카드마다 [광고] 표기가 들어가요. 광고 표기는 끌 수 있지만 파트너스 글이라 켜 두는 게 기본이고, 끄면 점수와 내보내기 확인에 경고가 떠요.'],
  ['faq-photos', '사진은 몇 장까지 쓸 수 있나요?', '사진 캐러셀은 2장에서 10장까지예요. 순서가 카드 순서이고 1번이 커버예요.'],
  ['faq-transform', '판매처 사진을 그대로 써도 되나요? 배경을 바꾸거나 새로 그릴 수 있나요?', '사진 줄의 "AI 사진 3장 추가 만들기"를 누르면 원본은 그대로 두고 같은 상품을 다른 각도·구도·배경으로 찍은 사진을 2~3장 더 만들어요(원본과 다른 제품으로 그려지면 넣지 않아요). 사진과 카드에 AI 표시는 넣지 않으니, 인스타에 올릴 때 AI 표시를 직접 체크하세요. 한 장씩은 사진을 누르고 "AI로 바꾸기"에서 새로 그리기·배경 바꾸기·그림체·보정·비율 늘리기·직접 쓰기 중에 고르면 돼요. 상품 모양은 그대로 두고, 바꾼 사진에는 AI 표시(카드에는 넣지 않아요)가 붙어요. 한도·잔액 때문에 막히면 요청문을 복사해 Gemini 앱이나 ChatGPT에서 만든 뒤 올릴 수 있어요.'],
  ['faq-drop', '사진을 더 쉽게 넣을 수 있나요?', '시작 화면에 사진 파일을 끌어다 놓거나, 캡처한 사진을 붙여 넣기(Ctrl+V · ⌘V)하면 바로 들어가요.'],
  ['faq-flag', '⚠️ 표시는 뭔가요?', '글이 칸을 넘치거나, 숨기기로 한 번호·색상명이 그대로 나온 곳이에요. 검수 탭에서 "…로 바꾸기"나 "그 줄 빼기"를 누르면 정리돼요.'],
];

function overlayEl() {
  let o = document.getElementById('overlay');
  if (!o) { o = h('div', { id: 'overlay', class: 'overlay', hidden: true }); document.body.append(o); }
  return o;
}

let current = null;   // 열려 있는 가이드의 정리 함수

export function closeGuide() {
  current?.();
  current = null;
  const o = document.getElementById('overlay');
  if (!o) return;
  o.hidden = true; o.replaceChildren();
  document.body.classList.remove('overlay-open');
}

/** 지금 만들어 보기: 가이드를 닫고 입력 칸(사진 모드면 사진 추가 버튼)에 포커스 */
function startNow() {
  closeGuide();
  const photo = document.getElementById('mode-photo')?.getAttribute('aria-selected') === 'true';
  const target = photo ? document.getElementById('btn-photo-upload') : (document.getElementById('manual-title') || document.getElementById('btn-make'));
  if (target) setTimeout(() => { target.scrollIntoView?.({ block: 'center' }); target.focus(); }, 60);
  else if (IS_WEB && /settings\.html/.test(location.pathname)) location.href = 'index.html';
}

/**
 * 사용 방법 열기. focus: 'faq-key' 처럼 질문 id → 자주 묻는 질문 탭에서 펼침 / 'step-2' → 해당 슬라이드.
 */
export function openGuide({ focus } = {}) {
  closeGuide();
  const o = overlayEl();
  const data = slides();
  let idx = 0;
  let tab = 'steps';
  let scene = null;
  const swipe = { x: null };

  const stage = h('div', { class: 'guide-stage', id: 'guide-stage' });
  const count = h('span', { class: 'guide-count', id: 'guide-count' });
  const title = h('h2', { class: 'guide-slide-title', id: 'guide-slide-title', 'aria-live': 'polite' });
  const text = h('p', { class: 'guide-slide-text', id: 'guide-slide-text' });
  const more = h('button', { type: 'button', class: 'link-btn guide-more', id: 'guide-key-link', hidden: true, onclick: () => setTab('faq', 'faq-key') }, '키 만드는 법');
  const prev = h('button', { type: 'button', class: 'btn', id: 'guide-prev', onclick: () => go(idx - 1) }, icon('arrowLeft', { size: 18 }), '이전');
  const next = h('button', { type: 'button', class: 'btn btn-primary', id: 'guide-next', onclick: () => go(idx + 1) }, '다음', icon('arrowRight', { size: 18 }));
  const start = h('button', { type: 'button', class: 'btn btn-primary btn-big', id: 'guide-start', hidden: true, onclick: startNow }, '지금 만들어 보기');
  const dots = h('div', { class: 'guide-dots', role: 'group', 'aria-label': '단계' }, ...data.map((_, i) => h('button', { type: 'button', class: 'guide-dot', 'aria-label': `${i + 1}단계`, 'data-i': i, onclick: () => go(i) }, h('span'))));

  function go(i) {
    if (i < 0 || i >= data.length) return;
    idx = i;
    scene?.stop();
    scene = makeScene();
    const s = data[i];
    count.textContent = `${i + 1} / ${data.length}`;
    title.textContent = s.title;
    text.textContent = s.text;
    more.hidden = !s.link;
    prev.disabled = i === 0;
    next.hidden = i === data.length - 1;
    start.hidden = i !== data.length - 1;
    dots.querySelectorAll('.guide-dot').forEach((d, k) => d.setAttribute('aria-current', String(k === i)));
    stage.dataset.slide = String(i + 1);
    const sc = scene;
    Promise.resolve(s.scene(stage, sc, { still: reduced() })).catch((e) => console.warn('[guide] 장면 오류', e));
  }

  const steps = h('div', { class: 'guide-slide', id: 'guide-steps-panel', role: 'tabpanel' },
    stage,
    h('div', { class: 'guide-side' }, count, title, text, more, h('div', { class: 'guide-nav' }, dots, h('div', { class: 'guide-btns' }, prev, next, start))));
  const faqPanel = h('div', { class: 'faq-list', id: 'guide-faq-panel', role: 'tabpanel', hidden: true },
    ...FAQ.map(([id, q, a]) => h('details', { class: 'faq', id }, h('summary', null, q), h('p', null, a))));

  const tabBtn = (key, label) => h('button', { type: 'button', role: 'tab', class: 'guide-tab', id: `guide-tab-${key}`, 'aria-selected': String(key === tab), onclick: () => setTab(key) }, label);
  const tabSteps = tabBtn('steps', '따라 하기');
  const tabFaq = tabBtn('faq', '자주 묻는 질문');

  function setTab(key, faqId) {
    tab = key;
    tabSteps.setAttribute('aria-selected', String(key === 'steps'));
    tabFaq.setAttribute('aria-selected', String(key === 'faq'));
    steps.hidden = key !== 'steps';
    faqPanel.hidden = key !== 'faq';
    if (key === 'faq') {
      scene?.stop(); scene = null;
      faqPanel.querySelectorAll('details').forEach((d) => { d.open = d.id === faqId; });
      if (faqId) setTimeout(() => document.getElementById(faqId)?.scrollIntoView({ block: 'start' }), 30);
    } else go(idx);
  }

  const body = h('div', { class: 'sheet-body guide-body', tabindex: -1 }, steps, faqPanel);
  o.replaceChildren(h('div', { class: 'sheet guide-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': '사용 방법', id: 'guide-sheet' },
    h('div', { class: 'sheet-head' }, h('div', { class: 'guide-tabs', role: 'tablist' }, tabSteps, tabFaq), h('button', { type: 'button', class: 'btn', id: 'btn-guide-close', onclick: closeGuide }, '닫기')),
    body));
  o.hidden = false;
  document.body.classList.add('overlay-open');

  // 키보드 ←/→ · Esc, 좌우 밀기
  const onKey = (e) => {
    if (e.key === 'Escape') { closeGuide(); return; }
    if (tab !== 'steps' || /INPUT|TEXTAREA/.test(document.activeElement?.tagName || '')) return;
    if (e.key === 'ArrowRight') go(idx + 1); else if (e.key === 'ArrowLeft') go(idx - 1);
  };
  document.addEventListener('keydown', onKey);
  stage.addEventListener('pointerdown', (e) => { swipe.x = e.clientX; });
  const endSwipe = (e) => { if (swipe.x == null) return; const dx = e.clientX - swipe.x; swipe.x = null; if (Math.abs(dx) > 50) go(idx + (dx < 0 ? 1 : -1)); };
  stage.addEventListener('pointerup', endSwipe);
  stage.addEventListener('pointercancel', () => { swipe.x = null; });
  current = () => { scene?.stop(); scene = null; document.removeEventListener('keydown', onKey); };

  const m = /^faq-/.test(focus || '') ? 'faq' : 'steps';
  const stepNo = /^step-(\d)$/.exec(focus || '');
  if (stepNo) idx = Math.min(data.length, Math.max(1, Number(stepNo[1]))) - 1;
  if (m === 'faq') setTab('faq', focus); else go(idx);
  body.focus();
}

// ───────────────────────── 첫 방문 띠 ─────────────────────────
export async function guideSeen() { try { return !!(await store.kvGet('guideSeen', null)); } catch { return true; } }
export function markGuideSeen() { store.kvSet('guideSeen', { at: Date.now() }).catch(() => {}); }

/** 시작 화면 위 한 줄 띠. 누르면 따라 하기 슬라이드를 연다. onClose: 닫았을 때(다시 안 뜸). */
export function guideBand({ onClose }) {
  return h('section', { class: 'guide-band', id: 'guide-band', 'aria-label': '처음 쓰는 방법' },
    h('button', { type: 'button', class: 'band-link', id: 'btn-band-more', onclick: () => openGuide() }, '처음이세요? 1분 따라 하기', icon('chevronRight', { size: 18 })),
    h('button', { type: 'button', class: 'btn btn-quiet band-close', id: 'btn-band-close', 'aria-label': '안내 닫기', onclick: onClose }, icon('close', { size: 20 })));
}
