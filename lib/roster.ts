/**
 * 개인 인증 명단(roster) — 단일 소스.
 *
 * 로그인 방식은 DAAI(mp-scoring-app)와 동일하다: **이름을 고르고 전화번호 뒤 4자리를 입력**한다.
 * 다른 점은 저장 위치뿐이다 —
 *   - DAAI: Postgres(Prisma) `AppUser` 테이블에 전화번호 원문을 담고 뒤 4자리를 비교한다.
 *   - 여기: **이 저장소에는 DB가 없다**(보고서 초안은 브라우저 localStorage에만 있다).
 *     그래서 명단은 환경변수 `APP_ROSTER` 하나에만 둔다.
 *
 * ★ 이 저장소는 PUBLIC 이다. 그래서 DAAI와 두 가지가 다르다.
 *   1) 전화번호를 원문으로 두지 않는다. 뒤 4자리를 **엔트리별 salt + scrypt**로 해시해 보관한다.
 *      APP_ROSTER 값이 유출돼도 뒤 4자리를 즉시 읽어낼 수 없다(scrypt라 전수 대입 1만 건에도 비용이 붙는다).
 *   2) 전화번호는 어떤 형태로도 저장소에 커밋되지 않는다. 코드에는 이 파서만 있고 값은 Vercel 환경변수에 있다.
 *
 * 설계 전제(DAAI 주석과 동일):
 *   - 막는 것: 주소만 주운 외부인. 못 막는 것: 서로 번호를 아는 내부 구성원 간 사칭.
 *   - 뒤 4자리는 경우의 수 1만뿐이라 "비밀"이 아니라 "게이트"다. 실패에 지연을 넣어 비용만 올린다.
 *   - 전화번호(및 뒤 4자리)는 절대 클라이언트로 내려보내지 않는다.
 *
 * APP_ROSTER 형식 — 엔트리를 `;`로 잇고, 필드를 `:`로 나눈다(한 줄, Vercel 환경변수 UI에 붙여넣기 좋게).
 *
 *     이름:역할:salt(hex):해시(hex)   ← 번호 등록됨(로그인 가능)
 *     이름:역할                        ← 번호 미등록(명단에 보이되 로그인 불가)
 *
 *   예) 전소영:A:9f3c…:1a2b…;정우범:S
 *
 *   역할 A = ADMIN(명단 관리 화면 접근 가능), S = STAFF.
 *   이름에는 `:` `;` 를 쓸 수 없다(생성 시 거부한다).
 *
 * ★ 번호 미등록 엔트리(DAAI의 hasPhone=false와 같다)를 두는 이유는 이름을 먼저 넣고 번호를 나중에
 *   채우기 위해서다. 여기에는 단 하나의 불변조건이 걸려 있다 —
 *   **salt·해시가 없는 엔트리로 인증이 성공하는 경로는 존재하지 않는다.**
 *   빈 입력, 0000, 남의 뒤 4자리, 폼을 건너뛴 API 직접호출, 해시 필드를 비운 조작 명단까지
 *   전부 막힌다. scripts/roster-selftest.mjs 가 이 경로들을 항목별로 시험한다.
 */
import crypto from "node:crypto";
import { CREDENTIAL_DIGITS, type RosterPublicEntry } from "./auth-config";

/** 명단 환경변수 이름 — 코드 전체가 이 상수만 쓴다 */
export const ROSTER_ENV_NAME = "APP_ROSTER";

/** 엔트리 구분자 / 필드 구분자 */
const ENTRY_SEPARATOR = ";";
const FIELD_SEPARATOR = ":";

// 자릿수와 공개 엔트리 타입은 클라이언트 컴포넌트도 봐야 해서 auth-config.ts(노드 모듈 미의존)에 있다.
export { CREDENTIAL_DIGITS };
export type { RosterPublicEntry };

/** salt 바이트 수 */
const SALT_BYTES = 16;
/** 파생 키 바이트 수 */
const HASH_BYTES = 32;

/**
 * 실패 지연(ms) — 뒤 4자리 전수 대입(1만 가지)의 비용을 올린다.
 * DAAI(src/lib/phoneLogin.ts)의 FAIL_DELAY_MS와 같은 값을 쓴다.
 */
export const FAIL_DELAY_MS = 700;

export type RosterRole = "ADMIN" | "STAFF";

/** 서버 내부에서만 도는 완전한 엔트리 (salt·해시 포함 — 절대 클라이언트로 보내지 않는다) */
export type RosterEntry = {
  /** 화면·쿠키에서 쓰는 불투명 식별자 (이름+salt에서 파생 — 개인정보를 담지 않는다) */
  id: string;
  name: string;
  role: RosterRole;
  /** 번호 미등록이면 null — 이 상태로는 어떤 입력도 통과하지 못한다 */
  salt: string | null;
  /** 번호 미등록이면 null */
  hash: string | null;
};

