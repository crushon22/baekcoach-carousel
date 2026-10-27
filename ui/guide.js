// 사용 방법: 모달(웹 넓은 화면은 가운데 창, 좁은 화면·패널은 아래에서 올라오는 시트) + 첫 방문 3단계 띠.
// 패널(sidepanel)과 설정 화면(options) 모두 쓴다. 쇼츠비서 /guide 구성: 배지 → 2줄 제목 → 3단계 퀵 스타트 → 자세히 보기 → 자주 묻는 질문.
import * as store from '../lib/store.js';
import { IS_WEB } from '../lib/platform.js';
import { h } from './dom.js';
import { icon } from './icons.js';

const QUICK = [
  { n: '01', icon: 'photo', tone: 'green', title: '사진·상품 넣기', line: '상품 이름과 사진을 넣어요' },
  { n: '02', icon: 'palette', tone: 'sky', title: '버전·스타일 고르기', line: '카드뉴스 또는 사진 캐러셀' },
  { n: '03', icon: 'sparkle', tone: 'yellow', title: '만들고 내보내기', line: '카드·캡션·대본을 한 번에', done: true },
];

// 첫 방문 띠에 쓰는 짧은 3단계 (퀵 스타트와 같은 문구)
export const BAND_STEPS = QUICK.map((q) => q.title);

function mini(kind) {
  const bits = {
    key: ['m-input', 'm-pill'], mode: ['m-card', 'm-card m-on'], make: ['m-input', 'm-input m-short', 'm-pill m-navy'],
    edit: ['m-phone', 'm-tabs'], review: ['m-score', 'm-flag'], link: ['m-input', 'm-cap'], export: ['m-zip', 'm-arrow'],
  }[kind] || [];
  return h('span', { class: `mini mini-${kind}`, 'aria-hidden': 'true' }, ...bits.map((c) => h('i', { class: c })));
}

function steps() {
  const photoWord = IS_WEB ? '상품 이름과 사진을 직접 넣고 "만들기"를 눌러요. 쿠팡 상품 설명을 복사해 붙여 넣으면 글이 더 정확해져요.'
    : '쿠팡 상품 페이지에서 "캐러셀 만들기" 버튼을 누르면 이름·가격·사진이 자동으로 들어가요. 그다음 "만들기"를 눌러요.';
  return [
    { id: 'step-1', icon: 'key', mini: 'key', title: '설정에서 Gemini 키 넣기', text: 'aistudio.google.com/apikey 에서 결제 없는 새 프로젝트로 무료 키를 만들어 설정에 붙여넣고 "키 연결 확인"을 눌러요.' },
    { id: 'step-2', icon: 'cards', mini: 'mode', title: '버전 고르기', text: '카드뉴스(글 카드) 또는 사진 캐러셀(사진 위에 글)을 골라요.' },
    { id: 'step-3', icon: 'photo', mini: 'make', title: '상품 정보·사진 넣고 만들기', text: photoWord },
    { id: 'step-4', icon: 'pen', mini: 'edit', title: '카드 고치기', text: '카드 편집 탭에서 글을 고치거나, 아래 입력창에 말로 요청해요. 예: "3번 짧게", "베이지로", "3번 글 위로".' },
    { id: 'step-5', icon: 'search', mini: 'review', title: '근거·검수 확인', text: '🔎가 붙은 문장은 근거가 없어요. 완화하거나 빼거나, 직접 확인했다면 근거를 남겨요.' },
    { id: 'step-6', icon: 'link', mini: 'link', title: '파트너스 링크 붙여넣기', text: '캡션·쇼츠 탭에 파트너스 링크를 붙여넣으면 캡션 첫 줄에 고지 문구가 자동으로 들어가요.' },
    { id: 'step-7', icon: 'download', mini: 'export', title: '내보내기', text: '내보내기에서 체크리스트를 확인하고 zip을 받아 인스타에 올려요.' },
  ];
}

const FAQ = [
  ['faq-key', '키는 어디서 만드나요?', 'aistudio.google.com/apikey 에서 결제를 연결하지 않은 새 프로젝트로 만들면 무료예요. 만든 키를 설정에 붙여넣고 "키 연결 확인"을 눌러요.'],
  ['faq-402', '"결제·크레딧"(402) 오류가 나요', '크레딧이 소진된 프로젝트의 키예요. 결제를 연결하지 않은 새 프로젝트에서 키를 새로 만들어 바꿔 보세요.'],
  ['faq-429', '"요청이 너무 많아요"(429)가 나와요', '무료 키는 분당 요청 수가 제한돼요. 잠시 뒤 다시 눌러 보세요. 막히면 앱이 알아서 한 장씩 만들기로 바꿔 이어가요.'],
  ['faq-safe', '키는 안전한가요?', '키는 이 브라우저에만 저장되고 개발자나 다른 서버로 보내지 않아요. 공용 컴퓨터에서는 다 쓴 뒤 설정에서 "저장된 키 지우기"를 눌러 주세요.'],
  ['faq-disclosure', '파트너스 고지 문구를 끌 수 있나요?', '끌 수 없어요. 쿠팡 파트너스 규정 때문에 캡션 첫 줄에 항상 들어가요. 문구 모양만 설정에서 고를 수 있어요.'],
  ['faq-photos', '사진은 몇 장까지 쓸 수 있나요?', '사진 캐러셀은 2장에서 10장까지예요. 순서가 카드 순서이고 1번이 커버예요.'],
  ['faq-flag', '🔎 표시는 뭔가요?', '근거가 확인되지 않은 주장이에요. "완화해서 쓰기", "빼기", "내가 확인했어요" 중 하나로 정리한 뒤 올려 주세요.'],
];

