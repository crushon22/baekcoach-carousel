// GPT(OpenAI) 호출 모듈 (서비스워커 전용) — 설정에서 "GPT"를 고르면 ai.js 의 generate·selectModel·checkKey 가 여기로 넘긴다.
//  · 글: Responses API(POST /v1/responses) — instructions(시스템) · input(글·사진) · text.format json_object · web_search 도구 · SSE 스트리밍.
//  · 이미지: Images API — 참고 사진이 있으면 /v1/images/edits(멀티파트), 없으면 /v1/images/generations. 결과는 base64 PNG.
//  · 모델 자동 선택(하드코딩 금지): GET /v1/models → 이름 패턴으로 고른다. 글 = 가장 높은 버전의 mini(없으면 기본형),
//    가벼운 작업 = nano(없으면 글 모델), 이미지 = 가장 높은 버전의 이미지 모델(mini 아닌 쪽 우선). 날짜 꼬리·preview·audio 등은 제외.
//  · 생각(reasoning) 모델은 temperature 를 보내지 않고 reasoning.effort 를 가장 낮게. 400 으로 거절되면 다음 값 → 빼기(모델별로 기억).
//  · 오류 번역(401·429 잔액 없음=BILLING(바로 멈춤)/한도=RATE_LIMIT·403 조직 인증·404·400 정책 차단·5xx) + 원문 + where:'서비스워커'. 키는 Authorization 헤더로만.
// 서비스워커에서는 동적 import() 금지 — 정적 import 만 쓴다.

import { AppError, WHERE, redactSecrets, base64ToBlob, blobToBase64, keyFingerprint } from './common.js';
import * as store from './store.js';
import { parseLooseJson, SseParser, describeEnv } from './ai.js';

export const OPENAI_BASE = 'https://api.openai.com/v1';
const MODELS_KEY = 'oai:models';
const DROPS_KEY = 'oai:drops';
const MODEL_TTL_MS = 24 * 3600 * 1000;
const MAX_RECOVER = 5;
const EFFORTS = ['minimal', 'none', 'low'];   // 가장 가벼운 생각 단계부터. 모델이 거절하면 다음 값

async function tuning() {
  const t = (await store.kvGet('dev:ai', null)) || {};
  const n = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== undefined ? Number(v) : d);
  return { rateWaitMs: n(t.rateWaitMs, 10000), timeoutMs: n(t.timeoutMs, 20000) };
}
const cancelled = () => new AppError('요청이 취소되었습니다.', { raw: 'AbortError', where: WHERE.SW, code: 'CANCELLED' });
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(cancelled());
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(cancelled()); }, { once: true });
});

// ───────────────────────── 오류 번역 ─────────────────────────

function errOf(text) {
  try { const j = JSON.parse(text); return j?.error || j?.response?.error || null; } catch { return null; }
}

