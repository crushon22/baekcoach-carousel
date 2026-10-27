// 캡션·쇼츠 탭: 캡션(첫 줄 125자 미리보기), 해시태그(30개 상한), 파트너스 링크(만들기/붙여넣기), 최종 캡션 복사, 쇼츠 대본, 쇼츠 대본 → 캐러셀.
import { request } from '../lib/bus.js';
import { IS_WEB } from '../lib/platform.js';
import { normalizeLink, canonicalProductUrl } from '../lib/coupang.js';
import { h3i } from './icons.js';
import { h, setChildren, debounce, copyText, toast } from './dom.js';
import { S, fn, composed, finalTags, shortsText, refreshAll, refreshCaptionInFrame, runReview, scheduleSave, scheduleReview, saveNow } from './app.js';
import { showError } from './errors.js';

const ui = { linkNote: '', linkBusy: false, shortsBusy: false, captionBusy: false };
let host;

const PREVIEW_LEN = 125;

function postText() {
  const c = composed();
  const tags = finalTags();
  return tags.length ? `${c.text}\n\n${tags.join(' ')}` : c.text;
}

/** 입력 중에도 호출되는 가벼운 갱신: 125자 미리보기·최종 캡션·해시태그 개수 */
export function paintCaptionLive() {
  const c = composed();
  if (!c) return;
  const prev = document.getElementById('caption-preview');
  if (prev) {
    const t = c.text;
    prev.replaceChildren(
      h('span', null, t.length > PREVIEW_LEN ? t.slice(0, PREVIEW_LEN) : t),
      t.length > PREVIEW_LEN ? h('span', { class: 'more' }, '… 더보기') : null);
    const cnt = document.getElementById('preview-count');
    if (cnt) cnt.textContent = `고지 문구를 포함해 ${t.length}자 중 앞 ${Math.min(t.length, PREVIEW_LEN)}자가 보여요`;
  }
  const fin = document.getElementById('final-caption');
  if (fin) fin.textContent = postText();
  const warns = document.getElementById('caption-warnings');
  if (warns) setChildren(warns, ...c.warnings.map((w) => h('p', { class: 'warn-line', 'data-code': w.code }, `⚠️ ${w.messageKo}`)));
  const tags = finalTags();
  const tc = document.getElementById('tag-count');
  if (tc) {
    tc.textContent = `${tags.length}/30개`;
    tc.classList.toggle('over', tags.length > 30);
  }
  const tw = document.getElementById('tag-warning');
  if (tw) tw.textContent = tags.length > 30 ? `해시태그가 ${tags.length}개예요. 인스타는 30개까지만 쓸 수 있어서 ${tags.length - 30}개를 줄여야 해요.` : '';
}

