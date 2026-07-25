import { SeriesPoint, SourceAdapter, SourceError, requireKey } from "./types";
import { KrxStore, StoredKrxDay, fileStore } from "./krx-store";

/**
 * 한국거래소 KRX 정보데이터시스템 Open API
 * https://openapi.krx.co.kr/ — 인증: AUTH_KEY 요청 헤더 (서비스별 승인형)
 *
 * 모든 서비스가 기준일(basDd) 1일 단위로 해당일의 전 종목/전 지수 행을 반환하므로,
 * 요청 범위의 영업일을 순회 호출한 뒤 필터로 원하는 행을 골라 시계열을 구성한다.
 *
 * 영속 캐시 (<데이터루트>/krx/{endpoint}/{YYYYMMDD}.json — krx-store.ts, 루트는 lib/data-dir.ts):
 * - 일별 확정치는 과거 소급 수정이 없으므로 한 번 받은 날은 영구 재사용.
 *   5년 요청 ≈ 영업일 1,250회 연속 호출이 KRX 속도 제한(HTTP 403)에 걸린 실사례가
 *   배경 — 미캐시 일자만 API를 호출한다.
 * - endpoint+일자 단위로 전체 행을 저장해 같은 endpoint를 쓰는 지표들
 *   (국고 3y/10y 등)이 캐시를 공유하고, 행 필터는 캐시 위에서 적용.
 * - 빈 응답(휴장일)도 캐시해 재호출을 막되, 장 마감 전 조회였을 수 있는
 *   최근 일자는 24시간 후 재확인한다.
 * - 미캐시 일자가 BACKFILL_MAX_DAYS_PER_REQUEST를 넘는 대량 백필은 최신부터
 *   그만큼만 채우고 부분 반환(나머지는 서버 콘솔에 안내 — 다음 조회에서 이어짐).
 * - 403을 만나면 즉시 중단하고 그때까지 받은 것은 캐시에 남긴 뒤 SourceError.
 * - 캐시 쓰기 실패(읽기전용 FS 등)는 조회를 실패시키지 않는다 — 경고 후 API 결과를
 *   그대로 반환한다. 재호출해도 값이 달라지지 않으므로 정확성 영향은 없고,
 *   느려지고 403 위험이 커질 뿐이다(krx-store.ts 주석 참조).
 *
 * params:
 * - endpoint     (필수) 서비스 경로. 예: "bon/kts_bydd_trd", "idx/drvprod_dd_trd"
 * - valueField   (필수) 값으로 쓸 응답 필드명. 예: "CLSPRC_YD", "CLSPRC_IDX"
 * - dateField    (선택) 날짜 필드명. 기본 "BAS_DD" (YYYYMMDD)
 * - 그 외 모든 키는 행 필터로 해석: 완전일치, 값이 "*"로 끝나면 접두사 일치.
 *   예: { GOVBND_ISU_TP_NM: "지표", BND_EXP_TP_NM: "10", ISU_NM: "국고*" }
 *   → 10년 지표물 중 국고채 행 선택 (물가연동국채 제외)
 */

// ── 한도·동시성 정책 상수 ────────────────────────────────────
/** 미캐시 일자 API 호출 동시성 — 속도 제한(403) 완화를 위해 낮게 유지 */
const UNCACHED_CONCURRENCY = 3;
/** API 호출 배치 사이의 지연 (ms) — 버스트 완화 */
const INTER_BATCH_DELAY_MS = 300;
/** 요청 1회당 미캐시 일자 최대 수집 수 — 초과분은 부분 반환 후 다음 조회에서 이어감 */
const BACKFILL_MAX_DAYS_PER_REQUEST = 400;
/**
 * 빈 응답(휴장 추정)의 확정 유예: 해당일 KST 자정(익일 0시)에서 이 시간이 지난 뒤
 * 받은 빈 응답만 "확정 휴장일"로 영구 캐시한다 (장 마감 전·집계 전 조회 방어)
 */
const EMPTY_DAY_FINAL_AFTER_MS = 24 * 60 * 60 * 1000;
/** 아직 확정 전인 캐시 항목의 재확인 주기 (24시간 후 재확인) */
const UNSETTLED_RECHECK_MS = 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000; // KST=UTC+9 고정, DST 없음

export const krx: SourceAdapter = {
  id: "krx",
  name: "한국거래소 KRX",
  requiresKey: true,

  async fetchSeries(params, range) {
    return fetchKrxSeries(params, range, fileStore);
  },
};

