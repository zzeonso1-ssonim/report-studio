import { SeriesPoint, SeriesRange, SourceAdapter, SourceError, requireKey } from "./types";

/**
 * 한국부동산원 R-ONE 부동산통계 OpenAPI (reb.or.kr 자체 포털 — data.go.kr 경유 아님)
 * https://www.reb.or.kr/r-one/openapi/
 * - SttsApiTbl.do     통계표 목록 (카탈로그, 2026-07 기준 738개 표)
 * - SttsApiTblData.do 통계자료 조회
 *
 * 카탈로그 기반 범용 어댑터: 특정 지표를 하드코딩하지 않고 통계표 ID·분류·항목
 * 코드를 params로 받아 임의의 R-ONE 통계를 조회한다.
 *
 * params:
 * - statblId (필수) 통계표 ID. 예: "A_2024_00045" (월 매매가격지수_아파트)
 * - cycle    (필수) 주기 코드 DTACYCLE_CD: MM(월)|WK(주)|QY(분기)|HY(반기)|YY(연)
 * - clsId    (선택) 분류(지역 등) 코드 CLS_ID — 서버측 필터. 예: "500001"(전국)
 * - itmId    (선택) 항목 코드 ITM_ID — 서버측 필터. 예: "100001"(지수)
 * - grpId    (선택) 그룹 코드 GRP_ID — 서버측 필터
 * - 그 외 모든 키는 응답 행 필드에 대한 클라이언트측 필터: 완전일치,
 *   값이 "*"로 끝나면 접두사 일치. 예: { CLS_FULLNM: "전북>*" }
 *
 * 시점 표기: 월 "YYYY-MM", 분기 "YYYY-Qn", 반기 "YYYY-Hn", 연 "YYYY",
 * 주간은 R-ONE이 주는 실제 조사일(WRTTIME_DESC, YYYY-MM-DD)을 그대로 살린다.
 */
export const rone: SourceAdapter = {
  id: "rone",
  name: "한국부동산원 R-ONE",
  requiresKey: true,

  async fetchSeries(params, range) {
    const key = requireKey("rone", "RONE_API_KEY");
    const { statblId, cycle, clsId, itmId, grpId, ...filters } = params;
    if (!statblId) throw new SourceError("rone", "params.statblId가 필요합니다 (예: A_2024_00045)");
    if (!cycle) throw new SourceError("rone", "params.cycle이 필요합니다 (MM|WK|QY|HY|YY)");

    const rows = await fetchAllRows(key, { statblId, cycle, clsId, itmId, grpId }, range);

    // 클라이언트측 행 필터 (krx 어댑터와 동일 규약: 완전일치, "*" 접미는 접두사 일치)
    const entries = Object.entries(filters);
    const matched = rows.filter((row) =>
      entries.every(([f, v]) => {
        const cell = row[f] == null ? "" : String(row[f]);
        return v.endsWith("*") ? cell.startsWith(v.slice(0, -1)) : cell === v;
      })
    );

    // 같은 시점에 여러 행이 남으면 필터가 덜 좁혀진 것 — 조용히 임의 선택하지 않는다
    const seen = new Map<string, RoneRow>();
    for (const row of matched) {
      const period = row.WRTTIME_IDTFR_ID;
      const prev = seen.get(period);
      if (prev) {
        throw new SourceError(
          "rone",
          `${statblId} ${period}: 조건에 맞는 행이 2개 이상입니다 — clsId/itmId나 필터를 더 좁히세요 ` +
            `(예: ${JSON.stringify({ CLS_ID: prev.CLS_ID, CLS_FULLNM: prev.CLS_FULLNM, ITM_ID: prev.ITM_ID, ITM_NM: prev.ITM_NM })})`
        );
      }
      seen.set(period, row);
    }

    const points = matched.map(
      (row): SeriesPoint => ({
        date: toIsoPeriod(row, cycle),
        value: toNumber(row.DTA_VAL),
      })
    );

    // 주간은 서버측 범위를 연 단위로 넉넉히 잡았으므로 실제 날짜로 다시 거른다
    const inRange =
      cycle === "WK"
        ? points.filter((p) => p.date >= range.start && p.date <= range.end)
        : points;

    return inRange.sort((a, b) => a.date.localeCompare(b.date));
  },
};

const BASE = "https://www.reb.or.kr/r-one/openapi";
const PAGE_SIZE = 1000;
const MAX_PAGES = 200; // 폭주 방지 (한 페이지 1000행 × 200)

interface RoneRow {
  WRTTIME_IDTFR_ID: string; // 시점 ID: MM=YYYYMM, WK=YYYYWW, QY=YYYY0q, YY=YYYY
  WRTTIME_DESC: string; //     시점 표시: 주간은 YYYY-MM-DD 실제 날짜
  DTA_VAL: number | string | null;
  CLS_ID: number | string | null;
  CLS_NM: string | null;
  CLS_FULLNM: string | null;
  ITM_ID: number | string | null;
  ITM_NM: string | null;
  [field: string]: unknown;
}

interface RoneResult {
  CODE: string;
  MESSAGE: string;
}

