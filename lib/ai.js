// Gemini 호출 모듈 (서비스워커 전용) — 설계서 v1 §8 전부.
//  · 모델 자동 선택(하드코딩 금지): GET /v1beta/models?pageSize=200 → generateContent 지원 + gemini-<버전>-flash 안정판 최고 버전
//    (image|tts|audio|live|preview|exp|lite 제외). 가벼운 작업용 lite 선택 함수는 별도(kind:'lite'). 결과는 store.kv 에 캐시.
//  · 400 옵션 거부 자동 복구: 메시지에 따라 temperature → schema → json → tools → system 순으로 옵션만 빼고 재시도(최대 5회).
//  · 404 목록 재선택 1회 · 429 10초 대기 1회(전역 대기선 공유) → 그래도 막히면 RATE_LIMIT 으로 던져 호출자가 순차 전환.
//  · 오류 번역(402·API_KEY_INVALID·403·429·Failed to fetch·숫자 없는 Internal server error …) + 원문 + where:'서비스워커'.
//  · streamGenerateContent(SSE) 파서 · google_search 와 JSON 모드 동시 사용 금지 · 관대한 JSON 파서.
//  · 키는 store.getSecrets() 로만 읽고 URL·로그에 싣지 않는다(헤더 x-goog-api-key). 키 형식 검사로 거부하지 않는다(AQ. 로 시작할 수 있음).
// 서비스워커에서는 동적 import() 금지 — 정적 import 만 쓴다.

import { AppError, WHERE, redactSecrets } from './common.js';
import * as store from './store.js';
import { IS_WEB } from './platform.js';

export const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MODELS_KEY = 'ai:models';
const DROPS_KEY = 'ai:drops';
const MODEL_TTL_MS = 24 * 3600 * 1000;
const MAX_RECOVER = 5;

/** 시험용 조절값(kv 'dev:ai'): {rateWaitMs, timeoutMs}. 운영에서는 비어 있어 기본값을 쓴다. */
async function tuning() {
  const t = (await store.kvGet('dev:ai', null)) || {};
  const n = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== undefined ? Number(v) : d);
  return { rateWaitMs: n(t.rateWaitMs, 10000), timeoutMs: n(t.timeoutMs, 20000) };
}

// ───────────────────────── 작은 도구 ─────────────────────────

const cancelled = () => new AppError('요청이 취소되었습니다.', { raw: 'AbortError', where: WHERE.SW, code: 'CANCELLED' });

function sleepAbortable(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled());
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(cancelled()); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 429 가 한 번 나면 모든 호출이 같이 기다리게 하는 전역 대기선(병렬 호출이 한꺼번에 재시도하며 더 막히는 것을 방지). */
const gate = { until: 0 };
async function waitGate(signal) {
  const ms = gate.until - Date.now();
  if (ms > 0) await sleepAbortable(ms, signal);
}

/** 환경 설명(키 연결 확인 실패 때 같이 보여 줌): 열린 위치 + 브라우저. */
export function describeEnv() {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  const m = ua.match(/(Edg|OPR|Chrome|Firefox|Safari)\/[\d.]+/);
  const browser = m ? m[0].replace('Edg/', 'Edge/').replace('OPR/', 'Opera/') : ua.slice(0, 60);
  if (IS_WEB) return `위치: 앱(웹 버전, 주소 ${typeof location !== 'undefined' ? location.origin : '알 수 없음'}) · 브라우저: ${browser || '알 수 없음'}`;
  return `위치: 서비스워커(확장 프로그램, 주소 ${typeof chrome !== 'undefined' && chrome.runtime?.id ? 'chrome-extension' : '알 수 없음'}) · 브라우저: ${browser || '알 수 없음'}`;
}

// ───────────────────────── 오류 번역 ─────────────────────────

function pickMessage(text) {
  if (!text) return '';
  try {
    const j = JSON.parse(text);
    const e = Array.isArray(j) ? j[0]?.error : j.error;
    if (e) return `${e.status ? e.status + ': ' : ''}${e.message || ''}`.trim() || text;
  } catch { /* 본문이 JSON 이 아니면 원문 그대로 */ }
  return String(text);
}

