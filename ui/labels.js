// 화면에 보이는 이름표. (규칙이 아니라 표시용 글자)
import { TEMPLATES } from '../lib/render.js';

export const TYPE_LABELS = {
  list: '리스트형', sales: '제품판매형', problem: '문제해결형', checklist: '체크리스트형', compare: '비교형',
  story: '스토리형', reviews: '후기 모음형', qna: 'Q&A형', ranking: '랭킹형',
};
export const LAYOUT_LABELS = {
  title: '제목 크게', 'photo-full': '사진 가득', split: '사진 반반', number: '번호 강조', quote: '인용', table: '표', cta: '마무리 버튼',
};
export const LAYOUT_SLOT = { 'photo-full': 'hero', split: 'side' };
export const TEMPLATE_LABELS = Object.fromEntries(Object.entries(TEMPLATES).map(([k, v]) => [k, v.name]));
export const HOOK_LABELS = ['숫자형', '질문형', '반전형'];
export const STYLE_HELP = { 짧게: '글자를 줄여요', 감성: '감정을 살려요', 근거형: '사실을 붙여요', 다르게: '다른 각도로' };
export const CLAIM_TYPE = { fact: '사실', opinion: '의견', hype: '과장' };
export const IMAGE_CHIPS = ['더 밝게', '따뜻하게', '미니멀'];
export const COUNT_OPTIONS = [5, 6, 7, 8];
