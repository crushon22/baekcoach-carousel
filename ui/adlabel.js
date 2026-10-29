// 광고 표기 옵션: 위치(없음·4모서리) 아이콘 세그먼트 + 모양 견본 4개 + 문구 칩 4개 + 크기. 계약: docs/색편집_광고표기.md
// 시작 화면 "옵션"(실시간 미리보기에 반영)과 결과 화면 "디자인"(카드에 바로 반영)이 같은 부품을 쓴다.
import * as R from '../lib/render.js';
import { h } from './dom.js';
import { S } from './app.js';
import { segment } from './segment.js';
import { icon } from './icons.js';
import { presets } from './coloredit.js';

export const AD_POS = [
  { value: 'none', icon: 'adNone', label: '표시 없음' },
  { value: 'tl', icon: 'adTL', label: '왼쪽 위' },
  { value: 'tr', icon: 'adTR', label: '오른쪽 위' },
  { value: 'bl', icon: 'adBL', label: '왼쪽 아래' },
  { value: 'br', icon: 'adBR', label: '오른쪽 아래' },
];
export const AD_LOOKS = [
  { value: 'box', label: '바탕 상자' }, { value: 'shadow', label: '그림자' }, { value: 'plain', label: '글자만' }, { value: 'outline', label: '테두리 상자' },
];
export const AD_TEXTS = ['[광고]', '광고', '#광고', '유료 광고'];
export const AD_SIZES = [{ value: 's', label: '작게', text: '작게' }, { value: 'm', label: '보통', text: '보통' }, { value: 'l', label: '크게', text: '크게' }];

/** 기본값: 카드뉴스는 표시 없음, 사진 캐러셀은 왼쪽 위 · 바탕 상자 */
// 광고 표기는 카드뉴스·사진 캐러셀 모두 기본 켬(2026-10-29 사용자 결정: 파트너스 글이라 표기는 필수, 캡션 고지문은 뺌)
export const defaultAd = (mode) => ({ on: true, position: 'tl', look: 'box', text: '[광고]', size: 'm', color: null, mode });
export const adCfg = (mode = S.mode) => (S.ad[mode] = { ...defaultAd(mode), ...(S.ad[mode] || {}) });

/** 설정 → carousel 필드 */
const HEX6 = /^#[0-9a-fA-F]{6}$/;
const okColor = (v) => (typeof v === 'string' && HEX6.test(v) ? v.toUpperCase() : null);
export const adFields = (cfg) => {
  const st = { position: cfg.position, look: cfg.look, text: cfg.text, size: cfg.size };
  const col = okColor(cfg.color); if (col) st.color = col;   // 비우면 렌더러가 배경에 맞춰 흰색/잉크를 고른다(자동)
  return { adLabel: !!cfg.on, adLabelStyle: st };
};
/** carousel → 설정 */
export function cfgFromCarousel(c) {
  const st = c?.adLabelStyle || {};
  return { on: c?.adLabel ?? true, position: st.position || 'tl', look: st.look || 'box', text: st.text || '[광고]', size: st.size || 'm', color: okColor(st.color) };
}

// 견본 그림: 렌더러의 renderAdLabelSample 이 있으면 그것으로, 없거나 실패하면 CSS 로 흉내 낸다
function sample(look, text, color) {
  const box = h('span', { class: 'ad-sample-img', 'aria-hidden': 'true' });
  const fallback = () => box.replaceChildren(h('span', { class: `ad-fb ad-fb-${look}` }, text));
  const f = R.renderAdLabelSample;
  if (typeof f !== 'function') { fallback(); return box; }
  Promise.resolve().then(() => f({ position: 'tl', look, text, size: 'm', ...(color ? { color } : {}) }, { bg: 'photo' })).then((res) => {
    if (res instanceof Blob) box.replaceChildren(h('img', { src: URL.createObjectURL(res), alt: '' }));
    else if (res && res.nodeType === 1) { res.classList?.add('ad-sample-canvas'); box.replaceChildren(res); }
    else if (typeof res === 'string' && res.startsWith('data:')) box.replaceChildren(h('img', { src: res, alt: '' }));
    else fallback();
  }).catch(fallback);
  return box;
}

/**
 * cfg: {on, position, look, text, size}  onChange(patch)  lowContrast: 렌더러가 "광고 표기가 잘 안 보인다"고 알려 준 경우  hasLink: 파트너스 링크가 있는지
 */
