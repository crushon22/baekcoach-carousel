// 메시지 버스 — 클라이언트 쪽 (사이드 패널·옵션 페이지에서 import).
// 서비스워커로 보내는 모든 호출은 이 두 함수만 쓴다. 형식은 docs/인터페이스.md.
//   request(type, payload)  → 요청/응답. 성공 시 data, 실패 시 AppError 를 throw.
//   stream(type, payload, {onEvent}) → 포트 스트리밍. {done: Promise, cancel(), requestId}
// 콘텐츠 스크립트는 ES 모듈을 못 쓰므로 chrome.runtime.sendMessage({type, payload, requestId}) 를 직접 쓴다.

import { AppError, WHERE, newId, toErrorPayload } from './common.js';

export const STREAM_PORT_NAME = 'bc-stream';

function fromErrorObject(err, fallbackWhere) {
  return new AppError(err?.messageKo || '알 수 없는 오류가 발생했습니다.', { raw: err?.raw, where: err?.where || fallbackWhere, code: err?.code });
}

/**
 * 요청/응답. 서비스워커가 `{ok:false,error}` 로 답하면 같은 내용의 AppError 로 throw 한다.
 * @param {string} type  'core.getSettings' 처럼 접두사.이름
 * @param {*} payload    JSON 직렬화 가능한 값 (Blob·함수 불가 → 이미지는 imageId 로)
 * @param {{timeoutMs?:number, where?:string}} opts  where: 연결 실패 시 표시할 호출 위치(기본 '패널')
 */
export async function request(type, payload = null, { timeoutMs = 120000, where = WHERE.PANEL } = {}) {
  const requestId = newId('r');
  let timer;
  try {
    const res = await Promise.race([
      chrome.runtime.sendMessage({ type, payload, requestId }),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new AppError('서비스워커가 제때 응답하지 않았습니다. 다시 시도해 주세요.', { raw: `${type} 타임아웃 ${timeoutMs}ms`, where })), timeoutMs); }),
    ]);
    if (res === undefined) throw new AppError('서비스워커가 응답하지 않았습니다. 요청 종류를 확인해 주세요.', { raw: `${type}: 응답 없음`, where });
    if (res && res.ok === false) throw fromErrorObject(res.error, WHERE.SW);
    return res?.data ?? null;
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw fromErrorObject(toErrorPayload(e, where), where);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 포트 스트리밍. 서비스워커의 portHandlers[type] 이 emit 한 이벤트를 순서대로 onEvent 로 받는다.
 * @returns {{requestId:string, done:Promise<*>, cancel:()=>void}}
 *   done: 서비스워커 핸들러가 반환한 값으로 resolve, 오류면 AppError 로 reject.
 */
export function stream(type, payload = null, { onEvent, where = WHERE.PANEL } = {}) {
  const requestId = newId('s');
  let port;
  let settled = false;
  let cancel = () => {};
  const done = new Promise((resolve, reject) => {
    try {
      port = chrome.runtime.connect({ name: STREAM_PORT_NAME });
    } catch (e) {
      settled = true;
      reject(fromErrorObject(toErrorPayload(e, where), where));
      return;
    }
    let lastSeq = 0;
    port.onMessage.addListener((m) => {
      if (!m || m.requestId !== requestId) return;
      if (m.kind === 'event') {
        lastSeq = m.seq;
        try { onEvent && onEvent(m.event, m.data, m.seq); } catch (e) { console.error('[bus] onEvent 오류', e); }
      } else if (m.kind === 'done') {
        settled = true; resolve(m.data ?? null); try { port.disconnect(); } catch {}
      } else if (m.kind === 'error') {
        settled = true; reject(fromErrorObject(m.error, WHERE.SW)); try { port.disconnect(); } catch {}
      }
    });
    port.onDisconnect.addListener(() => {
      if (settled) return;
      settled = true;
      const raw = chrome.runtime.lastError?.message || `${type}: 포트가 닫힘 (마지막 이벤트 seq=${lastSeq})`;
      reject(new AppError('서비스워커와의 연결이 끊겼습니다. 다시 시도해 주세요.', { raw, where }));
    });
    port.postMessage({ type, payload, requestId });
    cancel = () => {
      if (settled) return;
      try { port.postMessage({ kind: 'cancel', requestId }); } catch {}
      settled = true;
      reject(new AppError('요청이 취소되었습니다.', { raw: `${type}: 사용자가 취소`, where, code: 'CANCELLED' }));
      setTimeout(() => { try { port.disconnect(); } catch {} }, 50);
    };
  });
  // 취소 후 done 을 아무도 안 기다려도 "처리되지 않은 거부" 경고가 나지 않게
  done.catch(() => {});
  return { requestId, done, cancel: () => cancel() };
}
