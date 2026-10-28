// 저장소 — 서비스워커와 사이드 패널·옵션 페이지 양쪽에서 import 하는 ES 모듈.
//  · 설정:  chrome.storage.local 의 'settings' 객체 1개 (키 포함)
//  · 캐시:  chrome.storage.local 의 'kv:<이름>' (모델 목록, 쿠팡 검색 호출 기록 등 작은 값)
//  · 작업:  IndexedDB 'baekcoach' → projects / images / chats (프로젝트는 최근 50개 유지)
//  · 백업:  exportBackup / importBackup (API 키 제외)
// API 키(geminiKey, openaiKey, coupangAccessKey, coupangSecretKey)는 getSecrets()/getSettings() 로만 읽고,
// 이 둘은 서비스워커 안에서만 호출할 수 있다. 패널·옵션은 getPublicSettings() 의 `has` 로 "있음/없음"만 본다.
// (chrome.storage.local 은 기본값으로 콘텐츠 스크립트에서 접근되지 않는다.)

import { AppError, WHERE, newId, isServiceWorker, canReadSecrets, blobToBase64, base64ToBlob } from './common.js';

export const SECRET_KEYS = Object.freeze(['geminiKey', 'openaiKey', 'coupangAccessKey', 'coupangSecretKey']);
/** 글·이미지를 만드는 AI: 'gemini'(기본) | 'openai'(GPT). 2026-10-28 사용자 결정 — 수강생이 둘 중 하나를 고른다. */
export const AI_PROVIDERS = Object.freeze(['gemini', 'openai']);
/** 지금 고른 AI 의 키 이름(설정·공개 설정 어느 쪽이든) */
export const aiKeyName = (s) => (s?.aiProvider === 'openai' ? 'openaiKey' : 'geminiKey');
export const MAX_PROJECTS = 50;
export const PARALLEL_MIN = 3;
export const PARALLEL_MAX = 7;

/** 설정 기본값. 이 목록에 없는 이름은 저장되지 않는다. */
export const SETTINGS_DEFAULTS = Object.freeze({
  aiProvider: 'gemini',            // 'gemini' | 'openai'
  geminiKey: '',
  openaiKey: '',
  coupangAccessKey: '',
  coupangSecretKey: '',
  subId: '',                       // 쿠팡 파트너스 subId (채널 구분용)
  accountName: '',                 // 인스타 계정명 (마지막 카드·캡션에 쓰임)
  tone: '',                        // 말투 (빈 값 = 기본). 자유 문자열 또는 프리셋 이름
  logoImageId: null,               // IndexedDB images 의 id (kind: 'logo')
  fixedTags: [],                   // 고정 해시태그 ['#백코치', ...]
  disclosureVariant: 0,            // 파트너스 고지 문구 변형 번호 (문구 목록은 lib/coupang.js). 고지 자체는 해제 불가
  imageDisclosureText: '연출 이미지', // 생성 이미지 표시 문구
  parallel: 5,                     // 카드 작가 병렬 수 3~7
  devMockAI: false,                // [테스트 전용] true 면 ai-layer 가 실제 Gemini 대신 더미 응답. 옵션 화면에 노출하지 않는다.
});

const SETTINGS_KEY = 'settings';
const KV_PREFIX = 'kv:';

// ───────────────────────── 설정 ─────────────────────────

function normalize(patch, current) {
  const out = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in SETTINGS_DEFAULTS) || v === undefined) continue;
    const def = SETTINGS_DEFAULTS[k];
    if (SECRET_KEYS.includes(k)) {
      const s = v === null ? '' : String(v).trim();
      if (/\s/.test(s)) throw new AppError('키에 공백이나 줄바꿈이 들어 있습니다. 복사한 키를 다시 붙여넣어 주세요.', { where: WHERE.PANEL, raw: `${k}: 공백 포함` });
      out[k] = s;
    } else if (k === 'aiProvider') {
      out[k] = AI_PROVIDERS.includes(v) ? v : 'gemini';
    } else if (k === 'parallel') {
      const n = Math.round(Number(v));
      out[k] = Number.isFinite(n) ? Math.min(PARALLEL_MAX, Math.max(PARALLEL_MIN, n)) : def;
    } else if (k === 'disclosureVariant') {
      const n = Math.round(Number(v));
      out[k] = Number.isFinite(n) && n >= 0 ? n : 0;
    } else if (k === 'fixedTags') {
      const arr = Array.isArray(v) ? v : String(v ?? '').split(/[\s,]+/);
      out[k] = [...new Set(arr.map((t) => String(t).trim()).filter(Boolean).map((t) => (t.startsWith('#') ? t : `#${t}`)))];
    } else if (k === 'logoImageId') {
      out[k] = v ? String(v) : null;
    } else if (typeof def === 'boolean') {
      out[k] = !!v;
    } else {
      out[k] = String(v ?? '').trim();
    }
  }
  return { ...current, ...out };
}

