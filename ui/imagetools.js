// AI 사진 바꾸기 시트: 사진 한 장을 골라 배경·그림체·보정·비율 늘리기·직접 쓰기로 바꾼다(image.transform).
//  · 누를 때만 만든다. 원본과 결과를 나란히 보여 주고 [이 사진 쓰기]를 눌러야 바뀐다.
//  · 한도·무료 키로 막히면 한국어 요청문을 복사해 Gemini 앱·ChatGPT 에서 만들고 "만든 사진 올리기"로 넣게 안내한다.
//  · 바뀐 사진은 연출 이미지(카드에 표시가 붙는다). 데이터 계약은 docs/이미지변환.md.
import { request } from '../lib/bus.js';
import * as store from '../lib/store.js';
import { TRANSFORMS, transformOf, buildTransformPrompt, nearestAspect } from '../lib/imageprompt.js';
import { h, setChildren, copyText, pickImageFile, toast } from './dom.js';
import { imageUrl, S } from './app.js';
import { showError } from './errors.js';
import { icon } from './icons.js';

const st = { src: null, kind: 'recreate', option: 'studio', extra: '', busy: false, result: null, fallback: null, srcAspect: '4:5', opts: null };

function overlayEl() {
  let o = document.getElementById('overlay');
  if (!o) { o = h('div', { id: 'overlay', class: 'overlay', hidden: true }); document.body.append(o); }
  return o;
}

export function closeImageTool() {
  const o = document.getElementById('overlay');
  if (o && o.querySelector('#imgtool-sheet')) { o.hidden = true; o.replaceChildren(); document.body.classList.remove('overlay-open'); }
  st.opts = null;
}

/**
 * 시트 열기. opts: {imageId, aspect?(늘리기 목표, 기본 4:5), productTitle?, projectId?, onUse(newImageId), title?}
 */
export async function openImageTool(opts) {
  if (!opts?.imageId) { toast('바꿀 사진이 없어요. 먼저 사진을 넣어 주세요.', { kind: 'warn' }); return; }
  Object.assign(st, { src: opts.imageId, busy: false, result: null, fallback: null, opts, srcAspect: '4:5' });
  if (!transformOf(st.kind).options.some((o) => o.key === st.option)) st.option = transformOf(st.kind).options[0]?.key || null;
  const o = overlayEl();
  o.hidden = false;
  document.body.classList.add('overlay-open');
  render();
  o.querySelector('.sheet-body')?.focus();
  // 원본 비율(요청문 복사용)
  const u = await imageUrl(opts.imageId);
  if (u) { const im = new Image(); im.onload = () => { st.srcAspect = nearestAspect(im.naturalWidth, im.naturalHeight); }; im.src = u; }
}

const targetAspect = () => (st.kind === 'extend' ? st.opts?.aspect || '4:5' : st.srcAspect);
const promptKo = () => buildTransformPrompt({ kind: st.kind, option: st.option, extra: st.extra, aspect: targetAspect() }).promptKo;

function pic(id, label, empty) {
  const box = h('div', { class: 'imgtool-pic', 'data-pic': label }, h('span', { class: 'imgtool-empty' }, empty || '…'));
  if (id) imageUrl(id).then((u) => { if (u) box.replaceChildren(h('img', { src: u, alt: label })); });
  return h('figure', { class: 'imgtool-fig' }, box, h('figcaption', { class: 'small muted' }, label));
}

