import { SeriesPoint, SeriesRange, SourceAdapter, SourceError, requireKey } from "./types";

/**
 * 한국거래소 KRX 정보데이터시스템 Open API
 * https://openapi.krx.co.kr/ — 인증: AUTH_KEY 요청 헤더 (서비스별 승인형)
 *
 * 모든 서비스가 기준일(basDd) 1일 단위로 해당일의 전 종목/전 지수 행을 반환하므로,
 * 요청 범위의 영업일을 순회 호출한 뒤 필터로 원하는 행을 골라 시계열을 구성한다.
 *
 * params:
 * - endpoint     (필수) 서비스 경로. 예: "bon/kts_bydd_trd", "idx/drvprod_dd_trd"
 * - valueField   (필수) 값으로 쓸 응답 필드명. 예: "CLSPRC_YD", "CLSPRC_IDX"
 * - dateField    (선택) 날짜 필드명. 기본 "BAS_DD" (YYYYMMDD)
 * - 그 외 모든 키는 행 필터로 해석: 완전일치, 값이 "*"로 끝나면 접두사 일치.
 *   예: { GOVBND_ISU_TP_NM: "지표", BND_EXP_TP_NM: "10", ISU_NM: "국고*" }
 *   → 10년 지표물 중 국고채 행 선택 (물가연동국채 제외)
 */
export const krx: SourceAdapter = {
  id: "krx",
  name: "한국거래소 KRX",
  requiresKey: true,

  async fetchSeries(params, range) {
    const key = requireKey("krx", "KRX_API_KEY");
    const { endpoint, valueField, dateField = "BAS_DD", ...filters } = params;
    if (!endpoint) throw new SourceError("krx", "params.endpoint가 필요합니다 (예: bon/kts_bydd_trd)");
    if (!valueField) throw new SourceError("krx", "params.valueField가 필요합니다 (예: CLSPRC_YD)");

    const days = weekdaysBetween(range.start, range.end);
    const points: SeriesPoint[] = [];

    // 일 단위 호출이므로 동시성을 제한해 순회
    for (let i = 0; i < days.length; i += CONCURRENCY) {
      const chunk = days.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        chunk.map((day) => fetchDay(key, endpoint, day, dateField, valueField, filters))
      );
      for (const p of results) if (p) points.push(p);
    }

    return points.sort((a, b) => a.date.localeCompare(b.date));
  },
};

const CONCURRENCY = 8;

type KrxRow = Record<string, string>;

async function fetchDay(
  key: string,
  endpoint: string,
  day: string, // YYYYMMDD
  dateField: string,
  valueField: string,
  filters: Record<string, string>
): Promise<SeriesPoint | null> {
  const url = `https://data-dbg.krx.co.kr/svc/apis/${endpoint}?basDd=${day}`;
  // 일별 확정 데이터라 재검증 주기를 길게 둔다
  const res = await fetch(url, { headers: { AUTH_KEY: key }, next: { revalidate: 86400 } });
  if (res.status === 401 || res.status === 403) {
    throw new SourceError("krx", `HTTP ${res.status} — 인증키가 '${endpoint}' 서비스에 승인되지 않았을 수 있습니다`);
  }
  if (!res.ok) throw new SourceError("krx", `HTTP ${res.status} (${endpoint})`);

  const json: { OutBlock_1?: KrxRow[] } = await res.json();
  const rows = json.OutBlock_1;
  if (!Array.isArray(rows)) throw new SourceError("krx", `예상치 못한 응답 형식 (${endpoint}): OutBlock_1 없음`);
  if (rows.length === 0) return null; // 휴장일

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
