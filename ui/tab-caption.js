// 캡션 탭: 캡션 본문(직접 고치기·다시 쓰기) · 해시태그(3~7개) · 최종 캡션 복사.
// 2026-10-29 사용자 결정으로 뺀 것: 파트너스 링크 칸·고지문 안내·"맨 처음 보이는 부분" 미리보기·쇼츠 대본·쇼츠 대본 → 캐러셀.
// 링크는 게시물에 넣지 않고, 댓글이 달리면 DM 으로 보내는 흐름이라 캡션은 본문 + 댓글 유도 + 해시태그만 남긴다.
import { HASHTAG_MAX } from '../lib/ai-util.js';
import { h3i } from './icons.js';
import { h, setChildren, debounce, copyText, toast } from './dom.js';
import { S, fn, composed, finalTags, refreshCaptionInFrame, scheduleSave, scheduleReview } from './app.js';

const ui = { captionBusy: false };
let host;

function postText() {
  const c = composed();
  const tags = finalTags();
  return tags.length ? `${c.text}\n\n${tags.join(' ')}` : c.text;
}

/** 입력 중에도 호출되는 가벼운 갱신: 최종 캡션·경고·해시태그 개수 */
export function paintCaptionLive() {
  const c = composed();
  if (!c) return;
  const fin = document.getElementById('final-caption');
  if (fin) fin.textContent = postText();
  const warns = document.getElementById('caption-warnings');
  if (warns) setChildren(warns, ...c.warnings.map((w) => h('p', { class: 'warn-line', 'data-code': w.code }, `⚠️ ${w.messageKo}`)));
  const tags = finalTags();
  const tc = document.getElementById('tag-count');
  if (tc) {
    tc.textContent = `${tags.length}/${HASHTAG_MAX}개`;
    tc.classList.toggle('over', tags.length > HASHTAG_MAX);
  }
  const tw = document.getElementById('tag-warning');
  if (tw) tw.textContent = tags.length > HASHTAG_MAX ? `해시태그가 ${tags.length}개예요. 3~${HASHTAG_MAX}개가 좋아서 ${tags.length - HASHTAG_MAX}개를 줄여 주세요.` : '';
}

export function renderCaption() {
  host = host || document.getElementById('tab-caption');
  const p = S.project;
  if (!p) { setChildren(host); return; }

  const cap = h('textarea', { id: 'caption-text', class: 'input', rows: 7, 'aria-label': '캡션 본문' });
  cap.value = p.caption || '';
  const sync = debounce(() => { refreshCaptionInFrame(); scheduleReview(); scheduleSave(); }, 400);
  cap.addEventListener('input', () => { p.caption = cap.value; paintCaptionLive(); sync(); });

  const tagBox = h('textarea', { id: 'tags-text', class: 'input', rows: 2, 'aria-label': '해시태그' });
  tagBox.value = (p.hashtags || []).join(' ');
  tagBox.addEventListener('input', () => {
    p.hashtags = tagBox.value.split(/[\s,]+/).filter(Boolean).map((t) => (t.startsWith('#') ? t : `#${t}`));
    paintCaptionLive(); scheduleSave();
  });

  const word = p.plan?.commentWord || '';
  const captionSection =
    h('section', { class: 'group', id: 'caption-group' },
      h3i('bubble', '캡션'),
      h('label', { class: 'label', for: 'caption-text' }, '캡션 본문 (직접 고칠 수 있어요)'), cap,
      p.options?.tease
        ? h('p', { class: 'muted small', id: 'caption-tease-note' }, `댓글 단어는 "${word || '나도'}"예요. 댓글이 달리면 DM으로 쿠팡 파트너스 링크를 보내 주세요. 캡션에는 링크를 넣지 않아요.`)
        : h('p', { class: 'muted small', id: 'caption-tease-note' }, '마지막 줄은 댓글 유도예요. 댓글이 달리면 DM으로 링크를 보내 주세요.'),
      h('button', { type: 'button', class: 'btn btn-block', id: 'btn-caption-regen', disabled: ui.captionBusy, onclick: regenCaption }, ui.captionBusy ? '다시 쓰는 중…' : '캡션 다시 쓰기'));

  const tagSection =
    h('section', { class: 'group', id: 'tag-group' },
      h('div', { class: 'label-row' }, h3i('bubble', '해시태그'), h('span', { class: 'count', id: 'tag-count' })),
      tagBox,
      h('p', { class: 'muted small' }, `3~${HASHTAG_MAX}개가 좋아요. 번호·색상명은 태그에도 넣지 않아요.`),
      h('p', { class: 'warn-line', id: 'tag-warning' }));

  const finalSection =
    h('section', { class: 'group', id: 'final-group' },
      h3i('check', '최종 캡션'),
      h('p', { class: 'muted small' }, '이대로 복사해서 인스타에 붙여 넣으세요. 해시태그는 맨 아래에 붙어요.'),
      h('div', { class: 'warnings', id: 'caption-warnings' }),
      h('pre', { class: 'final-caption', id: 'final-caption', tabindex: 0 }),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn btn-primary', id: 'btn-copy-caption', onclick: async () => toast((await copyText(postText())) ? '캡션을 복사했어요.' : '복사하지 못했어요. 글을 길게 눌러 직접 복사해 주세요.') }, '캡션 복사'),
        h('button', { type: 'button', class: 'btn', id: 'btn-copy-tags', onclick: async () => toast((await copyText(finalTags().join(' '))) ? '해시태그를 복사했어요.' : '복사하지 못했어요.') }, '해시태그만 복사')));

  setChildren(host, captionSection, tagSection, finalSection);
  paintCaptionLive();
}

async function regenCaption() {
  ui.captionBusy = true; renderCaption();
  await fn.regenerate('caption', { label: '캡션을 다시 쓰는 중' });
  ui.captionBusy = false;
  if (S.tab === 'caption') renderCaption();
}
