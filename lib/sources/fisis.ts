import { SeriesPoint, SourceAdapter, SourceError, requireKey } from "./types";
import { FisisStore, StoredSeries, fileStore } from "./fisis-store";

/**
 * 금융감독원 금융통계정보시스템(FISIS) OpenAPI
 * https://fisis.fss.or.kr/openapi/
 * params: { financeCd, listNo, accountCd, term(Y|H|Q|M) }
 *
 * 제약:
 * - 호출당 조회기간 최대 1개월 → 요청 범위를 월 단위로 분할해 호출 (startBaseMm == endBaseMm)
 * - 1일 30회 한도 → KST 날짜별 영속 카운터로 추적, 안전 버퍼(28회) 도달 시 중단
 * - 과거분 증분 적재: 받은 월은 .data/fisis/에 저장하고 재호출하지 않음.
 *   단, 최근 월(당월·직전월)은 갱신 가능성이 있어 저장 후 7일 지나면 재호출.
 */

const FISIS_ENDPOINT = "https://fisis.fss.or.kr/openapi/statisticsSearch.json";
const FISIS_LANG = "kr";
/** 정상 응답 코드 */
const FISIS_OK_CODE = "000";
/** FISIS 공식 일일 호출 한도 */
const DAILY_CALL_LIMIT = 30;
/** 안전 버퍼 — 이 횟수 도달 시 더 이상 호출하지 않음 */
const DAILY_CALL_SAFETY_LIMIT = 28;
/** 최근 월 데이터 재수집 주기 (일) */
const RECENT_REFRESH_DAYS = 7;
/** "최근 월"로 간주하는 개월 수 (당월 + 직전월) */
const RECENT_MONTH_WINDOW = 2;

export const fisis: SourceAdapter = {
  id: "fisis",
  name: "금감원 FISIS",
  requiresKey: true,

  async fetchSeries(params, range) {
    return fetchFisisSeries(params, range, fileStore);
  },
};

/** store를 주입받는 본체 — 테스트·저장소 교체(Supabase 등) 용이하게 분리 */
export async function fetchFisisSeries(
  params: Record<string, string>,
  range: { start: string; end: string },
  store: FisisStore
): Promise<SeriesPoint[]> {
  const key = requireKey("fisis", "FISIS_API_KEY");
  const { financeCd, listNo, accountCd, term = "M" } = params;
  if (!financeCd || !listNo || !accountCd) {
    throw new SourceError("fisis", "params에 financeCd, listNo, accountCd가 모두 필요합니다");
  }

  const seriesKey = `${financeCd}_${listNo}_${accountCd}_${term}`;
  const stored = await store.loadSeries(seriesKey);
  const months = enumerateMonths(range.start, range.end); // ["YYYYMM", ...]
  const now = new Date();

  let dirty = false;
  for (const month of months) {
    if (!needsFetch(month, stored, now)) continue; // (a) 저장분 재사용

    // (b) 미보유(또는 최근 월 만료) → 호출 전 일일 한도 확인
    const kstDate = kstDateString(now);
    const used = await store.getDailyCallCount(kstDate);
    if (used >= DAILY_CALL_SAFETY_LIMIT) {
      // 이미 받아둔 만큼이라도 반환할지 고민 여지가 있으나, 불완전 시계열의
      // 조용한 반환은 오판을 부르므로 명시적으로 실패시킨다.
      throw new SourceError(
        "fisis",
        `일일 호출 안전 한도(${DAILY_CALL_SAFETY_LIMIT}/${DAILY_CALL_LIMIT}회)에 도달했습니다 ` +
          `(오늘 ${used}회 사용, KST ${kstDate}). 내일 다시 시도하세요.`
      );
    }
    await store.incrementDailyCallCount(kstDate); // 실패한 호출도 한도에 포함될 수 있으므로 선차감

    const value = await callFisisMonth(key, { financeCd, listNo, accountCd, term }, month);
    if (value !== undefined) stored.values[month] = value;
    else delete stored.values[month]; // 데이터 없음 — fetchedAt만 남겨 재호출 방지
    stored.fetchedAt[month] = now.toISOString();
    dirty = true;
  }
  if (dirty) await store.saveSeries(seriesKey, stored);

  return months
    .filter((m) => m in stored.values)
    .map((m): SeriesPoint => ({
      date: `${m.slice(0, 4)}-${m.slice(4, 6)}`,
      value: stored.values[m],
    }));
}

/** 해당 월을 API로 (재)수집해야 하는지 판단 */
function needsFetch(month: string, stored: StoredSeries, now: Date): boolean {
  const fetchedAt = stored.fetchedAt[month];
  if (!fetchedAt) return true;
  if (!isRecentMonth(month, now)) return false; // 과거 확정분은 재호출 안 함
  const ageMs = now.getTime() - new Date(fetchedAt).getTime();
  return ageMs > RECENT_REFRESH_DAYS * 24 * 60 * 60 * 1000;
}

