/**
 * 앱 전체 접근 게이트 — 서버 전용 서명·검증 로직.
 *
 * 로그인은 **이름 선택 + 전화번호 뒤 4자리**다(DAAI/mp-scoring-app과 동일한 방식).
 * 명단과 자격증명 규칙은 lib/roster.ts에, 여기서는 세션 토큰 발급·검증만 다룬다.
 *
 * 쿠키에는 전화번호도, 뒤 4자리도 절대 넣지 않는다.
 * `v2.<만료ms>.<base64url(id|역할|이름)>.<HMAC-SHA256>` 형태의 서명 토큰만 발급하고,
 * 검증은 서명 재계산 + 만료 확인으로만 한다. 비교는 crypto.timingSafeEqual(동일 길이 다이제스트)로 수행한다.
 *
 * 서명 키: APP_SECRET(있으면) → 없으면 APP_ROSTER에서 HMAC으로 파생.
 *   파생 키를 쓰면 명단을 바꿀 때 기존 세션이 전부 무효화된다(=사람을 뺐을 때 그 사람의 쿠키가 즉시 죽는다).
 *   대신 사람을 **추가**할 때도 전원이 다시 로그인해야 하므로, 그게 싫으면 APP_SECRET을 지정하면 된다.
 *   ※ APP_SECRET을 지정한 경우, 명단에서 뺀 사람의 쿠키는 만료 전까지 서명은 유효하지만
 *      아래 verifySessionToken이 명단 재조회로 걸러낸다(탈퇴자 즉시 차단).
 */
import crypto from "node:crypto";
import {
  AUTH_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  type GateMode,
} from "./auth-config";
import { ROSTER_ENV_NAME, hasCredential, loadRoster, type RosterEntry, type RosterRole } from "./roster";

export * from "./auth-config";

/** 토큰 포맷 버전 — 포맷이 바뀌면 올린다(구 토큰 자동 무효화) */
const TOKEN_VERSION = "v2";
const TOKEN_SEPARATOR = ".";

/** APP_SECRET 미설정 시 APP_ROSTER에서 서명키를 파생할 때 쓰는 라벨 */
const DERIVED_SECRET_LABEL = "report-studio/app-session-key/v2";

/** 환경변수를 다듬어 읽는다 — 빈 문자열/공백은 미설정으로 취급 */
function envValue(name: string): string {
  return (process.env[name] ?? "").trim();
}

/** 프로덕션 유사 환경인지 — Vercel이거나 NODE_ENV=production */
export function isProductionLike(): boolean {
  return Boolean(process.env.VERCEL) || process.env.NODE_ENV === "production";
}

/**
 * 현재 게이트 상태.
 * - 명단(APP_ROSTER)에 유효한 사람이 1명 이상 → "enforced"
 * - 없음 + 프로덕션 → "unconfigured" (전면 차단)
 * - 없음 + 로컬 → "open" (개발 편의)
 */
export function gateMode(): GateMode {
  if (loadRoster().length > 0) return "enforced";
  return isProductionLike() ? "unconfigured" : "open";
}

