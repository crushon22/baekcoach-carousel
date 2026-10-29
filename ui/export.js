// 내보내기 체크리스트(v1 §13-A·§21-D) → zip 만들기 → 다운로드.
import { IS_WEB } from '../lib/platform.js';
import { buildExportZip, downloadZip } from '../lib/render.js';
import { h, setChildren, toast } from './dom.js';
import { S, fn, el, isPhoto, cards, composed, finalTags, shortsText, formatIssues, cardMeta, saveNow } from './app.js';
import { HASHTAG_MAX } from '../lib/ai-util.js';
import { showError, errorBox, normalizeError } from './errors.js';
import { ensureCardFont } from './fontpick.js';
import { cfgFromCarousel, adFields, defaultAd } from './adlabel.js';

const st = { manual: { price: false, order: false, click: false }, opts: { c9x16: true, c1x1: false, textless: false }, confirming: false, busy: null, done: null, error: null };
let checks = null;

function safeTitle(t) {
  const s = String(t || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return s || '캐러셀';
}

async function computeChecks() {
  const p = S.project;
  const c = composed();
  const overflow = [];
  const lowCards = [];
  const lowKinds = new Set();
  for (let i = 0; i < cards().length; i++) {
    const m = await cardMeta(i);
    if (m?.overflow) overflow.push(i);
    void lowCards; void lowKinds;   // "잘 보이는 글씨 색" 항목은 뺐다(2026-10-29 사용자 요청: 잘 보이는데 경고가 떠서)
  }
  const warn = (code) => c.warnings.find((w) => w.code === code);
  const leaks = formatIssues().filter((i) => i.kind === 'identity_leak').length;
  const tags = finalTags().length;
  const items = [
    (() => {
      const ad = cfgFromCarousel(p.carousel);
      return { key: 'adlabel', ok: ad.on, title: '광고 표기', detail: ad.on ? `카드에 "${ad.text}" 표시가 들어가요.` : '파트너스 글이라 카드에 광고 표기가 있어야 해요.',
        go: ad.on ? null : { label: '광고 표기 켜기', run: () => { Object.assign(p.carousel, adFields({ ...defaultAd(isPhoto(p) ? 'photo' : 'cardnews'), ...ad, on: true })); fn.refreshAll?.(); fn.openExport(); } } };
    })(),
    ...(p.options?.tease ? [{ key: 'leak', ok: leaks === 0, title: '번호·색상명 숨김', detail: leaks ? `숨기기로 한 제품 정보가 ${leaks}곳에 그대로 있어요.` : '카드와 캡션에 번호·색상명이 없어요. 댓글이 달리면 DM으로 링크를 보내 주세요.', go: leaks ? { label: '검수 열기', run: () => fn.openTab('review', { scroll: true }) } : null }] : []),
    { key: 'volatile', ok: !warn('VOLATILE_CLAIM'), title: '바뀔 수 있는 표현(배송·최저가)', detail: warn('VOLATILE_CLAIM')?.messageKo || '캡션에 로켓배송·최저가 같은 표현이 없어요.', go: warn('VOLATILE_CLAIM') ? { label: '캡션 고치기', run: () => fn.openTab('caption', { scroll: true }) } : null },
    { key: 'overflow', ok: overflow.length === 0, title: '카드 글자 넘침', detail: overflow.length ? `${overflow.map((i) => i + 1).join('·')}번 카드의 글이 칸을 넘쳐요.` : '모든 카드의 글이 칸 안에 들어가요.', go: overflow.length ? { label: `${overflow[0] + 1}번 카드 고치기`, run: () => fn.gotoCard(overflow[0]) } : null },
    { key: 'tags', ok: tags >= 1 && tags <= HASHTAG_MAX, title: `해시태그 ${HASHTAG_MAX}개 이하`, detail: tags > HASHTAG_MAX ? `${tags}개예요. ${tags - HASHTAG_MAX}개를 줄여 주세요.` : tags ? `${tags}개예요.` : '해시태그가 없어요.', go: tags > HASHTAG_MAX || !tags ? { label: '해시태그 고치기', run: () => fn.openTab('caption', { scroll: true }) } : null },
  ];
  return { items, overflow };
}

// 렌더러 meta.lowContrast 값 → 사람 말
const LOW_NAME = { headline: '제목', body: '본문', accent: '강조색', overlay: '사진 위 글씨', adLabel: '광고 표기' };

/** 결과 화면 "디자인 · 색 · 광고 표기"를 펼치고 그쪽으로 스크롤 */
function openDesign() {
  closeOverlay();
  fn.openTab('edit', { scroll: true });
  setTimeout(() => { const d = document.getElementById('design-group'); if (d) { d.open = true; d.scrollIntoView({ block: 'start', behavior: 'smooth' }); } }, 80);
}

const MANUAL = [
  { key: 'order', text: '카드 순서와 글이 괜찮은지 넘겨 봤어요' },
  { key: 'click', text: '링크를 눌러 내 상품이 열리는지 확인했어요', needsLink: true },
];

function unresolved() {
  const auto = checks.items.filter((i) => !i.ok).length;
  const c = composed();
  const manual = MANUAL.filter((m) => (!m.needsLink || c.hasLink) && !st.manual[m.key]).length;
  return { auto, manual, total: auto + manual };
}

export async function openExport() {
  if (!S.project || S.phase !== 'ready') return;
  st.confirming = false; st.done = null; st.error = null; st.busy = null;
  checks = await computeChecks();
  el.overlay.hidden = false;
  document.body.classList.add('overlay-open');
  renderExport();
  el.overlay.querySelector('.sheet-body')?.focus();
}

export function closeOverlay() {
  el.overlay.hidden = true;
  el.overlay.replaceChildren();
  document.body.classList.remove('overlay-open');
}

function renderExport() {
  const p = S.project;
  const c = composed();
  const u = unresolved();
  const close = () => closeOverlay();

  const list = h('ul', { class: 'checklist', id: 'export-checklist' }, ...checks.items.map((it) => h('li', { class: `check-item ${it.ok ? 'ok' : 'bad'}`, 'data-key': it.key, 'data-ok': String(it.ok) },
    h('span', { class: 'check-mark', 'aria-hidden': 'true' }, it.ok ? '✅' : '⚠️'),
    h('div', { class: 'check-text' }, h('strong', null, it.title), h('div', { class: 'small' }, it.detail),
      it.go ? h('button', { type: 'button', class: 'btn', onclick: () => { close(); it.go.run(); } }, it.go.label) : null))));

  const manual = h('div', { class: 'manual-checks', id: 'manual-checks' }, ...MANUAL.filter((m) => !m.needsLink || c.hasLink).map((m) => {
    const cb = h('input', { type: 'checkbox', id: `mc-${m.key}`, checked: st.manual[m.key], onchange: () => { st.manual[m.key] = cb.checked; st.confirming = false; renderExport(); } });
    return h('label', { class: 'check-row', for: `mc-${m.key}` }, cb, h('span', null, m.text));
  }));

  const optRows = [
    ['c9x16', '9:16 커버·엔딩 (릴스·스토리용)'],
    ['c1x1', '1:1 정사각 카드도 함께'],
    ['textless', '글자 없는 버전도 함께 (캔바 등에서 글자를 다시 얹을 때)'],
  ].map(([k, label]) => {
    const cb = h('input', { type: 'checkbox', id: `opt-${k}`, checked: st.opts[k], onchange: () => { st.opts[k] = cb.checked; } });
    return h('label', { class: 'check-row', for: `opt-${k}` }, cb, h('span', null, label));
  });

  const footer = [];
  if (st.busy) {
    footer.push(h('div', { class: 'progress', id: 'export-progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': st.busy.pct },
      h('div', { class: 'progress-bar', style: { width: st.busy.pct + '%' } })), h('p', { class: 'muted center' }, `${st.busy.label} (${st.busy.pct}%)`));
  } else if (st.done) {
    footer.push(h('div', { class: 'ok-box', id: 'export-done' }, h('strong', null, '내려받기 폴더에 저장했어요'), h('p', null, st.done.filename), h('p', { class: 'muted small' }, `${(st.done.bytes / 1048576).toFixed(1)}MB · 카드 PNG, 캡션, 해시태그${p.shorts ? ', 쇼츠 대본' : ''}가 들어 있어요. 올리기 전에 캡션을 한 번 더 봐 주세요.`)),
      h('button', { type: 'button', class: 'btn btn-block', onclick: close }, '닫기'));
  } else if (st.confirming) {
    footer.push(h('div', { class: 'warn-box', id: 'export-confirm' }, h('strong', null, `아직 해결하지 않은 항목이 ${u.total}개 있어요`),
      h('p', null, '그대로 올리면 광고 표기가 빠지거나 숨긴 번호가 그대로 나갈 수 있어요. 그래도 내려받을까요?')),
    h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn', id: 'btn-export-back', onclick: () => { st.confirming = false; renderExport(); } }, '아니요, 고칠게요'),
      h('button', { type: 'button', class: 'btn btn-primary', id: 'btn-export-force', onclick: doExport }, '그래도 내려받기')));
  } else {
    footer.push(u.total
      ? h('button', { type: 'button', class: 'btn btn-block btn-warn', id: 'btn-export-go', onclick: () => { st.confirming = true; renderExport(); } }, `그래도 내려받기 (남은 항목 ${u.total}개)`)
      : h('button', { type: 'button', class: 'btn btn-primary btn-big btn-block', id: 'btn-export-go', onclick: doExport }, '내려받기'));
  }
  if (st.error) footer.unshift(errorBox(st.error));

  setChildren(el.overlay, h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': '내보내기 전 확인', id: 'export-sheet' },
    h('div', { class: 'sheet-head' }, h('h2', null, '내보내기 전 확인'), h('button', { type: 'button', class: 'btn', id: 'btn-overlay-close', onclick: close }, '닫기')),
    h('div', { class: 'sheet-body', tabindex: -1 },
      h('p', { class: 'muted' }, '올리기 전에 꼭 봐야 하는 것들이에요. ⚠️는 고치면 ✅로 바뀌어요.'),
      list,
      h('h3', null, '내가 확인할 것'), manual,
      h('h3', null, '함께 받을 것'), h('div', { class: 'manual-checks' }, ...optRows),
      IS_WEB ? h('p', { class: 'muted small', id: 'web-zip-note' }, '휴대폰(특히 아이폰 사파리)에서는 zip 저장이 제한될 수 있어요. 저장이 안 되면 컴퓨터나 안드로이드 크롬에서 내려받아 주세요.') : null,
      h('div', { class: 'sheet-foot' }, ...footer))));
}

