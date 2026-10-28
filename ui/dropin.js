// 시작 화면에서 사진을 끌어다 놓거나(드래그) 붙여 넣기(Ctrl+V·⌘V)로 넣는다.
//  · 사진 캐러셀: 사진 줄 맨 뒤에 붙는다(10장까지). 카드뉴스: 웹은 보이는 사진 줄(8장까지), 확장은 대표 사진 한 장.
//  · 결과 화면·시트가 열려 있을 때는 아무것도 하지 않는다(실수로 카드 사진이 바뀌지 않게).
import * as store from '../lib/store.js';
import { IS_WEB } from '../lib/platform.js';
import { toast } from './dom.js';
import { S, fn } from './app.js';
import { showError } from './errors.js';
import { addPhotos } from './photo.js';

const IMAGE = /^image\/(png|jpeg|webp|gif)$/;
const active = () => S.phase === 'start' && !document.body.classList.contains('overlay-open');

/** 파일 목록을 시작 화면에 넣는다. 넣은 장수를 돌려준다. */
export async function takeImages(files) {
  const imgs = [...files].filter((f) => IMAGE.test(f.type));
  if (!imgs.length || !active()) return 0;
  let n = 0;
  if (S.mode === 'photo') n = await addPhotos(imgs);
  else if (IS_WEB) {
    const list = S.webKind === 'topic' ? (S.topicImageIds ||= []) : (S.manual.imageIds ||= []);
    for (const f of imgs.slice(0, Math.max(0, 8 - list.length))) {
      if (f.size > 15 * 1024 * 1024) { toast(`"${f.name || '사진'}" 사진이 너무 커요(15MB 이하).`, { kind: 'warn' }); continue; }
      try { list.push(await store.putImage(f, { kind: 'upload' })); n++; } catch (e) { showError(e); }
    }
  } else {
    const f = imgs[0];
    if (f.size > 15 * 1024 * 1024) { toast('사진이 너무 커요(15MB 이하로 올려 주세요).', { kind: 'warn' }); return 0; }
    try { S.manual.imageId = await store.putImage(f, { kind: 'upload' }); n = 1; fn.renderStrip?.(); } catch (e) { showError(e); }
  }
  if (n) { fn.renderStage(); toast(`사진 ${n}장을 넣었어요.`); }
  return n;
}

export function initDropIn() {
  document.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.items || [])].filter((i) => i.kind === 'file' && IMAGE.test(i.type)).map((i) => i.getAsFile()).filter(Boolean);
    if (!files.length || !active()) return;
    e.preventDefault();
    takeImages(files);
  });
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  let depth = 0;
  document.addEventListener('dragenter', (e) => { if (!hasFiles(e) || !active()) return; depth++; document.body.classList.add('drop-over'); });
  document.addEventListener('dragleave', () => { if (depth && --depth === 0) document.body.classList.remove('drop-over'); });
  document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();   // 결과 화면에서도 브라우저가 사진 파일을 열어 버리지 않게
    depth = 0; document.body.classList.remove('drop-over');
    takeImages(e.dataTransfer.files);
  });
}
