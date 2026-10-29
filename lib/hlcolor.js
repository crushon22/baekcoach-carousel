// 강조색을 제품 사진에 어울리는 색으로(2026-10-29 사용자 요청: "포인트 색상은 제품 이미지와 잘 어울리는 색으로").
// 사진의 대표색(render.js extractColors, 진한 순 hex 배열) 중 채도가 있는 첫 색을 골라, 사진 위 흰 글씨·검은 테두리 옆에서도 잘 읽히게 밝기를 맞춘다.
// 순수 함수(서비스워커·패널·node 어디서나).

export function hexToHsl(hex) {
  const m = String(hex || '').trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h, s, l };
}

export function hslToHex(h, s, l) {
  const f = (p, q, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
  let r, g, b;
  if (s === 0) r = g = b = l;
  else { const q = l < 0.5 ? l * (1 + s) : l + s - l * s; const p = 2 * l - q; r = f(p, q, h + 1 / 3); g = f(p, q, h); b = f(p, q, h - 1 / 3); }
  const to = (x) => Math.round(x * 255).toString(16).padStart(2, '0').toUpperCase();
  return `#${to(r)}${to(g)}${to(b)}`;
}

export const DEFAULT_HIGHLIGHT = '#FFE14D';

/**
 * 사진 대표색 목록(hex[]) → 강조색 hex. 채도 0.35 이상·너무 어둡거나 밝지 않은 첫 색의 색상(hue)을 쓰고,
 * 채도는 0.65 이상, 밝기는 0.62~0.75 로 올려 어두운 그라데이션·검은 테두리 위에서 읽히게 한다. 맞는 색이 없으면 기본 노랑.
 */
export function highlightFromColors(hexes, fallback = DEFAULT_HIGHLIGHT) {
  for (const hx of hexes || []) {
    const c = hexToHsl(hx);
    if (!c || c.s < 0.35 || c.l < 0.12 || c.l > 0.9) continue;
    const l = c.l < 0.62 ? 0.68 : Math.min(0.75, c.l);
    return hslToHex(c.h, Math.max(0.65, c.s), l);
  }
  return fallback;
}