/**
 * 이 엔트리로 로그인이 가능한가 — salt·해시가 **둘 다** 있어야 한다.
 * 한쪽만 있는 엔트리는 parseRoster가 아예 버리지만, 검증 경로도 이 함수 하나만 본다.
 */
export function hasCredential(e: RosterEntry): boolean {
  return typeof e.salt === "string" && e.salt.length > 0 && typeof e.hash === "string" && e.hash.length > 0;
}

// 로그인 화면이 받는 것은 RosterPublicEntry({id, name, hasPhone})뿐이다 — DAAI와 같은 모양이다.
// 전화번호·뒤 4자리·salt·해시는 어떤 경우에도 포함되지 않는다.

/** 하이픈·공백·국가번호 표기를 흡수하고 숫자만 남긴다. "+82 10-1234-5678" → "821012345678" */
export function digitsOnly(v: string): string {
  return (v ?? "").replace(/\D/g, "");
}

/** 전화번호에서 뒤 4자리. 숫자가 4개 미만이면 null(자격증명으로 못 씀). */
export function last4Of(phone: string | null | undefined): string | null {
  const d = digitsOnly(phone ?? "");
  return d.length >= CREDENTIAL_DIGITS ? d.slice(-CREDENTIAL_DIGITS) : null;
}

/** scrypt 파생 — salt는 hex 문자열, 결과도 hex 문자열 */
function derive(last4: string, saltHex: string): string {
  return crypto.scryptSync(last4, Buffer.from(saltHex, "hex"), HASH_BYTES).toString("hex");
}

/**
 * 엔트리 식별자 — 이름과 salt에서 파생한 불투명 값(역산해도 전화번호가 나오지 않는다).
 * 번호 미등록이면 salt가 없으므로 이름만으로 파생한다.
 * 나중에 번호를 넣으면 salt가 생겨 id가 바뀌는데, 그 사람은 아직 로그인한 적이 없으므로 깨질 세션이 없다.
 */
function entryId(name: string, saltHex: string | null): string {
  return crypto.createHash("sha256").update(`${name} ${saltHex ?? ""}`).digest("hex").slice(0, 12);
}

/** 관리자 화면이 넣는 이름 검증 — 구분자가 섞이면 명단이 통째로 깨진다 */
export function validateName(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const v = (raw ?? "").trim();
  if (!v) return { ok: false, error: "이름을 입력하세요." };
  if (v.includes(FIELD_SEPARATOR) || v.includes(ENTRY_SEPARATOR)) {
    return { ok: false, error: `이름에 ${FIELD_SEPARATOR} 또는 ${ENTRY_SEPARATOR} 는 쓸 수 없습니다.` };
  }
  if (v.length > 40) return { ok: false, error: "이름이 너무 깁니다." };
  return { ok: true, value: v };
}

/** 관리자 화면이 넣는 전화번호 검증 (DAAI validatePhone과 같은 규칙) */
export function validatePhone(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const v = (raw ?? "").trim();
  if (!v) return { ok: false, error: "전화번호를 입력하세요." };
  const d = digitsOnly(v);
  if (d.length < CREDENTIAL_DIGITS) return { ok: false, error: "숫자가 4자리 이상이어야 합니다." };
  if (d.length > 15) return { ok: false, error: "전화번호가 너무 깁니다." };
  return { ok: true, value: v };
}

/**
 * 이름 + 전화번호 → 명단 엔트리.
 * **전화번호 원문은 여기서 끝나고 어디에도 남지 않는다** — 뒤 4자리만 해시로 바뀐다.
 */
export function makeEntry(name: string, phone: string, role: RosterRole): RosterEntry {
  const last4 = last4Of(phone);
  if (!last4) throw new Error("전화번호에서 뒤 4자리를 얻지 못했습니다.");
  const salt = crypto.randomBytes(SALT_BYTES).toString("hex");
  return { id: entryId(name, salt), name, role, salt, hash: derive(last4, salt) };
}

/**
 * 이름만 있는 엔트리 — 번호는 나중에 채운다.
 * 로그인 화면에는 보이지만 이 상태로는 인증이 성립하지 않는다(hasCredential=false).
 */
export function makeNameOnlyEntry(name: string, role: RosterRole): RosterEntry {
  return { id: entryId(name, null), name, role, salt: null, hash: null };
}

/** 기존 엔트리에 전화번호를 채운다(원문은 여기서 끝나고 뒤 4자리 해시만 남는다) */
export function withPhone(entry: RosterEntry, phone: string): RosterEntry {
  const filled = makeEntry(entry.name, phone, entry.role);
  return filled;
}