async function fetchAllRows(
  key: string,
  ids: { statblId: string; cycle: string; clsId?: string; itmId?: string; grpId?: string },
  range: SeriesRange
): Promise<RoneRow[]> {
  const rows: RoneRow[] = [];

  for (let pIndex = 1; pIndex <= MAX_PAGES; pIndex++) {
    const qs = new URLSearchParams({
      KEY: key,
      Type: "json",
      pIndex: String(pIndex),
      pSize: String(PAGE_SIZE),
      STATBL_ID: ids.statblId,
      DTACYCLE_CD: ids.cycle,
      START_WRTTIME: toRonePeriod(range.start, ids.cycle, false),
      END_WRTTIME: toRonePeriod(range.end, ids.cycle, true),
    });
    if (ids.clsId) qs.set("CLS_ID", ids.clsId);
    if (ids.itmId) qs.set("ITM_ID", ids.itmId);
    if (ids.grpId) qs.set("GRP_ID", ids.grpId);

    // 주의: URL에 인증키가 포함되므로 오류 메시지에 URL을 절대 넣지 않는다
    const res = await fetch(`${BASE}/SttsApiTblData.do?${qs}`, { next: { revalidate: 3600 } });
    if (!res.ok) throw new SourceError("rone", `HTTP ${res.status} (SttsApiTblData)`);
    const json: unknown = await res.json();

    // 오류·데이터없음은 {"RESULT":{...}}가 최상위로 온다 (INFO-200 = 해당 데이터 없음)
    const topResult = (json as { RESULT?: RoneResult }).RESULT;
    if (topResult) {
      if (topResult.CODE === "INFO-200") return rows;
      throw new SourceError("rone", `${topResult.CODE} ${topResult.MESSAGE}`);
    }

    const blocks = (json as { SttsApiTblData?: unknown[] }).SttsApiTblData;
    if (!Array.isArray(blocks)) throw new SourceError("rone", "예상치 못한 응답 형식: SttsApiTblData 없음");

    const head = blocks[0] as { head?: [{ list_total_count: number }, { RESULT: RoneResult }] };
    const result = head.head?.[1]?.RESULT;
    if (result && result.CODE !== "INFO-000") {
      throw new SourceError("rone", `${result.CODE} ${result.MESSAGE}`);
    }
    const total = head.head?.[0]?.list_total_count ?? 0;

    const page = (blocks[1] as { row?: RoneRow[] })?.row ?? [];
    rows.push(...page);

    if (rows.length >= total || page.length === 0) return rows;
  }

  throw new SourceError("rone", `응답 행이 너무 많습니다 (${MAX_PAGES * PAGE_SIZE}행 초과) — clsId/itmId로 좁히세요`);
}

/** YYYY-MM-DD → R-ONE 주기별 시점 ID. 주간(WK)은 연내 주차 번호라 ISO 날짜로 정확히
 *  환산할 수 없으므로 연 단위로 넉넉히 잡고 fetchSeries에서 실제 날짜로 거른다. */
function toRonePeriod(iso: string, cycle: string, isEnd: boolean): string {
  const [y, m] = iso.split("-");
  switch (cycle) {
    case "MM": return `${y}${m}`;
    case "WK": return isEnd ? `${y}54` : `${y}00`;
    case "QY": return `${y}0${Math.ceil(Number(m) / 3)}`;
    case "HY": return `${y}0${Number(m) <= 6 ? 1 : 2}`;
    default: return y; // YY
  }
}

/** R-ONE 시점 → 반환 표기. 주간은 실제 조사일(YYYY-MM-DD)을 그대로 쓴다. */
function toIsoPeriod(row: RoneRow, cycle: string): string {
  const id = row.WRTTIME_IDTFR_ID;
  switch (cycle) {
    case "MM": return `${id.slice(0, 4)}-${id.slice(4, 6)}`;
    case "WK": return /^\d{4}-\d{2}-\d{2}$/.test(row.WRTTIME_DESC) ? row.WRTTIME_DESC : id;
    case "QY": return `${id.slice(0, 4)}-Q${Number(id.slice(4, 6))}`;
    case "HY": return `${id.slice(0, 4)}-H${Number(id.slice(4, 6))}`;
    default: return id; // YY = YYYY
  }
}

function toNumber(raw: number | string | null): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** 통계표 카탈로그 항목 (SttsApiTbl.do) */
export interface RoneTable {
  STATBL_ID: string;
  STATBL_NM: string;
  DTACYCLE_CD: string; // "MM" | "WK" | "QY" | "YY" | 복합("YY,QY" 등)
  DTACYCLE_NM: string;
  TOP_ORG_NM: string;
  DATA_START_YY: string;
  DATA_END_YY: string;
  RPSTUI_NM: string | null; // 기준시점 등 대표 표기
  STATBL_CMMT: string | null;
}

/**
 * 통계표 목록(카탈로그) 조회 — 지표 검색 기능에 활용할 수 있다.
 * 전체를 한 번에 가져온다 (2026-07 기준 738개, pSize 1000이면 1페이지).
 */
export async function fetchRoneCatalog(): Promise<RoneTable[]> {
  const key = requireKey("rone", "RONE_API_KEY");
  const qs = new URLSearchParams({ KEY: key, Type: "json", pIndex: "1", pSize: "1000" });
  const res = await fetch(`${BASE}/SttsApiTbl.do?${qs}`, { next: { revalidate: 86400 } });
  if (!res.ok) throw new SourceError("rone", `HTTP ${res.status} (SttsApiTbl)`);
  const json: {
    RESULT?: RoneResult;
    SttsApiTbl?: [unknown, { row?: RoneTable[] }];
  } = await res.json();
  if (json.RESULT) throw new SourceError("rone", `${json.RESULT.CODE} ${json.RESULT.MESSAGE}`);
  return json.SttsApiTbl?.[1]?.row ?? [];
}