/** 당월·직전월(RECENT_MONTH_WINDOW개월) 여부 — KST 기준 */
function isRecentMonth(month: string, now: Date): boolean {
  const [cy, cm] = kstDateString(now).split("-").map(Number);
  const monthIndex = Number(month.slice(0, 4)) * 12 + (Number(month.slice(4, 6)) - 1);
  const currentIndex = cy * 12 + (cm - 1);
  return currentIndex - monthIndex < RECENT_MONTH_WINDOW;
}

/**
 * 단일 월 호출 (startBaseMm == endBaseMm — 호출당 최대 1개월 제약 준수).
 * 반환: 값(number|null=원천 빈 값) 또는 undefined(해당 월 데이터 없음).
 */
async function callFisisMonth(
  key: string,
  p: { financeCd: string; listNo: string; accountCd: string; term: string },
  month: string
): Promise<number | null | undefined> {
  const url = new URL(FISIS_ENDPOINT);
  url.searchParams.set("auth", key);
  url.searchParams.set("financeCd", p.financeCd);
  url.searchParams.set("listNo", p.listNo);
  url.searchParams.set("accountCd", p.accountCd);
  url.searchParams.set("term", p.term);
  url.searchParams.set("startBaseMm", month);
  url.searchParams.set("endBaseMm", month);
  url.searchParams.set("lang", FISIS_LANG);

  // 자체 증분 적재를 쓰므로 Next fetch 캐시는 사용하지 않음
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new SourceError("fisis", `HTTP ${res.status} (${month})`);
  const json: unknown = await res.json();

  // ── 응답 파싱 — 실키 검증 전 ──────────────────────────────
  // 문서상 { result: { err_cd, err_msg, list: [{ base_month, a, ... }] } }로
  // 알려져 있으나 실제 필드명이 다를 수 있어 방어적으로 처리한다.
  // 실키 확보 후: err_cd/err_msg 표기, list 위치, base_month·값 필드명(a) 확인 필요.
  const result = pickObject(json, ["result"]) ?? (isObject(json) ? json : undefined);
  if (!result) throw new SourceError("fisis", `응답 형식을 해석할 수 없습니다 (${month})`);

  const errCd = pickString(result, ["err_cd", "errCd", "err_code"]);
  if (errCd !== undefined && errCd !== FISIS_OK_CODE) {
    const errMsg = pickString(result, ["err_msg", "errMsg", "err_message"]) ?? "";
    throw new SourceError("fisis", `${errCd} ${errMsg} (${month})`.trim());
  }

  const list = pickArray(result, ["list", "row", "data"]);
  if (!list || list.length === 0) return undefined; // 해당 월 데이터 없음

  // startBaseMm==endBaseMm이므로 통상 1행. 여러 행이면 요청 월과 일치하는 행 우선.
  const row =
    list.find(
      (r) => isObject(r) && pickString(r, ["base_month", "baseMm", "base_mm"]) === month
    ) ?? list[0];
  if (!isObject(row)) return undefined;

  const raw = pickValue(row, ["a", "value", "amt", "data_value"]);
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  const num = Number(String(raw).replace(/,/g, "")); // 천단위 콤마 방어
  return Number.isNaN(num) ? null : num;
}

/** "YYYY-MM-DD"(정규형) 범위 → 포함된 월 목록 ["YYYYMM", ...] */
function enumerateMonths(startIso: string, endIso: string): string[] {
  const [sy, sm] = startIso.split("-").map(Number);
  const [ey, em] = endIso.split("-").map(Number);
  const months: string[] = [];
  for (let i = sy * 12 + (sm - 1); i <= ey * 12 + (em - 1); i++) {
    const y = Math.floor(i / 12);
    const m = (i % 12) + 1;
    months.push(`${y}${String(m).padStart(2, "0")}`);
  }
  return months;
}

/** KST 기준 "YYYY-MM-DD" (KST는 UTC+9 고정, DST 없음) */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
function kstDateString(now: Date): string {
  return new Date(now.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

// ── 방어적 파싱 헬퍼 ─────────────────────────────────────────
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function pickObject(v: unknown, keys: string[]): Record<string, unknown> | undefined {
  if (!isObject(v)) return undefined;
  for (const k of keys) if (isObject(v[k])) return v[k];
  return undefined;
}
function pickArray(v: Record<string, unknown>, keys: string[]): unknown[] | undefined {
  for (const k of keys) if (Array.isArray(v[k])) return v[k];
  return undefined;
}
function pickString(v: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const x = v[k];
    if (typeof x === "string" || typeof x === "number") return String(x);
  }
  return undefined;
}
function pickValue(v: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (k in v) return v[k];
  return undefined;
}