async function readSettingsRaw() {
  const { [SETTINGS_KEY]: saved } = await chrome.storage.local.get(SETTINGS_KEY);
  return normalize({ ...SETTINGS_DEFAULTS, ...(saved || {}) }, {});
}

let writeChain = Promise.resolve();

/**
 * 설정 일부를 저장하고 "공개용 설정"을 돌려준다. 동시 호출은 순서대로 처리된다.
 * 키 필드: 문자열이면 저장(앞뒤 공백 제거), ''/null 이면 삭제, undefined 면 그대로 둠.
 */
export function saveSettings(patch) {
  const job = writeChain.then(async () => {
    const current = await readSettingsRaw();
    const next = normalize(patch, current);
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    return toPublic(next);
  });
  writeChain = job.catch(() => {});
  return job;
}

function toPublic(s) {
  const pub = {};
  const has = {};
  for (const k of Object.keys(SETTINGS_DEFAULTS)) {
    if (SECRET_KEYS.includes(k)) has[k] = !!s[k];
    else pub[k] = s[k];
  }
  return { ...pub, has };
}

/** 패널·옵션용. 키 값은 없고 `has: {geminiKey: true/false, ...}` 만 있다. 어디서든 호출 가능. */
export async function getPublicSettings() {
  return toPublic(await readSettingsRaw());
}

function assertSW(fn) {
  if (!canReadSecrets()) {
    throw new AppError('키는 서비스워커에서만 읽을 수 있습니다. (개발 오류)', { where: WHERE.PANEL, raw: `${fn}() 를 서비스워커 밖에서 호출했습니다.` });
  }
}

/** 서비스워커 전용. 키 포함 전체 설정. */
export async function getSettings() {
  assertSW('getSettings');
  return readSettingsRaw();
}

/** 서비스워커 전용. 키만. 값이 없으면 ''. */
export async function getSecrets() {
  assertSW('getSecrets');
  const s = await readSettingsRaw();
  return { geminiKey: s.geminiKey, openaiKey: s.openaiKey, coupangAccessKey: s.coupangAccessKey, coupangSecretKey: s.coupangSecretKey };
}

// ───────────────────────── 작은 값 캐시 (kv) ─────────────────────────
// 모델 목록 캐시, 쿠팡 검색 시간당 8회 제한 기록처럼 서비스워커가 재시작돼도 남아야 하는 값용.
// 백업에 들어가지 않는다. 키 같은 비밀은 넣지 말 것.

export async function kvGet(name, fallback = null) {
  const k = KV_PREFIX + name;
  const r = await chrome.storage.local.get(k);
  return k in r ? r[k] : fallback;
}
export const kvSet = (name, value) => chrome.storage.local.set({ [KV_PREFIX + name]: value });
export const kvRemove = (name) => chrome.storage.local.remove(KV_PREFIX + name);

// ───────────────────────── IndexedDB ─────────────────────────

const DB_NAME = 'baekcoach';
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const projects = db.createObjectStore('projects', { keyPath: 'id' });
      projects.createIndex('updatedAt', 'updatedAt');
      const images = db.createObjectStore('images', { keyPath: 'id' });
      images.createIndex('projectId', 'projectId');
      images.createIndex('sourceUrl', 'sourceUrl');
      images.createIndex('createdAt', 'createdAt');
      db.createObjectStore('chats', { keyPath: 'projectId' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(new AppError('브라우저 저장소(IndexedDB)를 열지 못했습니다.', { raw: req.error?.message, where: isServiceWorker() ? WHERE.SW : WHERE.PANEL })); };
  });
  return dbPromise;
}

/** 단일 트랜잭션에서 fn(stores) 를 실행하고, 트랜잭션 완료 후 fn 의 결과를 돌려준다. */
async function withStores(names, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(names, mode);
    const stores = Object.fromEntries(names.map((n) => [n, tx.objectStore(n)]));
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB 트랜잭션이 취소되었습니다.'));
    Promise.resolve(fn(stores, tx)).then((r) => { result = r; }, (e) => { try { tx.abort(); } catch {} reject(e); });
  });
}
const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

// ── 프로젝트 ──
// 레코드는 자유 형식이다. store 는 id / createdAt / updatedAt / title 만 건드린다.
// 권장 필드: {title, product, plan, cards[], caption, tags[], links, facts[], settingsSnapshot ...}