export function renderCaption() {
  host = host || document.getElementById('tab-caption');
  const p = S.project;
  if (!p) { setChildren(host); return; }
  const c = composed();

  const cap = h('textarea', { id: 'caption-text', class: 'input', rows: 6, 'aria-label': '캡션 본문' });
  cap.value = p.caption || '';
  const sync = debounce(() => { refreshCaptionInFrame(); scheduleReview(); scheduleSave(); }, 400);
  cap.addEventListener('input', () => { p.caption = cap.value; paintCaptionLive(); sync(); });

  const tagBox = h('textarea', { id: 'tags-text', class: 'input', rows: 3, 'aria-label': '해시태그' });
  tagBox.value = (p.hashtags || []).join(' ');
  tagBox.addEventListener('input', () => {
    p.hashtags = tagBox.value.split(/[\s,]+/).filter(Boolean).map((t) => (t.startsWith('#') ? t : `#${t}`));
    paintCaptionLive(); scheduleSave();
  });

  const linkInput = h('input', { id: 'link-input', class: 'input', inputmode: 'url', placeholder: '파트너스에서 만든 링크를 붙여넣으세요', 'aria-label': '파트너스 링크' });
  linkInput.value = p.link || '';
  linkInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); setLink(linkInput.value); } });
  linkInput.addEventListener('paste', () => setTimeout(() => setLink(linkInput.value), 0));

  const hasKeys = !IS_WEB && !!S.cp?.hasKeys;
  const deepOk = !IS_WEB && canDeeplink();

  const captionSection =
    h('section', { class: 'group' },
      h3i('bubble', '캡션'),
      h('label', { class: 'label', for: 'caption-text' }, '캡션 본문 (직접 고칠 수 있어요)'), cap,
      h('div', { class: 'label' }, '올렸을 때 맨 처음 보이는 부분'),
      h('div', { class: 'preview-box', id: 'caption-preview' }),
      h('p', { class: 'muted small', id: 'preview-count' }),
      h('button', { type: 'button', class: 'btn btn-block', id: 'btn-caption-regen', disabled: ui.captionBusy, onclick: regenCaption }, ui.captionBusy ? '다시 쓰는 중…' : '캡션 다시 쓰기'));

  const tagSection =
    h('section', { class: 'group' },
      h('div', { class: 'label-row' }, h3i('bubble', '해시태그'), h('span', { class: 'count', id: 'tag-count' })),
      tagBox,
      h('p', { class: 'warn-line', id: 'tag-warning' }),
      null);

  const linkSection =
    h('section', { class: 'group', id: 'link-group' },
      h3i('link', '파트너스 링크'),
      hasKeys
        ? h('div', null,
          h('button', { type: 'button', class: 'btn btn-block', id: 'btn-deeplink', disabled: ui.linkBusy || !deepOk, onclick: makeDeeplink }, ui.linkBusy ? '링크 만드는 중…' : '링크 만들기'),
          h('p', { class: 'muted small' }, deepOk ? '내 파트너스 키로 이 상품의 링크를 만들어요. 캐러셀 하나에 한 번만 만들고, 이후에는 저장된 링크를 써요.' : '이 작업은 상품 주소를 몰라서 링크를 만들 수 없어요. 아래에 붙여넣어 주세요.'))
        : h('div', null, h('p', { class: 'muted', id: 'web-link-guide' }, 'partners.coupang.com 에 로그인해서 이 상품의 링크를 만든 뒤, 그 링크를 아래 칸에 붙여넣으세요.')),
      h('label', { class: 'label', for: 'link-input' }, '붙여넣은 링크'), linkInput,
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn btn-primary', id: 'btn-link-apply', onclick: () => setLink(linkInput.value) }, '링크 넣기'),
        p.link ? h('button', { type: 'button', class: 'btn', id: 'btn-link-clear', onclick: () => { linkInput.value = ''; setLink(''); } }, '링크 지우기') : null),
      ui.linkNote ? h('p', { class: 'warn-line', id: 'link-note' }, ui.linkNote) : null,
      p.link ? h('p', { class: 'ok-line small', id: 'link-current' }, `✅ 링크가 들어 있어요: ${p.link}`) : h('p', { class: 'warn-line small', id: 'link-missing' }, '아직 링크가 없어요. 링크가 없으면 내보내기 전에 경고가 떠요.'));

  const finalSection =
    h('section', { class: 'group', id: 'final-group' },
      h3i('check', '최종 캡션'),
      h('p', { class: 'muted small' }, '맨 윗줄 고지 문구는 쿠팡 파트너스 규정 때문에 자동으로 들어가고 끌 수 없어요. 문구 모양은 설정에서 고를 수 있어요.'),
      h('div', { class: 'warnings', id: 'caption-warnings' }),
      h('pre', { class: 'final-caption', id: 'final-caption', tabindex: 0 }),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn btn-primary', id: 'btn-copy-caption', onclick: async () => toast((await copyText(postText())) ? '캡션을 복사했어요.' : '복사하지 못했어요. 글을 길게 눌러 직접 복사해 주세요.') }, '캡션 복사'),
        h('button', { type: 'button', class: 'btn', id: 'btn-copy-tags', onclick: async () => toast((await copyText(finalTags().join(' '))) ? '해시태그를 복사했어요.' : '복사하지 못했어요.') }, '해시태그만 복사')));

  const shortsSection =
    h('section', { class: 'group', id: 'shorts-group' },
      h3i('sparkle', '쇼츠 대본'),
      p.shorts ? h('pre', { class: 'final-caption', id: 'shorts-text', tabindex: 0 }, shortsText(p.shorts)) : h('p', { class: 'muted' }, '아직 쇼츠 대본이 없어요. 아래 버튼으로 만들 수 있어요.'),
      h('div', { class: 'btn-row' },
        p.shorts ? h('button', { type: 'button', class: 'btn btn-primary', id: 'btn-copy-shorts', onclick: async () => toast((await copyText(shortsText(p.shorts))) ? '쇼츠 대본을 복사했어요.' : '복사하지 못했어요.') }, '대본 복사') : null,
        h('button', { type: 'button', class: 'btn', id: 'btn-shorts-regen', disabled: ui.shortsBusy, onclick: regenShorts }, ui.shortsBusy ? '만드는 중…' : (p.shorts ? '대본 다시 만들기' : '쇼츠 대본 만들기'))));

  const convertSection =
    h('section', { class: 'group', id: 'shorts-to-carousel' },
      h3i('sparkle', '쇼츠 대본 → 캐러셀'),
      h('p', { class: 'muted small' }, '가지고 있는 쇼츠 대본을 붙여 넣으면 새 캐러셀을 만들어요. 지금 작업은 "지난 작업"에 저장돼요.'),
      shortsInput());
  // 웹 버전은 링크 붙여넣기를 맨 앞에 둔다(파트너스 API 가 없어서 링크가 가장 중요한 입력)
  setChildren(host, ...(IS_WEB ? [linkSection, captionSection, tagSection, finalSection, shortsSection, convertSection] : [captionSection, tagSection, linkSection, finalSection, shortsSection, convertSection]));
  paintCaptionLive();
}

