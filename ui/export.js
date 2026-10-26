// 내보내기 체크리스트(v1 §13-A·§21-D) → zip 만들기 → 다운로드.
import { IS_WEB } from '../lib/platform.js';
import { buildExportZip, downloadZip } from '../lib/render.js';
import { h, setChildren, toast } from './dom.js';
import { S, fn, el, cards, composed, finalTags, shortsText, factIssues, cardMeta, saveNow } from './app.js';
import { showError, errorBox, normalizeError } from './errors.js';

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
  for (let i = 0; i < cards().length; i++) {
    const m = await cardMeta(i);
    if (m?.overflow) overflow.push(i);
  }
  const warn = (code) => c.warnings.find((w) => w.code === code);
  const fi = factIssues().length;
  const tags = finalTags().length;
  const items = [
    { key: 'fact', ok: fi === 0, title: '근거 없는 주장 0개', detail: fi ? `🔎 ${fi}건이 남아 있어요. 완화하거나 빼거나 근거를 남겨 주세요.` : '남은 🔎가 없어요.', go: fi ? { label: '근거·검수 열기', run: () => fn.openTab('review', { scroll: true }) } : null },
    { key: 'disclosure', ok: c.text.startsWith(c.disclosure), title: '파트너스 고지 문구', detail: '캡션 첫 줄에 고지 문구가 자동으로 들어가요(끌 수 없어요).' },
    { key: 'link', ok: c.hasLink && !warn('LINK_INVALID'), title: '파트너스 링크', detail: c.hasLink ? (warn('LINK_NOT_COUPANG') ? '링크가 있지만 쿠팡 파트너스 링크가 맞는지 확인해 주세요.' : '캡션에 링크가 들어가요.') : '링크가 비어 있어요. 링크가 없으면 수수료가 생기지 않아요.', go: c.hasLink ? null : { label: '링크 넣으러 가기', run: () => fn.openTab('caption', { scroll: true }) } },
    { key: 'volatile', ok: !warn('VOLATILE_CLAIM'), title: '바뀔 수 있는 표현(배송·최저가)', detail: warn('VOLATILE_CLAIM')?.messageKo || '캡션에 로켓배송·최저가 같은 표현이 없어요.', go: warn('VOLATILE_CLAIM') ? { label: '캡션 고치기', run: () => fn.openTab('caption', { scroll: true }) } : null },
    { key: 'overflow', ok: overflow.length === 0, title: '카드 글자 넘침', detail: overflow.length ? `${overflow.map((i) => i + 1).join('·')}번 카드의 글이 칸을 넘쳐요.` : '모든 카드의 글이 칸 안에 들어가요.', go: overflow.length ? { label: `${overflow[0] + 1}번 카드 고치기`, run: () => fn.gotoCard(overflow[0]) } : null },
    { key: 'tags', ok: tags <= 30, title: '해시태그 30개 이하', detail: tags > 30 ? `${tags}개예요. ${tags - 30}개를 줄여 주세요.` : `${tags}개예요.`, go: tags > 30 ? { label: '해시태그 고치기', run: () => fn.openTab('caption', { scroll: true }) } : null },
  ];
  return { items, overflow };
}

const MANUAL = [
  { key: 'price', text: '판매 페이지에서 가격·배송을 다시 확인했어요' },
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
    footer.push(h('div', { class: 'ok-box', id: 'export-done' }, h('strong', null, '내려받기 폴더에 저장했어요'), h('p', null, st.done.filename), h('p', { class: 'muted small' }, `${(st.done.bytes / 1048576).toFixed(1)}MB · 카드 PNG, 캡션, 해시태그, 쇼츠 대본이 들어 있어요. 올리기 전에 캡션의 가격·링크를 한 번 더 봐 주세요.`)),
      h('button', { type: 'button', class: 'btn btn-block', onclick: close }, '닫기'));
  } else if (st.confirming) {
    footer.push(h('div', { class: 'warn-box', id: 'export-confirm' }, h('strong', null, `아직 해결하지 않은 항목이 ${u.total}개 있어요`),
      h('p', null, '그대로 올리면 근거 없는 말이나 빠진 링크가 그대로 나갈 수 있어요. 그래도 내려받을까요?')),
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
    const carousel = { ...p.carousel, hasPartnersLink: !!p.link };
    const zip = await buildExportZip(carousel, {
      caption: c.text, hashtags: finalTags(), shortsScript: shortsText(p.shorts),
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
