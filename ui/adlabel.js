// 광고 표기 옵션: 위치(없음·4모서리) 아이콘 세그먼트 + 모양 견본 4개 + 문구 칩 4개 + 크기. 계약: docs/색편집_광고표기.md
// 시작 화면 "옵션"(실시간 미리보기에 반영)과 결과 화면 "디자인"(카드에 바로 반영)이 같은 부품을 쓴다.
import * as R from '../lib/render.js';
import { h } from './dom.js';
import { S } from './app.js';
import { segment } from './segment.js';

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
export const defaultAd = (mode) => ({ on: mode === 'photo', position: 'tl', look: 'box', text: '[광고]', size: 'm' });
export const adCfg = (mode = S.mode) => (S.ad[mode] = { ...defaultAd(mode), ...(S.ad[mode] || {}) });

/** 설정 → carousel 필드 */
export const adFields = (cfg) => ({ adLabel: !!cfg.on, adLabelStyle: { position: cfg.position, look: cfg.look, text: cfg.text, size: cfg.size } });
/** carousel → 설정 */
export function cfgFromCarousel(c) {
  const st = c?.adLabelStyle || {};
  return { on: c?.adLabel ?? (c?.mode === 'photo'), position: st.position || 'tl', look: st.look || 'box', text: st.text || '[광고]', size: st.size || 'm' };
}

// 견본 그림: 렌더러의 renderAdLabelSample 이 있으면 그것으로, 없거나 실패하면 CSS 로 흉내 낸다
function sample(look, text) {
  const box = h('span', { class: 'ad-sample-img', 'aria-hidden': 'true' });
  const fallback = () => box.replaceChildren(h('span', { class: `ad-fb ad-fb-${look}` }, text));
  const f = R.renderAdLabelSample;
  if (typeof f !== 'function') { fallback(); return box; }
  Promise.resolve().then(() => f({ position: 'tl', look, text, size: 'm' }, { bg: 'photo' })).then((res) => {
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
          sample(l.value, cfg.text), h('span', { class: 'ad-look-name' }, l.label))))));
    kids.push(h('div', { class: 'seg-group' }, h('span', { class: 'seg-label' }, '문구'),
      h('div', { class: 'chips', id: 'ad-text', role: 'group', 'aria-label': '광고 표기 문구' },
        ...AD_TEXTS.map((t) => h('button', { type: 'button', class: 'chip', 'data-value': t, 'aria-pressed': String(cfg.text === t), onclick: () => onChange({ text: t }) }, t)))));
    kids.push(segment({ id: 'ad-size', label: '크기', value: cfg.size, items: AD_SIZES, onPick: (v) => onChange({ size: v }) }));
    if (lowContrast) kids.push(h('p', { class: 'warn-line small', id: 'ad-contrast' }, '⚠️ 이 사진에선 잘 안 보여요 — 바탕 상자를 권해요.'));
  } else {
    kids.push(h('p', { class: 'warn-line small', id: 'ad-off-note' }, hasLink ? '파트너스 링크가 있는 글이에요. 표시를 권장해요.' : '파트너스 게시물이면 표시를 권장해요.'));
  }
  return h('div', { class: 'ad-panel', id: 'ad-panel' }, ...kids);
}