/** HTTP 상태·본문 → AppError(한국어 안내 + 원문 + 위치) */
export function translateOpenAIError(status, bodyText, secrets = []) {
  const e = errOf(bodyText) || {};
  const msg = `${e.code ? e.code + ': ' : ''}${e.message || String(bodyText || '')}`.trim();
  const raw = redactSecrets(`${status ? 'HTTP ' + status + ' ' : ''}${msg}`.slice(0, 900), secrets);
  const has = (re) => re.test(msg) || re.test(String(e.type || ''));
  const mk = (ko, code) => new AppError(ko, { raw, where: WHERE.SW, code });
  // 401 이라도 "키가 틀림"만 있는 게 아니다: 권한을 줄인 키(Restricted)·꺼진 프로젝트·조직 미가입은 따로 알려 준다
  if (has(/insufficient permissions|missing scopes/i)) return mk('이 GPT 키에는 필요한 권한이 없어요(401). 키를 "Restricted"로 만들었다면 Models·Responses·Images 를 허용하거나, 권한을 "All"로 해서 새 키를 만들어 주세요.', 'FORBIDDEN');
  if (has(/member of an organization/i)) return mk('이 OpenAI 계정이 조직(Organization)에 속해 있지 않아 API 를 쓸 수 없어요(401). platform.openai.com 에 로그인해 조직을 만든 뒤 그 안에서 키를 새로 만들어 주세요.', 'FORBIDDEN');
  if (has(/deactivated|disabled|archived/i)) return mk('이 GPT 키(또는 키가 속한 프로젝트)가 꺼져 있어요(401). platform.openai.com 의 API keys 에서 새 키를 만들어 주세요.', 'KEY_INVALID');
  if (status === 401 || has(/invalid_api_key|Incorrect API key/i)) return mk('OpenAI가 이 GPT 키를 받아 주지 않았어요(401). ① 키 목록에 보이는 "sk-...abcd"처럼 가려진 키는 쓸 수 없어요 — [Create new secret key]로 새 키를 만들고 처음 한 번 보여 줄 때 전체를 복사해 주세요. ② 키를 지웠거나(Revoke) 다른 계정의 키가 아닌지 확인해 주세요.', 'KEY_INVALID');
  if (has(/insufficient_quota|billing|exceeded your current quota/i)) return mk('OpenAI 계정에 남은 잔액(크레딧)이 없어 막혔어요(429). platform.openai.com 의 Billing 에서 충전한 뒤 다시 시도해 주세요. (ChatGPT 구독과 API 잔액은 따로예요.)', 'BILLING');
  if (status === 429) return mk('GPT 요청이 너무 많습니다(429). 1분쯤 뒤에 다시 시도해 주세요.', 'RATE_LIMIT');
  if (status === 403 || has(/must be verified|organization.*verif/i)) {
    if (has(/verif/i)) return mk('이 GPT 모델은 OpenAI 조직 인증(Verify Organization)을 마친 계정만 쓸 수 있어요(403). platform.openai.com 의 Settings → Organization 에서 인증하거나, 이미지는 "다른 AI에서 만들기"를 써 주세요.', 'FORBIDDEN');
    if (has(/country|region|territory/i)) return mk('이 지역에서는 OpenAI API 를 쓸 수 없다고 응답했습니다(403).', 'FORBIDDEN');
    return mk('이 키로는 요청이 허용되지 않습니다(403). 키 권한(Restricted 키라면 Responses·Images·Models 허용)을 확인해 주세요.', 'FORBIDDEN');
  }
  if (status === 404 || has(/model_not_found|does not exist/i)) return mk('선택된 GPT 모델을 찾지 못했습니다(404). 모델 목록을 다시 받아 봤지만 쓸 수 있는 모델이 없었어요. 설정에서 "키 연결 확인"을 눌러 주세요.', 'MODEL_NOT_FOUND');
  if (has(/moderation_blocked|content_policy|safety system/i)) return mk('GPT 안전 정책에 걸려 만들지 못했어요. 문구나 요청을 조금 바꿔 다시 시도해 주세요.', 'BLOCKED');
  if (status === 400) return mk('GPT가 요청 형식을 받아들이지 않았습니다(400). 아래 원문을 선생님께 알려 주세요.', 'BAD_REQUEST');
  if (status === 408 || status === 504) return mk('GPT 응답이 너무 오래 걸렸습니다. 잠시 뒤 다시 시도해 주세요.', 'TIMEOUT');
  if (status && status >= 500) return mk(`OpenAI 서버가 일시적으로 바쁩니다(${status}). 잠시 뒤 다시 시도해 주세요.`, 'SERVER');
  return mk(`GPT 호출에 실패했습니다${status ? '(' + status + ')' : ''}. 아래 원문을 선생님께 알려 주세요.`, 'OPENAI_ERROR');
}

const timeoutError = (ms) => new AppError(`GPT 응답이 ${Math.round(ms / 1000)}초 안에 오지 않았습니다. 잠시 뒤 다시 시도해 주세요.`, { raw: `timeout ${ms}ms`, where: WHERE.SW, code: 'TIMEOUT' });
function networkError(e) {
  const raw = redactSecrets(e?.message || String(e));
  return new AppError('OpenAI 에 연결하지 못했습니다. 인터넷 연결을 확인하고, VPN·보안 프로그램·다른 확장이 api.openai.com 을 막고 있지 않은지 확인해 주세요.', { raw, where: WHERE.SW, code: 'NETWORK' });
}

