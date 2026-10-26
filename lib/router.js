// 서비스워커 메시지 라우터 — background.js 가 모듈 목록을 넘겨 한 번 만든다.
// 각 모듈(core/coupang/agents/image)은 handlers / portHandlers / contentAllowed 만 export 하면 된다.
// 접두사 규칙: core.* (lib/core.js) · coupang.* (lib/coupang.js) · ai.* (lib/agents.js) · image.* (lib/image.js)
// 자기 접두사가 아닌 이름을 등록하면 무시하고 콘솔에 오류를 남긴다(다른 모듈 보호).

import { WHERE, toErrorPayload } from './common.js';
import { STREAM_PORT_NAME } from './bus.js';
import { IS_WEB } from './platform.js';

/** 진행 중인 요청이 있는 동안 서비스워커가 30초 유휴로 종료되지 않게 한다. */
let activeJobs = 0;
let keepAliveTimer = null;
function keepAliveStart() {
  activeJobs++;
  if (IS_WEB) return; // 웹은 서비스워커가 없어 깨울 필요가 없다
  if (!keepAliveTimer) keepAliveTimer = setInterval(() => { chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError); }, 20000);
}
function keepAliveEnd() {
  activeJobs = Math.max(0, activeJobs - 1);
  if (IS_WEB) return;
  if (activeJobs === 0 && keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
}

/**
 * @param {{prefix:string, handlers?:object, portHandlers?:object, contentAllowed?:string[]}[]} modules
 * @param {{getSecretValues?:()=>Promise<string[]>}} deps  오류 원문에서 키 값을 가리기 위한 훅
 */
export function createRouter(modules, { getSecretValues = async () => [] } = {}) {
  const requests = new Map();   // type → fn
  const streams = new Map();    // type → fn
  const contentAllowed = new Set();
  const warnings = [];

  for (const m of modules) {
    for (const [kind, map, target] of [['handlers', m.handlers, requests], ['portHandlers', m.portHandlers, streams]]) {
      for (const [type, fn] of Object.entries(map || {})) {
        if (!type.startsWith(m.prefix)) { warnings.push(`${kind}: '${type}' 은(는) '${m.prefix}' 로 시작해야 합니다.`); continue; }
        if (typeof fn !== 'function') { warnings.push(`${kind}: '${type}' 이(가) 함수가 아닙니다.`); continue; }
        if (requests.has(type) || streams.has(type)) { warnings.push(`${kind}: '${type}' 이(가) 중복 등록되었습니다.`); continue; }
        target.set(type, fn);
      }
    }
    for (const t of m.contentAllowed || []) contentAllowed.add(t);
  }
  warnings.forEach((w) => console.error('[router]', w));

  const ownPrefixes = modules.map((m) => m.prefix);
  const extOrigin = chrome.runtime.getURL('');

  /** 'ext' 확장 페이지(패널·옵션) / 'content' 콘텐츠 스크립트 / 'other' */
  function senderKind(sender) {
    if (sender?.id !== chrome.runtime.id) return 'other';
    if (sender.url && sender.url.startsWith(extOrigin)) return 'ext';
    if (sender.tab) return 'content';
    return 'ext'; // 사이드 패널 등 tab 없는 확장 페이지
  }
  const fail = (e, secrets) => ({ ok: false, error: toErrorPayload(e, WHERE.SW, secrets) });
  const notAllowed = (type) => ({ ok: false, error: { messageKo: '이 위치에서는 사용할 수 없는 요청입니다.', raw: `${type}: 허용되지 않은 호출 위치`, where: WHERE.SW } });

  /** chrome.runtime.onMessage 리스너. 핸들러는 첫 줄에서 동기 호출한다(사이드 패널 열기의 사용자 제스처 유지). */
  function onMessage(msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string' || !ownPrefixes.some((p) => msg.type.startsWith(p))) return false;
    const requestId = msg.requestId ?? null;
    const fn = requests.get(msg.type);
    if (!fn) {
      sendResponse({ ok: false, requestId, error: { messageKo: '알 수 없는 요청입니다. 확장을 최신 버전으로 업데이트해 주세요.', raw: `type=${msg.type}`, where: WHERE.SW } });
      return false;
    }
    const kind = senderKind(sender);
    if (kind === 'other' || (kind === 'content' && !contentAllowed.has(msg.type))) {
      sendResponse({ requestId, ...notAllowed(msg.type) });
      return false;
    }
    keepAliveStart();
    const t0 = Date.now();
    let p;
    try { p = Promise.resolve(fn(msg.payload ?? null, { type: msg.type, requestId, sender, from: kind })); } catch (e) { p = Promise.reject(e); }
    p.then(
      (data) => { console.debug('[router]', msg.type, 'ok', Date.now() - t0, 'ms'); sendResponse({ ok: true, requestId, data: data === undefined ? null : data }); },
      async (e) => {
        const secrets = await getSecretValues().catch(() => []);
        const res = fail(e, secrets);
        console.debug('[router]', msg.type, 'fail', res.error.where, res.error.messageKo);
        sendResponse({ requestId, ...res });
      }
    ).finally(keepAliveEnd);
    return true; // 비동기 응답
  }

  /** chrome.runtime.onConnect 리스너. 포트 하나 = 요청 하나. */
  function onConnect(port) {
    if (port.name !== STREAM_PORT_NAME) return;
    const kind = senderKind(port.sender);
    let started = false;
    let seq = 0;
    let closed = false;
    const ac = new AbortController();
    port.onDisconnect.addListener(() => { closed = true; ac.abort(); });

    const send = (m) => { if (closed) return; try { port.postMessage(m); } catch { closed = true; } };

    port.onMessage.addListener(async (msg) => {
      if (msg?.kind === 'cancel') { ac.abort(); return; }
      if (started) return;
      started = true;
      const requestId = msg?.requestId ?? null;
      const type = msg?.type;
      const finishErr = async (e) => {
        const secrets = await getSecretValues().catch(() => []);
        send({ kind: 'error', requestId, seq: ++seq, error: toErrorPayload(e, WHERE.SW, secrets) });
      };
      const fn = typeof type === 'string' ? streams.get(type) : null;
      if (!fn) return finishErr({ messageKo: '알 수 없는 스트리밍 요청입니다. 확장을 최신 버전으로 업데이트해 주세요.', raw: `type=${type}`, where: WHERE.SW });
      if (kind === 'other' || (kind === 'content' && !contentAllowed.has(type))) return finishErr(notAllowed(type).error);

      const ctx = {
        type, requestId, sender: port.sender, from: kind,
        signal: ac.signal,
        /** 이벤트를 순서대로 패널에 보낸다. event 는 짧은 이름, data 는 JSON 가능한 값. */
        emit: (event, data = null) => send({ kind: 'event', requestId, seq: ++seq, event, data }),
      };
      keepAliveStart();
      try {
        const data = await fn(msg.payload ?? null, ctx);
        send({ kind: 'done', requestId, seq: ++seq, data: data === undefined ? null : data });
      } catch (e) {
        await finishErr(e);
      } finally {
        keepAliveEnd();
        setTimeout(() => { try { port.disconnect(); } catch {} }, 100);
      }
    });
  }

  return { onMessage, onConnect, warnings, types: () => ({ requests: [...requests.keys()], streams: [...streams.keys()], contentAllowed: [...contentAllowed] }) };
}
