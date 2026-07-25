// 최소 서비스워커 — 안드로이드 크롬이 "앱 설치"(WebAPK)를 제공하려면
// fetch 핸들러를 가진 서비스워커가 필요하다. 그 조건만 충족시키고
// **캐싱은 일절 하지 않는다**: 이 앱은 인증 쿠키가 붙은 개인 데이터를 다루므로
// 응답을 저장하면 로그아웃 후 노출·오래된 시세 표시 같은 사고가 난다.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// 네트워크로 그대로 통과 (설치 요건 충족용)
self.addEventListener("fetch", () => {});
