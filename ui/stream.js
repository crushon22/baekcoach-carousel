// 만들기 / 다시 만들기: ai.generate · ai.regenerate 스트림을 받아 화면에 한 장씩 채운다. (부분 결과 먼저 — 규칙 6)
import { stream } from '../lib/bus.js';
import { S, fn, el, BRAND, cards, mountPf, unmountPf, refreshCard, refreshAll, updateStatus, composed, saveNow, scheduleSave } from './app.js';
import { deepClone, toast } from './dom.js';
import { showError, clearErrors } from './errors.js';
import { ensureCardFont } from './fontpick.js';
import { adCfg, adFields } from './adlabel.js';

const now = () => performance.now();

function skeletonProject(product, { link, options = {} }) {
  const photo = options.mode === 'photo';
  return {
    title: '', input: product, options: {}, plan: null, link: link || '',
    carousel: {
      type: '', template: 'basic', brandColor: BRAND, accountName: S.settings?.accountName || '', ...(S.settings?.logoImageId ? { logoImageId: S.settings.logoImageId } : {}),
      peek: false, panorama: false, hasPartnersLink: !!link, cards: [],
      font: S.font || 'pretendard',
      ...adFields(adCfg(photo ? 'photo' : 'cardnews')),
      ...(photo ? { mode: 'photo', overlayStyle: options.overlayStyle || 'outline' } : {}),
    },
    facts: [], factsInfo: null, caption: '', hashtags: [], issues: [], score: null, shorts: null, notices: [],
  };
}

function setProgress(label, got = null, total = null) {
  S.progress = { label, got, total };
  fn.renderProgress?.();
}

/** 이벤트 하나를 화면에 반영한다. mode: 'full'(처음부터) | 'part'(일부만) */
function makeHandler(mode, t0, part) {
  const marks = { firstCard: null };
  return {
    marks,
    onEvent(event, data) {
      const p = S.project;
      if (!p) return;
      if (event === 'plan') {
        p.plan = data;
        p.carousel.type = data.type;
        if (p.carousel.mode !== 'photo') p.carousel.template = data.template;
        p.carousel.cards = Array.from({ length: data.count }, () => null);
        p.options = { ...(p.options || {}) };
        p.notices = data.notices || [];
        S.cardIndex = 0;
        if (S.pf) S.pf.update(p.carousel, { total: data.count, caption: '' }); else mountPf(data.count);
        fn.renderDecision?.();
        fn.renderNotices?.();
        setProgress('카드를 쓰는 중', 0, data.count);
      } else if (event === 'card') {
        p.carousel.cards[data.index] = data.card;
        const done = cards().filter(Boolean).length;
        const painted = S.pf ? S.pf.setCard(data.index, data.card) : null;
        if (marks.firstCard == null) {
          marks.firstCard = Math.round(now() - t0);
          Promise.resolve(painted).then(() => {
            marks.firstPainted = Math.round(now() - t0);
            el.app.dataset.firstCardMs = String(marks.firstPainted);
          });
        }
        if (mode === 'full') setProgress('카드를 쓰는 중', done, p.plan?.count || p.carousel.cards.length);
        else fn.onCardIndex?.(S.cardIndex);
      } else if (event === 'facts') {
        p.facts = data.facts || []; p.factsInfo = { mode: data.mode, unknown: data.unknown || [], groundingUrls: data.groundingUrls || [], searchUsed: !!data.searchUsed };
        if (data.notices?.length) { p.notices = data.notices; fn.renderNotices?.(); }
        if (mode === 'full') setProgress('캡션을 쓰는 중');
      } else if (event === 'caption') {
        p.caption = data.caption || ''; p.hashtags = data.hashtags || [];
        S.pf?.setCaption(composed()?.text || '');
        if (mode === 'full') setProgress('근거를 확인하는 중');
      } else if (event === 'review') {
        p.issues = data.issues || [];
        updateStatus();
      } else if (event === 'score') {
        p.score = data;
        updateStatus();
        if (mode === 'full') setProgress('쇼츠 대본을 쓰는 중');
      } else if (event === 'shorts') {
        p.shorts = data;
      }
    },
  };
}