/** HTTP 상태·본문 → AppError(한국어 안내 + 원문 + 위치). status 가 null 이면 숫자 없는 오류. */
export function translateHttpError(status, bodyText, secrets = []) {
  const msg = pickMessage(bodyText);
  const raw = redactSecrets(`${status ? 'HTTP ' + status + ' ' : ''}${msg}`.trim().slice(0, 900), secrets);
  const has = (re) => re.test(msg) || re.test(String(bodyText || ''));
  const mk = (ko, code) => new AppError(ko, { raw, where: WHERE.SW, code });

  // 번호(코드)가 없는 "Internal server error while processing action": 요청이 가로채졌거나 확장 밖 환경
  if (/Internal server error while processing action/i.test(String(bodyText || '')) && !/"code"\s*:\s*\d/.test(String(bodyText || ''))) {
    return mk('요청이 가로채졌거나 확장 밖 환경에서 실행된 것 같습니다("Internal server error while processing action", 번호 없음). Chrome 에서 이 확장을 직접 쓰고 있는지, 다른 확장(광고 차단 등)이 막고 있지 않은지 확인해 주세요.', 'INTERCEPTED');
  }

  if (status === 402 || (status !== 429 && has(/credits? (are|is) depleted|prepayment/i))) {
    return mk('결제가 연결된 프로젝트의 잔액이 0이라 막혔습니다. 결제가 안 붙은 새 프로젝트에서 키를 새로 만들거나(무료), aistudio.google.com/billing 에서 충전해 주세요.', 'BILLING');
  }
  if (has(/API_KEY_INVALID|API key not valid|API key expired|Invalid API key/i)) {
    return mk('Gemini 키가 올바르지 않습니다. aistudio.google.com 에서 키를 다시 복사해 옵션에 붙여넣어 주세요. (키는 AQ. 또는 AIza 로 시작하며 둘 다 정상입니다. 앞뒤 공백·줄바꿈이 없는지 확인하세요.)', 'KEY_INVALID');
  }
  if (status === 403 || has(/PERMISSION_DENIED/i)) {
    if (has(/location is not supported|User location/i)) return mk('이 지역에서는 Gemini를 쓸 수 없다고 응답했습니다. 계정·접속 지역 정책을 확인해 주세요.', 'FORBIDDEN');
    return mk('이 키로는 요청이 허용되지 않습니다(403). 키 사용 제한(허용 사이트·앱 제한)이나 계정 정책을 확인하고, 필요하면 결제 없는 새 프로젝트에서 키를 새로 만들어 주세요.', 'FORBIDDEN');
  }
  if (status === 429 || (!status && has(/RESOURCE_EXHAUSTED|quota|rate limit/i))) {
    if (has(/limit:\s*0|per day|PerDay|daily/i)) return mk('오늘 무료 사용량을 다 썼거나, 이 모델은 무료 키로 쓸 수 없습니다(429). 내일 다시 하거나 잠시 뒤 시도해 주세요.', 'QUOTA');
    return mk('요청이 너무 많습니다(무료 한도, 429). 1분쯤 뒤에 다시 시도해 주세요.', 'RATE_LIMIT');
  }
  if (status === 404 || has(/is not found for API version|models\/.+ not found/i)) {
    return mk('선택된 Gemini 모델을 찾지 못했습니다(404). 모델 목록을 다시 받아 자동으로 고르는 중이며, 계속되면 "키 연결 확인"을 눌러 주세요.', 'MODEL_NOT_FOUND');
  }
  if (status === 400) {
    return mk('Gemini가 요청 형식을 받아들이지 않았습니다(400). 아래 원문을 선생님께 알려 주세요.', 'BAD_REQUEST');
  }
  if (status === 408 || status === 504 || has(/DEADLINE_EXCEEDED/i)) {
    return mk('Gemini 응답이 너무 오래 걸렸습니다. 잠시 뒤 다시 시도해 주세요.', 'TIMEOUT');
  }
  if (status && status >= 500) {
    return mk(`Gemini 서버가 일시적으로 바쁩니다(${status}). 잠시 뒤 다시 시도해 주세요.`, 'SERVER');
  }
  return mk(`Gemini 호출에 실패했습니다${status ? '(' + status + ')' : ''}. 아래 원문을 선생님께 알려 주세요.`, 'GEMINI_ERROR');
}