/** store를 주입받는 본체 — 테스트·저장소 교체(Supabase 등) 용이하게 분리 */
export async function fetchKrxSeries(
  params: Record<string, string>,
  range: { start: string; end: string },
  store: KrxStore
): Promise<SeriesPoint[]> {
  const key = requireKey("krx", "KRX_API_KEY");
  const { endpoint, valueField, dateField = "BAS_DD", ...filters } = params;
  if (!endpoint) throw new SourceError("krx", "params.endpoint가 필요합니다 (예: bon/kts_bydd_trd)");
  if (!valueField) throw new SourceError("krx", "params.valueField가 필요합니다 (예: CLSPRC_YD)");

  const days = weekdaysBetween(range.start, range.end);
  const now = new Date();

  // 1) 캐시 로드
  const cached = new Map<string, StoredKrxDay>();
  for (const day of days) {
    const entry = await store.loadDay(endpoint, day);
    if (entry) cached.set(day, entry);
  }

  // 2) 수집 대상 선정 — 최신 일자 우선, 대량 백필은 상한까지만
  const missing = days
    .filter((day) => needsFetch(day, cached.get(day) ?? null, now))
    .sort((a, b) => b.localeCompare(a));
  let toFetch = missing;
  if (missing.length > BACKFILL_MAX_DAYS_PER_REQUEST) {
    toFetch = missing.slice(0, BACKFILL_MAX_DAYS_PER_REQUEST);
    const deferred = missing.slice(BACKFILL_MAX_DAYS_PER_REQUEST);
    console.warn(
      `[krx] ${endpoint}: 미캐시 ${missing.length}일 중 최신 ${BACKFILL_MAX_DAYS_PER_REQUEST}일만 이번에 수집합니다. ` +
        `나머지 ${deferred.length}일(${deferred[deferred.length - 1]}~${deferred[0]})은 이번 응답에서 빠지며(부분 반환), ` +
        `다음 조회에서 이어서 채워집니다.`
    );
  }
  if (days.length > 0) {
    console.log(
      `[krx] ${endpoint} ${range.start}~${range.end}: 영업일 ${days.length} · 캐시 재사용 ${days.length - missing.length} · API 호출 ${toFetch.length}`
    );
  }

  // 3) 미캐시 일자 호출 — 낮은 동시성 + 배치 간 지연, 실패 시 받은 만큼은 저장 후 중단
  let firstError: unknown = null;
  for (let i = 0; i < toFetch.length; i += UNCACHED_CONCURRENCY) {
    const chunk = toFetch.slice(i, i + UNCACHED_CONCURRENCY);
    const results = await Promise.allSettled(chunk.map((day) => fetchDayRows(key, endpoint, day)));
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === "fulfilled") {
        const entry: StoredKrxDay = { fetchedAt: new Date().toISOString(), rows: r.value };
        await store.saveDay(endpoint, chunk[j], entry);
        cached.set(chunk[j], entry);
      } else if (firstError === null) {
        firstError = r.reason;
      }
    }
    if (firstError !== null) break; // 같은 배치의 성공분은 저장 완료 — 즉시 중단
    if (i + UNCACHED_CONCURRENCY < toFetch.length) await sleep(INTER_BATCH_DELAY_MS);
  }
  if (firstError !== null) {
    if (firstError instanceof KrxHttpError && firstError.status === 403) {
      throw new SourceError(
        "krx",
        `HTTP 403 (${endpoint}) — 속도 제한(또는 서비스 미승인)으로 수집을 중단했습니다. ` +
          `지금까지 받은 일자는 캐시(<데이터루트>/krx/)에 저장되어 다음 조회에서 즉시 반환되므로, ` +
          `잠시 후 다시 시도하면 남은 구간부터 이어서 채워집니다.`
      );
    }
    throw firstError instanceof SourceError ? firstError : new SourceError("krx", String(firstError));
  }

  // 4) 캐시 위에서 행 필터 적용해 시계열 구성 (미수집 일자는 제외 = 부분 반환)
  const points: SeriesPoint[] = [];
  for (const day of days) {
    const entry = cached.get(day);
    if (!entry || entry.rows.length === 0) continue; // 미수집 또는 휴장일
    const p = extractPoint(entry.rows, day, endpoint, dateField, valueField, filters);
    if (p) points.push(p);
  }
  return points.sort((a, b) => a.date.localeCompare(b.date));
}

type KrxRow = Record<string, string>;

