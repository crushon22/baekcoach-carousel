// core.* 핸들러 — 서비스워커 전용. (ext-core 담당)
//  core.ping · core.echo · core.getSettings · core.saveSettings · core.fetchImage · core.fetchImages
//  core.downloadStored · core.openPanel · core.openOptions    + 스트림 core.echoStream
// 요청/응답 형식·오류 형식은 docs/인터페이스.md.

import { AppError, WHERE, sleep, blobToBase64 } from './common.js';
import * as store from './store.js';
import { IS_WEB } from './platform.js';

export const prefix = 'core.';

/** 콘텐츠 스크립트가 보낼 수 있는 요청 (그 외는 확장 페이지에서만 허용) */
export const contentAllowed = ['core.openPanel', 'core.ping'];

// 테스트에서 네트워크를 가로챌 수 있게 fetch 를 한 곳으로 모은다. (실제 코드는 globalThis.fetch)
const doFetch = (...a) => globalThis.fetch(...a);

// ───────────── 이미지 fetch → Blob → IndexedDB ─────────────

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20000;

/** manifest 의 host_permissions 패턴에 맞는 https 주소만 허용 (권한 밖 주소는 거절) */
export function isAllowedImageUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  for (const pat of chrome.runtime.getManifest().host_permissions || []) {
    const [scheme, rest] = pat.split('://');
    if (scheme !== 'https') continue;
    const host = rest.split('/')[0];
    if (host.startsWith('*.')) {
      const base = host.slice(2);
      if (u.hostname === base || u.hostname.endsWith('.' + base)) return true;
    } else if (u.hostname === host) return true;
  }
  return false;
}

async function fetchImageToStore({ url, projectId = null, kind = 'remote', refresh = false }) {
  if (IS_WEB) {
    // 웹 버전: 쿠팡 CDN 사진은 브라우저 CORS 때문에 받을 수 없다. 사진은 파일 업로드만.
    throw new AppError('웹 버전에서는 쿠팡 사진 주소로 사진을 가져올 수 없어요. 사진 파일을 직접 올려 주세요.', { raw: `web: 외부 이미지 주소 거절 (${String(url).slice(0, 120)})`, where: WHERE.SW, code: 'WEB_UNAVAILABLE' });
  }
  if (typeof url !== 'string' || !isAllowedImageUrl(url)) {
    throw new AppError('허용되지 않은 이미지 주소입니다. 쿠팡 이미지 주소만 가져올 수 있습니다.', { raw: `url=${String(url).slice(0, 200)}`, where: WHERE.SW, code: 'URL_NOT_ALLOWED' });
  }
  if (!refresh) {
    const hit = await store.findImageBySourceUrl(url);
    if (hit) return { imageId: hit.id, mime: hit.type, size: hit.size, width: hit.width ?? null, height: hit.height ?? null, reused: true };
  }
  let res;
  try {
    res = await doFetch(url, { credentials: 'omit', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (e) {
    throw new AppError('이미지를 내려받지 못했습니다. 인터넷 연결을 확인하거나 다른 사진을 골라 주세요.', { raw: `${e?.name}: ${e?.message} (${url})`, where: WHERE.SW, code: 'IMAGE_FETCH_FAILED' });
  }
  if (!res.ok) {
    throw new AppError(`이미지를 내려받지 못했습니다. (서버 응답 ${res.status})`, { raw: `HTTP ${res.status} ${url}`, where: WHERE.SW, code: 'IMAGE_FETCH_FAILED' });
  }
  if (res.url && !isAllowedImageUrl(res.url)) {
    throw new AppError('허용되지 않은 주소로 이동되어 이미지를 받지 않았습니다.', { raw: `redirected to ${res.url}`, where: WHERE.SW, code: 'URL_NOT_ALLOWED' });
  }
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_IMAGE_BYTES) throw new AppError('이미지가 너무 큽니다(15MB 초과).', { raw: `content-length=${len}`, where: WHERE.SW, code: 'IMAGE_TOO_LARGE' });
  const blob = await res.blob();
  if (blob.size > MAX_IMAGE_BYTES) throw new AppError('이미지가 너무 큽니다(15MB 초과).', { raw: `size=${blob.size}`, where: WHERE.SW, code: 'IMAGE_TOO_LARGE' });
  if (!/^image\//.test(blob.type)) {
    throw new AppError('이미지가 아닌 파일이 내려왔습니다. 다른 사진을 골라 주세요.', { raw: `content-type=${blob.type || '(없음)'} ${url}`, where: WHERE.SW, code: 'NOT_AN_IMAGE' });
  }
  let width = null, height = null;
  try { const bmp = await createImageBitmap(blob); width = bmp.width; height = bmp.height; bmp.close(); } catch { /* svg 등은 크기 생략 */ }
  const imageId = await store.putImage(blob, { kind, sourceUrl: url, projectId, width, height });
  store.pruneUnownedImages().catch(() => {});
  return { imageId, mime: blob.type, size: blob.size, width, height, reused: false };
}

async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await worker(items[i], i); }
  }));
  return out;
}

