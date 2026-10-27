// 카드 글씨체 목록 (렌더러·화면 공통). 파일은 extension/fonts/ (tools/copy-fonts.js 가 복사, 모두 OFL).
// - family: 캔버스·CSS 에서 쓰는 이름(다른 글꼴과 섞이지 않게 'BC ' 접두사).
// - weight: 이 글꼴 파일의 실제 굵기. 굵기가 하나뿐인 글꼴에 700 을 주면 브라우저가 가짜 굵게를 만들어 뭉개지므로 이 값으로만 그린다.
// - files: 한글 파일(ko)과 영문·숫자 파일(latin)을 unicodeRange 로 나눠 등록한다. 고를 때만 불러온다(지연 로드).
export const KO_RANGE = 'U+1100-11FF, U+3000-303F, U+3130-318F, U+A960-A97F, U+AC00-D7AF, U+D7B0-D7FF, U+FF00-FFEF';
export const LATIN_RANGE = 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';

export const CARD_FONTS = [
  { key: 'pretendard', name: '프리텐다드', desc: '깔끔한 기본', family: 'Pretendard', weight: 700, bodyWeight: 500, files: null },
  { key: 'blackhan', name: '검은고딕', desc: '굵고 강렬하게', family: 'BC Black Han Sans', weight: 400, files: ['BlackHanSans-ko.woff2', 'BlackHanSans-latin.woff2'] },
  { key: 'dohyeon', name: '도현', desc: '또박또박 귀엽게', family: 'BC Do Hyeon', weight: 400, files: ['DoHyeon-ko.woff2', 'DoHyeon-latin.woff2'] },
  { key: 'jua', name: '주아', desc: '동글동글 말랑하게', family: 'BC Jua', weight: 400, files: ['Jua-ko.woff2', 'Jua-latin.woff2'] },
  { key: 'gowun', name: '고운돋움', desc: '부드럽고 차분하게', family: 'BC Gowun Dodum', weight: 400, files: ['GowunDodum-ko.woff2', 'GowunDodum-latin.woff2'] },
  { key: 'myeongjo', name: '나눔명조', desc: '감성 있게', family: 'BC Nanum Myeongjo', weight: 700, files: ['NanumMyeongjo-ko.woff2', 'NanumMyeongjo-latin.woff2'] },
  { key: 'pen', name: '나눔손글씨 펜', desc: '손글씨 느낌', family: 'BC Nanum Pen Script', weight: 400, files: ['NanumPenScript-ko.woff2', 'NanumPenScript-latin.woff2'] },
];
export const DEFAULT_FONT = 'pretendard';
export const fontByKey = (key) => CARD_FONTS.find((f) => f.key === key) || CARD_FONTS[0];

const loaded = new Map(); // key → Promise<boolean>

/** 카드 글씨체를 문서(document.fonts)에 등록하고 불러온다. 같은 글꼴은 한 번만. 실패해도 throw 하지 않고 false(기본 글꼴로 그림).
 *  패널·옵션·렌더러 어디서나 쓴다. 서비스워커에서는 부르지 않는다. */
export function ensureCardFont(key) {
  const f = fontByKey(key);
  if (!f.files) return Promise.resolve(true); // Pretendard 는 render.js 가 이미 등록
  if (loaded.has(f.key)) return loaded.get(f.key);
  const url = (file) => (globalThis.chrome?.runtime?.getURL ? chrome.runtime.getURL('fonts/' + file) : 'fonts/' + file);
  const p = (async () => {
    try {
      const faces = [
        new FontFace(f.family, `url("${url(f.files[0])}") format("woff2")`, { weight: String(f.weight), unicodeRange: KO_RANGE }),
        new FontFace(f.family, `url("${url(f.files[1])}") format("woff2")`, { weight: String(f.weight), unicodeRange: LATIN_RANGE }),
      ];
      await Promise.all(faces.map((ff) => ff.load()));
      faces.forEach((ff) => document.fonts.add(ff));
      return true;
    } catch (e) {
      console.warn('[fonts] 글씨체를 불러오지 못해 기본 글꼴로 그립니다:', f.key, e?.message || e);
      loaded.delete(f.key);
      return false;
    }
  })();
  loaded.set(f.key, p);
  return p;
}
