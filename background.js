// 서비스워커 (MV3, type: module) — 메시지 허브.
// 이 파일은 "연결"만 한다. 실제 요청 처리는 모듈별 handlers / portHandlers 맵에 있다:
//   lib/core.js    core.*     (설정·이미지 fetch·다운로드·패널 열기)   ← ext-core
//   lib/coupang.js coupang.*  (파트너스 API)                           ← coupang
//   lib/agents.js  ai.*       (에이전트 파이프라인·Gemini)             ← ai-layer
//   lib/image.js   image.*    (Gemini 이미지 생성)                     ← ai-layer
// 새 요청을 추가할 때는 해당 모듈의 맵에만 등록한다. 이 파일은 고치지 않는다. (docs/인터페이스.md)
// 키(Gemini·쿠팡)는 서비스워커 안에서만 읽고 사용한다. 패널·콘텐츠 스크립트로 넘기지 않는다.

import * as core from './lib/core.js';
import * as coupang from './lib/coupang.js';
import * as agents from './lib/agents.js';
import * as image from './lib/image.js';
import { createRouter } from './lib/router.js';
import { getSecrets } from './lib/store.js';
import { IS_WEB } from './lib/platform.js';

// 다른 에이전트의 모듈이 아직 맵을 export 하지 않았거나 일부만 export 해도 서비스워커가 죽지 않게 모두 기본값을 둔다.
const mod = (m, prefix) => ({ prefix: m.prefix || prefix, handlers: m.handlers || {}, portHandlers: m.portHandlers || {}, contentAllowed: m.contentAllowed || [] });

const router = createRouter(
  [mod(core, 'core.'), mod(coupang, 'coupang.'), mod(agents, 'ai.'), mod(image, 'image.')],
  { getSecretValues: async () => Object.values(await getSecrets()) } // 오류 원문에서 키 값을 가리기 위함
);
globalThis.__routerWarnings = router.warnings; // core.ping 으로 확인

chrome.runtime.onMessage.addListener(router.onMessage);
chrome.runtime.onConnect.addListener(router.onConnect);

// 웹 버전: 이 파일은 서비스워커가 아니라 index.html·settings.html 안에서 모듈로 실행된다(web/chrome-shim.js 가 chrome.* 를 대신함).
// 페이지가 둘이므로 각 페이지가 자기 라우터를 띄운다(저장소는 IndexedDB 라 공유됨). 툴바·사이드 패널 설정은 필요 없다.
// 툴바 아이콘 클릭 = 사이드 패널 열기/닫기
const enablePanelOnAction = () =>
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
if (!IS_WEB) {
  chrome.runtime.onInstalled.addListener(enablePanelOnAction);
  chrome.runtime.onStartup.addListener(enablePanelOnAction);
  enablePanelOnAction();
}