function finishWith(done, prev, { fresh = false } = {}) {
  const project = done;
  // 패널이 따로 들고 있던 값 보존
  // 처음 만들 때는 패널이 아는 링크(검색 결과의 수수료 링크)를, 다시 만들 때는 ai.regenerate 가 유지해 돌려준 link 를 쓴다
  project.link = fresh ? (prev.link || '') : (done.link || '');
  if (prev.id) project.id = prev.id;
  if (prev.carousel?.accentColor && !project.carousel.accentColor) project.carousel.accentColor = prev.carousel.accentColor;
  project.carousel.hasPartnersLink = !!project.link;
  // 광고 표기·색: 처음 만들 때는 시작 화면에서 고른 광고 표기, 다시 만들 때는 이전 값을 그대로(lib 가 기본값을 채워도 사용자가 고른 것을 우선)
  if (fresh) Object.assign(project.carousel, adFields(adCfg(project.carousel.mode === 'photo' ? 'photo' : 'cardnews')));
  else for (const k of ['adLabel', 'adLabelStyle', 'colors', 'overlayColors']) if (prev.carousel?.[k] !== undefined) project.carousel[k] = prev.carousel[k];
  // 글씨체: 처음 만들 때는 시작 화면에서 고른 것, 다시 만들 때는 이전 값을 유지(lib 가 넣어 주면 그 값)
  if (!project.carousel.font) project.carousel.font = (fresh ? S.font : prev.carousel?.font) || 'pretendard';
  S.project = project;
}

/** 새로 만들기 */
export async function startGenerate(product, { options = {}, link = '' } = {}) {
  if (S.phase === 'generating') return;
  clearErrors();
  S.project = skeletonProject(product, { link, options });
  S.phase = 'generating';
  S.chat = [];
  S.newProductBanner = null;
  delete el.app.dataset.firstCardMs;
  delete el.app.dataset.doneMs;
  await ensureCardFont(S.font);
  mountPf(options.mode === 'photo' ? (product.imageIds?.length || 7) : 7);
  S.progress = { label: '계획을 세우는 중', got: null, total: null };
  fn.render();
  const t0 = now();
  const h = makeHandler('full', t0);
  const s = stream('ai.generate', { product, options, hasPartnersLink: !!link }, { onEvent: h.onEvent });
  S.stream = s;
  fn.render();
  try {
    const done = await s.done;
    const prev = S.project;
    finishWith(done, prev, { fresh: true });
    S.phase = 'ready';
    S.stream = null;
    S.progress = null;
    S.tab = 'edit';
    S.cardIndex = 0;
    el.app.dataset.doneMs = String(Math.round(now() - t0));
    if (h.marks.firstPainted == null) el.app.dataset.firstCardMs = String(h.marks.firstCard ?? Math.round(now() - t0));
    refreshAll();
    fn.render();
    await saveNow();
  } catch (e) {
    S.stream = null;
    S.progress = null;
    unmountPf();
    S.project = null;
    S.phase = 'start';
    fn.render();
    if (e?.code !== 'CANCELLED') showError(e);
  }
}

/**
 * 일부 또는 전체 다시 만들기.
 * part: 'all'(상단 띠 변경·처음부터) | 'hook' | 'card' | 'caption' | 'shorts'
 */
export async function regenerate(part, { options, index, hookIndex, label } = {}) {
  if (!S.project || S.stream) return;
  clearErrors();
  const backup = deepClone(S.project);
  const full = part === 'all';
  const payload = { project: S.project, part, options: options || undefined, hasPartnersLink: !!S.project.link };
  if (index !== undefined) payload.index = index;
  if (hookIndex !== undefined) payload.hookIndex = hookIndex;
  if (full) S.phase = 'generating';
  S.progress = { label: label || (full ? '다시 계획을 세우는 중' : '다시 만드는 중'), got: null, total: null };
  const t0 = now();
  const h = makeHandler(full ? 'full' : 'part', t0, part);
  const s = stream('ai.regenerate', payload, { onEvent: h.onEvent });
  S.stream = s;
  fn.render();
  try {
    const done = await s.done;
    const prev = S.project;
    finishWith(done, prev);
    S.stream = null; S.progress = null; S.phase = 'ready';
    refreshAll();
    fn.render();
    scheduleSave();
    return true;
  } catch (e) {
    S.stream = null; S.progress = null; S.phase = 'ready';
    S.project = backup;
    refreshAll();
    fn.render();
    if (e?.code !== 'CANCELLED') showError(e); else toast('취소했어요. 이전 내용 그대로예요.');
    return false;
  }
}

export function cancelStream() { S.stream?.cancel(); }