// ───────────── 다운로드 ─────────────

export function safeFilename(name) {
  const parts = String(name || '').split(/[\\/]+/).map((s) => s.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/^\.+/, '').trim()).filter(Boolean);
  return parts.length ? parts.join('/') : '백코치-캐러셀.zip';
}

function waitDownload(id, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { chrome.downloads.onChanged.removeListener(on); reject(new AppError('저장이 오래 걸려 확인하지 못했습니다. 다운로드 폴더를 확인해 주세요.', { raw: `download ${id} timeout`, where: WHERE.SW })); }, timeoutMs);
    const on = (d) => {
      if (d.id !== id || !d.state) return;
      if (d.state.current === 'complete') { clearTimeout(timer); chrome.downloads.onChanged.removeListener(on); resolve(); }
      else if (d.state.current === 'interrupted') {
        clearTimeout(timer); chrome.downloads.onChanged.removeListener(on);
        reject(new AppError('파일을 저장하지 못했습니다. 다운로드 폴더 권한이나 남은 공간을 확인해 주세요.', { raw: `download ${id} interrupted: ${d.error?.current || ''}`, where: WHERE.SW }));
      }
    };
    chrome.downloads.onChanged.addListener(on);
  });
}

// ───────────── 요청/응답 핸들러 ─────────────

