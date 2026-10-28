// 공통 유틸 — 서비스워커·사이드 패널·옵션 페이지 어디서든 import 가능한 ES 모듈.
// (콘텐츠 스크립트는 ES 모듈을 못 쓰므로 import 하지 않는다. 형식은 docs/인터페이스.md 참고)

import { IS_WEB } from './platform.js';

/**
 * 오류가 어디서 났는지 (CLAUDE.md 규칙 9). 화면에 그대로 표시한다.
 * 웹 버전은 서비스워커·패널 구분이 없는 한 페이지 앱이라 SW·PANEL 모두 '앱'으로 나온다(코드는 그대로 WHERE.SW 를 써도 된다).
 */
export const WHERE = Object.freeze({
  SW: IS_WEB ? '앱' : '서비스워커',
  PANEL: IS_WEB ? '앱' : '패널',
  CONTENT: '콘텐츠',
  APP: '앱',
});

/**
 * 사용자에게 보여줄 한국어 문구(messageKo)와 원문(raw), 발생 위치(where)를 함께 싣는 오류.
 * 어디서든 `throw new AppError('한국어 안내', { raw: 원문, where: WHERE.SW, code: 'RATE_LIMIT' })`.
 */
export class AppError extends Error {
  constructor(messageKo, { raw, where, code } = {}) {
    super(messageKo);
    this.name = 'AppError';
    this.messageKo = messageKo;
    this.raw = raw === undefined ? '' : String(raw);
    this.where = where || WHERE.SW;
    if (code) this.code = code;
  }
}

/** 오류 원문에서 API 키로 보이는 값을 가린다. (로그·화면·응답 어디에도 키가 남지 않게) */
export function redactSecrets(text, extraSecrets = []) {
  let s = String(text ?? '');
  for (const secret of extraSecrets) {
    if (secret && String(secret).length >= 6) s = s.split(String(secret)).join('***');
  }
  return s
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, 'AIza***')
    .replace(/sk-[0-9A-Za-z_-]{16,}/g, 'sk-***')
    .replace(/(Bearer\s+)[^\s"',]+/gi, '$1***')
    .replace(/([?&]key=)[^&\s"']+/gi, '$1***')
    .replace(/(x-goog-api-key["']?\s*[:=]\s*["']?)[^\s"',]+/gi, '$1***')
    .replace(/(access-key=)[^,\s]+/gi, '$1***')
    .replace(/(signature=)[0-9a-f]{16,}/gi, '$1***');
}

const KNOWN = [
  [/Extension context invalidated/i, '확장 프로그램이 업데이트되었거나 다시 로드되었습니다. 이 페이지를 새로고침한 뒤 다시 시도해 주세요.'],
  [/Receiving end does not exist|Could not establish connection/i, '서비스워커와 연결하지 못했습니다. 잠시 뒤 다시 시도하고, 계속되면 chrome://extensions 에서 확장을 새로고침해 주세요.'],
  [/message port closed before a response|The message port closed/i, '서비스워커가 응답하기 전에 연결이 닫혔습니다. 다시 시도해 주세요.'],
  [/Failed to fetch|NetworkError|Load failed/i, '네트워크에 연결하지 못했습니다. 인터넷 연결을 확인하고 다시 시도해 주세요.'],
  [/QuotaExceededError/i, '브라우저 저장 공간이 부족합니다. 옵션의 "지난 작업"을 정리해 주세요.'],
  [/user gesture/i, '이 동작은 버튼을 직접 눌렀을 때만 실행됩니다. 버튼을 다시 눌러 주세요.'],
  [/aborted|AbortError/i, '요청이 취소되었습니다.'],
];

/** 아무 예외나 `{messageKo, raw, where, code?}` 로 바꾼다. (응답·이벤트로 보낼 때 사용) */
export function toErrorPayload(e, defaultWhere = WHERE.SW, extraSecrets = []) {
  if (e && typeof e === 'object' && typeof e.messageKo === 'string') {
    const out = {
      messageKo: e.messageKo,
      raw: redactSecrets(e.raw ?? '', extraSecrets),
      where: e.where || defaultWhere,
    };
    if (e.code) out.code = e.code;
    return out;
  }
  const raw = redactSecrets(e && e.message ? e.message : String(e), extraSecrets);
  const hit = KNOWN.find(([re]) => re.test(raw));
  return {
    messageKo: hit ? hit[1] : '알 수 없는 오류가 발생했습니다. 아래 원문과 발생 위치를 선생님께 알려 주세요.',
    raw,
    where: defaultWhere,
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function newId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Blob → base64 문자열 (data: 접두사 없음). Gemini inline_data 용. */
export async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
}

export function base64ToBlob(b64, type = 'application/octet-stream') {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** 지금 코드가 서비스워커 안에서 도는지 */
export function isServiceWorker() {
  return typeof ServiceWorkerGlobalScope !== 'undefined' && self instanceof ServiceWorkerGlobalScope;
}

/**
 * 키(비밀)를 읽어도 되는 곳인지. 확장은 서비스워커만 허용한다.
 * 웹 버전은 라우터까지 같은 페이지 안에서 돌아 격리가 불가능하므로 허용한다(키는 그 사이트 origin 의 브라우저 저장소에만 있고 화면에는 안 나옴).
 */
export function canReadSecrets() {
  return IS_WEB || isServiceWorker();
}
