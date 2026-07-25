/**
 * 앱 전체 비밀번호 게이트 — 서버 전용 서명·검증 로직.
 *
 * 쿠키에는 평문 비밀번호를 절대 넣지 않는다. `v1.<만료ms>.<HMAC-SHA256>` 형태의
 * 토큰을 발급하고, 검증은 서명 재계산 + 만료 확인으로만 한다.
 * 모든 비교는 crypto.timingSafeEqual (동일 길이 다이제스트 비교)로 수행한다.
 *
 * 서명 키: APP_SECRET(있으면) → 없으면 APP_PASSWORD에서 HMAC으로 파생.
 * 파생 키를 쓰면 비밀번호를 바꿀 때 기존 세션이 자동 무효화된다.
 */
import crypto from "node:crypto";
import {
  AUTH_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  type GateMode,
} from "./auth-config";

export * from "./auth-config";

/** 토큰 포맷 버전 — 포맷이 바뀌면 올린다(구 토큰 자동 무효화) */
const TOKEN_VERSION = "v1";
const TOKEN_SEPARATOR = ".";

/** APP_SECRET 미설정 시 APP_PASSWORD에서 서명키를 파생할 때 쓰는 라벨 */
const DERIVED_SECRET_LABEL = "econ-cockpit/app-session-key/v1";

/** 환경변수를 다듬어 읽는다 — 빈 문자열/공백은 미설정으로 취급 */
function envValue(name: string): string {
  return (process.env[name] ?? "").trim();
}

/** 게이트 비밀번호 (미설정이면 빈 문자열) */
export function appPassword(): string {
  return envValue("APP_PASSWORD");
}

/** 프로덕션 유사 환경인지 — Vercel이거나 NODE_ENV=production */
export function isProductionLike(): boolean {
  return Boolean(process.env.VERCEL) || process.env.NODE_ENV === "production";
}

/**
 * 현재 게이트 상태.
 * - APP_PASSWORD 있음 → "enforced"
 * - 없음 + 프로덕션 → "unconfigured" (전면 차단)
 * - 없음 + 로컬 → "open" (개발 편의)
 */
export function gateMode(): GateMode {
  if (appPassword()) return "enforced";
  return isProductionLike() ? "unconfigured" : "open";
}

/** 서명키 — APP_SECRET 우선, 없으면 APP_PASSWORD에서 파생 */
function signingKey(): Buffer | null {
  const explicit = envValue("APP_SECRET");
  if (explicit) return Buffer.from(explicit, "utf8");
  const password = appPassword();
  if (!password) return null;
  return crypto.createHmac("sha256", DERIVED_SECRET_LABEL).update(password).digest();
}

function sign(payload: string, key: Buffer): string {
  return crypto.createHmac("sha256", key).update(payload).digest("base64url");
}

/**
 * 길이를 노출하지 않는 상수시간 문자열 비교.
 * timingSafeEqual은 길이가 다르면 예외를 던지므로 SHA-256 다이제스트(32B)끼리 비교한다.
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const da = crypto.createHash("sha256").update(a, "utf8").digest();
  const db = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(da, db);
}

/** 입력 비밀번호가 APP_PASSWORD와 일치하는지 (미설정이면 항상 false) */
export function verifyPassword(input: string): boolean {
  const expected = appPassword();
  if (!expected) return false;
  return timingSafeEqualStrings(input, expected);
}

/** 세션 토큰 발급 — 서명키가 없으면 null */
export function createSessionToken(now: number = Date.now()): string | null {
  const key = signingKey();
  if (!key) return null;
  const expiresAt = now + SESSION_MAX_AGE_SECONDS * 1000;
  const payload = `${TOKEN_VERSION}${TOKEN_SEPARATOR}${expiresAt}`;
  return `${payload}${TOKEN_SEPARATOR}${sign(payload, key)}`;
}

/** 세션 토큰 검증 — 서명 확인 + 만료 확인 */
export function verifySessionToken(
  token: string | null | undefined,
  now: number = Date.now()
): boolean {
  if (!token) return false;
  const key = signingKey();
  if (!key) return false;

  const parts = token.split(TOKEN_SEPARATOR);
  if (parts.length !== 3) return false;
  const [version, expiresRaw, signature] = parts;
  if (version !== TOKEN_VERSION) return false;

  const expiresAt = Number(expiresRaw);
  if (!Number.isSafeInteger(expiresAt)) return false;
  // 만료됐거나, 최대 유효기간을 넘겨 발급된(위조 의심) 토큰은 거부
  if (expiresAt <= now) return false;
  if (expiresAt > now + SESSION_MAX_AGE_SECONDS * 1000) return false;

  const payload = `${version}${TOKEN_SEPARATOR}${expiresRaw}`;
  return timingSafeEqualStrings(sign(payload, key), signature);
}

/** 세션 쿠키 옵션 — 발급/삭제가 같은 소스를 쓴다 */
export const SESSION_COOKIE_OPTIONS = {
  name: AUTH_COOKIE_NAME,
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
} as const;
