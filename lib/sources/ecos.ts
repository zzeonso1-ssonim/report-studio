import { SeriesPoint, SourceAdapter, SourceError, requireKey } from "./types";

/**
 * 한국은행 경제통계시스템(ECOS) OpenAPI
 * https://ecos.bok.or.kr/api/
 * params: { statCode, cycle(D|M|Q|A), itemCode1, itemCode2?, itemCode3? }
 */
export const ecos: SourceAdapter = {
  id: "ecos",
  name: "한국은행 ECOS",
  requiresKey: true,

  async fetchSeries(params, range) {
    const key = requireKey("ecos", "ECOS_API_KEY");
    const { statCode, cycle, itemCode1 = "?", itemCode2 = "?", itemCode3 = "?" } = params;
    const start = toEcosPeriod(range.start, cycle);
    const end = toEcosPeriod(range.end, cycle);

    const url = `https://ecos.bok.or.kr/api/StatisticSearch/${key}/json/kr/1/10000/${statCode}/${cycle}/${start}/${end}/${itemCode1}/${itemCode2}/${itemCode3}`;
    const res = await fetch(url, { next: { revalidate: 600 } });
    if (!res.ok) throw new SourceError("ecos", `HTTP ${res.status}`);
    const json = await res.json();

    if (json.RESULT) throw new SourceError("ecos", `${json.RESULT.CODE} ${json.RESULT.MESSAGE}`);
    const rows: { TIME: string; DATA_VALUE: string }[] = json.StatisticSearch?.row ?? [];

    return rows.map(
      (r): SeriesPoint => ({
        date: fromEcosPeriod(r.TIME, cycle),
        value: r.DATA_VALUE === "" ? null : Number(r.DATA_VALUE),
      })
    );
  },
};

/** YYYY-MM-DD → ECOS 주기별 표기 (D: YYYYMMDD, M: YYYYMM, Q: YYYYQn, A: YYYY) */
function toEcosPeriod(iso: string, cycle: string): string {
  const [y, m, d] = iso.split("-");
  switch (cycle) {
    case "D": return `${y}${m}${d}`;
    case "M": return `${y}${m}`;
    case "Q": return `${y}Q${Math.ceil(Number(m) / 3)}`;
    default: return y;
  }
}

function fromEcosPeriod(time: string, cycle: string): string {
  switch (cycle) {
    case "D": return `${time.slice(0, 4)}-${time.slice(4, 6)}-${time.slice(6, 8)}`;
    case "M": return `${time.slice(0, 4)}-${time.slice(4, 6)}`;
    case "Q": return time.replace(/^(\d{4})Q(\d)$/, "$1-Q$2"); // "2026Q2" → "2026-Q2" (정렬·병합 정규형)
    default: return time; // A는 YYYY 그대로
  }
}