function shortsInput() {
  const ta = h('textarea', { class: 'input', id: 'shorts-in', rows: 4, placeholder: '쇼츠 대본이나 자막을 붙여 넣으세요 (10자 이상)', 'aria-label': '쇼츠 대본 붙여넣기' });
  return h('div', { class: 'form' }, ta, h('button', { type: 'button', class: 'btn btn-block', id: 'btn-shorts-convert', onclick: () => fn.makeFromShorts(ta.value) }, '이 대본으로 새 캐러셀 만들기'));
}

// ── 링크 ──
function productUrlForDeeplink() {
  const inp = S.project?.input;
  if (!inp) return null;
  if (inp.source === 'coupang_page' && inp.url) return inp.url;
  if (inp.productId) return canonicalProductUrl({ productId: inp.productId, itemId: inp.itemId, vendorItemId: inp.vendorItemId });
  return null;
}
const canDeeplink = () => !!productUrlForDeeplink();

async function setLink(raw) {
  const p = S.project;
  const lk = normalizeLink(raw);
  ui.linkNote = '';
  if (lk.state === 'invalid') {
    ui.linkNote = '링크 모양이 올바르지 않아요. 파트너스에서 만든 주소(https로 시작)를 그대로 붙여넣어 주세요.';
    renderCaption(); return;
  }
  if (lk.state === 'not_coupang') ui.linkNote = '쿠팡 파트너스 링크가 아닌 것 같아요. 수수료 링크가 맞는지 확인해 주세요. (그래도 넣어 두었어요)';
  const had = !!p.link;
  p.link = lk.url || '';
  p.carousel.hasPartnersLink = !!p.link;
  refreshAll();
  renderCaption();
  scheduleSave();
  if (had !== !!p.link) await runReview();   // "링크로 가라는데 링크 없음" 검수(⚠️)를 다시 계산
  if (p.link) toast('링크를 넣었어요. 캡션 맨 아래와 마지막 카드에 반영돼요.');
}

async function makeDeeplink() {
  const p = S.project;
  ui.linkBusy = true; ui.linkNote = ''; renderCaption();
  try {
    if (!p.id) await saveNow();
    const r = await request('coupang.deeplink', { projectId: p.id, url: productUrlForDeeplink(), tabId: S.fixedTab });
    ui.linkBusy = false;
    await setLink(r.shortenUrl);
    toast(r.cached ? '이미 만든 링크를 불러왔어요.' : '파트너스 링크를 만들었어요.');
    try { S.cp = await request('coupang.status', { projectId: p.id }); } catch { /* 상태는 선택 */ }
  } catch (e) {
    ui.linkBusy = false;
    ui.linkNote = `${e.messageKo || '링크를 만들지 못했어요.'} 파트너스에서 만든 링크를 아래에 붙여넣어도 돼요.`;
    renderCaption();
    showError(e);
  }
}

// ── 캡션·쇼츠 다시 ──
async function regenCaption() {
  ui.captionBusy = true; renderCaption();
  await fn.regenerate('caption', { label: '캡션을 다시 쓰는 중' });
  ui.captionBusy = false;
  if (S.tab === 'caption') renderCaption();
}

async function regenShorts() {
  ui.shortsBusy = true; renderCaption();
  try {
    const r = await request('ai.convertShorts', { project: S.project });
    S.project.shorts = r.shorts;
    scheduleSave();
  } catch (e) { showError(e); }
  ui.shortsBusy = false;
  renderCaption();
}
