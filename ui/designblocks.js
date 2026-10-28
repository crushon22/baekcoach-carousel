// 결과 화면 "디자인" 섹션의 공통 조각: 색 편집 + 광고 표기. 카드뉴스·사진 캐러셀 편집 탭이 같이 쓴다.
import { h } from './dom.js';
import { S, refreshAll, scheduleSave } from './app.js';
import { colorPanel, fillContrastWarnings } from './coloredit.js';
import { adPanel, adFields, cfgFromCarousel, adContrastLine } from './adlabel.js';

/** 색 묶음. extraAccent: 카드뉴스 강조 줄 앞에 둘 노드(제품 색으로 맞추기) */
export function colorBlock({ extraAccent, rerender }) {
  return h('div', { class: 'design-block', id: 'color-block' }, h('div', { class: 'label' }, '색'), colorPanel({ extraAccent, onChange: rerender }));
}

/** 광고 표기 묶음: 위치(없음·4모서리)·모양 견본·문구·크기. 바로 카드에 반영 */
export function adBlock({ rerender }) {
  const p = S.project;
  const cfg = cfgFromCarousel(p.carousel);
  return h('div', { class: 'design-block', id: 'ad-block' }, h('div', { class: 'label' }, '광고 표기'),
    adPanel({
      cfg, hasLink: !!p.link,
      onChange: (patch) => {
        const next = { ...cfgFromCarousel(p.carousel), ...patch };
        Object.assign(p.carousel, adFields(next));
        S.ad[p.carousel.mode === 'photo' ? 'photo' : 'cardnews'] = next;
        refreshAll(); scheduleSave(); rerender?.();
      },
    }));
}

/** 그린 뒤: 색 줄·광고 표기 옆 ⚠️ 를 렌더러 점검(meta.lowContrast)으로 채운다 */
export async function afterDesignRender(root) {
  const low = await fillContrastWarnings(root);
  const ad = root.querySelector('#ad-panel');
  const cfg = cfgFromCarousel(S.project.carousel);
  if (ad && low.has('adLabel') && !ad.querySelector('#ad-contrast') && cfg.on) ad.append(adContrastLine(cfg));
}