/** HTTP 오류에 상태 코드를 보존 — 403(속도 제한) 분기용 */
class KrxHttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

/** 해당일을 API로 (재)수집해야 하는지 판단 */
function needsFetch(day: string, entry: StoredKrxDay | null, now: Date): boolean {
  if (!entry) return true;
  if (isFinal(day, entry)) return false;
  // 확정 전(당일 장 마감 전 조회 등) — 24시간 지나면 재확인
  const ageMs = now.getTime() - new Date(entry.fetchedAt).getTime();
  return ageMs > UNSETTLED_RECHECK_MS;
}

/**
 * 캐시 항목이 확정치인지 — 확정이면 영구 재사용.
 * - 데이터 있음: 해당일 KST 자정 이후 수집분은 확정 (일별 확정치는 소급 수정 없음)
 * - 빈 응답: 익일 자정에서 EMPTY_DAY_FINAL_AFTER_MS 더 지난 뒤 수집분만 확정 휴장일
 */
function isFinal(day: string, entry: StoredKrxDay): boolean {
  const fetchedMs = new Date(entry.fetchedAt).getTime();
  const dayEndMs = kstDayEndUtcMs(day);
  if (entry.rows.length > 0) return fetchedMs >= dayEndMs;
  return fetchedMs >= dayEndMs + EMPTY_DAY_FINAL_AFTER_MS;
}

/** "YYYYMMDD"의 KST 하루가 끝나는 시각(익일 0시 KST)의 UTC epoch ms */
function kstDayEndUtcMs(day: string): number {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(4, 6));
  const d = Number(day.slice(6, 8));
  return Date.UTC(y, m - 1, d) - KST_OFFSET_MS + DAY_MS;
}

/** 단일 일자 원시응답 조회 — 해당일 전체 행 반환 (빈 배열 = 데이터 없음) */
async function fetchDayRows(key: string, endpoint: string, day: string): Promise<KrxRow[]> {
  const url = `https://data-dbg.krx.co.kr/svc/apis/${endpoint}?basDd=${day}`;
  // 자체 영속 캐시(krx-store)를 쓰므로 Next fetch 캐시는 사용하지 않음
  const res = await fetch(url, { headers: { AUTH_KEY: key }, cache: "no-store" });
  if (!res.ok) throw new KrxHttpError(res.status, `HTTP ${res.status} (${endpoint} ${day})`);

  const json: { OutBlock_1?: KrxRow[] } = await res.json();
  const rows = json.OutBlock_1;
  if (!Array.isArray(rows)) throw new SourceError("krx", `예상치 못한 응답 형식 (${endpoint}): OutBlock_1 없음`);
  return rows;
}

/** 캐시된 일자 행에서 필터로 1행을 골라 SeriesPoint로 변환 */
function extractPoint(
  rows: KrxRow[],
  day: string,
  endpoint: string,
  dateField: string,
  valueField: string,
  filters: Record<string, string>
): SeriesPoint | null {
  const entries = Object.entries(filters);
  const matched = rows.filter((row) =>
    entries.every(([f, v]) =>
      v.endsWith("*") ? (row[f] ?? "").startsWith(v.slice(0, -1)) : row[f] === v
    )
  );
  if (matched.length === 0) return null; // 해당일에 조건에 맞는 행 없음 (미상장 기간 등)
  if (matched.length > 1) {
    throw new SourceError(
      "krx",
      `${endpoint} ${day}: 필터 조건에 ${matched.length}개 행이 일치합니다 — 필터를 더 좁히세요 (예: ${JSON.stringify(matched[0])})`
    );
  }

  const row = matched[0];
  return {
    date: toIsoDate(row[dateField] ?? day),
    value: parseKrxNumber(row[valueField]),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** "20260723" → "2026-07-23" (이미 ISO면 그대로) */
function toIsoDate(raw: string): string {
  if (raw.includes("-")) return raw;
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

/** KRX 수치 문자열 → number|null ("", "-" 등 비수치는 null) */
function parseKrxNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const cleaned = raw.replace(/,/g, "").trim();
  if (cleaned === "" || cleaned === "-") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** range(YYYY-MM-DD)의 주중일(월–금)을 YYYYMMDD 목록으로 (KRX는 주말 휴장) */
function weekdaysBetween(start: string, end: string): string[] {
  const out: string[] = [];
  const cur = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cur <= last) {
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(cur.toISOString().slice(0, 10).replace(/-/g, ""));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}