/** 저장(없으면 id 생성, updatedAt 갱신). 50개를 넘으면 가장 오래된 프로젝트와 딸린 이미지·대화를 지운다. */
let lastStamp = 0;
export async function putProject(project) {
  const now = (lastStamp = Math.max(Date.now(), lastStamp + 1)); // 같은 밀리초에 저장해도 최근순이 흔들리지 않게
  const rec = { ...project, id: project.id || newId('p'), createdAt: project.createdAt || now, updatedAt: now };
  if (!rec.title) rec.title = '제목 없음';
  await withStores(['projects'], 'readwrite', ({ projects }) => wrap(projects.put(rec)));
  await pruneProjects();
  return rec;
}
export async function getProject(id) {
  return withStores(['projects'], 'readonly', ({ projects }) => wrap(projects.get(id))).then((r) => r || null);
}
/** 최근 수정순. */
export async function listProjects({ limit = MAX_PROJECTS } = {}) {
  const all = await withStores(['projects'], 'readonly', ({ projects }) => wrap(projects.getAll()));
  return all.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}
/** 프로젝트 + 딸린 이미지 + 대화 삭제. */
export async function deleteProject(id) {
  await withStores(['projects', 'images', 'chats'], 'readwrite', async ({ projects, images, chats }) => {
    projects.delete(id);
    chats.delete(id);
    const keys = await wrap(images.index('projectId').getAllKeys(id));
    for (const k of keys) images.delete(k);
  });
}
async function pruneProjects() {
  const all = await withStores(['projects'], 'readonly', ({ projects }) => wrap(projects.getAll()));
  if (all.length <= MAX_PROJECTS) return;
  all.sort((a, b) => b.updatedAt - a.updatedAt);
  for (const p of all.slice(MAX_PROJECTS)) await deleteProject(p.id);
}

// ── 이미지 ──
// 서비스워커가 받은 원격 이미지·사용자 업로드·AI 생성 이미지·로고·zip 임시 파일이 모두 여기 Blob 으로 들어간다.
// 패널은 같은 확장 origin 이라 getImage() 로 Blob 을 바로 읽어 URL.createObjectURL 로 그린다.
// 레코드: {id, blob, type, size, kind, sourceUrl, projectId, createdAt, width?, height?, meta?}
//   kind: 'remote'(쿠팡 이미지) | 'upload' | 'generated' | 'logo' | 'zip' | 기타 문자열
// projectId 없는 이미지는 3일 뒤 정리된다. 'logo' 는 정리 대상이 아니다.

const UNOWNED_TTL_MS = 3 * 24 * 3600 * 1000;
let lastPrune = 0;

export async function putImage(blob, { id, kind = 'upload', sourceUrl = null, projectId = null, width, height, meta } = {}) {
  if (!(blob instanceof Blob)) throw new AppError('이미지 데이터가 올바르지 않습니다.', { raw: 'putImage: Blob 이 아님', where: isServiceWorker() ? WHERE.SW : WHERE.PANEL });
  const rec = { id: id || newId('img'), blob, type: blob.type || 'application/octet-stream', size: blob.size, kind, sourceUrl, projectId, createdAt: Date.now() };
  if (width) rec.width = width;
  if (height) rec.height = height;
  if (meta !== undefined) rec.meta = meta;
  await withStores(['images'], 'readwrite', ({ images }) => wrap(images.put(rec)));
  return rec.id;
}
/** 레코드 전체(Blob 포함). 없으면 null. */
export async function getImage(id) {
  if (!id) return null;
  return withStores(['images'], 'readonly', ({ images }) => wrap(images.get(id))).then((r) => r || null);
}
export async function getImageBlob(id) {
  return (await getImage(id))?.blob || null;
}
/** 같은 원본 URL 로 이미 받아 둔 이미지 id (없으면 null) */
export async function findImageBySourceUrl(url) {
  const recs = await withStores(['images'], 'readonly', ({ images }) => wrap(images.index('sourceUrl').getAll(url)));
  return recs.sort((a, b) => b.createdAt - a.createdAt)[0] || null;
}
export async function deleteImage(id) {
  await withStores(['images'], 'readwrite', ({ images }) => wrap(images.delete(id)));
}
/** 이미지들을 프로젝트에 귀속(= 자동 정리 대상에서 제외, 프로젝트 삭제 시 함께 삭제) */
export async function attachImages(ids, projectId) {
  await withStores(['images'], 'readwrite', async ({ images }) => {
    for (const id of ids) {
      const rec = await wrap(images.get(id));
      if (rec) { rec.projectId = projectId; images.put(rec); }
    }
  });
}
/** 패널용: 이미지 id → ObjectURL. 다 쓰면 URL.revokeObjectURL. 없으면 null. */
export async function getImageObjectUrl(id) {
  const blob = await getImageBlob(id);
  return blob ? URL.createObjectURL(blob) : null;
}
/** 주인 없는 오래된 이미지 정리. 10분에 한 번만 실제로 돈다. */
export async function pruneUnownedImages({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastPrune < 10 * 60 * 1000) return 0;
  lastPrune = now;
  return withStores(['images'], 'readwrite', async ({ images }) => {
    const all = await wrap(images.getAll());
    let n = 0;
    for (const r of all) {
      if (!r.projectId && r.kind !== 'logo' && now - r.createdAt > UNOWNED_TTL_MS) { images.delete(r.id); n++; }
    }
    return n;
  });
}