// ───────────────────────── HTTP ─────────────────────────

async function httpCall({ path, method = 'GET', key, body, form, signal, timeoutMs, onChunk }) {
  const ac = new AbortController();
  let timedOut = false;
  const onAbort = () => ac.abort();
  if (signal) { if (signal.aborted) throw cancelled(); signal.addEventListener('abort', onAbort, { once: true }); }
  const timer = timeoutMs ? setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs) : null;
  try {
    const headers = { Authorization: `Bearer ${key}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(OPENAI_BASE + path, { method, headers, body: form || (body === undefined ? undefined : JSON.stringify(body)), signal: ac.signal });
    } catch (e) {
      if (timedOut) throw timeoutError(timeoutMs);
      if (signal?.aborted) throw cancelled();
      throw networkError(e);
    }
    if (!res.ok) return { ok: false, status: res.status, text: await res.text().catch(() => '') };
    try {
      if (onChunk) {
        const reader = res.body.getReader();
        const dec = new TextDecoder('utf-8');
        for (;;) { const { done, value } = await reader.read(); if (done) break; onChunk(dec.decode(value, { stream: true })); }
        const tail = dec.decode(); if (tail) onChunk(tail);
        return { ok: true, status: res.status, text: '' };
      }
      return { ok: true, status: res.status, text: await res.text() };
    } catch (e) {
      if (timedOut) throw timeoutError(timeoutMs);
      if (signal?.aborted) throw cancelled();
      if (e instanceof AppError) throw e;
      throw networkError(e);
    }
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// ───────────────────────── 모델 자동 선택 ─────────────────────────

const verOf = (s) => { const [a, b = '0'] = String(s).split('.'); return [Number(a) || 0, Number(b) || 0]; };
const cmpVer = (x, y) => (x[0] - y[0]) || (x[1] - y[1]);
const SKIP = /audio|realtime|search|transcribe|tts|embedding|moderation|instruct|codex|preview|latest|\d{4}-\d{2}-\d{2}|-\d{4}$/i;

/** /v1/models 응답(data[].id) → {main, lite, image, lists}. 순수 함수(시험 가능). 이름은 패턴으로만 고른다. */
export function chooseOpenAIModels(models) {
  const ids = (models || []).map((m) => String(m?.id || '')).filter(Boolean);
  const by = (re, skip = SKIP) => ids.map((n) => { const m = skip && skip.test(n) ? null : n.match(re); return m ? { n, v: verOf(m[1]), o: !!m[2] } : null; })
    .filter(Boolean).sort((x, y) => cmpVer(y.v, x.v) || (Number(x.o) - Number(y.o))).map((x) => x.n);
  const mini = by(/^gpt-(\d+(?:\.\d+)?)(o)?-mini$/);
  const nano = by(/^gpt-(\d+(?:\.\d+)?)(o)?-nano$/);
  const full = by(/^gpt-(\d+(?:\.\d+)?)(o)?$/);
  const mainList = [...mini, ...full];
  const liteList = [...nano, ...mainList];
  const imgs = ids.map((n) => { const m = n.match(/^gpt-image-(\d+(?:\.\d+)?)(-mini)?$/); return m ? { n, v: verOf(m[1]), mini: !!m[2] } : null; })
    .filter(Boolean).sort((x, y) => cmpVer(y.v, x.v) || (Number(x.mini) - Number(y.mini))).map((x) => x.n);
  return { main: mainList[0] || null, lite: liteList[0] || null, image: imgs[0] || null, lists: { main: mainList, lite: liteList, image: imgs } };
}

let memModels = null;
export async function refreshModels({ key, signal } = {}) {
  const k = key ?? (await getKey());
  const tun = await tuning();
  const r = await httpCall({ path: '/models', key: k, signal, timeoutMs: tun.timeoutMs });
  if (!r.ok) throw translateOpenAIError(r.status, r.text, [k]);
  let j;
  try { j = JSON.parse(r.text); } catch { throw new AppError('GPT 모델 목록 응답을 읽지 못했습니다.', { raw: r.text.slice(0, 300), where: WHERE.SW, code: 'PARSE' }); }
  const picks = chooseOpenAIModels(j.data || []);
  memModels = { at: Date.now(), fp: await keyFingerprint(k), picks, count: (j.data || []).length };
  await store.kvSet(MODELS_KEY, memModels);
  return memModels;
}

async function getCache({ refresh, key, signal } = {}) {
  let cache = memModels || (await store.kvGet(MODELS_KEY, null));
  // 키를 바꿔 저장했으면(키 연결 확인 없이) 다른 키로 받은 목록이니 다시 받는다
  const k = key ?? (await getKey());
  if (refresh || !cache || Date.now() - (cache.at || 0) > MODEL_TTL_MS || !cache.picks || cache.fp !== (await keyFingerprint(k))) cache = await refreshModels({ key: k, signal });
  else memModels = cache;
  return cache;
}

export async function selectModel(kind = 'main', { refresh = false, key, signal } = {}) {
  const cache = await getCache({ refresh, key, signal });
  const name = cache.picks[kind] || (kind === 'lite' ? cache.picks.main : null);
  if (!name) {
    throw new AppError(kind === 'image' ? '이 GPT 키로 쓸 수 있는 이미지 모델을 찾지 못했습니다. OpenAI 조직 인증이 필요할 수 있어요.' : '이 GPT 키로 쓸 수 있는 글쓰기 모델을 찾지 못했습니다.',
      { raw: `models=${cache.count} picks=${JSON.stringify(cache.picks)}`, where: WHERE.SW, code: 'MODEL_NONE' });
  }
  return name;
}

async function getKey() {
  const { openaiKey } = await store.getSecrets();
  if (!openaiKey) throw new AppError('GPT 키가 없습니다. 설정에서 키를 입력하고 "키 연결 확인"을 눌러 주세요.', { raw: 'openaiKey 없음', where: WHERE.SW, code: 'NO_KEY' });
  return openaiKey;
}

let learned = null;
async function loadLearned() { if (!learned) learned = (await store.kvGet(DROPS_KEY, null)) || {}; return learned; }
async function learn(model, value) {
  const l = await loadLearned();
  l[model] = { ...(l[model] || {}), ...value };
  await store.kvSet(DROPS_KEY, l);
}
export async function resetCaches() {
  memModels = null; learned = {};
  await store.kvRemove(MODELS_KEY); await store.kvRemove(DROPS_KEY);
}

/** 생각(reasoning)하는 모델: gpt-5 이상·o 시리즈. temperature 를 받지 않는다. */
export const isReasoningModel = (m) => /^o\d/i.test(m) || Number((String(m).match(/^gpt-(\d+)/) || [])[1] || 0) >= 5;

// ───────────────────────── 글 (Responses API) ─────────────────────────

function toInput(o) {
  const parts = typeof o.prompt === 'string' ? [{ text: o.prompt }] : (o.parts || []);
  const content = parts.map((p) => {
    const d = p.inline_data || p.inlineData;
    if (d) return { type: 'input_image', image_url: `data:${d.mime_type || d.mimeType || 'image/jpeg'};base64,${d.data}` };
    return { type: 'input_text', text: String(p.text ?? '') };
  });
  return [{ role: 'user', content }];
}

function buildBody(o, model, st) {
  const reasoning = isReasoningModel(model);
  const body = { model, input: toInput(o), store: false };
  if (o.system) body.instructions = o.system;
  const want = o.maxOutputTokens || 0;
  if (want) body.max_output_tokens = reasoning ? Math.max(want, 1024) : Math.max(want, 16);
  if (!reasoning && st.temperature && o.temperature != null) body.temperature = o.temperature;
  if (reasoning && st.effort != null) body.reasoning = { effort: EFFORTS[st.effort] };
  if (st.json) body.text = { format: { type: 'json_object' } };
  if (st.tools && o.search) body.tools = [{ type: 'web_search' }];
  if (o.stream) body.stream = true;
  // json_object 형식은 입력(input)에 "JSON" 이라는 말이 있어야 한다. 형식을 못 쓰는 모델이면 말로 부탁한다
  if (o.json) {
    const last = [...body.input[0].content].reverse().find((c) => c.type === 'input_text');
    if (last && !st.json) last.text += '\n\n(JSON만 출력하세요. 코드블록·설명 없이 JSON 한 덩어리만.)';
    else if (last && !/json/i.test(last.text)) last.text += '\n\n(JSON 한 덩어리만 출력하세요.)';
  }
  return body;
}

function summarize(resp) {
  const items = resp?.output || [];
  let text = '';
  const chunks = [];
  for (const it of items) {
    if (it.type !== 'message') continue;
    for (const c of it.content || []) {
      if (c.type === 'output_text') {
        text += c.text || '';
        for (const a of c.annotations || []) if (a.type === 'url_citation' && a.url) chunks.push({ uri: a.url, title: a.title || '' });
      }
    }
  }
  if (!text && typeof resp?.output_text === 'string') text = resp.output_text;
  const refusal = items.some((it) => (it.content || []).some((c) => c.type === 'refusal'));
  return {
    text, images: [], finishReason: resp?.status === 'incomplete' ? (resp.incomplete_details?.reason || 'incomplete') : (resp?.status || ''),
    blockReason: refusal ? 'refusal' : '', grounding: { chunks, supports: [], queries: [] }, usage: resp?.usage || null,
  };
}

async function generateText(o, key, tun) {
  const t0 = Date.now();
  const signal = o.signal;
  let model = o.modelName || (await selectModel(o.kind || 'main', { key, signal }));
  const search = !!o.search;
  const wantJson = !!o.json && !search;
  const l = (await loadLearned())[model] || {};
  const st = { temperature: o.temperature != null && !l.noTemperature, json: wantJson && !l.noJson, tools: search && !l.noTools };
  // 검색 도구는 가장 가벼운 생각 단계를 거절하기도 한다 → 검색할 때의 단계(searchEffort)는 따로 기억해 검색 없는 호출이 느려지지 않게 한다
  const effKey = () => (st.tools ? 'searchEffort' : 'effort');
  const learnedEffort = (k) => (l[k] === -1 ? null : l[k] ?? (k === 'searchEffort' ? (l.effort === -1 ? null : l.effort ?? 0) : 0));
  st.effort = learnedEffort(effKey());
  const dropped = [];
  let recoveries = 0, rateRetried = false, serverRetried = false, reselected = false;
  for (;;) {
    const body = buildBody({ ...o, json: wantJson }, model, st);
    let summary = null, res;
    if (o.stream) {
      let full = '', final = null, streamErr = null;
      const sse = new SseParser((ev) => {
        if (ev.type === 'response.output_text.delta' && ev.delta) { full += ev.delta; try { o.onText?.(ev.delta, full); } catch { /* 콜백 오류 무시 */ } }
        else if (ev.type === 'response.completed' || ev.type === 'response.incomplete') final = ev.response;
        else if (ev.type === 'response.failed') streamErr = ev.response?.error || { message: 'response.failed' };
        else if (ev.type === 'error') streamErr = ev.error || ev;
      });
      res = await httpCall({ path: '/responses', method: 'POST', key, body, signal, timeoutMs: o.timeoutMs ?? tun.timeoutMs, onChunk: (c) => sse.feed(c) });
      sse.end();
      if (res.ok && streamErr) res = { ok: false, status: /rate/i.test(streamErr.code || '') ? 429 : 500, text: JSON.stringify({ error: streamErr }) };
      if (res.ok) { summary = final ? summarize(final) : { text: full, images: [], finishReason: '', blockReason: '', grounding: { chunks: [], supports: [], queries: [] }, usage: null }; if (!summary.text) summary.text = full; }
    } else {
      res = await httpCall({ path: '/responses', method: 'POST', key, body, signal, timeoutMs: o.timeoutMs ?? tun.timeoutMs });
      if (res.ok) {
        let j;
        try { j = JSON.parse(res.text); } catch { throw new AppError('GPT 응답을 읽지 못했습니다.', { raw: redactSecrets(res.text.slice(0, 400), [key]), where: WHERE.SW, code: 'PARSE' }); }
        summary = summarize(j);
      }
    }
    if (res.ok) {
      if (!summary.text) {
        if (summary.blockReason) throw new AppError('GPT가 이 요청에 답하지 않았어요(안전 정책). 상품명·문구를 조금 바꿔 다시 시도해 주세요.', { raw: `refusal finishReason=${summary.finishReason}`, where: WHERE.SW, code: 'BLOCKED' });
        throw new AppError('모델이 빈 답을 돌려줬습니다. 다시 시도해 주세요.', { raw: `status=${summary.finishReason || '없음'}`, where: WHERE.SW, code: 'EMPTY' });
      }
      const out = { ...summary, model, dropped, ms: Date.now() - t0, provider: 'openai' };
      if (o.parse) out.json = parseLooseJson(summary.text);
      return out;
    }
    const { status, text } = res;
    const e = errOf(text) || {};
    const m = `${e.param || ''} ${e.code || ''} ${e.message || ''}`.toLowerCase();
    if (status === 400 && recoveries < MAX_RECOVER && !/invalid_api_key/.test(m)) {
      recoveries++;
      if (/temperature/.test(m) && st.temperature) { st.temperature = false; dropped.push('temperature'); await learn(model, { noTemperature: true }); continue; }
      if (/reasoning|effort/.test(m) && st.effort != null) {
        st.effort = st.effort + 1 < EFFORTS.length ? st.effort + 1 : null;
        await learn(model, { [effKey()]: st.effort == null ? -1 : st.effort });
        if (st.effort == null) dropped.push('thinking');
        continue;
      }
      if (/web_search|tool/.test(m) && st.tools) { st.tools = false; dropped.push('tools'); await learn(model, { noTools: true }); continue; }
      if (/text\.format|json|response_format/.test(m) && st.json) { st.json = false; dropped.push('json'); await learn(model, { noJson: true }); continue; }
    }
    if (status === 429 && o.rate !== false && !rateRetried && !/insufficient_quota/.test(m)) { rateRetried = true; await sleep(tun.rateWaitMs, signal); continue; }
    if ((status === 500 || status === 503) && !serverRetried) { serverRetried = true; await sleep(1200, signal); continue; }
    // 고른 모델이 사라짐(404) → 목록을 다시 받아 다른 모델이면 한 번 더
    if (status === 404 && !o.modelName && !reselected) {
      reselected = true;
      const next = await selectModel(o.kind || 'main', { refresh: true, key, signal });
      if (next !== model) { model = next; continue; }
    }
    throw translateOpenAIError(status, text, [key]);
  }
}

// ───────────────────────── 이미지 (Images API) ─────────────────────────

/** "4:5" 같은 비율 → GPT 이미지 크기(정사각·세로·가로 3가지) */
export function sizeForAspect(aspect) {
  const [w, h] = String(aspect || '1:1').split(':').map(Number);
  const r = w > 0 && h > 0 ? w / h : 1;
  return r > 1.15 ? '1536x1024' : r < 0.87 ? '1024x1536' : '1024x1024';
}

const ratioOf = (aspect) => { const [w, h] = String(aspect || '').split(':').map(Number); return w > 0 && h > 0 ? w / h : 0; };
function makeCanvas(w, h) {
  return typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
}
async function canvasB64(cv) {
  const blob = cv.convertToBlob ? await cv.convertToBlob({ type: 'image/png' }) : await new Promise((r, j) => cv.toBlob((b) => (b ? r(b) : j(new Error('toBlob 실패'))), 'image/png'));
  return blobToBase64(blob);
}
/** 가운데에서 비율 ratio 로 가장 크게 잘라 낼 칸 */
function centerBox(W, H, ratio) {
  const w = W / H > ratio ? Math.round(H * ratio) : W, h = W / H > ratio ? H : Math.round(W / ratio);
  return { x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w, h };
}
/** 비율 늘리기: 원본 사진을 GPT 크기 캔버스의 "요청 비율 칸" 안에 통째로 올리고 남는 곳은 흰색으로 둔다(나중에 그 칸만 잘라 쓴다) */
async function padRef(d, size, ratio) {
  const [W, H] = size.split('x').map(Number);
  const bmp = await createImageBitmap(base64ToBlob(d.data, d.mime_type || d.mimeType || 'image/jpeg'));
  const box = centerBox(W, H, ratio);
  const k = Math.min(box.w / bmp.width, box.h / bmp.height);
  const cv = makeCanvas(W, H); const g = cv.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  g.drawImage(bmp, box.x + (box.w - bmp.width * k) / 2, box.y + (box.h - bmp.height * k) / 2, bmp.width * k, bmp.height * k);
  bmp.close?.();
  return { mime_type: 'image/png', data: await canvasB64(cv) };
}
/** 결과를 요청 비율로 가운데 자르기(이미 맞으면 그대로). 못 읽으면 원래 결과를 쓴다. */
async function cropToRatio(b64, ratio) {
  try {
    const bmp = await createImageBitmap(base64ToBlob(b64, 'image/png'));
    if (Math.abs(bmp.width / bmp.height - ratio) < 0.01) { bmp.close?.(); return b64; }
    const b = centerBox(bmp.width, bmp.height, ratio);
    const cv = makeCanvas(b.w, b.h);
    cv.getContext('2d').drawImage(bmp, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
    bmp.close?.();
    return await canvasB64(cv);
  } catch { return b64; }
}

async function generateImage(o, key) {
  const t0 = Date.now();
  const signal = o.signal;
  let model = o.modelName || (await selectModel('image', { key, signal }));
  let reselected = false;
  const parts = typeof o.prompt === 'string' ? [{ text: o.prompt }] : (o.parts || []);
  let prompt = parts.filter((p) => typeof p.text === 'string').map((p) => p.text).join('\n').slice(0, 30000);
  let refs = parts.map((p) => p.inline_data || p.inlineData).filter(Boolean);
  const size = sizeForAspect(o.imageConfig?.aspectRatio);
  // GPT 는 1:1·2:3·3:2 만 만든다 → 받은 뒤 요청 비율(4:5·9:16 등)로 가운데를 잘라 맞춘다.
  // 비율 늘리기(padToAspect)는 원본을 미리 그 칸 안에 올려 보내 잘리는 곳에 원본이 걸리지 않게 한다.
  const ratio = ratioOf(o.imageConfig?.aspectRatio);
  if (o.padToAspect && ratio && refs.length) {
    try {
      refs = [await padRef(refs[0], size, ratio), ...refs.slice(1)];
      prompt += '\nThe attached photo was placed on a white canvas. Fill only the plain white margins by continuing the scene naturally; keep the photo area itself unchanged.';
    } catch { /* 못 읽으면 원본 그대로 보낸다 */ }
  }
  const timeoutMs = Math.max(o.timeoutMs || 0, 150000);
  const l = (await loadLearned())[model] || {};
  let quality = !l.noQuality;
  const dropped = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    if (refs.length) {
      const form = new FormData();
      form.append('model', model); form.append('prompt', prompt); form.append('size', size); form.append('n', '1');
      if (quality) form.append('quality', 'medium');
      refs.slice(0, 4).forEach((d, i) => { const mime = d.mime_type || d.mimeType || 'image/png'; form.append(refs.length > 1 ? 'image[]' : 'image', base64ToBlob(d.data, mime), `photo-${i + 1}.${/png/.test(mime) ? 'png' : /webp/.test(mime) ? 'webp' : 'jpg'}`); });
      res = await httpCall({ path: '/images/edits', method: 'POST', key, form, signal, timeoutMs });
    } else {
      res = await httpCall({ path: '/images/generations', method: 'POST', key, body: { model, prompt, size, n: 1, ...(quality ? { quality: 'medium' } : {}) }, signal, timeoutMs });
    }
    if (res.ok) {
      let j;
      try { j = JSON.parse(res.text); } catch { throw new AppError('GPT 이미지 응답을 읽지 못했습니다.', { raw: res.text.slice(0, 300), where: WHERE.SW, code: 'PARSE' }); }
      let b64 = j?.data?.[0]?.b64_json;
      if (b64 && ratio) b64 = await cropToRatio(b64, ratio);
      return { text: '', images: b64 ? [{ mime: 'image/png', data: b64 }] : [], model, finishReason: b64 ? 'STOP' : 'EMPTY', blockReason: '', grounding: { chunks: [], supports: [], queries: [] }, usage: j?.usage || null, dropped, ms: Date.now() - t0, provider: 'openai' };
    }
    const m = `${(errOf(res.text) || {}).param || ''} ${(errOf(res.text) || {}).message || ''}`.toLowerCase();
    if (res.status === 400 && quality && /quality/.test(m)) { quality = false; dropped.push('quality'); await learn(model, { noQuality: true }); continue; }
    if (res.status === 404 && !o.modelName && !reselected) {
      reselected = true;
      const next = await selectModel('image', { refresh: true, key, signal });
      if (next !== model) { model = next; attempt--; continue; }
    }
    throw translateOpenAIError(res.status, res.text, [key]);
  }
  throw new AppError('GPT 이미지를 만들지 못했습니다.', { raw: 'retry exhausted', where: WHERE.SW, code: 'IMAGE_NO_OUTPUT' });
}

/** ai.js generate 와 같은 모양으로 돌려준다: {text, json?, images, model, finishReason, grounding, usage, dropped, ms} */
export async function generate(o) {
  const tun = await tuning();
  const key = o.key ?? (await getKey());
  if ((o.kind || 'main') === 'image') return generateImage(o, key);
  return generateText(o, key, tun);
}

// ───────────────────────── 키 연결 확인 ─────────────────────────

export async function checkKey({ key, signal } = {}) {
  const t0 = Date.now();
  try {
    const k = key || (await getKey());
    await resetCaches();
    const info = await refreshModels({ key: k, signal });
    if (!info.picks.main) throw new AppError('키는 정상이지만 이 계정에서 쓸 수 있는 GPT 글쓰기 모델을 찾지 못했어요.', { raw: `models=${info.count}`, where: WHERE.SW, code: 'MODEL_NONE' });
    const s0 = Date.now();
    let reply = '', warning;
    try {
      const r = await generate({ key: k, modelName: info.picks.main, prompt: '한국어로 "연결 확인"이라고만 답하세요.', maxOutputTokens: 40, temperature: 0, signal, timeoutMs: 20000, rate: false });
      reply = r.text.trim().slice(0, 40);
    } catch (e) {
      if (e instanceof AppError && e.code === 'RATE_LIMIT') warning = '요청 한도에 잠시 걸려 있어요. 1분쯤 뒤에 만들기를 눌러 주세요.';
      else throw e;
    }
    const testMs = Date.now() - s0;
    if (!warning && testMs > 8000) warning = `응답이 느린 편이에요(${Math.round(testMs / 1000)}초).`;
    return {
      ok: true, provider: 'openai', model: info.picks.main, liteModel: info.picks.lite, imageModel: info.picks.image, modelCount: info.count, env: describeEnv(),
      reply, ms: Date.now() - t0, testMs, tried: [{ model: info.picks.main, ok: true, ms: testMs }], slow: !!warning, warning,
    };
  } catch (e) {
    if (e instanceof AppError) { e.raw = `${e.raw}${e.raw ? ' | ' : ''}${describeEnv()}`; throw e; }
    throw new AppError('GPT 키 연결 확인에 실패했습니다.', { raw: `${redactSecrets(e?.message || String(e))} | ${describeEnv()}`, where: WHERE.SW });
  }
}
