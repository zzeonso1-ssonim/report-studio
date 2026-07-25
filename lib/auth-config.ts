/**
 * 앱 전체 비밀번호 게이트의 설정 상수 — 단일 소스.
 *
 * 이 파일은 노드 전용 모듈(node:crypto 등)을 import하지 않는다.
 * 클라이언트 컴포넌트(로그인 폼·헤더 로그아웃)도 같은 상수를 쓰기 때문이다.
 * 서명·검증 로직은 서버 전용인 lib/auth.ts에 있다.
 */

/** 세션 쿠키 이름 */
export const AUTH_COOKIE_NAME = "econ_cockpit_session";

/** 세션 유효기간 (초) — 30일 */
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** 로그인 화면 경로 (게이트 예외) */
export const LOGIN_PATH = "/login";

/** 로그인 처리 API (게이트 예외) */
export const LOGIN_API_PATH = "/api/login";

/** 로그아웃 API (게이트 예외 — 쿠키 삭제만 수행) */
export const LOGOUT_API_PATH = "/api/logout";

/** 로그인 후 복귀 경로를 담는 쿼리 파라미터 이름 */
export const FROM_PARAM = "from";

/** 로그인 후 복귀 기본 경로 */
export const DEFAULT_REDIRECT_PATH = "/";

/** API 경로 접두사 — 게이트 차단 시 리다이렉트 대신 401 JSON을 준다 */
export const API_PATH_PREFIX = "/api/";

/** 인증 없이 통과시키는 경로 접두사 (Next 정적 자산·이미지 최적화) */
export const PUBLIC_PATH_PREFIXES = ["/_next/static", "/_next/image"] as const;

/** 인증 없이 통과시키는 정확한 경로 (메타데이터 파일) */
export const PUBLIC_EXACT_PATHS = [
  "/favicon.ico",
  "/robots.txt",
  "/sitemap.xml",
  "/manifest.json",
  "/manifest.webmanifest",
] as const;

/** 인증 없이 통과시키는 public/ 정적 파일 확장자 (API 경로에는 적용하지 않는다) */
export const PUBLIC_FILE_EXTENSIONS = [
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
  ".txt",
  ".xml",
  ".webmanifest",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
] as const;

/** 게이트 상태 — 환경변수 구성에서 파생 */
export type GateMode =
  /** APP_PASSWORD 미설정 + 로컬 개발 → 통과 */
  | "open"
  /** APP_PASSWORD 미설정 + 프로덕션 → 전면 차단(설정 안내) */
  | "unconfigured"
  /** APP_PASSWORD 설정 → 쿠키 검증 */
  | "enforced";

/** 게이트가 요청을 막았을 때 API 응답 메시지 */
export const UNAUTHORIZED_MESSAGE = "인증이 필요합니다 — 로그인 후 이용하세요";

/** APP_PASSWORD 미설정 상태로 프로덕션에 뜬 경우의 API 응답 메시지 */
export const UNCONFIGURED_MESSAGE =
  "APP_PASSWORD가 설정되지 않아 앱이 잠겨 있습니다 (관리자 설정 필요)";

/**
 * 로그인 후 복귀 경로가 이 앱 내부 경로인지 확인한다.
 * 오픈 리다이렉트 방지 — "//host", "/\\host", 절대 URL은 모두 거부.
 */
export function safeInternalPath(value: string | null | undefined): string {
  if (!value) return DEFAULT_REDIRECT_PATH;
  if (!value.startsWith("/")) return DEFAULT_REDIRECT_PATH;
  if (value.startsWith("//") || value.startsWith("/\\")) return DEFAULT_REDIRECT_PATH;
  return value;
}

/** 게이트 예외(무인증 통과) 정적 자산인지 판정 */
export function isPublicAsset(pathname: string): boolean {
  if (pathname.startsWith(API_PATH_PREFIX)) return false;
  if (PUBLIC_PATH_PREFIXES.some((p) => pathname.startsWith(p))) return true;
  if ((PUBLIC_EXACT_PATHS as readonly string[]).includes(pathname)) return true;
  const dot = pathname.lastIndexOf(".");
  if (dot === -1) return false;
  const ext = pathname.slice(dot).toLowerCase();
  return (PUBLIC_FILE_EXTENSIONS as readonly string[]).includes(ext);
}
