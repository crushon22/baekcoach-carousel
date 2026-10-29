// 시작 화면의 4:5 실시간 미리보기: 입력하는 대로 "첫 카드"를 render.js 로 작게 그린다. 이 앱의 주인공.
// 카드뉴스: 상품 이름이 훅 자리에 들어간 커버 / 사진 모드: 첫 사진 + 상품 이름 오버레이. 고른 글씨체·스타일이 바로 반영된다.
import { renderCard } from '../lib/render.js';
import { h, debounce } from './dom.js';
import { S, el, BRAND } from './app.js';
import { ensureCardFont } from './fontpick.js';
import { adCfg, adFields } from './adlabel.js';
import { IS_WEB } from '../lib/platform.js';

const SAMPLE = '상품 이름이 여기 들어가요';
let ver = 0;
let drawn = 0;

function currentName() {
  const rec = S.rec;
  if (!IS_WEB && S.sel?.kind === 'search') return S.sel.item.title;
  if (!IS_WEB && rec?.product?.title) return rec.product.title;
  return (S.manual.title || '').trim();
}

function currentImageId() {
  if (S.mode === 'photo') return S.photos[0] || null;
  if (IS_WEB) return S.manual.imageIds?.[0] || null;
  if (S.sel?.kind === 'search') return S.sel.imageId || null;
  return S.manual.imageId || S.rec?.imageIds?.[S.photoIdx] || null;
}

/** 이름을 사진 위 줄(최대 3줄, 한 줄 12자 안쪽)로 나눈다 */
function toLines(text) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > 12 && cur) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3).map((l) => l.slice(0, 14));
}

function buildCarousel() {
  const name = currentName();
  const text = name || SAMPLE;
  const imageId = currentImageId();
  const base = { type: 'sales', template: 'basic', brandColor: BRAND, accountName: S.settings?.accountName || '', hasPartnersLink: false, font: S.font || 'pretendard', ...adFields(adCfg(S.mode === 'photo' ? 'photo' : 'cardnews')) };
  if (S.mode === 'photo') {
    const lines = toLines(text);
    return { ...base, mode: 'photo', overlayStyle: S.photoStyle || 'gradient',
      cards: [{ index: 0, role: '커버', layout: 'overlay', imageSlot: 'hero', ...(imageId ? { imageId } : {}), headline: lines.join('\n'), body: '', overlay: { lines, position: 'top', size: 'xl' } }] };
  }
  return { ...base, mode: 'cardnews',
    cards: [{ index: 0, role: '훅', layout: imageId ? 'photo-full' : 'title', imageSlot: imageId ? 'hero' : 'none', ...(imageId ? { imageId } : {}), headline: text.slice(0, 40), body: '' }] };
}

export async function drawPreview() {
  const host = document.getElementById('live-canvas');
  if (!host) return;
  const v = ++ver;
  try {
    await ensureCardFont(S.font);
    const canvas = await renderCard(buildCarousel(), 0, { size: '4x5', scale: 0.5, total: 7 });
    if (v !== ver || !document.body.contains(host)) return;
    canvas.className = 'preview-canvas';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `미리보기: ${currentName() || SAMPLE}`);
    host.replaceChildren(canvas);
    host.dataset.drawn = String(++drawn);
    host.dataset.text = currentName();
  } catch (e) {
    if (v === ver) host.replaceChildren(h('p', { class: 'muted small' }, '미리보기를 그리지 못했어요.'));
    console.warn('[panel] 미리보기', e);
  }
}

const debounced = debounce(drawPreview, 300);
/** delay 가 0 이면 바로, 아니면 그만큼 기다렸다가(입력 중 연속 호출은 한 번으로) 그린다 */
export function schedulePreview(delay = 300) {
  if (!delay) { drawPreview(); return; }
  if (delay >= 300) debounced(); else { setTimeout(drawPreview, delay); }
}

/** 시작 화면에서만 미리보기 칸을 만든다 */
export function renderPreview() {
  const host = el.livepreview;
  if (!host) return;
  if (S.phase !== 'start') { host.replaceChildren(); return; }
  if (!host.querySelector('#live-canvas')) {
    host.replaceChildren(h('div', { class: 'preview-frame', id: 'live-preview' }, h('div', { id: 'live-canvas', class: 'preview-canvas-wrap' })),
      h('p', { class: 'muted small center preview-note' }, '첫 카드 미리보기 · 입력하는 대로 바뀌어요'));
  }
  schedulePreview(0);
}
