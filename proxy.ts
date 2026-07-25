/**
 * 앱 전체 비밀번호 게이트 (Next 16 Proxy — 구 middleware).
 *
 * Next 16부터 middleware.ts는 proxy.ts로 이름이 바뀌었고, 프로젝트 루트에서
 * `proxy` 함수(또는 default export)를 내보낸다. 런타임 기본값은 Node.js라서
 * node:crypto를 그대로 쓸 수 있다.
 *
 * matcher를 두지 않아 **모든 요청**이 이 함수를 거친다. 예외 경로는 코드에서
 * 명명 상수(lib/auth-config.ts)로 판정한다 — matcher 정규식은 빌드타임 상수만
 * 허용해 상수 재사용이 불가능하고, 패턴 실수 시 경로가 통째로 게이트를
 * 빠져나가기 때문이다.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  API_PATH_PREFIX,
  AUTH_COOKIE_NAME,
  FROM_PARAM,
  LOGIN_API_PATH,
  LOGIN_PATH,
  LOGOUT_API_PATH,
  UNAUTHORIZED_MESSAGE,
  UNCONFIGURED_MESSAGE,
  gateMode,
  isPublicAsset,
  safeInternalPath,
  verifySessionToken,
} from "@/lib/auth";

/** 로그인 화면으로 보내는 리다이렉트 — 원래 가려던 경로를 ?from=에 실어준다 */
function redirectToLogin(request: NextRequest, withFrom: boolean): NextResponse {
  const url = request.nextUrl.clone();
  const from = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  url.pathname = LOGIN_PATH;
  url.search = "";
  if (withFrom && from !== LOGIN_PATH) url.searchParams.set(FROM_PARAM, from);
  return NextResponse.redirect(url);
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  // 1) Next 정적 자산·파비콘 등은 인증 없이 통과
  if (isPublicAsset(pathname)) return NextResponse.next();

  const isApi = pathname === "/api" || pathname.startsWith(API_PATH_PREFIX);
  const mode = gateMode();

  // 2) 로컬 개발(APP_PASSWORD 미설정, 비프로덕션)만 무인증 통과
  if (mode === "open") return NextResponse.next();

  // 3) 프로덕션인데 APP_PASSWORD가 없다 → 전면 차단 + 설정 안내 화면
  if (mode === "unconfigured") {
    if (isApi) {
      return NextResponse.json({ error: UNCONFIGURED_MESSAGE }, { status: 503 });
    }
    if (pathname === LOGIN_PATH) return NextResponse.next();
    return redirectToLogin(request, false);
  }

  // 4) 정상 게이트 — 쿠키 서명·만료 검증
  const authenticated = verifySessionToken(request.cookies.get(AUTH_COOKIE_NAME)?.value);

  if (pathname === LOGIN_PATH) {
    if (!authenticated) return NextResponse.next();
    // 이미 로그인 상태면 원래 가려던 곳(없으면 홈)으로 되돌린다
    const url = request.nextUrl.clone();
    url.pathname = safeInternalPath(request.nextUrl.searchParams.get(FROM_PARAM));
    url.search = "";
    return NextResponse.redirect(url);
  }

  // 로그인/로그아웃 API는 게이트 대상에서 제외 (자체적으로 비밀번호를 검증한다)
  if (pathname === LOGIN_API_PATH || pathname === LOGOUT_API_PATH) {
    return NextResponse.next();
  }

  if (authenticated) return NextResponse.next();

  if (isApi) {
    return NextResponse.json({ error: UNAUTHORIZED_MESSAGE }, { status: 401 });
  }
  return redirectToLogin(request, true);
}
