// 근거·검수 탭: 저장 가능성 점수 + 가장 큰 감점 1개와 고치기, 🔎 근거 없음 목록(완화/빼기/내가 확인했어요), ⚠️ 형식 점검, 카드별 근거 보기.
import { request } from '../lib/bus.js';
import { h, setChildren, toast } from './dom.js';
import { S, fn, cards, factIssues, formatIssues, applyPatch } from './app.js';
import { showError } from './errors.js';
import { CLAIM_TYPE } from './labels.js';

const ui = { evidenceOpen: null, evOpen: null, busy: new Set(), notes: new Map() };
let host;

const FACT_MODE = {
  search: '인터넷 검색과 상품 페이지에서 근거를 찾았어요.',
  page: '오늘은 검색 없이 작성했어요. 상품 페이지에 있는 내용만 근거로 썼어요.',
  user_input: '오늘은 검색 없이 작성했어요. 내가 입력한 정보만 근거로 썼어요.',
  script: '쇼츠 대본의 문장을 근거로 썼어요.',
  none: '근거로 쓸 자료가 없어서 체감 표현 위주로 썼어요. 숫자·후기 수는 모두 🔎로 잡혀요.',
};

function sourceNode(f) {
  const src = f.source;
  if (src === 'coupang_page') return h('span', null, '쿠팡 상품 페이지');
  if (src === 'user_input' || src === 'user') return h('span', null, f.byUser ? '내가 확인한 근거' : '내가 입력한 정보');
  if (src === 'unverified') return h('span', { class: 'warn-text' }, '출처 확인 안 됨');
  const label = String(f.sourceTitle || src).replace(/^https?:\/\//, '').slice(0, 60);
  if (/^https?:\/\//i.test(String(src))) return h('a', { href: src, target: '_blank', rel: 'noopener noreferrer' }, label);
  return h('span', null, label);
}

function claimsFor(card) {
  const facts = S.project?.facts || [];
  const list = (card.claims || []);
  if (!list.length) return h('p', { class: 'muted small' }, '이 카드에는 따로 기록된 주장이 없어요(글을 직접 고친 경우).');
  return h('ul', { class: 'claims' }, ...list.map((c) => {
    const f = c.fact_id ? facts.find((x) => x.id === c.fact_id) : null;
    return h('li', null,
      h('span', { class: `badge badge-${c.type}` }, CLAIM_TYPE[c.type] || c.type),
      h('span', { class: 'claim-text' }, c.text),
      f ? h('div', { class: 'claim-src small' }, '출처: ', sourceNode(f), f.quote ? h('span', { class: 'muted' }, ` — "${String(f.quote).slice(0, 80)}"`) : null)
        : (c.type === 'fact' ? h('div', { class: 'claim-src small warn-text' }, '연결된 근거가 없어요 🔎') : null));
  }));
}

export function renderReview() {
  host = host || document.getElementById('tab-review');
  const p = S.project;
  if (!p) { setChildren(host); return; }
  const fi = factIssues();
  const fm = formatIssues();
  const sc = p.score;
  const top = sc?.top;

  const scoreCard = h('div', { class: 'score-card', id: 'score-card' },
    h('div', { class: 'score-num' }, h('span', { id: 'score-total' }, sc ? String(sc.total) : '-'), h('span', { class: 'score-unit' }, '점')),
    h('div', { class: 'score-text' },
      h('strong', null, '저장 가능성'),
      top ? h('p', { class: 'small', id: 'score-top' }, `가장 큰 감점: ${top.label} (−${top.points}점)`) : h('p', { class: 'small' }, '큰 감점이 없어요.'),
      top?.hint ? h('p', { class: 'muted small' }, top.hint) : null),
    top ? h('button', { type: 'button', class: 'btn', id: 'btn-fix-top', onclick: () => fixTop(top) }, '고치기') : null);

  const deductions = sc?.deductions?.length ? h('details', { class: 'plain' }, h('summary', null, '점수가 이렇게 나왔어요'),
    h('ul', { class: 'deductions' }, ...sc.deductions.map((d) => h('li', null, h('strong', null, `${d.label} −${d.points}`), d.detail ? h('span', { class: 'muted small' }, ` ${d.detail}`) : null)))) : null;

  const factSection = h('section', { class: 'group', id: 'fact-section' },
    h('h3', null, fi.length ? `🔎 근거 없음 ${fi.length}건` : '🔎 근거 없는 주장 0건'),
    fi.length ? h('p', { class: 'muted small' }, '출처가 확인되지 않은 말이에요. 완화하거나 빼거나, 직접 확인했다면 근거를 남기세요. 남은 채로 내보내면 경고가 떠요.')
      : h('p', { class: 'ok-line' }, '✅ 지금은 근거 없는 주장이 없어요.'),
    ...fi.map(issueItem));

  const formatSection = fm.length ? h('details', { class: 'plain', id: 'format-section', open: fm.length <= 3 },
    h('summary', null, `⚠️ 형식 점검 ${fm.length}건`),
    h('ul', { class: 'format-list' }, ...fm.map((x) => h('li', { 'data-kind': x.kind || '', 'data-issue': x.id },
      h('div', null, h('strong', null, x.cardNo ? `카드 ${x.cardNo}` : (x.target === 'caption' ? '캡션' : '전체')), ' ', x.text),
      x.why ? h('div', { class: 'muted small' }, x.why) : null,
      // 숨긴 제품 정보가 새어 나온 줄(댓글 유도): 그 글자만 빼거나 줄째 뺄 수 있다
      x.kind === 'identity_leak' ? h('div', { class: 'btn-row' },
        x.fix_soften ? h('button', { type: 'button', class: 'btn', 'data-fix': 'soften', disabled: ui.busy.has(x.id), onclick: () => fix(x, 'soften') }, `"${x.fix_soften}"로 바꾸기`) : null,
        h('button', { type: 'button', class: 'btn', 'data-fix': 'delete', disabled: ui.busy.has(x.id), onclick: () => fix(x, 'delete') }, '그 줄 빼기')) : null,
      x.cardIndex >= 0 ? h('button', { type: 'button', class: 'btn', onclick: () => gotoCard(x.cardIndex) }, '그 카드로') : null)))) : null;

  const fiInfo = p.factsInfo;
  const infoSection = h('details', { class: 'plain', id: 'facts-info' }, h('summary', null, '근거 자료는 어디서 왔나요?'),
    h('p', null, FACT_MODE[fiInfo?.mode] || '근거 자료 정보가 없어요.'),
    fiInfo?.unknown?.length ? h('div', null, h('strong', null, '확인하지 못한 것'), h('ul', null, ...fiInfo.unknown.map((u) => h('li', null, u)))) : null,
    fiInfo?.groundingUrls?.length ? h('div', null, h('strong', null, '검색에서 찾은 출처'), h('ul', null, ...fiInfo.groundingUrls.slice(0, 8).map((g) => h('li', null, sourceNode({ source: g.uri, sourceTitle: g.title || g.uri }))))) : null);

  const perCard = h('section', { class: 'group', id: 'evidence-section' },
    h('h3', null, '카드별 근거 보기'),
    ...cards().map((c, i) => c ? h('details', { class: 'plain evidence', 'data-card': i, open: ui.evidenceOpen === i || (ui.evidenceOpen == null && i === S.cardIndex) },
      h('summary', null, `카드 ${i + 1} · ${String(c.headline || '').replace(/\n/g, ' ').slice(0, 24)}`),
      claimsFor(c)) : null));

  setChildren(host, scoreCard, deductions, factSection, formatSection, infoSection, perCard);
}

function issueItem(x) {
  const busy = ui.busy.has(x.id);
  const note = ui.notes.get(x.id);
  const where = x.target === 'caption' ? '캡션' : x.cardNo ? `카드 ${x.cardNo}` : '전체';
  const box = h('article', { class: 'issue', 'data-issue': x.id, 'data-card': x.cardIndex },
    h('div', { class: 'issue-head' }, h('span', { class: 'badge badge-warn' }, '🔎'), h('strong', null, where),
      x.cardIndex >= 0 ? h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => gotoCard(x.cardIndex) }, '카드 보기') : null),
    h('p', { class: 'issue-text' }, `“${x.text}”`),
    x.why ? h('p', { class: 'muted small' }, x.why) : null,
    x.fix_soften ? h('p', { class: 'small' }, '완화하면: ', h('em', null, x.fix_soften)) : null,
    h('div', { class: 'btn-row issue-actions' },
      h('button', { type: 'button', class: 'btn', 'data-fix': 'soften', disabled: busy, onclick: () => fix(x, 'soften') }, '완화해서 쓰기'),
      h('button', { type: 'button', class: 'btn', 'data-fix': 'delete', disabled: busy, onclick: () => fix(x, 'delete') }, '빼기'),
      h('button', { type: 'button', class: 'btn', 'data-fix': 'evidence', disabled: busy, 'aria-expanded': String(ui.evOpen === x.id), onclick: () => { ui.evOpen = ui.evOpen === x.id ? null : x.id; renderReview(); } }, '내가 확인했어요')),
    ui.evOpen === x.id ? evidenceForm(x) : null,
    note ? h('p', { class: 'warn-line', 'data-note': x.id }, note) : null);
  return box;
}