function networkError(e) {
  const raw = redactSecrets(e?.message || String(e));
  if (/Internal server error while processing action/i.test(raw)) return translateHttpError(null, raw);
  if (/Failed to fetch|NetworkError|Load failed/i.test(raw)) {
    return new AppError('네트워크에 연결하지 못했습니다. 인터넷 연결을 확인하고, VPN·보안 프로그램·다른 확장이 generativelanguage.googleapis.com 을 막고 있지 않은지 확인해 주세요.', { raw, where: WHERE.SW, code: 'NETWORK' });
  }
  return new AppError('Gemini에 연결하는 중 오류가 났습니다.', { raw, where: WHERE.SW, code: 'NETWORK' });
}

// ───────────────────────── HTTP ─────────────────────────

/** 하나의 요청. onChunk 가 있으면 본문을 조각 단위로 흘려 준다. 타임아웃·취소를 구분해 던진다. */
async function httpCall({ url, method = 'GET', key, body, signal, timeoutMs, onChunk }) {
  const ac = new AbortController();
  let timedOut = false;
  const onAbort = () => ac.abort();
  if (signal) { if (signal.aborted) throw cancelled(); signal.addEventListener('abort', onAbort, { once: true }); }
  const timer = timeoutMs ? setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs) : null;
  try {
    const headers = { 'x-goog-api-key': key };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ac.signal });
    } catch (e) {
      if (timedOut) throw timeoutError(timeoutMs);
      if (signal?.aborted) throw cancelled();
      throw networkError(e);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, status: res.status, text };
    }
    if (onChunk) {
      const reader = res.body.getReader();
      const dec = new TextDecoder('utf-8');
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          onChunk(dec.decode(value, { stream: true }));
        }
        const tail = dec.decode();
        if (tail) onChunk(tail);
      } catch (e) {
        if (timedOut) throw timeoutError(timeoutMs);
        if (signal?.aborted) throw cancelled();
        if (e instanceof AppError) throw e;
        throw networkError(e);
      }
      return { ok: true, status: res.status, text: '' };
    }
    let text;
    try { text = await res.text(); } catch (e) {
      if (timedOut) throw timeoutError(timeoutMs);
      if (signal?.aborted) throw cancelled();
      throw networkError(e);
    }
    return { ok: true, status: res.status, text };
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

const timeoutError = (ms) => new AppError(`Gemini 응답이 ${Math.round(ms / 1000)}초 안에 오지 않았습니다. 잠시 뒤 다시 시도해 주세요.`, { raw: `timeout ${ms}ms`, where: WHERE.SW, code: 'TIMEOUT' });

/** SSE 조각을 이벤트(JSON 객체)로 바꾼다. 줄 경계가 어긋난 조각도 이어 붙인다. */
export class SseParser {
  constructor(onEvent) { this.buf = ''; this.onEvent = onEvent; }
  feed(chunk) {
    this.buf += chunk;
    for (;;) {
      const m = this.buf.match(/\r?\n\r?\n/);
      if (!m) break;
      const block = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      this._block(block);
    }
  }
  end() { if (this.buf.trim()) { const b = this.buf; this.buf = ''; this._block(b); } }
  _block(block) {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n').trim();
    if (!data || data === '[DONE]') return;
    let obj;
    try { obj = JSON.parse(data); } catch { return; } // 깨진 조각은 건너뜀(다음 이벤트가 이어짐)
    this.onEvent(obj);
  }
}

// ───────────────────────── 관대한 JSON 파서 ─────────────────────────

function extractBalanced(s, start) {
  const stack = [];
  let inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') { stack.pop(); if (!stack.length) return s.slice(start, i + 1); }
  }
  // 닫히지 않은 채 끝남(출력이 잘림): 열린 것들을 닫아 준다
  let out = s.slice(start);
  if (inStr) out += '"';
  out = out.replace(/[,:\s]+$/, '');
  while (stack.length) out += stack.pop();
  return out;
}

