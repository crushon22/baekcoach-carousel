// 폰 프레임 미리보기 — 인스타 피드 모양(프로필 줄·카드·좋아요 줄·캡션), 좌우 스와이프(포인터)·키보드 화살표·현재 번호.
// 사이드 패널 폭 360~420px 에 맞춘다(폭 100%, 최대 420px). 카드가 하나씩 도착하면 그 칸만 다시 그린다(setCard).
// 사용:
//   const pf = mountPhoneFrame(el, { carousel, total: 7, onIndexChange: (i) => … });
//   pf.setCard(2, card);  pf.update(carousel);  pf.goTo(3);  pf.destroy();
import { renderCard } from './render.js';

const CSS_ATTR = 'data-bcpf-css';
function ensureCss() {
  if (typeof document === 'undefined' || document.querySelector(`link[${CSS_ATTR}]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./phone-frame.css', import.meta.url).href;
  link.setAttribute(CSS_ATTR, '1');
  document.head.appendChild(link);
}

// 아이콘은 HTML 파서로 만든다(네임스페이스 문자열 불필요)
const ICON = {
  heart: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 20.5s-8-4.9-8-11A4.6 4.6 0 0 1 12 6.6a4.6 4.6 0 0 1 8 2.9c0 6.100-8 11-8 11z"/></svg>',
  chat: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M20.5 12a8.500 8.500 0 0 1-12.300 7.600L3.500 20.500l1-4.300A8.500 8.500 0 1 1 20.500 12z"/></svg>',
  send: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M21.500 3.500 10 13.500M21.500 3.500 14.500 21l-4.500-7.500L2.500 9z"/></svg>',
  save: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M6 3.500h12v17l-6-4.500-6 4.500z"/></svg>',
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/**
 * container 안에 폰 프레임을 만든다.
 * opts: {carousel, total?, onIndexChange?(i), onCardTap?(i), caption?, scale?=0.75, showGuides?=false, startIndex?=0}
 *  - total: 카드가 아직 다 안 왔어도 칸 수를 미리 잡는다(미도착 칸은 뼈대). carousel.cards 에는 빈 칸(null)이 있어도 된다.
 * 반환: {update(carousel,{total,caption}), setCard(i,card), setTotal(n), goTo(i), getIndex(), setCaption(text), setGuides(bool), getCanvas(i), root, destroy()}
 */
export function mountPhoneFrame(container, opts = {}) {
  ensureCss();
  const scale = opts.scale > 0 ? opts.scale : 0.75;
  let car = normalize(opts.carousel || { cards: [] });
  let n = Math.max(opts.total || 0, car.total || 0, car.cards.length);
  let idx = 0;
  let caption = opts.caption || '';
  let destroyed = false;
  const version = [];       // 칸마다 그리기 번호(오래된 결과 버림)
  const canvases = [];
  let queue = Promise.resolve();

  function normalize(c) { return { ...c, cards: (c.cards || []).slice() }; }

  // ── DOM ──
  const root = el('div', 'bcpf');
  root.tabIndex = 0;
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', '인스타 피드 미리보기. 좌우 화살표 키로 카드를 넘깁니다.');
  const head = el('div', 'bcpf-head');
  const avatar = el('div', 'bcpf-avatar');
  const name = el('div', 'bcpf-name');
  const more = el('div', 'bcpf-more', '⋯');
  head.append(avatar, name, more);
  const view = el('div', 'bcpf-view');
  const track = el('div', 'bcpf-track');
  view.appendChild(track);
  const count = el('div', 'bcpf-count');
  const prev = el('button', 'bcpf-nav bcpf-prev', '‹'); prev.type = 'button'; prev.setAttribute('aria-label', '이전 카드');
  const next = el('button', 'bcpf-nav bcpf-next', '›'); next.type = 'button'; next.setAttribute('aria-label', '다음 카드');
  const guides = el('div', 'bcpf-guides');
  guides.setAttribute('aria-hidden', 'true');
  view.append(count, prev, next, guides);
  const bar = el('div', 'bcpf-bar');
  const icons = el('div', 'bcpf-icons');
  [ICON.heart, ICON.chat, ICON.send].forEach((h) => { const s = el('span', 'bcpf-icon'); s.innerHTML = h; icons.appendChild(s); });
  const dots = el('div', 'bcpf-dots');
  const saveIcon = el('span', 'bcpf-icon bcpf-save'); saveIcon.innerHTML = ICON.save;
  bar.append(icons, dots, saveIcon);
  const cap = el('div', 'bcpf-cap');
  const live = el('div', 'bcpf-live'); live.setAttribute('aria-live', 'polite');
  root.append(head, view, bar, cap, live);
  container.appendChild(root);

  const slides = [];
  function buildSlides() {
    while (slides.length < n) {
      const s = el('div', 'bcpf-slide');
      slides.push(s); track.appendChild(s); version.push(0); canvases.push(null);
    }
    while (slides.length > n) { slides.pop().remove(); version.pop(); canvases.pop(); }
    dots.replaceChildren(...Array.from({ length: n }, () => el('span', 'bcpf-dot')));
  }
  function skeleton(i) {
    const s = el('div', 'bcpf-skel');
    s.append(el('div', 'bcpf-skel-bar bcpf-w40'), el('div', 'bcpf-skel-bar bcpf-w80 bcpf-tall'), el('div', 'bcpf-skel-bar bcpf-w60'), el('div', 'bcpf-skel-bar bcpf-w70'));
    s.append(el('div', 'bcpf-skel-label', `카드 ${i + 1} 만드는 중…`));
    return s;
  }
  function paintHeader() {
    const acct = String(car.accountName || '').trim();
    name.textContent = acct || '내 계정';
    avatar.textContent = [...(acct || '백')][0];
    avatar.style.background = /^#[0-9a-fA-F]{6}$/.test(car.brandColor || '') ? car.brandColor : '#2563EB';
    cap.replaceChildren();
    const b = el('b', null, acct || '내 계정');
    const firstLine = String(caption || '').split('\n').find((l) => l.trim()) || '';
    cap.append(b, document.createTextNode(' ' + (firstLine || '캡션은 아래 탭에서 확인하세요.')));
  }
  function paintIndex() {
    count.textContent = `${idx + 1} / ${n}`;
    [...dots.children].forEach((d, i) => d.classList.toggle('bcpf-dot-on', i === idx));
    prev.disabled = idx <= 0; next.disabled = idx >= n - 1;
    slides.forEach((s, i) => { s.setAttribute('aria-hidden', i === idx ? 'false' : 'true'); });
    live.textContent = `카드 ${idx + 1} / ${n}`;
  }

  async function paintSlot(i) {
    if (destroyed || i >= n) return;
    const v = ++version[i];
    const card = car.cards[i];
    if (!card) { slides[i].replaceChildren(skeleton(i)); canvases[i] = null; return; }
    try {
      const canvas = await renderCard(car, i, { size: '4x5', scale, total: n });
      if (destroyed || v !== version[i] || !slides[i]) return;
      canvas.className = 'bcpf-canvas';
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `${i + 1}번 카드: ${String(card.headline || '').replace(/\s+/g, ' ')}`);
      slides[i].replaceChildren(canvas);
      canvases[i] = canvas;
    } catch (e) {
      if (destroyed || v !== version[i] || !slides[i]) return;
      const msg = el('div', 'bcpf-error', `카드 ${i + 1}을 그리지 못했어요 (패널): ${e && e.message || e}`);
      slides[i].replaceChildren(msg);
      console.warn('[phone-frame]', e);
    }
  }
  /** 현재 칸 → 가까운 칸 순서로 하나씩 그린다(렌더 동시 실행 방지) */
  function schedule(order) {
    queue = queue.then(async () => { for (const i of order) { if (destroyed) return; await paintSlot(i); await new Promise((r) => setTimeout(r, 0)); } });
    return queue;
  }
  function nearOrder() {
    const out = [];
    for (let d = 0; d < n; d++) { if (idx + d < n) out.push(idx + d); if (d && idx - d >= 0) out.push(idx - d); }
    return out;
  }

  // ── 이동 ──
  function applyTransform(dx = 0, animate = true) {
    track.style.transition = animate ? 'transform .28s cubic-bezier(.2,.8,.2,1)' : 'none';
    track.style.transform = `translate3d(calc(${-idx * 100}% + ${dx}px),0,0)`;
  }
  function goTo(i, { animate = true, silent = false } = {}) {
    const t = Math.max(0, Math.min(n - 1, Math.round(Number(i) || 0)));
    const changed = t !== idx;
    idx = t;
    applyTransform(0, animate);
    paintIndex();
    if (changed && !silent && opts.onIndexChange) { try { opts.onIndexChange(idx); } catch (e) { console.warn(e); } }
  }

  // ── 포인터(스와이프) ──
  let drag = null;
  view.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    if (e.target.closest && e.target.closest('.bcpf-nav')) return;
    drag = { x: e.clientX, t: performance.now(), dx: 0, moved: false, id: e.pointerId, w: view.clientWidth || 1 };
    try { view.setPointerCapture(e.pointerId); } catch { /* 캡처 실패는 무시 */ }
    root.focus({ preventScroll: true });
  });
  view.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    let dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) < 6) return;
    drag.moved = true;
    if ((idx === 0 && dx > 0) || (idx === n - 1 && dx < 0)) dx *= 0.35;   // 가장자리 저항
    drag.dx = dx;
    applyTransform(dx, false);
  });
  const endDrag = (e) => {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    const d = drag; drag = null;
    try { view.releasePointerCapture(d.id); } catch { /* 이미 해제됨 */ }
    if (!d.moved) { if (opts.onCardTap && e && e.type === 'pointerup') opts.onCardTap(idx); return; }
    const v = d.dx / Math.max(1, performance.now() - d.t);   // px/ms
    if (d.dx < -d.w * 0.18 || v < -0.5) goTo(idx + 1);
    else if (d.dx > d.w * 0.18 || v > 0.5) goTo(idx - 1);
    else goTo(idx);
  };
  view.addEventListener('pointerup', endDrag);
  view.addEventListener('pointercancel', endDrag);
  prev.addEventListener('click', () => goTo(idx - 1));
  next.addEventListener('click', () => goTo(idx + 1));
  root.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { goTo(idx - 1); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { goTo(idx + 1); e.preventDefault(); }
    else if (e.key === 'Home') { goTo(0); e.preventDefault(); }
    else if (e.key === 'End') { goTo(n - 1); e.preventDefault(); }
  });

  // ── 초기화 ──
  buildSlides();
  paintHeader();
  if (opts.showGuides) root.classList.add('bcpf-show-guides');
  goTo(opts.startIndex || 0, { animate: false, silent: true });
  schedule(nearOrder());

  return {
    root,
    /** 새 Carousel 로 전체 다시 그린다(템플릿 전환·수정 등). 현재 번호는 유지. */
    update(carousel, { total, caption: cp } = {}) {
      car = normalize(carousel || { cards: [] });
      n = Math.max(total || 0, car.total || 0, car.cards.length, 1);
      if (cp !== undefined) caption = cp;
      buildSlides(); paintHeader();
      goTo(Math.min(idx, n - 1), { animate: false, silent: true });
      return schedule(nearOrder());
    },
    /** i번 칸 하나만 도착 → 그 칸(과 peek 때문에 바뀌는 앞 칸)만 다시 그린다. 반환: 그리기 끝나는 Promise */
    setCard(i, card) {
      if (i < 0) return Promise.resolve();
      while (car.cards.length <= i) car.cards.push(null);
      car.cards[i] = card;
      if (i >= n) { n = i + 1; buildSlides(); paintIndex(); }
      const order = [i];
      if (car.peek && i > 0 && car.cards[i - 1]) order.push(i - 1);
      return schedule(order);
    },
    /** 칸 수 지정(플래너가 장수를 정했을 때). 새 칸은 뼈대로 보인다. */
    setTotal(total) {
      const prevN = n;
      n = Math.max(1, total | 0, car.cards.length);
      buildSlides();
      for (let i = prevN; i < n; i++) slides[i].replaceChildren(skeleton(i));
      goTo(Math.min(idx, n - 1), { animate: false, silent: true });
      return schedule([...Array(n).keys()].filter((i) => i < prevN));   // 장수가 바뀌면 "01 / 07" 이 바뀌므로 기존 칸도 다시
    },
    setCaption(text) { caption = text || ''; paintHeader(); },
    setGuides(on) { root.classList.toggle('bcpf-show-guides', !!on); },
    goTo(i, o) { goTo(i, o); },
    getIndex() { return idx; },
    getTotal() { return n; },
    getCanvas(i) { return canvases[i] || null; },
    /** 그리기 대기열이 빌 때까지 기다린다(테스트·캡처용) */
    whenIdle() { return queue; },
    destroy() {
      destroyed = true;
      root.remove();
      slides.length = 0; canvases.length = 0; version.length = 0;
    },
  };
}
