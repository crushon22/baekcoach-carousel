// 지난 작업: IndexedDB 프로젝트 목록 · 열기(이어서 편집) · 삭제.
import * as store from '../lib/store.js';
import { h, setChildren, fmtDate, toast } from './dom.js';
import { S, fn, el, saveNow, mountPf, imageUrl } from './app.js';
import { showError, clearErrors } from './errors.js';
import { closeOverlay } from './export.js';
import { loadChat } from './dock.js';

let confirmDelete = null;

export async function openHistory() {
  el.overlay.hidden = false;
  document.body.classList.add('overlay-open');
  await renderHistory();
}

async function renderHistory() {
  let list = [];
  try { list = await store.listProjects({ limit: 50 }); } catch (e) { showError(e); }
  const body = list.length
    ? h('ul', { class: 'history-list', id: 'history-list' }, ...list.map((p) => {
      const t = h('div', { class: 'thumb', style: { width: '48px', height: '48px' } }, h('span', { class: 'thumb-empty' }, '…'));
      const imgId = p.input?.imageIds?.[0] || p.carousel?.cards?.find((c) => c?.imageId)?.imageId;
      if (imgId) imageUrl(imgId).then((u) => { if (u) t.replaceChildren(h('img', { src: u, alt: '' })); });
      const asking = confirmDelete === p.id;
      return h('li', { class: 'history-item', 'data-id': p.id },
        t,
        h('div', { class: 'history-text' }, h('strong', null, p.title || '제목 없음'), h('span', { class: 'muted small' }, `${p.carousel?.mode === 'photo' ? '사진' : '카드뉴스'} · ${fmtDate(p.updatedAt || p.createdAt)} · ${(p.carousel?.cards || []).length}장${p.mock ? ' · 시험용' : ''}`)),
        h('div', { class: 'history-actions' },
          asking
            ? [h('button', { type: 'button', class: 'btn btn-warn', 'data-act': 'delete-yes', onclick: async () => { await store.deleteProject(p.id); confirmDelete = null; toast('삭제했어요.'); renderHistory(); } }, '정말 삭제'),
              h('button', { type: 'button', class: 'btn', onclick: () => { confirmDelete = null; renderHistory(); } }, '취소')]
            : [h('button', { type: 'button', class: 'btn btn-primary', 'data-act': 'open', onclick: () => openProject(p.id) }, '열기'),
              h('button', { type: 'button', class: 'btn', 'data-act': 'delete', onclick: () => { confirmDelete = p.id; renderHistory(); } }, '삭제')]));
    }))
    : h('p', { class: 'muted', id: 'history-empty' }, '아직 저장된 작업이 없어요. 캐러셀을 만들면 자동으로 여기에 저장돼요.');
  setChildren(el.overlay, h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': '지난 작업', id: 'history-sheet' },
    h('div', { class: 'sheet-head' }, h('h2', null, '지난 작업'), h('button', { type: 'button', class: 'btn', id: 'btn-overlay-close', onclick: closeOverlay }, '닫기')),
    h('div', { class: 'sheet-body', tabindex: -1 }, h('p', { class: 'muted small' }, '최근 50개까지 이 브라우저에 저장돼요. 열면 이어서 고칠 수 있어요.'), body)));
}

export async function openProject(id) {
  try {
    const p = await store.getProject(id);
    if (!p || !p.carousel?.cards?.length) { toast('이 작업을 열 수 없어요.', { kind: 'warn' }); return; }
    if (S.stream) S.stream.cancel();
    if (S.project && S.phase === 'ready') await saveNow();
    clearErrors();
    p.link = p.link || '';
    S.project = p;
    S.phase = 'ready';
    S.stream = null; S.progress = null;
    S.tab = 'edit'; S.cardIndex = 0;
    S.newProductBanner = null;
    await loadChat(p.id);
    mountPf(p.carousel.cards.length);
    closeOverlay();
    fn.render();
    toast('지난 작업을 열었어요.');
  } catch (e) { showError(e); }
}
