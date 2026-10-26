// 옵션 페이지 — 키 저장은 core.saveSettings(서비스워커 경유), 키 값은 화면에 다시 보여 주지 않는다.
import { request } from './lib/bus.js';
import { IS_WEB } from './lib/platform.js';
import { WHERE } from './lib/common.js';
import * as store from './lib/store.js';
import { DISCLOSURE_VARIANTS } from './lib/coupang.js';
import { h, setChildren, pickImageFile, fmtDate } from './ui/dom.js';
import { errorBox, normalizeError } from './ui/errors.js';

let settings = null;
const $id = (id) => document.getElementById(id);

const TONES = [
  ['', '기본 (존댓말, 해요체)'],
  ['친근하고 가벼운 말투 (~했어요, ~예요)', '친근하고 가벼운 말투'],
  ['차분하고 믿음을 주는 말투', '차분하고 믿음을 주는 말투'],
  ['발랄하고 통통 튀는 말투', '발랄하고 통통 튀는 말투'],
];
const CUSTOM = '__custom__';

function statusLine(host, text, ok = true) {
  let s = host.querySelector('.status');
  if (!s) { s = h('p', { class: 'status', role: 'status' }); host.append(s); }
  s.textContent = text;
  s.className = `status ${ok ? 'ok' : 'bad'}`;
}

async function save(patch) {
  settings = await request('core.saveSettings', patch);
  return settings;
}

const badge = (has) => h('span', { class: `badge ${has ? 'badge-ok' : 'badge-no'}` }, has ? '저장됨' : '아직 없음');

// ───────────────────────── 첫 진입 고지 ─────────────────────────

// 웹 버전에서만: 확장 전용 문장을 대체 문구로 바꾼다(지식 파일은 그대로 두고 화면에서만 바꿈)
function webNoticeLine(t) {
  if (/상품 정보는 내가 열어 둔 쿠팡 상품 페이지/.test(t)) return '**상품 정보는 내가 직접 입력한 것만 사용합니다.** 쿠팡 페이지를 자동으로 읽거나 다른 사이트를 열지 않습니다. 상품 이미지는 판매처 소유이며 소개 목적으로만 쓰세요.';
  return t.replace('이 확장 프로그램은', '이 사이트는').replace('내 브라우저에만 저장됩니다', '이 사이트를 연 내 브라우저에만 저장됩니다');
}