function render() {
  const o = document.getElementById('overlay');
  if (!o || !st.opts) return;
  const t = transformOf(st.kind);
  const needText = st.kind === 'custom';
  const extra = h('textarea', { id: 'imgtool-extra', class: 'input', rows: 2, maxlength: 200, 'aria-label': needText ? '어떻게 바꿀지' : '더 원하는 것',
    placeholder: needText ? '예: 배경을 바닷가 모래사장으로 바꿔 주세요' : '더 원하는 것이 있으면 적어 주세요 (선택)' });
  extra.value = st.extra;
  extra.addEventListener('input', () => { st.extra = extra.value; const b = document.getElementById('btn-imgtool-run'); if (b) b.disabled = st.busy || (st.kind === 'custom' && !st.extra.trim()); });

  const kinds = h('div', { class: 'chips', id: 'imgtool-kinds', role: 'group', 'aria-label': '바꾸는 방법' },
    ...TRANSFORMS.map((k) => h('button', { type: 'button', class: 'chip', 'data-kind': k.key, 'aria-pressed': String(st.kind === k.key), disabled: st.busy,
      onclick: () => { st.kind = k.key; st.option = k.options[0]?.key || null; render(); } }, k.label)));
  const options = t.options.length ? h('div', { class: 'chips', id: 'imgtool-options', role: 'group', 'aria-label': t.label },
    ...t.options.map((op) => h('button', { type: 'button', class: 'chip', 'data-option': op.key, 'aria-pressed': String(st.option === op.key), disabled: st.busy,
      onclick: () => { st.option = op.key; render(); } }, op.label))) : null;
  const help = st.kind === 'recreate'
    ? h('p', { class: 'muted small' }, '판매처 사진을 그대로 올리지 않고, 같은 상품을 다른 각도·구도·배경의 새 사진으로 그려요. 중복 사진으로 걸릴 걱정을 줄여요.')
    : st.kind === 'extend'
    ? h('p', { class: 'muted small' }, `사진을 자르지 않고 ${targetAspect()} 비율로 바깥을 이어 그려요. 상품이 잘리는 사진에 좋아요.`)
    : st.kind === 'style' ? h('p', { class: 'muted small' }, '구도는 그대로 두고 그림 느낌으로 바꿔요. 상품을 알아볼 수 있게 그려요.')
      : null;

  const fb = st.fallback;
  const manual = h('div', { class: 'imgtool-manual', id: 'imgtool-manual' },
    fb ? h('p', { class: 'warn-line', id: 'imgtool-note' }, fb.messageKo) : null,
    h('ol', { class: 'imgtool-steps small', id: 'imgtool-steps' },
      h('li', null, '아래 [요청문 복사]를 눌러요.'),
      h('li', null, 'Gemini 앱(gemini.google.com)이나 ChatGPT에 원본 사진을 첨부하고 요청문을 붙여 넣어요.'),
      h('li', null, '만들어진 사진을 내려받아 [다른 AI에서 만든 사진 올리기]로 넣어요.')),
    h('button', { type: 'button', class: 'btn btn-block', id: 'btn-imgtool-copy', onclick: async () => { const ok = await copyText(fb?.promptKo || promptKo()); toast(ok ? '요청문을 복사했어요. 사진을 첨부하고 붙여 넣으세요.' : '복사하지 못했어요.', { kind: ok ? 'info' : 'warn' }); } }, '요청문 복사'),
    h('button', { type: 'button', class: 'btn btn-block', id: 'btn-imgtool-upload', disabled: st.busy, onclick: uploadMade }, '다른 AI에서 만든 사진 올리기'));

  const res = st.result;
  const foot = res
    ? [h('button', { type: 'button', class: 'btn btn-primary', id: 'btn-imgtool-use', onclick: useResult }, icon('check', { size: 18 }), '이 사진 쓰기'),
      h('button', { type: 'button', class: 'btn', id: 'btn-imgtool-save', onclick: saveResult }, icon('download', { size: 18 }), '사진만 저장'),
      h('button', { type: 'button', class: 'btn', id: 'btn-imgtool-again', disabled: st.busy, onclick: run }, st.busy ? '바꾸는 중…' : '다시 바꾸기')]
    : [h('button', { type: 'button', class: 'btn btn-primary btn-block', id: 'btn-imgtool-run', disabled: st.busy || (needText && !st.extra.trim()), onclick: run },
      icon('sparkle', { size: 18 }), st.busy ? '바꾸는 중… (최대 1분)' : '사진 바꾸기')];

  setChildren(o, h('div', { class: 'sheet imgtool-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'AI로 사진 바꾸기', id: 'imgtool-sheet' },
    h('div', { class: 'sheet-head' }, h('h2', null, st.opts.title || 'AI로 사진 바꾸기'), h('button', { type: 'button', class: 'btn', id: 'btn-imgtool-close', onclick: closeImageTool }, '닫기')),
    h('div', { class: 'sheet-body', tabindex: -1 },
      h('div', { class: 'imgtool-compare', id: 'imgtool-compare' },
        pic(st.src, '원본'),
        h('span', { class: 'imgtool-arrow', 'aria-hidden': 'true' }, icon('arrowRight', { size: 22 })),
        h('div', { id: 'imgtool-result' }, res ? pic(res.imageId, '바뀐 사진') : pic(null, '바뀐 사진', st.busy ? '만드는 중…' : '여기에 나와요'))),
      // 원본과 같은 제품인지 확인한 결과(서비스워커 검증). 다르면 쓰기 전에 알려 준다
      res?.check?.same === false ? h('p', { class: 'warn-line', id: 'imgtool-check' }, `⚠️ 원본과 달라 보여요: ${(res.check.differences || []).join(', ') || res.check.summary || '색·모양이 바뀜'}. 그래도 쓰려면 [이 사진 쓰기], 아니면 [다시 바꾸기].`)
        : res?.check?.same === true ? h('p', { class: 'ok-line small', id: 'imgtool-check' }, '✅ 원본과 같은 제품으로 확인했어요.') : null,
      h('div', { class: 'label' }, '바꾸는 방법'), kinds, options, help, extra,
      h('p', { class: 'muted small' }, '누를 때만 만들어요. 상품 모양은 그대로 두고, 사진에 글자·워터마크는 넣지 않아요. 카드에도 AI 표시를 넣지 않으니 올릴 때 AI 표시를 직접 체크하세요.'),
      h('details', { class: 'extra imgtool-other', open: !!fb },
        h('summary', null, '다른 AI에서 만들기 (키 한도가 없을 때)'), manual),
      h('div', { class: 'sheet-foot imgtool-foot' }, ...foot))));
}

async function run() {
  if (st.busy) return;
  st.busy = true; st.fallback = null; render();
  try {
    const r = await request('image.transform', {
      imageId: st.src, kind: st.kind, option: st.option, extra: st.extra, aspect: st.opts?.aspect || '4:5',
      productTitle: st.opts?.productTitle, productLook: S.ident?.look || undefined, projectId: st.opts?.projectId,
    }, { timeoutMs: 200000 }); // GPT 이미지는 서비스워커가 150초까지 기다린다 → 패널은 그보다 길게
    if (r.fallback || !r.imageId) st.fallback = { messageKo: r.messageKo, promptKo: r.promptKo };
    else st.result = { imageId: r.imageId, model: r.model, check: r.check || null };
  } catch (e) { showError(e); }
  st.busy = false;
  render();
}

async function uploadMade() {
  const file = await pickImageFile();
  if (!file) return;
  if (file.size > 15 * 1024 * 1024) { toast('사진이 너무 커요(15MB 이하).', { kind: 'warn' }); return; }
  try {
    const id = await store.putImage(file, { kind: 'generated', projectId: st.opts?.projectId || null, meta: { purpose: 'transform', manual: true, source: st.src } });
    st.result = { imageId: id, model: '다른 AI' };
    st.fallback = null;
    render();
  } catch (e) { showError(e); }
}

function useResult() {
  const id = st.result?.imageId;
  const cb = st.opts?.onUse;
  closeImageTool();
  if (id && cb) { cb(id); toast('바꾼 사진을 넣었어요. 원본은 그대로 남아 있어요.'); }
}

async function saveResult() {
  const id = st.result?.imageId;
  if (!id) return;
  try {
    const rec = await store.getImage(id);
    const ext = /jpe?g/.test(rec?.type || '') ? 'jpg' : /webp/.test(rec?.type || '') ? 'webp' : 'png';
    await request('core.downloadStored', { imageId: id, filename: `바꾼사진_${transformOf(st.kind).label.replace(/\s/g, '')}.${ext}` });
    toast('사진을 저장했어요.');
  } catch (e) { showError(e); }
}