/** 엔트리 배열 → APP_ROSTER 환경변수 값(한 줄) */
export function formatRoster(entries: RosterEntry[]): string {
  return entries
    .map((e) => {
      const head = [e.name, e.role === "ADMIN" ? "A" : "S"];
      // 번호 미등록이면 2필드로만 적는다 — 빈 salt·해시 자리를 남기면 조작 표적이 된다.
      return hasCredential(e)
        ? [...head, e.salt, e.hash].join(FIELD_SEPARATOR)
        : head.join(FIELD_SEPARATOR);
    })
    .join(ENTRY_SEPARATOR);
}

/** APP_ROSTER 값 → 엔트리 배열. 깨진 엔트리는 조용히 버린다(한 줄 오타로 전원 잠기지 않게). */
export function parseRoster(raw: string | undefined | null): RosterEntry[] {
  const value = (raw ?? "").trim();
  if (!value) return [];
  const out: RosterEntry[] = [];
  for (const chunk of value.split(ENTRY_SEPARATOR)) {
    const part = chunk.trim();
    if (!part) continue;
    const fields = part.split(FIELD_SEPARATOR).map((f) => f.trim());
    // 2필드(이름만) 또는 4필드(이름+번호) 외에는 읽지 않는다.
    if (fields.length !== 2 && fields.length !== 4) continue;
    const [name, roleRaw, saltRaw, hashRaw] = fields;
    if (!name) continue;
    const role: RosterRole = roleRaw.toUpperCase().startsWith("A") ? "ADMIN" : "STAFF";

    if (fields.length === 2) {
      out.push({ id: entryId(name, null), name, role, salt: null, hash: null });
      continue;
    }

    const salt = saltRaw ?? "";
    const hash = hashRaw ?? "";
    // 4필드인데 salt·해시가 둘 다 비었으면 "번호 미등록"으로 읽는다(구 표기 호환).
    if (!salt && !hash) {
      out.push({ id: entryId(name, null), name, role, salt: null, hash: null });
      continue;
    }
    // ★ 한쪽만 있거나 hex가 아니면 엔트리를 통째로 버린다.
    //   "해시만 지운 명단"을 번호 미등록으로 강등시켜 통과 경로를 만들지 않기 위해서다.
    if (!salt || !hash) continue;
    if (!/^[0-9a-f]+$/i.test(salt) || !/^[0-9a-f]+$/i.test(hash)) continue;
    out.push({ id: entryId(name, salt), name, role, salt, hash });
  }
  return out;
}

/** 현재 프로세스의 명단 (이름 오름차순) */
export function loadRoster(): RosterEntry[] {
  return parseRoster(process.env[ROSTER_ENV_NAME]).sort((a, b) => a.name.localeCompare(b.name, "ko"));
}

/** 로그인 화면용 — 이름과 불투명 id만. 전화번호·해시·salt는 포함되지 않는다. */
export function publicRoster(entries: RosterEntry[] = loadRoster()): RosterPublicEntry[] {
  return entries.map((e) => ({ id: e.id, name: e.name, hasPhone: hasCredential(e) }));
}

export type VerifyResult =
  | { ok: true; entry: RosterEntry }
  | { ok: false; reason: "invalid" | "no_phone" };

/**
 * 이름(id) + 뒤 4자리 검증.
 * 실패는 사유를 구분하지 않고 항상 같은 지연을 거친다 — 어느 쪽이 틀렸는지 알려주면 전수 대입이 쉬워진다.
 */
export async function verifyCredential(id: string, input: string): Promise<VerifyResult> {
  const fail = async (): Promise<VerifyResult> => {
    await new Promise((r) => setTimeout(r, FAIL_DELAY_MS));
    return { ok: false, reason: "invalid" };
  };

  const noPhone = async (): Promise<VerifyResult> => {
    await new Promise((r) => setTimeout(r, FAIL_DELAY_MS));
    return { ok: false, reason: "no_phone" };
  };

  const typed = digitsOnly(input);
  if (typed.length !== CREDENTIAL_DIGITS) return fail();

  const entry = loadRoster().find((e) => e.id === id);
  if (!entry) return fail();

  // ★ 번호 미등록 엔트리는 여기서 끝난다. 아래 해시 비교로 내려가지 않는다.
  //   (내려가더라도 길이 불일치로 실패하지만, 통과 여부를 우연에 맡기지 않는다.)
  if (!hasCredential(entry)) return noPhone();
  const salt = entry.salt as string;
  const hashHex = entry.hash as string;

  let actual: Buffer;
  try {
    actual = Buffer.from(derive(typed, salt), "hex");
  } catch {
    return fail();
  }
  const expected = Buffer.from(hashHex, "hex");
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return fail();

  return { ok: true, entry };
}