function evidenceForm(x) {
  const input = h('input', { class: 'input', id: `ev-${x.id}`, placeholder: '근거 주소(URL)나 메모. 예: 상세 페이지 3번째 사진 표 / 제조사 안내문', 'aria-label': '근거 입력' });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); fix(x, 'evidence', input.value); } });
  return h('div', { class: 'form evidence-form' },
    h('label', { class: 'label', for: `ev-${x.id}` }, '내가 확인한 근거'),
    input,
    h('p', { class: 'muted small' }, '이 말이 맞다는 책임은 나에게 있어요. 적어 둔 근거는 이 작업에 기록돼요.'),
    h('button', { type: 'button', class: 'btn btn-primary', 'data-fix': 'evidence-save', onclick: () => fix(x, 'evidence', input.value) }, '근거 저장'));
}

async function fix(issue, mode, evidence) {
  if (mode === 'evidence' && !String(evidence || '').trim()) { toast('근거(주소나 메모)를 적어 주세요.', { kind: 'warn' }); return; }
  ui.busy.add(issue.id); ui.notes.delete(issue.id); renderReview();
  try {
    const r = await request('ai.applyFix', { project: S.project, issueId: issue.id, mode, evidence: mode === 'evidence' ? String(evidence).trim() : undefined });
    applyPatch(r.patch);
    if (r.usedMode && r.usedMode !== mode) toast('제목 전체가 문제라서 빼는 대신 완화했어요.');
    else toast(mode === 'soften' ? '완화했어요.' : mode === 'delete' ? '뺐어요.' : '근거를 기록했어요.');
    if (r.stillOpen) ui.notes.set(issue.id, mode === 'evidence' ? '근거를 남겼지만 문장과 딱 맞지 않아 아직 🔎로 남았어요. 문장을 완화하거나 더 구체적인 근거를 적어 주세요.' : '고쳤지만 아직 근거가 부족해 보여요. 다른 방법을 써 보세요.');
    ui.evOpen = null;
  } catch (e) {
    if (['FIX_NO_SOFTEN', 'FIX_NOT_FOUND', 'FIX_EMPTY_HEADLINE'].includes(e.code)) {
      ui.notes.set(issue.id, `${e.messageKo} 카드에서 직접 고쳐 주세요.`);
    } else showError(e);
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

function fixTop(top) {
  const cs = cards();
  const last = cs.length - 1;
  const fmt = formatIssues();
  const firstFmt = fmt.find((x) => x.cardIndex >= 0)?.cardIndex;
  if (top.key === 'fact') { document.querySelector('#fact-section .issue')?.scrollIntoView({ block: 'center' }); return; }
  let idx = 0;
  if (top.key === 'hook') idx = 0;
  else if (top.key === 'cta') idx = last;
  else if (top.key === 'table') { idx = cs.findIndex((c) => c?.layout === 'table'); if (idx < 0) idx = Math.max(0, last - 1); }
  else if (top.key === 'bridge') { idx = cs.findIndex((c, k) => k > 0 && k < last && c && !c.bridge); if (idx < 0) idx = Math.min(1, last); }
  else idx = firstFmt ?? 0;
  gotoCard(idx);
  if (top.key === 'hook') setTimeout(() => document.getElementById('first-card-group')?.scrollIntoView({ block: 'start' }), 50);
  else fn.rewriteCurrent?.();
}
