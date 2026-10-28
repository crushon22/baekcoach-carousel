// 색 편집: 카드뉴스(배경·제목·본문·강조) / 사진(글씨·테두리·강조 단어·띠·그라데이션). 견본 원 + 직접 고르기 + 되돌리기. AI 호출 없이 바로 다시 그린다.
// 계약: carousel.colors / carousel.overlayColors (docs/색편집_광고표기.md). 대비가 모자라면 렌더러가 meta.lowContrast 로 알려 준다.
import * as R from '../lib/render.js';
import { h } from './dom.js';
import { icon } from './icons.js';
import { S, BRAND, cards, refreshAll, scheduleSave } from './app.js';

const FALLBACK_PRESETS = ['#FFFFFF', '#111827', '#F5F5DC', '#FDE68A', '#F59E0B', '#EF4444', '#EC4899', '#8B5CF6', '#2563EB', '#10B981'];
const hex = (v) => (typeof v === 'string' ? v : v?.hex || v?.value || v?.color || '');
export const presets = () => {
  const p = Array.isArray(R.COLOR_PRESETS) ? R.COLOR_PRESETS.map(hex).filter((x) => /^#[0-9a-fA-F]{6}$/.test(x)) : [];
  return p.length ? p : FALLBACK_PRESETS;
};

const CN_ROWS = [['bg', '배경'], ['headline', '제목'], ['body', '본문'], ['accent', '강조']];
const PH_ROWS = [['text', '글씨'], ['stroke', '테두리·그림자'], ['highlight', '강조 단어'], ['shade', '띠·그라데이션']];
const PH_DEFAULT = { text: '#FFFFFF', stroke: '#000000', highlight: '#FFE14D', shade: '#000000' };
const WARN_KEY = { headline: 'headline', body: 'body', text: 'overlay', stroke: 'overlay', highlight: 'overlay', shade: 'overlay' };

/** 지금 실제로 쓰이는 색 */
export function currentColor(c, group, key) {
  if (group === 'overlayColors') return (c.overlayColors || {})[key] || PH_DEFAULT[key];
  const t = (R.TEMPLATES || {})[c.template] || (R.TEMPLATES || {}).basic || {};
  const o = c.colors || {};
  const brand = c.brandColor || BRAND;
  if (key === 'bg') return o.bg || t.bg || brand;
  if (key === 'headline') return o.headline || t.head || brand;
  if (key === 'body') return o.body || t.body || '#1A1F2B';
  return o.accent || c.accentColor || t.accent || '#F59E0B';
}

/** 모든 카드를 작게 그려 대비가 모자란 곳(meta.lowContrast)을 모은다 */
export async function lowContrastSet(carousel) {
  const set = new Set();
  const n = (carousel.cards || []).length;
  for (let i = 0; i < n; i++) {
    if (!carousel.cards[i]) continue;
    try { ((await R.renderCardMeta(carousel, i, { scale: 0.1, total: n })).meta.lowContrast || []).forEach((k) => set.add(k)); } catch { /* 점검 실패는 조용히 */ }
  }
  return set;
}

function row(c, group, key, label, { onPick, extra }) {
  const cur = currentColor(c, group, key);
  const input = h('input', { type: 'color', class: 'color-input', value: /^#[0-9a-fA-F]{6}$/.test(cur) ? cur : '#000000', 'aria-label': `${label} 색 직접 고르기` });
  input.addEventListener('change', () => onPick(input.value.toUpperCase()));
  const rail = h('div', { class: 'color-rail' },
    extra || null,
    ...presets().map((p) => h('button', { type: 'button', class: 'swatch-btn', 'data-color': p.toUpperCase(), 'aria-pressed': String(p.toUpperCase() === String(cur).toUpperCase()), 'aria-label': `${label} ${p}`, onclick: () => onPick(p.toUpperCase()) }, h('span', { class: 'swatch-dot', style: { background: p } }))),
    h('label', { class: 'swatch-custom' }, icon('palette', { size: 18 }), h('span', null, '직접'), input));
  return h('div', { class: 'color-row', 'data-key': key },
    h('div', { class: 'color-head' }, h('span', { class: 'seg-label' }, label), h('span', { class: 'color-now' }, h('span', { class: 'swatch-dot sm', style: { background: cur } }), h('span', null, String(cur).toUpperCase())), h('span', { class: 'color-warn', 'data-for': WARN_KEY[key] || key, hidden: true }, '⚠️ 글씨가 잘 안 보일 수 있어요')),
    rail);
}

/** extraAccent: 카드뉴스 강조 줄 맨 앞에 둘 노드(제품 색으로 맞추기 등) */
export function colorPanel({ extraAccent, onChange }) {
  const p = S.project;
  const c = p.carousel;
  const photo = c.mode === 'photo';
  const style = c.overlayStyle || 'outline';
  const set = (group, key, v) => { c[group] = { ...(c[group] || {}), [key]: v }; refreshAll(); scheduleSave(); onChange?.(); };
  let rows;
  if (photo) {
    rows = PH_ROWS.filter(([k]) => (k === 'stroke' ? ['outline', 'shadow'].includes(style) : k === 'shade' ? ['band', 'gradient'].includes(style) : true))
      .map(([k, l]) => row(c, 'overlayColors', k, l, { onPick: (v) => set('overlayColors', k, v) }));
  } else {
    rows = CN_ROWS.map(([k, l]) => row(c, 'colors', k, l, { onPick: (v) => set('colors', k, v), extra: k === 'accent' ? extraAccent : null }));
  }
  const hasCustom = photo ? !!Object.keys(c.overlayColors || {}).length : !!(Object.keys(c.colors || {}).length || c.accentColor);
  const reset = h('button', { type: 'button', class: 'btn', id: 'btn-colors-reset', disabled: !hasCustom, onclick: () => {
    if (photo) delete c.overlayColors; else { delete c.colors; delete c.accentColor; }
    refreshAll(); scheduleSave(); onChange?.();
  } }, icon('undo', { size: 18 }), '되돌리기');
  return h('div', { class: 'color-panel', id: 'color-panel' }, ...rows, h('div', { class: 'btn-row' }, reset));
}

/** 색 줄 옆 ⚠️ 를 렌더러 점검 결과로 채운다 */
export async function fillContrastWarnings(root = document) {
  const p = S.project;
  if (!p) return new Set();
  const low = await lowContrastSet(p.carousel);
  root.querySelectorAll('.color-warn').forEach((e) => { e.hidden = !low.has(e.dataset.for); });
  return low;
}