function renderMarkdownLite(md) {
  const lines = md.split('\n').map((l) => l.trim()).filter(Boolean);
  const items = [];
  let title = '';
  const inline = (t) => {
    const parts = t.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
    return parts.map((p) => (p.startsWith('**') ? h('strong', null, p.slice(2, -2)) : p));
  };
  for (const l of lines) {
    if (/^#/.test(l)) continue;
    if (/^☐/.test(l)) continue;
    if (/^\*\*[^*]+\*\*$/.test(l) && !title) { title = l.slice(2, -2); continue; }
    const m = l.match(/^\d+\.\s*(.*)$/);
    if (m) items.push(h('li', null, ...inline(IS_WEB ? webNoticeLine(m[1]) : m[1])));
  }
  return { title, list: h('ol', { class: 'notice-list' }, ...items) };
}

async function renderNotice() {
  const host = $id('notice-section');
  const ack = await store.kvGet('noticeAck', null);
  let md = '';
  try { md = await (await fetch(chrome.runtime.getURL('knowledge/고지문.md'))).text(); } catch (e) {
    setChildren(host, errorBox(normalizeError(e, WHERE.PANEL), { title: '안내문을 불러오지 못했어요' }));
    return;
  }
  const { title, list } = renderMarkdownLite(md);
  if (ack) {
    host.classList.remove('attention');
    setChildren(host, h('details', { id: 'notice-details' }, h('summary', null, '이용 안내 다시 보기'), h('h2', null, title), list,
      h('p', { class: 'muted small' }, `확인한 날: ${fmtDate(ack.at)}`)));
    return;
  }
  host.classList.add('attention');
  const cb = h('input', { type: 'checkbox', id: 'notice-ack' });
  cb.addEventListener('change', async () => {
    if (!cb.checked) return;
    await store.kvSet('noticeAck', { at: Date.now() });
    renderNotice();
  });
  setChildren(host, h('h2', null, title || '시작하기 전에'), list, h('label', { class: 'check-row', for: 'notice-ack' }, cb, h('span', null, '확인했어요')));
}

// ───────────────────────── Gemini 키 ─────────────────────────

function renderGemini() {
  const host = $id('gemini-section');
  const input = h('input', { class: 'input', id: 'gemini-key', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: settings.has.geminiKey ? '새 키로 바꾸려면 여기에 붙여넣으세요' : 'Gemini 키를 붙여넣으세요', 'aria-label': 'Gemini 키' });
  const result = h('div', { id: 'gemini-result', 'aria-live': 'polite' });
  const checkBtn = h('button', { type: 'button', class: 'btn', id: 'btn-check-key' }, '키 연결 확인');
  const saveBtn = h('button', { type: 'button', class: 'btn btn-primary', id: 'btn-save-gemini' }, '키 저장');
  const delBtn = settings.has.geminiKey ? h('button', { type: 'button', class: 'btn', id: 'btn-del-gemini' }, '저장된 키 지우기') : null;

  saveBtn.addEventListener('click', async () => {
    const v = input.value.trim();
    if (!v) { setChildren(result, h('p', { class: 'status bad' }, '키를 먼저 붙여넣어 주세요.')); return; }
    try {
      await save({ geminiKey: v });
      input.value = '';
      renderGemini();
      statusLine($id('gemini-result'), '키를 저장했어요. 이제 "키 연결 확인"을 눌러 보세요.');
    } catch (e) { setChildren(result, errorBox(normalizeError(e, WHERE.PANEL))); }
  });
  delBtn?.addEventListener('click', async () => {
    await save({ geminiKey: null });
    renderGemini();
    statusLine($id('gemini-result'), '저장된 키를 지웠어요.');
  });
  checkBtn.addEventListener('click', async () => {
    const typed = input.value.trim();
    if (!typed && !settings.has.geminiKey) { setChildren(result, h('p', { class: 'status bad' }, '먼저 키를 붙여넣고 확인해 주세요.')); return; }
    checkBtn.disabled = true; checkBtn.textContent = '확인하는 중…';
    setChildren(result);
    try {
      const r = await request('ai.checkKey', typed ? { key: typed } : {}, { timeoutMs: 60000 });
      setChildren(result, h('div', { class: 'result-box', id: 'check-ok' },
        h('strong', null, r.slow ? '✅ 키는 정상이에요 (응답이 느려요)' : '✅ 연결됐어요'),
        r.warning ? h('p', { class: 'status warn' }, r.warning) : null,
        h('p', null, `글 쓰는 모델: ${r.model || '-'}`),
        h('p', null, r.imageModel ? `이미지 모델: ${r.imageModel}` : '이미지 모델은 이 키로 찾지 못했어요. 글 만들기는 문제없어요.'),
        r.ms ? h('p', { class: 'muted small' }, `응답 ${r.ms}ms`) : null,
        r.mock ? h('p', { class: 'muted small' }, '(시험용 더미 응답)') : null,
        typed ? h('p', { class: 'muted small' }, '아직 저장하지 않았어요. 맞으면 "키 저장"을 눌러 주세요.') : null));
    } catch (e) {
      setChildren(result, errorBox(normalizeError(e), { title: '연결하지 못했어요' }));
    }
    checkBtn.disabled = false; checkBtn.textContent = '키 연결 확인';
  });

  setChildren(host,
    h('div', { class: 'field-head' }, h('h2', { id: 'gemini-h' }, 'Gemini 키 (필수)'), h('span', { id: 'gemini-state' }, badge(settings.has.geminiKey))),
    h('p', null, '글과 이미지는 내 Gemini 키로 만들어요. aistudio.google.com/apikey 에서 무료로 만들 수 있어요(결제 연결 없이).'),
    IS_WEB ? h('p', { class: 'muted small', id: 'key-help' }, '결제를 연결하지 않은 새 프로젝트에서 키를 만들어야 무료로 쓸 수 있어요. "크레딧이 소진됐어요(402)" 같은 오류가 나면 새 프로젝트에서 만든 키로 바꿔 보세요.') : null,
    IS_WEB ? h('p', { class: 'warn-line small', id: 'key-storage-note' }, '이 키는 이 브라우저(이 사이트)에만 저장돼요. 공용 컴퓨터에서는 다 쓴 뒤 "저장된 키 지우기"를 꼭 눌러 주세요.') : null,
    h('label', { class: 'label', for: 'gemini-key' }, 'Gemini 키'), input,
    h('div', { class: 'btn-row' }, saveBtn, checkBtn, delBtn),
    result);
}

// ───────────────────────── 쿠팡 파트너스 ─────────────────────────

function renderCoupang() {
  const host = $id('coupang-section');
  if (IS_WEB) {
    setChildren(host, h('h2', { id: 'coupang-h' }, '쿠팡 파트너스'), h('p', { id: 'coupang-web-note' }, '웹 버전에서는 쓰이지 않아요(링크는 파트너스에서 만들어 붙여넣기).'));
    return;
  }
  const access = h('input', { class: 'input', id: 'cp-access', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: settings.has.coupangAccessKey ? '바꾸려면 새 Access Key 붙여넣기' : 'Access Key', 'aria-label': 'Access Key' });
  const secret = h('input', { class: 'input', id: 'cp-secret', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: settings.has.coupangSecretKey ? '바꾸려면 새 Secret Key 붙여넣기' : 'Secret Key', 'aria-label': 'Secret Key' });
  const subId = h('input', { class: 'input', id: 'cp-subid', value: settings.subId || '', placeholder: '예: baekcoach (영문·숫자)', 'aria-label': 'subId' });
  const result = h('div', { id: 'coupang-result', 'aria-live': 'polite' });
  const saveBtn = h('button', { type: 'button', class: 'btn btn-primary', id: 'btn-save-coupang' }, '저장');
  saveBtn.addEventListener('click', async () => {
    try {
      const patch = { subId: subId.value.trim() };
      if (access.value.trim()) patch.coupangAccessKey = access.value.trim();
      if (secret.value.trim()) patch.coupangSecretKey = secret.value.trim();
      await save(patch);
      renderCoupang();
      statusLine($id('coupang-result'), '저장했어요.');
    } catch (e) { setChildren(result, errorBox(normalizeError(e, WHERE.PANEL))); }
  });
  const delBtn = (settings.has.coupangAccessKey || settings.has.coupangSecretKey) ? h('button', { type: 'button', class: 'btn', id: 'btn-del-coupang' }, '저장된 파트너스 키 지우기') : null;
  delBtn?.addEventListener('click', async () => { await save({ coupangAccessKey: null, coupangSecretKey: null }); renderCoupang(); statusLine($id('coupang-result'), '파트너스 키를 지웠어요.'); });
  setChildren(host,
    h('div', { class: 'field-head' }, h('h2', { id: 'coupang-h' }, '쿠팡 파트너스 (선택)'), h('span', null, badge(settings.has.coupangAccessKey && settings.has.coupangSecretKey))),
    h('p', null, 'API 승인을 받은 분만 넣으면 돼요. 넣으면 "링크 만들기"와 "쿠팡에서 검색"을 쓸 수 있고, 안 넣어도 모든 기능이 되며 링크만 직접 붙여넣으면 돼요.'),
    h('label', { class: 'label', for: 'cp-access' }, 'Access Key'), access,
    h('label', { class: 'label', for: 'cp-secret' }, 'Secret Key'), secret,
    h('label', { class: 'label', for: 'cp-subid' }, 'subId (선택)'), subId,
    h('div', { class: 'btn-row' }, saveBtn, delBtn), result);
}

// ───────────────────────── 계정·말투·로고·고정 태그 ─────────────────────────

async function renderAccount() {
  const host = $id('account-section');
  const name = h('input', { class: 'input', id: 'account-name', value: settings.accountName || '', placeholder: '예: baekcoach_shop (@ 없이)', 'aria-label': '계정명' });
  const isPreset = TONES.some(([v]) => v === (settings.tone || ''));
  const toneSel = h('select', { class: 'input', id: 'tone-select', 'aria-label': '말투' },
    ...TONES.map(([v, label]) => h('option', { value: v, selected: v === (settings.tone || '') }, label)),
    h('option', { value: CUSTOM, selected: !isPreset }, '직접 쓰기'));
  const toneCustom = h('input', { class: 'input', id: 'tone-custom', value: isPreset ? '' : settings.tone, placeholder: '예: 40대 엄마가 친구에게 말하듯', 'aria-label': '말투 직접 쓰기' });
  const syncTone = () => { toneCustom.hidden = toneSel.value !== CUSTOM; };
  toneSel.addEventListener('change', syncTone); syncTone();
  const tags = h('textarea', { class: 'input', id: 'fixed-tags', rows: 2, placeholder: '#백코치 #공구 (띄어쓰기로 구분)', 'aria-label': '고정 해시태그' });
  tags.value = (settings.fixedTags || []).join(' ');

  // 로고
  const logoBox = h('div', { class: 'logo-preview', id: 'logo-preview' }, h('span', { class: 'muted small' }, '로고 없음'));
  if (settings.logoImageId) {
    const u = await store.getImageObjectUrl(settings.logoImageId);
    if (u) logoBox.replaceChildren(h('img', { src: u, alt: '내 로고' }));
  }
  const result = h('div', { id: 'account-result' });
  const logoUp = h('button', { type: 'button', class: 'btn', id: 'btn-logo-upload' }, settings.logoImageId ? '로고 바꾸기' : '로고 올리기');
  logoUp.addEventListener('click', async () => {
    const f = await pickImageFile();
    if (!f) return;
    try {
      if (f.size > 5 * 1024 * 1024) throw new Error('로고는 5MB 이하만 올릴 수 있어요.');
      const old = settings.logoImageId;
      const id = await store.putImage(f, { kind: 'logo' });
      await save({ logoImageId: id });
      if (old) store.deleteImage(old).catch(() => {});
      await renderAccount();
      statusLine($id('account-result'), '로고를 저장했어요. 새로 만드는 캐러셀부터 오른쪽 아래에 들어가요.');
    } catch (e) { setChildren(result, errorBox(normalizeError(e, WHERE.PANEL))); }
  });
  const logoDel = settings.logoImageId ? h('button', { type: 'button', class: 'btn', id: 'btn-logo-delete' }, '로고 지우기') : null;
  logoDel?.addEventListener('click', async () => {
    const old = settings.logoImageId;
    await save({ logoImageId: null });
    if (old) store.deleteImage(old).catch(() => {});
    await renderAccount();
    statusLine($id('account-result'), '로고를 지웠어요.');
  });

  const saveBtn = h('button', { type: 'button', class: 'btn btn-primary', id: 'btn-save-account' }, '저장');
  saveBtn.addEventListener('click', async () => {
    try {
      await save({ accountName: name.value.trim().replace(/^@/, ''), tone: toneSel.value === CUSTOM ? toneCustom.value.trim() : toneSel.value, fixedTags: tags.value });
      tags.value = (settings.fixedTags || []).join(' ');
      statusLine(result, '저장했어요.');
    } catch (e) { setChildren(result, errorBox(normalizeError(e, WHERE.PANEL))); }
  });

  setChildren(host,
    h('h2', { id: 'account-h' }, '내 계정'),
    h('label', { class: 'label', for: 'account-name' }, '인스타 계정명'), name,
    h('label', { class: 'label', for: 'tone-select' }, '말투'), toneSel, toneCustom,
    h('label', { class: 'label', for: 'fixed-tags' }, '고정 해시태그 (매번 자동으로 합쳐져요)'), tags,
    h('p', { class: 'muted small' }, '해시태그는 모두 합쳐서 30개까지만 쓸 수 있어요.'),
    h('div', { class: 'label' }, '로고 (카드 오른쪽 아래에 작게 들어가요)'),
    h('div', { class: 'btn-row' }, logoBox, logoUp, logoDel),
    h('div', { class: 'btn-row' }, saveBtn), result);
}

// ───────────────────────── 고지 문구 ─────────────────────────

function renderDisclosure() {
  const host = $id('disclosure-section');
  const cur = Number(settings.disclosureVariant) || 0;
  const result = h('div', { id: 'disclosure-result' });
  const radios = DISCLOSURE_VARIANTS.map((text, i) => {
    const r = h('input', { type: 'radio', name: 'disclosure', id: `disc-${i}`, value: String(i), checked: i === cur });
    r.addEventListener('change', async () => { await save({ disclosureVariant: i }); statusLine(result, '고지 문구를 바꿨어요.'); });
    return h('label', { class: 'check-row', for: `disc-${i}` }, r, h('span', null, text));
  });
  setChildren(host,
    h('h2', { id: 'disclosure-h' }, '캡션 첫 줄 고지 문구'),
    h('p', null, '쿠팡 파트너스 게시물에는 고지 문구가 꼭 있어야 해서, 캡션 맨 윗줄에 자동으로 들어가요. 문구 모양만 고를 수 있고 끌 수는 없어요.'),
    h('div', { class: 'radio-list', role: 'radiogroup', 'aria-label': '고지 문구' }, ...radios), result);
}

// ───────────────────────── 만들기 설정 ─────────────────────────

function renderMake() {
  const host = $id('make-section');
  const result = h('div', { id: 'make-result' });
  const seg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': '동시에 만들 카드 수' }, ...[3, 4, 5, 6, 7].map((n) => {
    const r = h('input', { type: 'radio', name: 'parallel', id: `par-${n}`, value: String(n), checked: n === settings.parallel });
    r.addEventListener('change', async () => { await save({ parallel: n }); statusLine(result, `동시에 ${n}장씩 만들어요.`); });
    return h('label', { for: `par-${n}` }, r, h('span', null, String(n)));
  }));
  const imgText = h('input', { class: 'input', id: 'image-disclosure', value: settings.imageDisclosureText || '연출 이미지', 'aria-label': '연출 이미지 표시 문구' });
  const saveBtn = h('button', { type: 'button', class: 'btn btn-primary', id: 'btn-save-make' }, '저장');
  saveBtn.addEventListener('click', async () => {
    try { await save({ imageDisclosureText: imgText.value.trim() || '연출 이미지' }); imgText.value = settings.imageDisclosureText; statusLine(result, '저장했어요.'); }
    catch (e) { setChildren(result, errorBox(normalizeError(e, WHERE.PANEL))); }
  });
  setChildren(host,
    h('h2', { id: 'make-h' }, '만들기 설정'),
    h('div', { class: 'label' }, '동시에 만들 카드 수 (3~7)'), seg,
    h('p', { class: 'muted small' }, '많을수록 빨라요. 무료 키에서 "요청이 너무 많아요" 오류가 자주 나면 숫자를 줄여 보세요. 막히면 알아서 하나씩 만들기로 바꿔요.'),
    h('label', { class: 'label', for: 'image-disclosure' }, '"연출 이미지" 표시 문구'), imgText,
    h('p', { class: 'muted small' }, 'AI가 만든 사진을 카드에 쓰면 왼쪽 아래에 이 문구가 작게 들어가요.'),
    h('div', { class: 'btn-row' }, saveBtn), result);
}

