// 실행 환경 구분: Chrome 확장('extension') / 정적 웹사이트('web').
// 웹 빌드(dist/web)는 다른 모듈보다 먼저 web/chrome-shim.js 를 불러 globalThis.__BC_WEB__ = true 로 표시한다.
// 확장에서는 이 값이 없으므로 'extension'. 화면·기능 분기는 이 모듈만 보고 한다(쿠팡 페이지 읽기·파트너스 API는 웹에서 꺼짐).
export const PLATFORM = globalThis.__BC_WEB__ === true ? 'web' : 'extension';
export const IS_WEB = PLATFORM === 'web';
export const IS_EXTENSION = !IS_WEB;