function overlayEl() {
  let o = document.getElementById('overlay');
  if (!o) { o = h('div', { id: 'overlay', class: 'overlay', hidden: true }); document.body.append(o); }
  return o;
}

export function closeGuide() {
  const o = document.getElementById('overlay');
  if (!o) return;
  o.hidden = true; o.replaceChildren();
  document.body.classList.remove('overlay-open');
}

/** 사용 방법 열기. focus: 'step-1' 처럼 단계 id 또는 'faq-key' 처럼 질문 id 를 펼쳐 보여 준다. */
export function openGuide({ focus } = {}) {
  const o = overlayEl();
  const card = (q) => h('div', { class: `qs-card qs-${q.tone}` },
    q.done ? h('span', { class: 'qs-done' }, '완성!') : null,
    h('span', { class: 'qs-icon' }, icon(q.icon, { size: 24 })),
    h('span', { class: 'qs-step' }, `STEP ${q.n}`), h('strong', { class: 'qs-title' }, q.title), h('span', { class: 'qs-line' }, q.line));
  const list = steps().map((st, i) => h('li', { class: 'guide-step', id: st.id },
    h('span', { class: 'guide-no' }, String(i + 1)),
    h('div', { class: 'guide-step-text' }, h('strong', null, st.title), h('p', null, st.text)),
    mini(st.mini)));
  const faq = FAQ.map(([id, q, a]) => h('details', { class: 'faq', id, open: focus === id }, h('summary', null, q), h('p', null, a)));
  o.replaceChildren(h('div', { class: 'sheet guide-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': '사용 방법', id: 'guide-sheet' },
    h('div', { class: 'sheet-head' }, h('span', { class: 'pill-badge' }, '사용 가이드'), h('button', { type: 'button', class: 'btn', id: 'btn-guide-close', onclick: closeGuide }, '닫기')),
    h('div', { class: 'sheet-body guide-body', tabindex: -1 },
      h('h2', { class: 'guide-title' }, '단 3단계로 끝나는', h('br'), h('span', { class: 'grad' }, '캐러셀 만들기')),
      h('p', { class: 'guide-sub' }, '상품 사진과 이름만 넣으면 카드·캡션·쇼츠 대본까지 한 번에 만들어요.'),
      h('h3', { class: 'guide-h' }, '3단계 퀵 스타트'),
      h('div', { class: 'qs-grid' }, ...QUICK.map(card)),
      h('h3', { class: 'guide-h' }, '자세히 보기'),
      h('ol', { class: 'guide-steps' }, ...list),
      h('h3', { class: 'guide-h' }, '자주 묻는 질문'),
      h('div', { class: 'faq-list' }, ...faq))));
  o.hidden = false;
  document.body.classList.add('overlay-open');
  o.onkeydown = (e) => { if (e.key === 'Escape') closeGuide(); };
  if (focus) setTimeout(() => document.getElementById(focus)?.scrollIntoView({ block: 'start' }), 30);
  else o.querySelector('.sheet-body')?.focus();
}

// ───────────────────────── 첫 방문 띠 ─────────────────────────
export async function guideSeen() { try { return !!(await store.kvGet('guideSeen', null)); } catch { return true; } }
export function markGuideSeen() { store.kvSet('guideSeen', { at: Date.now() }).catch(() => {}); }

/** 시작 화면 위 3단계 요약 띠. onClose: 닫았을 때(다시 안 뜸). */
export function guideBand({ onClose }) {
  const steps3 = QUICK.map((q, i) => [
    h('span', { class: 'band-step' }, h('span', { class: 'band-no' }, String(i + 1)), h('span', { class: 'band-txt' }, q.title)),
    i < 2 ? icon('arrowRight', { size: 18, cls: 'band-arrow' }) : null,
  ]);
  return h('section', { class: 'card guide-band', id: 'guide-band', 'aria-label': '처음 쓰는 방법' },
    h('div', { class: 'band-head' },
      h('strong', null, '처음이세요? 3단계면 끝나요'),
      h('button', { type: 'button', class: 'btn btn-quiet band-close', id: 'btn-band-close', 'aria-label': '안내 닫기', onclick: onClose }, icon('close', { size: 20 }))),
    h('div', { class: 'band-steps' }, ...steps3.flat()),
    h('button', { type: 'button', class: 'btn', id: 'btn-band-more', onclick: () => openGuide() }, '자세히 보기'));
}
