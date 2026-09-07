/**
 * 앱 전체 접근 게이트의 설정 상수 — 단일 소스.
 *
 * 이 파일은 노드 전용 모듈(node:crypto 등)을 import하지 않는다.
 * 클라이언트 컴포넌트(로그인 폼·헤더 로그아웃)도 같은 상수를 쓰기 때문이다.
 * 서명·검증 로직은 서버 전용인 lib/auth.ts, 명단 규칙은 lib/roster.ts에 있다.
 */

/**
 * 세션 쿠키 이름.
 * 공용 비밀번호 게이트 시절의 이름(econ_cockpit_session)에서 바꿨다 —
 * 이름이 바뀌면 구 방식으로 발급된 쿠키가 전부 무효가 되어 갈아탈 때 빈틈이 남지 않는다.
 */
export const AUTH_COOKIE_NAME = "report_studio_session";

/** 세션 유효기간 (초) — 30일 */
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * 로그인 자격증명 자릿수 — 전화번호 뒤 N자리.
 * 로그인 폼(클라이언트)과 검증 로직(lib/roster.ts)이 같은 값을 봐야 해서 여기에 둔다.
 * lib/roster.ts는 node:crypto를 import하므로 클라이언트 컴포넌트가 직접 참조할 수 없다.
 */
export const CREDENTIAL_DIGITS = 4;

/**
 * 로그인 화면으로 내려보내는 최소 정보 — 이름·불투명 id·번호 등록 여부뿐.
 * 전화번호·뒤 4자리·해시·salt는 어떤 경우에도 클라이언트로 가지 않는다.
 *
 * hasPhone은 DAAI(mp-scoring-app)가 내려보내는 것과 같은 필드다.
 * 번호가 없는 사람도 명단에는 보이되 로그인은 막힌다 — 이름만 먼저 넣고 번호를 나중에 채우기 위해서다.
 * 이 값이 false인 항목으로 인증이 성공하는 경로는 존재하지 않는다(scripts/roster-selftest.mjs가 시험한다).
 */
export type RosterPublicEntry = { id: string; name: string; hasPhone: boolean };

/** 로그인 화면 경로 (게이트 예외) */
export const LOGIN_PATH = "/login";

/** 로그인 처리 API (게이트 예외) */
export const LOGIN_API_PATH = "/api/login";

/** 로그아웃 API (게이트 예외 — 쿠키 삭제만 수행) */
export const LOGOUT_API_PATH = "/api/logout";

/**
 * 명단 관리 화면·API — ADMIN 역할만 통과한다.
 * (인증만으로는 부족하다. 아무나 명단을 재발급하면 게이트를 스스로 열 수 있다.)
 */
export const ADMIN_ROSTER_PATH = "/admin/roster";
export const ADMIN_ROSTER_API_PATH = "/api/admin/roster";

/** ADMIN 전용 경로 접두사 — proxy와 API 라우트가 같은 목록을 본다 */
export const ADMIN_PATH_PREFIXES = ["/admin", "/api/admin"] as const;

/** 해당 경로가 ADMIN 전용인지 */
export function isAdminPath(pathname: string): boolean {
  return ADMIN_PATH_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

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
  // 서비스워커 — 스코프가 "/"라 루트에서 인증 없이 받아져야 등록된다.
  // 캐싱을 하지 않는 통과용 워커라 노출돼도 정보가 없다(public/sw.js).
  "/sw.js",
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
  /** APP_ROSTER 미설정 + 로컬 개발 → 통과 */
  | "open"
  /** APP_ROSTER 미설정 + 프로덕션 → 전면 차단(설정 안내) */
  | "unconfigured"
  /** APP_ROSTER 설정 → 쿠키 검증 */
  | "enforced";

/** 게이트가 요청을 막았을 때 API 응답 메시지 */
export const UNAUTHORIZED_MESSAGE = "인증이 필요합니다 — 로그인 후 이용하세요";

/**
 * 이름은 명단에 있으나 전화번호가 아직 등록되지 않은 경우의 메시지.
 * 이 사실은 로그인 화면이 이미 hasPhone으로 표시하고 있으므로 새로 노출되는 정보가 없다.
 *
 * 문구는 DAAI(mp-scoring-app `src/app/login/LoginForm.tsx`)와 **글자까지 같게** 맞춘다 —
 * 같은 사람들이 두 앱을 쓰므로 같은 상황에서 다른 문장이 뜨면 다른 고장으로 읽힌다.
 * 로그인 화면(클라이언트)과 /api/login(서버)이 이 함수 하나만 쓴다.
 */
export function noPhoneMessage(name: string): string {
  return `${name} 계정은 전화번호가 등록되지 않았습니다. 관리자에게 등록을 요청하세요.`;
}

/** ADMIN 전용 경로에 STAFF가 들어왔을 때의 API 응답 메시지 */
export const FORBIDDEN_MESSAGE = "권한이 없습니다 — 관리자 전용입니다";

/**
 * APP_ROSTER 미설정 상태로 프로덕션에 뜬 경우의 API 응답 메시지.
 * 이 상태는 "열림"이 아니라 **전면 차단**이다 — 명단을 넣기 전에 배포돼도 무인증 창이 생기지 않는다.
 */
export const UNCONFIGURED_MESSAGE =
  "APP_ROSTER(사용자 명단)가 설정되지 않아 앱이 잠겨 있습니다 (관리자 설정 필요)";

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