async function doExport() {
  const p = S.project;
  const c = composed();
  st.confirming = false; st.error = null; st.done = null;
  st.busy = { pct: 0, label: '준비하는 중' };
  renderExport();
  try {
    await saveNow();
    await ensureCardFont(p.carousel.font);
    const carousel = { ...p.carousel, hasPartnersLink: !!p.link };
    const zip = await buildExportZip(carousel, {
      caption: c.text, hashtags: finalTags(), shortsScript: p.shorts ? shortsText(p.shorts) : '',
      include9x16: st.opts.c9x16, include1x1: st.opts.c1x1, includeTextless: st.opts.textless,
      onProgress: ({ done, total, label }) => { st.busy = { pct: Math.round((done / Math.max(1, total)) * 90), label: `${label} 그리는 중` }; updateProgress(); },
    });
    st.busy = { pct: 95, label: 'zip 파일 저장하는 중' }; updateProgress();
    const r = await downloadZip(zip, `백코치캐러셀/${safeTitle(p.title)}.zip`);
    st.busy = null;
    st.done = { filename: r.filename, bytes: r.bytes ?? zip.size };
    el.app.dataset.exportBytes = String(zip.size);
  } catch (e) {
    st.busy = null;
    st.error = normalizeError(e);
  }
  renderExport();
}

function updateProgress() {
  const bar = document.querySelector('#export-progress .progress-bar');
  const wrap = document.getElementById('export-progress');
  if (bar && wrap && st.busy) { bar.style.width = st.busy.pct + '%'; wrap.setAttribute('aria-valuenow', st.busy.pct); wrap.nextElementSibling.textContent = `${st.busy.label} (${st.busy.pct}%)`; }
}

export { toast, showError };
