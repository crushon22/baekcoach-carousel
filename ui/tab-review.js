// 검수 탭: 캐러셀 점수(100점에서 문제만 뺀다) + 가장 큰 감점 고치기 · ⚠️ 점검(글 넘침·숨긴 번호 새어 나옴) · 카드별 검수.
// 2026-10-29 사용자 결정으로 뺀 것: 🔎 근거 없는 주장 목록·근거 입력·"근거 자료는 어디서 왔나요?". 점수에도 넣지 않는다(lib/score.js).
import { request } from '../lib/bus.js';
import { h, setChildren, toast } from './dom.js';
import { S, fn, cards, formatIssues, applyPatch } from './app.js';
import { showError } from './errors.js';

const ui = { cardOpen: null, busy: new Set(), notes: new Map() };
let host;

const firstLine = (c) => String(c?.headline || '').split('\n').map((x) => x.trim()).filter(Boolean)[0] || '';
const linesOf = (c) => (c?.overlay?.lines?.length ? c.overlay.lines : [...String(c?.headline || '').split('\n'), ...String(c?.body || '').split('\n')]).map((x) => String(x).trim()).filter(Boolean);
const issuesOf = (i) => formatIssues().filter((x) => x.cardIndex === i);
const where = (x) => (x.target === 'caption' ? '캡션' : x.cardNo ? `카드 ${x.cardNo}` : '전체');

export function renderReview() {
  host = host || document.getElementById('tab-review');
  const p = S.project;
  if (!p) { setChildren(host); return; }
  const fm = formatIssues();
  const sc = p.score;
  const top = sc?.top;

  const scoreCard = h('div', { class: 'score-card', id: 'score-card' },
    h('div', { class: 'score-num' }, h('span', { id: 'score-total' }, sc ? String(sc.total) : '-'), h('span', { class: 'score-unit' }, '점')),
    h('div', { class: 'score-text' },
      h('strong', null, '캐러셀 점수'),
      top ? h('p', { class: 'small', id: 'score-top' }, `가장 큰 감점: ${top.label} (−${top.points}점)`) : h('p', { class: 'ok-line small', id: 'score-top' }, '✅ 괜찮아요. 광고 표기·글 길이·댓글 유도 모두 통과했어요.'),
      top?.hint ? h('p', { class: 'muted small' }, top.hint) : null),
    top ? h('button', { type: 'button', class: 'btn', id: 'btn-fix-top', onclick: () => fixTop(top) }, '고치기') : null);

  const deductions = sc?.deductions?.length
    ? h('details', { class: 'plain', id: 'score-why' }, h('summary', null, '점수가 이렇게 나왔어요'),
      h('ul', { class: 'deductions' }, ...sc.deductions.map((d) => h('li', null, h('strong', null, `${d.label} −${d.points}`), d.detail ? h('span', { class: 'muted small' }, ` ${d.detail}`) : null))))
    : h('p', { class: 'muted small', id: 'score-why' }, '광고 표기 · 번호·색상명 숨김 · 글이 칸을 넘치는지 · 사진 속 색·질감 설명 · 마지막 댓글 유도 · 같은 말 반복을 봐요.');

  const formatSection = fm.length
    ? h('details', { class: 'plain', id: 'format-section', open: true },
      h('summary', null, `⚠️ 점검 ${fm.length}건`),
      h('ul', { class: 'format-list' }, ...fm.map((x) => issueLi(x, { showWhere: true }))))
    : h('p', { class: 'ok-line', id: 'format-ok' }, '✅ 글 길이·숨긴 정보 모두 괜찮아요.');

  const perCard = h('section', { class: 'group', id: 'percard-section' },
    h('h3', null, '카드별 검수'),
    ...cards().map((c, i) => c ? h('details', { class: 'plain evidence', 'data-card': i, open: ui.cardOpen === i || (ui.cardOpen == null && i === S.cardIndex) },
      h('summary', null, `${issuesOf(i).length ? '⚠️' : '✅'} 카드 ${i + 1} · ${firstLine(c).slice(0, 24)}`),
      cardCheck(c, i)) : null));

  setChildren(host, scoreCard, deductions, formatSection, perCard);
}

