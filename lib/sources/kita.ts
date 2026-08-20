import { SeriesPoint, SourceAdapter, SourceError } from "./types";

const ENDPOINT = "https://stat.kita.net/stat/kts/pum/ItemImpExpListWorker.screen";
const BATCH_SIZE = 12;

function monthRange(start: string, end: string): string[] {
  const [startYear, startMonth] = start.split("-").map(Number);
  const [endYear, endMonth] = end.split("-").map(Number);
  if (!startYear || !startMonth || !endYear || !endMonth) return [];
  const months: string[] = [];
  let cursor = startYear * 12 + startMonth - 1;
  const last = endYear * 12 + endMonth - 1;
  for (; cursor <= last; cursor += 1) {
    months.push(`${Math.floor(cursor / 12)}-${String((cursor % 12) + 1).padStart(2, "0")}`);
  }
  return months;
}

function textCells(row: string): string[] {
  return [...row.matchAll(/<TD[^>]*>([\s\S]*?)<\/TD>/g)].map((match) =>
    match[1]
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<[^>]+>/g, "")
      .trim()
  );
}

function parseImportAmount(xml: string, itemCode: string): number | null {
  for (const row of xml.match(/<TR>[\s\S]*?<\/TR>/g) ?? []) {
    const cells = textCells(row);
    if (cells[1] !== itemCode) continue;
    const rawValue = cells[11]?.replaceAll(",", "");
    if (!rawValue) return null;
    const value = Number(rawValue);
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  return null;
}

async function fetchMonth(itemCode: string, date: string): Promise<SeriesPoint | null> {
  const [year, month] = date.split("-");
  const body = new URLSearchParams({
    event_udap: "Search",
    searchType: "SHEET",
    pageNum: "1",
    s_cond_gb: "MTI",
    s_cond_unit: "3",
    s_cond_unit_num: itemCode,
    p_cond_unit: "3",
    s_year: year,
    s_month: month,
    s_field: "AMT",
    s_monthsum_gb: "1",
    s_measure: "1",
    s_sort: "THIS_IMP_AMT",
    s_sort_val: "DESC",
    s_language: "kor_name",
    listCount: "100",
  });
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      accept: "application/xml,text/xml,*/*",
    },
    body,
    cache: "no-store",
  });
  if (!response.ok) throw new SourceError("kita", `HTTP ${response.status}`);
  const value = parseImportAmount(await response.text(), itemCode);
  return value == null ? null : { date, value };
}

/**
 * 한국무역협회 K-stat 품목별 수출입 공개 통계.
 * MTI 3단위의 월별 수입금액(달러)을 조회한다. 로그인이나 별도 API 키는 필요 없다.
 * 화면의 당월 조회와 같은 공식 원자료만 읽고, 응답이 없는 미공표월은 저장하지 않는다.
 */
export const kita: SourceAdapter = {
  id: "kita",
  name: "한국무역협회 K-stat",
  requiresKey: false,

  async fetchSeries(params, range) {
    const itemCode = params.itemCode;
    if (!itemCode) throw new SourceError("kita", "itemCode가 필요합니다");
    const dates = monthRange(range.start, range.end);
    const points: SeriesPoint[] = [];
    for (let offset = 0; offset < dates.length; offset += BATCH_SIZE) {
      const batch = dates.slice(offset, offset + BATCH_SIZE);
      const results = await Promise.all(batch.map((date) => fetchMonth(itemCode, date)));
      points.push(...results.filter((point): point is SeriesPoint => point !== null));
    }
    if (!points.length) throw new SourceError("kita", "조회 구간에 공표값이 없습니다");
    return points.sort((a, b) => a.date.localeCompare(b.date));
  },
};
