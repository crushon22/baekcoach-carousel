// 웹 버전용 chrome.* 대체층 (일반 스크립트 — 다른 모든 모듈보다 먼저 불러야 한다).
// extension/ 소스를 그대로 쓰기 위해, 앱이 실제로 쓰는 chrome.* 만 브라우저 기능으로 대신한다. (docs/웹버전.md · "구현 메모")
//   chrome.storage.local (+onChanged)  → IndexedDB 'baekcoach-web-storage'  (키도 여기 저장 — 그 사이트 주소(origin)의 브라우저 저장소)
//   chrome.runtime.sendMessage/onMessage/connect/onConnect → 같은 페이지 안의 메시지 버스 (background.js 의 라우터가 이 페이지에서 돈다)
//   chrome.runtime.getURL / id / lastError / getManifest / openOptionsPage / onInstalled·onStartup(빈 이벤트)
//   chrome.downloads.download / search / onChanged → <a download>
//   chrome.sidePanel · tabs · scripting · action → 안전한 빈 구현(웹에서는 쓰이지 않음)
// 실제 확장 안에서는 아무것도 하지 않는다(chrome.runtime.id 가 이미 있으면 즉시 종료).
(() => {
  'use strict';
  if (globalThis.chrome && globalThis.chrome.runtime && globalThis.chrome.runtime.id) return;
  globalThis.__BC_WEB__ = true;

  const VERSION = '0.1.0'; // tools/build-web.js 가 package/manifest 버전으로 바꿔 넣는다
  const EXT_ID = 'baekcoach-web';

  // JSON 직렬화 복사: 확장의 메시지 전달과 같은 제약(Blob·함수 불가, undefined 탈락)을 그대로 재현한다.
  const jclone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  function makeEvent() {
    const listeners = [];
    return {
      addListener(fn) { if (typeof fn === 'function' && !listeners.includes(fn)) listeners.push(fn); },
      removeListener(fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
      hasListener(fn) { return listeners.includes(fn); },
      _listeners: listeners,
    };
  }
  // callback 형 호출도 지원 (callback 이 있으면 promise 는 돌려주지 않는다 — 확장과 같음)
  function cbify(promise, cb) {
    if (typeof cb === 'function') { promise.then((v) => cb(v), () => cb(undefined)); return undefined; }
    return promise;
  }

  // ───────────────────────── chrome.runtime ─────────────────────────

  const baseUrl = () => new URL('.', document.baseURI).href; // 하위 경로 배포(/저장소이름/)에서도 맞다
  const selfSender = () => ({ id: EXT_ID, url: location.href, origin: location.origin, frameId: 0 });

  const onMessage = makeEvent();
  const onConnect = makeEvent();

  // chrome.runtime.sendMessage(message[, options][, callback]) → 같은 페이지의 onMessage 리스너들에게 전달.
  // 확장과 같은 규칙: 리스너가 true 를 돌려주면 비동기 응답을 기다리고, 처음 호출된 sendResponse 값이 응답이 된다.
  function sendMessage(...args) {
    const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    const message = args.length > 1 && typeof args[0] === 'string' ? args[1] : args[0]; // (extensionId, message) 형태도 허용
    const p = new Promise((resolve) => {
      let msg;
      try { msg = jclone(message); } catch (e) { throw new Error('메시지를 직렬화할 수 없습니다: ' + e.message); }
      queueMicrotask(() => {
        let done = false;
        let waiting = 0;
        const respond = (r) => { if (done) return; done = true; resolve(jclone(r)); };
        for (const l of onMessage._listeners.slice()) {
          let ret;
          try { ret = l(jclone(msg), selfSender(), respond); } catch (e) { console.error('[shim] onMessage 리스너 오류', e); }
          if (ret === true) waiting++;
          else if (ret && typeof ret.then === 'function') { waiting++; ret.then(respond, () => respond(undefined)); }
        }
        if (!waiting && !done) resolve(undefined);
      });
    });
    return cbify(p, cb);
  }

  // 포트: 한 쌍(클라이언트 a ↔ 서버 b). 메시지는 JSON 복사 후 마이크로태스크로 전달 → 보낸 순서가 보장된다.
  function makePort(name) {
    const port = {
      name, sender: undefined, _peer: null, _gone: false,
      onMessage: makeEvent(), onDisconnect: makeEvent(),
      postMessage(m) {
        if (port._gone) throw new Error('Attempting to use a disconnected port object');
        const c = jclone(m);
        const peer = port._peer;
        queueMicrotask(() => { for (const l of peer.onMessage._listeners.slice()) { try { l(jclone(c), peer); } catch (e) { console.error('[shim] port.onMessage 오류', e); } } });
      },
      disconnect() {
        if (port._gone) return;
        port._gone = true; port._peer._gone = true;
        const peer = port._peer;
        // 이미 보낸 메시지가 먼저 전달된 뒤 상대에게 끊김을 알린다
        queueMicrotask(() => { for (const l of peer.onDisconnect._listeners.slice()) { try { l(peer); } catch (e) { console.error('[shim] onDisconnect 오류', e); } } });
      },
    };
    return port;
  }
  function connect(a, b) {
    const info = a && typeof a === 'object' ? a : b || {};
    const client = makePort(info.name || '');
    const server = makePort(info.name || '');
    client._peer = server; server._peer = client;
    server.sender = selfSender();
    queueMicrotask(() => {
      const ls = onConnect._listeners.slice();
      if (!ls.length) { client._gone = server._gone = true; for (const l of client.onDisconnect._listeners.slice()) l(client); return; }
      for (const l of ls) { try { l(server); } catch (e) { console.error('[shim] onConnect 리스너 오류', e); } }
    });
    return client;
  }

  const runtime = {
    id: EXT_ID,
    lastError: undefined,
    getURL: (path = '') => new URL(String(path).replace(/^\/+/, ''), baseUrl()).href,
    getManifest: () => ({ manifest_version: 3, name: '백코치 캐러셀 메이커 (웹)', version: VERSION, permissions: [], host_permissions: [] }),
    sendMessage,
    onMessage,
    connect,
    onConnect,
    onInstalled: makeEvent(),
    onStartup: makeEvent(),
    openOptionsPage(cb) { location.href = new URL('settings.html', document.baseURI).href; return cbify(Promise.resolve(), cb); },
    getPlatformInfo(cb) { return cbify(Promise.resolve({ os: 'web', arch: 'unknown' }), cb); },
  };

  // ───────────────────────── chrome.storage.local ─────────────────────────

  const DB_NAME = 'baekcoach-web-storage';
  const STORE = 'kv';
  let dbp = null;
  function openDb() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => { req.result.onversionchange = () => { req.result.close(); dbp = null; }; resolve(req.result); };
      req.onerror = () => { dbp = null; reject(new Error('브라우저 저장소(IndexedDB)를 열지 못했습니다: ' + (req.error && req.error.message))); };
    });
    return dbp;
  }
  const wrapReq = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async function tx(mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const s = t.objectStore(STORE);
      let out;
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('저장소 트랜잭션이 취소되었습니다.'));
      Promise.resolve(fn(s)).then((r) => { out = r; }, (e) => { try { t.abort(); } catch (_) { /* 이미 끝남 */ } reject(e); });
    });
  }

  const storageChanged = makeEvent();
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('bc-storage') : null;
  const fireChanged = (changes) => { for (const l of storageChanged._listeners.slice()) { try { l(changes, 'local'); } catch (e) { console.error('[shim] storage.onChanged 오류', e); } } };
  if (channel) channel.onmessage = (ev) => { if (ev.data && ev.data.changes) fireChanged(ev.data.changes); }; // 다른 탭/페이지(예: 설정 페이지)의 변경
  const emitChanged = (changes) => {
    if (!Object.keys(changes).length) return;
    if (channel) { try { channel.postMessage({ changes }); } catch (_) { /* 복제 불가 값은 다른 탭에 알리지 않음 */ } }
    queueMicrotask(() => fireChanged(changes));
  };
  const same = (a, b) => { try { return JSON.stringify(a) === JSON.stringify(b); } catch (_) { return false; } };

  const local = {
    // keys: null/undefined → 전부 · 문자열 · 배열 · {키: 기본값} 객체
    get(keys, cb) {
      if (typeof keys === 'function') { cb = keys; keys = null; }
      const p = tx('readonly', async (s) => {
        const out = {};
        if (keys == null) {
          await new Promise((res, rej) => {
            const c = s.openCursor();
            c.onsuccess = () => { const cur = c.result; if (cur) { out[cur.key] = cur.value; cur.continue(); } else res(); };
            c.onerror = () => rej(c.error);
          });
          return out;
        }
        const defaults = typeof keys === 'object' && !Array.isArray(keys) ? keys : null;
        const names = defaults ? Object.keys(defaults) : [].concat(keys);
        for (const k of names) {
          const v = await wrapReq(s.get(k));
          if (v !== undefined) out[k] = v;
          else if (defaults && defaults[k] !== undefined) out[k] = defaults[k];
        }
        return out;
      });
      return cbify(p, cb);
    },
    set(items, cb) {
      const changes = {};
      const p = tx('readwrite', async (s) => {
        for (const [k, v] of Object.entries(items || {})) {
          if (v === undefined) continue;
          const old = await wrapReq(s.get(k));
          s.put(v, k);
          if (!same(old, v)) changes[k] = { ...(old !== undefined ? { oldValue: old } : {}), newValue: v };
        }
      }).then(() => { emitChanged(changes); });
      return cbify(p, cb);
    },
    remove(keys, cb) {
      const changes = {};
      const p = tx('readwrite', async (s) => {
        for (const k of [].concat(keys)) {
          const old = await wrapReq(s.get(k));
          if (old !== undefined) { s.delete(k); changes[k] = { oldValue: old }; }
        }
      }).then(() => { emitChanged(changes); });
      return cbify(p, cb);
    },
    clear(cb) {
      const changes = {};
      const p = tx('readwrite', async (s) => {
        const keys = await wrapReq(s.getAllKeys());
        for (const k of keys) { changes[k] = { oldValue: await wrapReq(s.get(k)) }; }
        s.clear();
      }).then(() => { emitChanged(changes); });
      return cbify(p, cb);
    },
    onChanged: storageChanged,
  };

  // ───────────────────────── chrome.downloads ─────────────────────────

  const downloadItems = [];
  const downloadsChanged = makeEvent();
  const downloads = {
    // url: data: / blob: 주소 → <a download>. 브라우저가 저장 위치를 정한다. 완료 이벤트는 바로 보낸다(웹은 진행을 알 수 없음).
    download(opts, cb) {
      const p = new Promise((resolve, reject) => {
        try {
          const url = opts && opts.url;
          if (!url) throw new Error('downloads.download: url 이 없습니다.');
          const id = downloadItems.length + 1;
          const wanted = String((opts && opts.filename) || 'download').split(/[\\/]+/).filter(Boolean).join('_'); // 폴더 구분은 웹에서 쓸 수 없어 이름에 합친다
          const a = document.createElement('a');
          a.href = url; a.download = wanted; a.rel = 'noopener'; a.style.display = 'none';
          document.body.appendChild(a); a.click(); a.remove();
          downloadItems.push({ id, url: String(url).slice(0, 40), filename: wanted, state: 'complete', byExtensionId: EXT_ID });
          if (String(url).startsWith('blob:')) setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) { /* 이미 해제됨 */ } }, 60000);
          setTimeout(() => { for (const l of downloadsChanged._listeners.slice()) { try { l({ id, state: { previous: 'in_progress', current: 'complete' } }); } catch (e) { console.error(e); } } }, 30);
          resolve(id);
        } catch (e) { reject(e); }
      });
      return cbify(p, cb);
    },
    search(query, cb) {
      const q = query || {};
      return cbify(Promise.resolve(downloadItems.filter((d) => q.id == null || d.id === q.id).map((d) => ({ ...d }))), cb);
    },
    onChanged: downloadsChanged,
  };

  // ───────────────────────── 웹에서 쓰이지 않는 확장 전용 API: 안전한 빈 구현 ─────────────────────────

  const noTabs = () => Promise.reject(new Error('웹 버전에는 브라우저 탭 API 가 없습니다.'));
  const tabs = { query: () => Promise.resolve([]), get: noTabs, sendMessage: noTabs, create: noTabs, onUpdated: makeEvent(), onActivated: makeEvent() };
  const scripting = { executeScript: noTabs };
  const sidePanel = {
    open: () => Promise.resolve(),
    setPanelBehavior: () => Promise.resolve(),
    getPanelBehavior: () => Promise.resolve({ openPanelOnActionClick: false }),
    setOptions: () => Promise.resolve(),
  };
  const action = { onClicked: makeEvent(), setBadgeText: () => Promise.resolve() };

  globalThis.chrome = { runtime, storage: { local, onChanged: storageChanged }, downloads, tabs, scripting, sidePanel, action };
})();