/** 서명키 — APP_SECRET 우선, 없으면 APP_ROSTER에서 파생 */
function signingKey(): Buffer | null {
  const explicit = envValue("APP_SECRET");
  if (explicit) return Buffer.from(explicit, "utf8");
  const roster = envValue(ROSTER_ENV_NAME);
  if (!roster) return null;
  return crypto.createHmac("sha256", DERIVED_SECRET_LABEL).update(roster).digest();
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

/** 로그인한 사람 — 쿠키에서 복원되는 최소 식별자 */
export type SessionUser = { id: string; name: string; role: RosterRole };

/** 세션 토큰 발급 — 서명키가 없으면 null */
export function createSessionToken(entry: RosterEntry, now: number = Date.now()): string | null {
  const key = signingKey();
  if (!key) return null;
  // 번호 미등록 엔트리에는 어떤 경우에도 세션을 내주지 않는다.
  // verifyCredential이 no_phone으로 먼저 막지만, **세션이 만들어지는 창구는 이 함수 하나**다.
  // 여기에 조건을 두지 않으면 "인증에 성공하지 못한 사람의 유효한 세션"이 만들어질 수 있는 상태로 남는다
  // (2026-09-07 실측: 이 줄이 없을 때 번호 미등록 엔트리로 유효 토큰이 발급됐다).
  if (!hasCredential(entry)) return null;
  const expiresAt = now + SESSION_MAX_AGE_SECONDS * 1000;
  const claims = Buffer.from(
    `${entry.id}|${entry.role}|${entry.name}`,
    "utf8"
  ).toString("base64url");
  const payload = `${TOKEN_VERSION}${TOKEN_SEPARATOR}${expiresAt}${TOKEN_SEPARATOR}${claims}`;
  return `${payload}${TOKEN_SEPARATOR}${sign(payload, key)}`;
}

/**
 * 세션 토큰 검증 — 서명 확인 + 만료 확인 + **명단 재확인**.
 * 명단에서 빠진 사람은 쿠키가 아직 유효해도 즉시 막힌다(DAAI가 DB로 active를 재확인하는 것과 같은 역할).
 * 실패하면 null.
 */
export function verifySessionToken(
  token: string | null | undefined,
  now: number = Date.now()
): SessionUser | null {
  if (!token) return null;
  const key = signingKey();
  if (!key) return null;

  const parts = token.split(TOKEN_SEPARATOR);
  if (parts.length !== 4) return null;
  const [version, expiresRaw, claims, signature] = parts;
  if (version !== TOKEN_VERSION) return null;

  const expiresAt = Number(expiresRaw);
  if (!Number.isSafeInteger(expiresAt)) return null;
  // 만료됐거나, 최대 유효기간을 넘겨 발급된(위조 의심) 토큰은 거부
  if (expiresAt <= now) return null;
  if (expiresAt > now + SESSION_MAX_AGE_SECONDS * 1000) return null;

  const payload = `${version}${TOKEN_SEPARATOR}${expiresRaw}${TOKEN_SEPARATOR}${claims}`;
  if (!timingSafeEqualStrings(sign(payload, key), signature)) return null;

  let decoded: string;
  try {
    decoded = Buffer.from(claims, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const id = decoded.split("|")[0];
  if (!id) return null;

  // 서명이 맞아도 명단에 없으면 거부한다 — 역할·이름도 쿠키가 아니라 명단을 정본으로 쓴다.
  const entry = loadRoster().find((e) => e.id === id);
  if (!entry) return null;

  // 번호 미등록인 사람의 세션은 존재할 수 없다 — 발급 경로가 없기 때문이다.
  // 그런 토큰이 들어왔다면 위조(APP_ROSTER가 유출되면 파생 서명키를 만들 수 있다)이거나
  // 번호가 지워진 뒤 남은 쿠키다. 둘 다 거부한다 = 번호 미등록으로 로그인된 상태가 성립하지 않는다.
  if (!hasCredential(entry)) return null;

  return { id: entry.id, name: entry.name, role: entry.role };
}

/**
 * 현재 요청의 로그인 사용자 — 서버 컴포넌트·라우트 핸들러용.
 *
 * proxy가 이미 걸러주지만 여기서 한 번 더 본다(이중 확인).
 * proxy는 경로 패턴으로 판정하므로, 경로 목록이 어긋나면 조용히 뚫린다.
 * 관리자 화면·API는 자기 자신도 역할을 확인해야 한다.
 */
export async function currentUser(): Promise<SessionUser | null> {
  const { cookies } = await import("next/headers");
  const store = await cookies();
  return verifySessionToken(store.get(AUTH_COOKIE_NAME)?.value);
}

/** ADMIN 여부 — 라우트 핸들러가 403을 내릴 때 쓴다 */
export async function isAdminRequest(): Promise<boolean> {
  const user = await currentUser();
  return user?.role === "ADMIN";
}

/** 세션 쿠키 옵션 — 발급/삭제가 같은 소스를 쓴다 */
export const SESSION_COOKIE_OPTIONS = {
  name: AUTH_COOKIE_NAME,
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
} as const;