/** 코드블록·앞뒤 잡문이 있어도 JSON 을 꺼낸다. 후행 쉼표·주석·잘림도 복구 시도. 실패하면 AppError(PARSE). */
export function parseLooseJson(text) {
  if (typeof text !== 'string' || !text.trim()) throw new AppError('모델이 빈 답을 돌려줬습니다.', { raw: String(text ?? ''), where: WHERE.SW, code: 'EMPTY' });
  let s = text.replace(/^﻿/, '').trim();
  const fence = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/) || s.match(/```(?:json|JSON)?\s*([\s\S]*)$/);
  if (fence) s = fence[1].trim();
  const start = s.search(/[{[]/);
  if (start < 0) throw new AppError('모델 답에서 JSON 을 찾지 못했습니다.', { raw: text.slice(0, 400), where: WHERE.SW, code: 'PARSE' });
  const cand = extractBalanced(s, start);
  const attempts = [
    (x) => x,
    (x) => x.replace(/\/\/[^\n"]*$/gm, '').replace(/,\s*([}\]])/g, '$1'),
    (x) => x.replace(/[“”]/g, '"').replace(/,\s*([}\]])/g, '$1').replace(/\/\/[^\n"]*$/gm, ''),
    (x) => x.replace(/[\u0000-\u001f]/g, (c) => (c === '\n' ? '\\n' : c === '\t' ? '\\t' : '')).replace(/,\s*([}\]])/g, '$1'),
  ];
  let lastErr;
  for (const fix of attempts) {
    try { return JSON.parse(fix(cand)); } catch (e) { lastErr = e; }
  }
  throw new AppError('모델 답을 JSON 으로 읽지 못했습니다. 다시 시도해 주세요.', { raw: `${lastErr?.message || ''} :: ${text.slice(0, 400)}`, where: WHERE.SW, code: 'PARSE' });
}

// ───────────────────────── 모델 자동 선택 ─────────────────────────

const verOf = (s) => { const [a, b = '0'] = String(s).split('.'); return [Number(a) || 0, Number(b) || 0]; };
const cmpVer = (x, y) => (x[0] - y[0]) || (x[1] - y[1]);

/** models.list 응답 → {main, lite, image} 모델 이름. 순수 함수(시험 가능). 이름 문자열을 코드에 박지 않고 패턴으로만 고른다. */
export function chooseModels(models) {
  const names = (models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => String(m.name || '').replace(/^models\//, ''));
  // 안정판 flash: gemini-<버전>-flash (선택적 -001 꼬리). image|tts|audio|live|preview|exp|lite 는 패턴이 아예 통과시키지 않는다.
  const best = (re) => {
    let top = null;
    for (const n of names) {
      const m = n.match(re);
      if (!m) continue;
      const v = verOf(m[1]);
      const plain = !m[2]; // 숫자 꼬리가 없는 쪽을 우선
      if (!top || cmpVer(v, top.v) > 0 || (cmpVer(v, top.v) === 0 && plain && !top.plain)) top = { n, v, plain };
    }
    return top ? top.n : null;
  };
  const main = best(/^gemini-(\d+(?:\.\d+)?)-flash(?:-(\d{3}))?$/);
  const lite = best(/^gemini-(\d+(?:\.\d+)?)-flash-lite(?:-(\d{3}))?$/);
  // 이미지: 이름에 image 가 있고 tts/audio/live 가 아닌 것. preview/exp 는 안정판이 없을 때만.
  const rank = (n) => ({ n, unstable: /preview|exp/i.test(n) ? 1 : 0, flash: /flash/i.test(n) ? 0 : 1, v: verOf((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || '0') });
  const image = names
    .filter((n) => /image/i.test(n) && !/tts|audio|live|embedding/i.test(n))
    .map(rank)
    .sort((x, y) => (x.unstable - y.unstable) || (x.flash - y.flash) || cmpVer(y.v, x.v))[0]?.n || null;
  return { main, lite: lite || main, image };
}

let memModels = null; // {at, picks, count}

/** 모델 목록을 받아 캐시한다. */
export async function refreshModels({ key, signal } = {}) {
  const k = key ?? (await getKey());
  const tun = await tuning();
  const all = [];
  let token = '';
  for (let page = 0; page < 4; page++) {
    const url = `${API_BASE}/models?pageSize=200${token ? '&pageToken=' + encodeURIComponent(token) : ''}`;
    const r = await httpCall({ url, key: k, signal, timeoutMs: tun.timeoutMs });
    if (!r.ok) throw translateHttpError(r.status, r.text, [k]);
    let j;
    try { j = JSON.parse(r.text); } catch { throw new AppError('모델 목록 응답을 읽지 못했습니다.', { raw: r.text.slice(0, 300), where: WHERE.SW, code: 'PARSE' }); }
    all.push(...(j.models || []));
    token = j.nextPageToken || '';
    if (!token) break;
  }
  const picks = chooseModels(all);
  memModels = { at: Date.now(), picks, count: all.length };
  await store.kvSet(MODELS_KEY, memModels);
  return memModels;
}

/** kind: 'main' | 'lite' | 'image'. 캐시가 24시간 안이면 그대로, 아니면 목록을 새로 받는다. */
export async function selectModel(kind = 'main', { refresh = false, key, signal } = {}) {
  let cache = memModels || (await store.kvGet(MODELS_KEY, null));
  if (refresh || !cache || Date.now() - (cache.at || 0) > MODEL_TTL_MS || !cache.picks) cache = await refreshModels({ key, signal });
  else memModels = cache;
  const name = cache.picks[kind];
  if (!name) {
    throw new AppError(
      kind === 'image' ? '이 키로 쓸 수 있는 Gemini 이미지 생성 모델을 찾지 못했습니다. 무료 키는 이미지 생성이 막혀 있을 수 있습니다.' : '이 키로 쓸 수 있는 Gemini 글쓰기 모델(flash)을 찾지 못했습니다.',
      { raw: `models=${cache.count} picks=${JSON.stringify(cache.picks)}`, where: WHERE.SW, code: 'MODEL_NONE' });
  }
  return name;
}

async function getKey() {
  const { geminiKey } = await store.getSecrets();
  if (!geminiKey) throw new AppError('Gemini 키가 없습니다. 옵션 화면에서 키를 입력하고 "키 연결 확인"을 눌러 주세요.', { raw: 'geminiKey 없음', where: WHERE.SW, code: 'NO_KEY' });
  return geminiKey;
}

// ───────────────────────── 옵션 거부 자동 복구 ─────────────────────────

/** 400 메시지에서 어떤 옵션이 문제인지 찾는다. 순서: temperature → (thinking) → schema → json → tools → system. */
export function pickOptionToDrop(message, enabled) {
  // "Invalid JSON payload received" 는 모든 알 수 없는 필드 오류에 붙으므로 json 판정에서 뺀다.
  const m = String(message || '').replace(/Invalid JSON payload received\.?/gi, '').toLowerCase();
  const order = [
    ['temperature', /temperature/],
    ['thinking', /thinking/],
    ['imageConfig', /imageconfig|image_config|aspect.?ratio/],
    ['modalities', /modalit/],
    ['schema', /schema/],
    ['json', /json|mime|response_?format|format/],
    ['tools', /tool|search|grounding/],
    ['system', /system|instruction|developer/],
  ];
  for (const [name, re] of order) if (enabled[name] && re.test(m)) return name;
  return null;
}

let learned = null; // {모델명: [옵션,…]}
async function loadLearned() { if (!learned) learned = (await store.kvGet(DROPS_KEY, null)) || {}; return learned; }
async function learn(model, opt) {
  const l = await loadLearned();
  const set = new Set(l[model] || []);
  if (set.has(opt)) return;
  set.add(opt);
  l[model] = [...set];
  await store.kvSet(DROPS_KEY, l);
}

/** 캐시(모델 목록·학습된 옵션 거부)를 비운다. 키 연결 확인·시험에서 쓴다. */
export async function resetCaches() {
  memModels = null; learned = {};
  gate.until = 0;
  await store.kvRemove(MODELS_KEY); await store.kvRemove(DROPS_KEY);
}

// ───────────────────────── generate / stream ─────────────────────────

function buildBody(o, on, jsonHint) {
  const gen = {};
  if (on.temperature && o.temperature != null) gen.temperature = o.temperature;
  if (o.maxOutputTokens) gen.maxOutputTokens = o.maxOutputTokens;
  if (on.json) gen.responseMimeType = 'application/json';
  if (on.json && on.schema && o.schema) gen.responseSchema = o.schema;
  if (on.thinking) gen.thinkingConfig = { thinkingBudget: 0 };
  if (on.modalities && o.responseModalities) gen.responseModalities = o.responseModalities;
  if (on.imageConfig && o.imageConfig) gen.imageConfig = o.imageConfig;

  const parts = typeof o.prompt === 'string' ? [{ text: o.prompt }] : (o.parts || []).map((p) => ({ ...p }));
  const body = { contents: [{ role: 'user', parts }] };
  if (o.system) {
    if (on.system) body.systemInstruction = { parts: [{ text: o.system }] };
    else if (parts[0] && typeof parts[0].text === 'string') parts[0].text = `${o.system}\n\n${parts[0].text}`;
    else parts.unshift({ text: o.system });
  }
  if (jsonHint) {
    const last = [...parts].reverse().find((p) => typeof p.text === 'string');
    if (last) last.text += '\n\n(JSON만 출력하세요. 코드블록·설명 없이 JSON 한 덩어리만.)';
  }
  if (Object.keys(gen).length) body.generationConfig = gen;
  if (on.tools && o.search) body.tools = [{ google_search: {} }];
  return body;
}

function summarize(j) {
  const cand = j?.candidates?.[0] || {};
  const parts = cand.content?.parts || [];
  const text = parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('');
  const images = parts
    .map((p) => p.inlineData || p.inline_data)
    .filter(Boolean)
    .map((d) => ({ mime: d.mimeType || d.mime_type || 'image/png', data: d.data }));
  const gm = cand.groundingMetadata || {};
  const chunks = (gm.groundingChunks || []).map((c) => ({ uri: c.web?.uri || '', title: c.web?.title || '' })).filter((c) => c.uri);
  const supports = (gm.groundingSupports || []).map((s) => ({ text: s.segment?.text || '', idx: s.groundingChunkIndices || [] }));
  return {
    text, images,
    finishReason: cand.finishReason || '',
    blockReason: j?.promptFeedback?.blockReason || '',
    grounding: { chunks, supports, queries: gm.webSearchQueries || [] },
    usage: j?.usageMetadata || null,
  };
}

function mergeSummaries(events) {
  // 스트림: 텍스트는 이어 붙이고, 나머지는 마지막으로 값이 있는 것을 쓴다.
  const out = { text: '', images: [], finishReason: '', blockReason: '', grounding: { chunks: [], supports: [], queries: [] }, usage: null };
  for (const j of events) {
    const s = summarize(j);
    out.text += s.text;
    out.images.push(...s.images);
    if (s.finishReason) out.finishReason = s.finishReason;
    if (s.blockReason) out.blockReason = s.blockReason;
    if (s.grounding.chunks.length) out.grounding.chunks = s.grounding.chunks;
    if (s.grounding.supports.length) out.grounding.supports = s.grounding.supports;
    if (s.grounding.queries.length) out.grounding.queries = s.grounding.queries;
    if (s.usage) out.usage = s.usage;
  }
  return out;
}

/**
 * Gemini 한 번 호출(복구 계층 포함).
 * @param {object} o
 *   kind 'main'|'lite'|'image' (기본 main) · modelName(직접 지정) · system · prompt(문자열) | parts[] · temperature · json · schema ·
 *   search(google_search; json 과 같이 쓰면 json 을 끈다) · maxOutputTokens · thinking(기본 끔) · responseModalities · imageConfig ·
 *   signal · timeoutMs · key(키 연결 확인용 임시 키) · stream · onText(delta, full) · rate(false 면 429 대기 없이 바로 던짐) · parse(true 면 .json 까지)
 * @returns {Promise<{text, json?, images, model, finishReason, grounding, usage, dropped:string[], ms}>}
 */
export async function generate(o) {
  const t0 = Date.now();
  const tun = await tuning();
  const key = o.key ?? (await getKey());
  const signal = o.signal;
  const explicit = !!o.modelName;
  let model = o.modelName || (await selectModel(o.kind || 'main', { key, signal }));

  // google_search 와 JSON 모드는 동시에 쓰지 않는다
  const search = !!o.search;
  const wantJson = !!o.json && !search;
  const on = {
    temperature: o.temperature != null, thinking: o.thinking !== false && (o.kind || 'main') !== 'image',
    schema: !!o.schema && wantJson, json: wantJson, tools: search, system: !!o.system,
    imageConfig: !!o.imageConfig, modalities: !!o.responseModalities,
  };
  const dropped = [];
  for (const opt of (await loadLearned())[model] || []) if (on[opt]) { on[opt] = false; dropped.push(opt); }

  let recoveries = 0, reselected = false, rateRetried = false, serverRetried = false, netRetried = false;
  for (;;) {
    await waitGate(signal);
    const jsonHint = wantJson && !on.json;
    const body = buildBody({ ...o, json: wantJson }, on, jsonHint);
    const path = `${API_BASE}/models/${encodeURIComponent(model)}:${o.stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;

    let summary = null;
    let res;
    if (o.stream) {
      const events = [];
      let full = '';
      let streamErr = null;
      const sse = new SseParser((obj) => {
        if (obj.error) { streamErr = obj.error; return; }
        events.push(obj);
        const s = summarize(obj);
        if (s.text) { full += s.text; try { o.onText?.(s.text, full); } catch { /* 콜백 오류는 무시 */ } }
      });
      res = await httpCall({ url: path, method: 'POST', key, body, signal, timeoutMs: o.timeoutMs ?? tun.timeoutMs, onChunk: (c) => sse.feed(c) });
      sse.end();
      if (res.ok && streamErr) res = { ok: false, status: Number(streamErr.code) || 500, text: JSON.stringify({ error: streamErr }) };
      if (res.ok) summary = mergeSummaries(events);
    } else {
      const post = () => httpCall({ url: path, method: 'POST', key, body, signal, timeoutMs: o.timeoutMs ?? tun.timeoutMs });
      try { res = await post(); } catch (e) { // 순간적인 네트워크 오류는 한 번만 다시 시도
        if (!(e instanceof AppError && e.code === 'NETWORK' && !netRetried)) throw e;
        netRetried = true; await sleepAbortable(800, signal); res = await post();
      }
      if (res.ok) {
        let j;
        try { j = JSON.parse(res.text); } catch {
          if (/Internal server error while processing action/i.test(res.text)) throw translateHttpError(null, res.text);
          throw new AppError('Gemini 응답을 읽지 못했습니다.', { raw: redactSecrets(res.text.slice(0, 400), [key]), where: WHERE.SW, code: 'PARSE' });
        }
        summary = summarize(j);
      }
    }

    if (res.ok) {
      if (!summary.text && !summary.images.length) {
        if (summary.blockReason || /SAFETY|PROHIBITED|BLOCKLIST|SPII|IMAGE_SAFETY|RECITATION/i.test(summary.finishReason)) {
          throw new AppError('Gemini 안전 필터에 걸려 답을 받지 못했습니다. 상품명·문구를 조금 바꿔 다시 시도해 주세요.', { raw: `blockReason=${summary.blockReason} finishReason=${summary.finishReason}`, where: WHERE.SW, code: 'BLOCKED' });
        }
        throw new AppError('모델이 빈 답을 돌려줬습니다. 다시 시도해 주세요.', { raw: `finishReason=${summary.finishReason || '없음'}`, where: WHERE.SW, code: 'EMPTY' });
      }
      const out = { ...summary, model, dropped, ms: Date.now() - t0 };
      if (o.parse) out.json = parseLooseJson(summary.text);
      return out;
    }

    // ── 실패 처리 ──
    const { status, text } = res;
    const msg = pickMessage(text);
    if (status === 400 && !/API_KEY_INVALID|API key not valid/i.test(msg) && recoveries < MAX_RECOVER) {
      const opt = pickOptionToDrop(msg, on);
      if (opt) {
        on[opt] = false; dropped.push(opt); recoveries++;
        await learn(model, opt);
        continue;
      }
    }
    if (status === 404 && !explicit && !reselected) {
      reselected = true;
      model = await selectModel(o.kind || 'main', { refresh: true, key, signal });
      continue; // 같은 모델이 다시 뽑혀도 1회는 다시 시도(일시 오류 가능)
    }
    if (status === 429 && o.rate !== false && !rateRetried) {
      rateRetried = true;
      gate.until = Math.max(gate.until, Date.now() + tun.rateWaitMs);
      continue; // 루프 맨 위 waitGate 가 10초 기다린다
    }
    if ((status === 500 || status === 503) && !serverRetried) {
      serverRetried = true;
      await sleepAbortable(1200, signal);
      continue;
    }
    throw translateHttpError(status, text, [key]);
  }
}