export function adPanel({ cfg, onChange, lowContrast = false, hasLink = false }) {
  const pos = segment({ id: 'ad-position', label: '위치', value: cfg.on ? cfg.position : 'none', items: AD_POS,
    onPick: (v) => onChange(v === 'none' ? { on: false } : { on: true, position: v }) });
  const kids = [pos];
  if (cfg.on) {
    kids.push(h('div', { class: 'seg-group' }, h('span', { class: 'seg-label' }, '모양'),
      h('div', { class: 'ad-looks', id: 'ad-look', role: 'group', 'aria-label': '광고 표기 모양' },
        ...AD_LOOKS.map((l) => h('button', { type: 'button', class: 'ad-look', 'data-value': l.value, 'aria-pressed': String(cfg.look === l.value), 'aria-label': l.label, onclick: () => onChange({ look: l.value }) },
          sample(l.value, cfg.text, okColor(cfg.color)), h('span', { class: 'ad-look-name' }, l.label))))));
    kids.push(h('div', { class: 'seg-group' }, h('span', { class: 'seg-label' }, '문구'),
      h('div', { class: 'chips', id: 'ad-text', role: 'group', 'aria-label': '광고 표기 문구' },
        ...AD_TEXTS.map((t) => h('button', { type: 'button', class: 'chip', 'data-value': t, 'aria-pressed': String(cfg.text === t), onclick: () => onChange({ text: t }) }, t)))));
    kids.push(segment({ id: 'ad-size', label: '크기', value: cfg.size, items: AD_SIZES, onPick: (v) => onChange({ size: v }) }));
    kids.push(adColorRow(cfg, onChange));
    if (lowContrast) kids.push(adContrastLine(cfg));
  } else {
    kids.push(h('p', { class: 'warn-line small', id: 'ad-off-note' }, hasLink ? '파트너스 링크가 있는 글이에요. 표시를 권장해요.' : '파트너스 게시물이면 표시를 권장해요.'));
  }
  return h('div', { class: 'ad-panel', id: 'ad-panel' }, ...kids);
}

/** 광고 표기가 잘 안 보일 때 한 줄 안내. 글자색을 직접 골랐으면 "자동"을, 아니면 바탕 상자를 권한다 */
export function adContrastLine(cfg) {
  const msg = okColor(cfg.color)
    ? '⚠️ 이 글자색은 배경과 비슷해서 잘 안 보여요. "자동"이나 바탕 상자를 권해요.'
    : '⚠️ 이 사진에선 잘 안 보여요. 바탕 상자를 권해요.';
  return h('p', { class: 'warn-line small', id: 'ad-contrast' }, msg);
}

/** 글자색: 자동(배경에 맞춰 흰색/잉크) + 견본 색 + 직접 고르기 */
function adColorRow(cfg, onChange) {
  const cur = okColor(cfg.color);
  const input = h('input', { type: 'color', class: 'color-input', value: cur || '#FFFFFF', 'aria-label': '광고 표기 글자색 직접 고르기' });
  input.addEventListener('change', () => onChange({ color: input.value.toUpperCase() }));
  const auto = h('button', { type: 'button', class: 'chip ad-color-auto', 'data-color': 'auto', 'aria-pressed': String(!cur), onclick: () => onChange({ color: null }) }, '자동');
  return h('div', { class: 'color-row', id: 'ad-color', 'data-key': 'adColor' },
    h('div', { class: 'color-head' }, h('span', { class: 'seg-label' }, '글자색'),
      h('span', { class: 'color-now' }, cur ? h('span', { class: 'swatch-dot sm', style: { background: cur } }) : null, h('span', null, cur || '자동 (배경에 맞춰요)'))),
    h('div', { class: 'color-rail' }, auto,
      ...presets().map((p) => h('button', { type: 'button', class: 'swatch-btn', 'data-color': p.toUpperCase(), 'aria-pressed': String(p.toUpperCase() === cur), 'aria-label': `광고 표기 글자색 ${p}`, onclick: () => onChange({ color: p.toUpperCase() }) }, h('span', { class: 'swatch-dot', style: { background: p } }))),
      h('label', { class: 'swatch-custom' }, icon('palette', { size: 18 }), h('span', null, '직접'), input)));
}