// ── 대화 (프로젝트당 1개) ──
export async function getChat(projectId) {
  const r = await withStores(['chats'], 'readonly', ({ chats }) => wrap(chats.get(projectId)));
  return r ? r.messages : [];
}
/** messages: [{role:'user'|'assistant'|'system', text, at, ...}] 자유 형식 */
export async function putChat(projectId, messages) {
  await withStores(['chats'], 'readwrite', ({ chats }) => wrap(chats.put({ projectId, messages, updatedAt: Date.now() })));
}

// ───────────────────────── 백업 ─────────────────────────

const BACKUP_APP = 'baekcoach-carousel';
const BACKUP_SCHEMA = 1;

/**
 * 백업 객체를 만든다. API 키·devMockAI 는 들어가지 않는다.
 * 이미지는 base64 로 들어간다(프로젝트에 귀속된 것 + 로고). JSON.stringify 해서 파일로 저장하면 된다.
 */
export async function exportBackup({ includeImages = true } = {}) {
  const settings = await getPublicSettings();
  delete settings.has;
  delete settings.devMockAI;
  const projects = await listProjects();
  const ids = new Set(projects.map((p) => p.id));
  const chats = await withStores(['chats'], 'readonly', ({ chats }) => wrap(chats.getAll()));
  const out = {
    app: BACKUP_APP, schema: BACKUP_SCHEMA, exportedAt: new Date().toISOString(),
    settings, projects, chats: chats.filter((c) => ids.has(c.projectId)), images: [],
  };
  if (includeImages) {
    const imgs = await withStores(['images'], 'readonly', ({ images }) => wrap(images.getAll()));
    for (const r of imgs) {
      if (!(ids.has(r.projectId) || r.id === settings.logoImageId)) continue;
      const { blob, ...rest } = r;
      out.images.push({ ...rest, dataBase64: await blobToBase64(blob) });
    }
  }
  return out;
}

/** exportBackup() 결과(또는 JSON.parse 한 파일)를 합쳐 넣는다. 같은 id 는 덮어쓴다. 키는 건드리지 않는다. */
export async function importBackup(data) {
  if (!data || data.app !== BACKUP_APP || typeof data.schema !== 'number') {
    throw new AppError('백코치 캐러셀 메이커의 백업 파일이 아닙니다.', { raw: `app=${data?.app} schema=${data?.schema}`, where: WHERE.PANEL });
  }
  if (data.schema > BACKUP_SCHEMA) {
    throw new AppError('더 새로운 버전에서 만든 백업입니다. 확장을 최신 버전으로 업데이트해 주세요.', { raw: `schema=${data.schema}`, where: WHERE.PANEL });
  }
  const counts = { projects: 0, images: 0, chats: 0 };
  const s = { ...(data.settings || {}) };
  for (const k of [...SECRET_KEYS, 'devMockAI', 'has']) delete s[k];
  // 키는 백업에 없다 → 이 컴퓨터에 그 AI 의 키가 없으면 고른 AI 는 지금 것 그대로 둔다("GPT 키가 없습니다"로 막히지 않게)
  if (s.aiProvider && !(await getPublicSettings()).has[aiKeyName(s)]) delete s.aiProvider;
  if (Object.keys(s).length) await saveSettings(s);
  await withStores(['projects', 'images', 'chats'], 'readwrite', async ({ projects, images, chats }) => {
    for (const p of data.projects || []) { if (p?.id) { projects.put(p); counts.projects++; } }
    for (const c of data.chats || []) { if (c?.projectId) { chats.put(c); counts.chats++; } }
    for (const im of data.images || []) {
      if (!im?.id || !im.dataBase64) continue;
      const { dataBase64, ...rest } = im;
      images.put({ ...rest, blob: base64ToBlob(dataBase64, im.type) });
      counts.images++;
    }
  });
  await pruneProjects();
  return counts;
}