// ───────────────────────── 백업 ─────────────────────────

function renderBackup() {
  const host = $id('backup-section');
  const result = h('div', { id: 'backup-result' });
  const exp = h('button', { type: 'button', class: 'btn', id: 'btn-backup-export' }, '백업 내보내기');
  exp.addEventListener('click', async () => {
    exp.disabled = true;
    try {
      const data = await store.exportBackup({ includeImages: true });
      const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      const a = h('a', { href: URL.createObjectURL(blob), download: `백코치-백업-${stamp}.json` });
      document.body.append(a); a.click(); a.remove();
      statusLine(result, `백업 파일을 만들었어요. 작업 ${data.projects?.length ?? 0}개가 들어 있고, 키는 들어 있지 않아요.`);
    } catch (e) { setChildren(result, errorBox(normalizeError(e, WHERE.PANEL))); }
    exp.disabled = false;
  });
  const imp = h('button', { type: 'button', class: 'btn', id: 'btn-backup-import' }, '백업 가져오기');
  const file = h('input', { type: 'file', accept: 'application/json,.json', id: 'backup-file', hidden: true });
  imp.addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    const f = file.files[0];
    if (!f) return;
    try {
      const obj = JSON.parse(await f.text());
      const r = await store.importBackup(obj);
      statusLine(result, `가져왔어요: 작업 ${r.projects}개, 사진 ${r.images}장, 대화 ${r.chats}개. 키는 그대로예요.`);
    } catch (e) { setChildren(result, errorBox(normalizeError(e, WHERE.PANEL), { title: '백업을 가져오지 못했어요' })); }
    file.value = '';
  });
  setChildren(host,
    h('h2', { id: 'backup-h' }, '백업'),
    h('p', null, '지난 작업과 설정을 파일로 저장해 두거나 다른 컴퓨터로 옮길 수 있어요. API 키는 안전을 위해 백업에 넣지 않아요.'),
    h('div', { class: 'btn-row' }, exp, imp, file), result);
}

async function boot() {
  if (IS_WEB) {
    document.documentElement.classList.add('web');
    const main = $id('options');
    main.prepend(h('a', { class: 'back-link', id: 'back-link', href: 'index.html' }, '← 만들기로 돌아가기'));
  }
  try { settings = await request('core.getSettings'); } catch (e) {
    setChildren($id('alerts'), errorBox(normalizeError(e), { title: '설정을 불러오지 못했어요' }));
    settings = { has: {}, fixedTags: [], parallel: 5, disclosureVariant: 0 };
  }
  await renderNotice();
  renderGemini();
  renderCoupang();
  await renderAccount();
  renderDisclosure();
  renderMake();
  renderBackup();
  document.documentElement.dataset.ready = '1';
}
boot();