/** 카드 한 장의 검수: 글 줄 + 그 카드의 ⚠️ (없으면 ✅) */
function cardCheck(c, i) {
  const list = issuesOf(i);
  return h('div', { class: 'card-check' },
    h('ul', { class: 'card-lines' }, ...linesOf(c).map((l) => h('li', null, l))),
    list.length ? h('ul', { class: 'format-list' }, ...list.map((x) => issueLi(x, { showWhere: false }))) : h('p', { class: 'ok-line small' }, '✅ 문제 없어요.'),
    h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn', onclick: () => gotoCard(i) }, '이 카드 고치기'),
      h('button', { type: 'button', class: 'btn', onclick: () => { gotoCard(i); setTimeout(() => fn.rewriteCurrent?.(), 60); } }, '다시 쓰기')));
}

/** ⚠️ 한 줄. 숨긴 제품 정보가 새어 나온 줄(댓글 유도)은 그 글자만 빼거나 줄째 뺄 수 있다 */
function issueLi(x, { showWhere }) {
  const busy = ui.busy.has(x.id);
  const note = ui.notes.get(x.id);
  return h('li', { 'data-kind': x.kind || '', 'data-issue': x.id, 'data-card': x.cardIndex },
    h('div', null, showWhere ? h('strong', null, where(x)) : null, showWhere ? ' ' : null, x.text),
    x.why ? h('div', { class: 'muted small' }, x.why) : null,
    x.kind === 'identity_leak' && x.key !== 'hashtag' ? h('div', { class: 'btn-row' },
      x.fix_soften ? h('button', { type: 'button', class: 'btn', 'data-fix': 'soften', disabled: busy, onclick: () => fix(x, 'soften') }, `"${x.fix_soften}"로 바꾸기`) : null,
      h('button', { type: 'button', class: 'btn', 'data-fix': 'delete', disabled: busy, onclick: () => fix(x, 'delete') }, '그 줄 빼기')) : null,
    showWhere && x.cardIndex >= 0 ? h('button', { type: 'button', class: 'btn', onclick: () => gotoCard(x.cardIndex) }, '그 카드로') : null,
    note ? h('p', { class: 'warn-line', 'data-note': x.id }, note) : null);
}

async function fix(issue, mode) {
  ui.busy.add(issue.id); ui.notes.delete(issue.id); renderReview();
  try {
    const r = await request('ai.applyFix', { project: S.project, issueId: issue.id, mode });
    applyPatch(r.patch);
    toast(mode === 'soften' ? '바꿨어요.' : '뺐어요.');
  } catch (e) {
    if (['FIX_NO_SOFTEN', 'FIX_NOT_FOUND', 'FIX_EMPTY_HEADLINE'].includes(e.code)) ui.notes.set(issue.id, `${e.messageKo} 카드에서 직접 고쳐 주세요.`);
    else showError(e);
  }
  ui.busy.delete(issue.id);
  renderReview();
  fn.renderEditMeta?.();
}

export function gotoCard(i) {
  S.pf?.goTo(i);
  S.cardIndex = i;
  fn.openTab('edit', { scroll: true });
  fn.onCardIndex?.(i);
}

/** "고치기": 가장 큰 감점이 있는 곳으로 데려간다 */
function fixTop(top) {
  const cs = cards();
  const last = cs.length - 1;
  const fmt = formatIssues();
  if (top.key === 'adlabel') {
    fn.openTab('edit', { scroll: true });
    setTimeout(() => { const d = document.getElementById('design-group'); if (d) { d.open = true; d.scrollIntoView({ block: 'start', behavior: 'smooth' }); } }, 80);
    return;
  }
  if (top.key === 'leak') { const li = document.querySelector('#format-section li[data-kind=identity_leak]'); if (li) { document.getElementById('format-section').open = true; li.scrollIntoView({ block: 'center' }); } return; }
  let idx = 0;
  if (top.key === 'format') idx = fmt.find((x) => x.cardIndex >= 0 && x.kind !== 'identity_leak')?.cardIndex ?? 0;
  else if (top.key === 'empty') { idx = cs.findIndex((c) => !c || c.error || !linesOf(c).length); if (idx < 0) idx = 0; }
  else if (top.key === 'cta') idx = last;
  else if (top.key === 'visual') idx = Math.min(1, last);
  else if (top.key === 'repeat') { idx = cs.findIndex((c, k) => k > 0 && linesOf(c).join('|') === linesOf(cs[k - 1]).join('|')); if (idx < 0) idx = 1; }
  gotoCard(idx);
  if (['cta', 'visual', 'repeat'].includes(top.key)) setTimeout(() => fn.rewriteCurrent?.(), 60);
}