export const selectMainModel = (opts) => selectModel('main', opts);
/** 가벼운 작업(사실 검수·쇼츠·채팅 해석)용 flash-lite. 없으면 main 으로 대체된다. */
export const selectLiteModel = (opts) => selectModel('lite', opts);
export const selectImageModel = (opts) => selectModel('image', opts);

/** 스트리밍 호출: generate({stream:true}) 의 별칭. onText(delta, full) 로 조각을 받는다. */
export const streamGenerate = (o) => generate({ ...o, stream: true });

// ───────────────────────── 키 연결 확인 (v1 §8-6) ─────────────────────────

/** 모델 목록 조회 + 짧은 생성 1회. 실패하면 원문·위치·브라우저를 함께 담은 AppError. payload.key 가 있으면 저장 전 키를 시험한다. */
export async function checkKey({ key, signal } = {}) {
  const t0 = Date.now();
  try {
    const k = key || (await getKey());
    await resetCaches();
    const info = await refreshModels({ key: k, signal });
    const main = await selectModel('main', { key: k, signal });
    const base = { ok: true, model: main, liteModel: info.picks.lite, imageModel: info.picks.image, modelCount: info.count, env: describeEnv() };
    // 모델 목록이 200으로 왔다 = 키는 유효하다. 시험 생성은 가장 가벼운 모델로, 넉넉히 기다린다.
    // 생성이 늦기만 한 경우(TIMEOUT)는 "연결 실패"가 아니라 "키는 정상, 응답이 느림"으로 알린다.
    let r;
    try {
      r = await generate({ key: k, kind: 'lite', prompt: '한국어로 "연결 확인"이라고만 답하세요.', maxOutputTokens: 24, temperature: 0, signal, timeoutMs: 30000 });
    } catch (e) {
      if (e instanceof AppError && e.code === 'TIMEOUT') {
        return { ...base, slow: true, reply: '', ms: Date.now() - t0,
          warning: '키는 정상이에요(모델 목록을 받았어요). 다만 시험 문장 응답이 30초 안에 오지 않았어요. Gemini 서버가 붐비는 중일 수 있으니 잠시 뒤 다시 확인해 주세요.' };
      }
      throw e;
    }
    return { ...base, reply: r.text.trim().slice(0, 40), testModel: r.model, dropped: r.dropped, ms: Date.now() - t0 };
  } catch (e) {
    if (e instanceof AppError) {
      e.raw = `${e.raw}${e.raw ? ' | ' : ''}${describeEnv()}`;
      throw e;
    }
    throw new AppError('키 연결 확인에 실패했습니다.', { raw: `${redactSecrets(e?.message || String(e))} | ${describeEnv()}`, where: WHERE.SW });
  }
}

/** JSON 모드 호출 + 관대한 파싱 + 파싱 실패/빈 답 1회 재시도. 에이전트가 주로 쓰는 진입점. */
export async function generateJson(o) {
  try {
    return await generate({ ...o, json: !o.search, parse: true });
  } catch (e) {
    if (e instanceof AppError && (e.code === 'PARSE' || e.code === 'EMPTY') && !o.signal?.aborted) {
      return await generate({ ...o, json: !o.search, parse: true });
    }
    throw e;
  }
}