export const handlers = {
  /** 연결 확인. 라우터 경고(중복·접두사 오류)도 여기서 볼 수 있다. */
  'core.ping': async (_p, ctx) => ({ pong: true, at: Date.now(), version: chrome.runtime.getManifest().version, where: WHERE.SW, from: ctx.from, routerWarnings: globalThis.__routerWarnings || [] }),

  /** 진단용: 받은 값을 그대로 돌려준다. {fail:true} 면 일부러 오류. {failWithSecret:true} 는 저장된 Gemini 키를 오류 원문에 넣어 보내 "키가 가려져 나가는지" 확인(시험용). */
  'core.echo': async (p) => {
    if (p?.failWithSecret) {
      const { geminiKey } = await store.getSecrets();
      throw new AppError('시험용 오류입니다.', { raw: `key=${geminiKey} 그리고 ${geminiKey}`, where: WHERE.SW, code: 'TEST' });
    }
    if (p?.fail) throw new AppError('시험용 오류입니다.', { raw: 'core.echo fail=true', where: WHERE.SW, code: 'TEST' });
    return { echo: p ?? null };
  },

  /** 키 값 없이 "있음/없음"만. → {…설정, has:{geminiKey,coupangAccessKey,coupangSecretKey}} */
  'core.getSettings': async () => store.getPublicSettings(),

  /** payload: 설정 일부({subId:'abc', parallel:4, geminiKey:'…'}). 반환은 공개용 설정. */
  'core.saveSettings': async (p) => store.saveSettings(p || {}),

  /** payload {url, projectId?, kind?, refresh?} → {imageId, mime, size, width, height, reused} */
  'core.fetchImage': async (p) => fetchImageToStore(p || {}),

  /** payload {urls:[…], projectId?, kind?} → [{ok:true,url,…결과}|{ok:false,url,error}] (동시 4개) */
  'core.fetchImages': async (p) => {
    const urls = Array.isArray(p?.urls) ? p.urls.slice(0, 16) : [];
    return pool(urls, 4, async (url) => {
      try { return { ok: true, url, ...(await fetchImageToStore({ url, projectId: p.projectId, kind: p.kind })) }; }
      catch (e) { return { ok: false, url, error: { messageKo: e.messageKo || '이미지를 내려받지 못했습니다.', raw: e.raw || String(e?.message || e), where: WHERE.SW } }; }
    });
  },

  /**
   * IndexedDB 에 저장된 Blob(예: 패널이 만든 zip, kind:'zip')을 chrome.downloads 로 저장.
   * payload {imageId, filename, saveAs?:boolean, keep?:boolean(true 면 저장 후 Blob 유지)} → {downloadId, filename, bytes}
   */
  'core.downloadStored': async (p) => {
    const rec = await store.getImage(p?.imageId);
    if (!rec) throw new AppError('저장할 파일을 찾지 못했습니다. 다시 내보내기를 눌러 주세요.', { raw: `imageId=${p?.imageId}`, where: WHERE.SW, code: 'NOT_FOUND' });
    const filename = safeFilename(p.filename);
    // 웹: Blob 주소로 바로 내려받는다(큰 파일을 base64 로 부풀리지 않음). 확장: 서비스워커라 data URL.
    const url = IS_WEB ? URL.createObjectURL(rec.blob) : `data:${rec.type || 'application/octet-stream'};base64,${await blobToBase64(rec.blob)}`;
    let downloadId;
    try {
      downloadId = await chrome.downloads.download({ url, filename, saveAs: !!p.saveAs, conflictAction: 'uniquify' });
    } catch (e) {
      throw new AppError('파일 저장을 시작하지 못했습니다.', { raw: e?.message, where: WHERE.SW });
    }
    // 웹: 브라우저가 알아서 저장하므로 완료를 기다리지 않는다(shim 은 즉시 완료로 본다).
    if (!IS_WEB) await waitDownload(downloadId);
    const [item] = IS_WEB ? [null] : await chrome.downloads.search({ id: downloadId });
    if (rec.kind === 'zip' && !p.keep) store.deleteImage(rec.id).catch(() => {});
    return { downloadId, filename: item?.filename ? item.filename.split(/[\\/]/).pop() : filename, bytes: rec.size };
  },

  /**
   * 사이드 패널 열기. 콘텐츠 스크립트(플로팅 버튼 클릭)나 확장 페이지에서 호출.
   * 사용자 제스처가 필요하므로 이 함수는 await 앞에서 sidePanel.open 을 부른다. payload {tabId?} (콘텐츠에서는 sender.tab.id 사용)
   */
  'core.openPanel': (p, ctx) => {
    if (IS_WEB) return Promise.resolve({ opened: true, web: true }); // 웹은 패널이 곧 페이지라 할 일이 없다
    const tabId = ctx.sender?.tab?.id ?? p?.tabId;
    if (tabId == null) return Promise.reject(new AppError('열 탭을 찾지 못했습니다.', { raw: 'sender.tab 없음', where: WHERE.SW }));
    return chrome.sidePanel.open({ tabId }).then(() => ({ opened: true, tabId }), (e) => {
      throw new AppError('사이드 패널을 열지 못했습니다. 툴바의 확장 아이콘을 눌러 열어 주세요.', { raw: e?.message, where: WHERE.SW, code: 'OPEN_PANEL_FAILED' });
    });
  },

  'core.openOptions': async () => {
    if (IS_WEB) { location.href = new URL('settings.html', document.baseURI).href; return { opened: true, web: true }; } // 같은 탭에서 설정 페이지로
    await chrome.runtime.openOptionsPage();
    return { opened: true };
  },
};

// ───────────── 스트리밍 핸들러 ─────────────

export const portHandlers = {
  /** 진단용 스트림. payload {count=3, delayMs=20, failAt?} → 이벤트 'tick' {i} 를 count 번, 반환 {count} */
  'core.echoStream': async (p, ctx) => {
    const count = Math.min(Math.max(Number(p?.count ?? 3), 0), 100);
    const delayMs = Number(p?.delayMs ?? 20);
    for (let i = 1; i <= count; i++) {
      if (ctx.signal.aborted) return { count: i - 1, cancelled: true };
      await sleep(delayMs);
      if (p?.failAt === i) throw new AppError('시험용 스트림 오류입니다.', { raw: `core.echoStream failAt=${i}`, where: WHERE.SW, code: 'TEST' });
      ctx.emit('tick', { i });
    }
    return { count };
  },
};
