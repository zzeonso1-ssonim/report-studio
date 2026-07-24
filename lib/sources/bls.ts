import { SeriesPoint, SourceAdapter, SourceError } from "./types";

/**
 * 미 노동통계국 BLS Public Data API v2
 * https://www.bls.gov/developers/
 * params: { seriesId }  (예: CPI-U 전체 CUUR0000SA0)
 * 키 없이도 동작하지만 한도가 낮음 — BLS_API_KEY 설정 권장
 */
export const bls: SourceAdapter = {
  id: "bls",
  name: "미 노동통계국 BLS",
  requiresKey: false,

  async fetchSeries(params, range) {
    const body: Record<string, unknown> = {
      seriesid: [params.seriesId],
      startyear: range.start.slice(0, 4),
      endyear: range.end.slice(0, 4),
    };
    if (process.env.BLS_API_KEY) body.registrationkey = process.env.BLS_API_KEY;

    const res = await fetch("https://api.bls.gov/publicAPI/v2/timeseries/data/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      next: { revalidate: 600 },
    });
    if (!res.ok) throw new SourceError("bls", `HTTP ${res.status}`);
    const json = await res.json();
    if (json.status !== "REQUEST_SUCCEEDED") {
      throw new SourceError("bls", (json.message ?? []).join("; ") || "요청 실패");
    }

    const rows: { year: string; period: string; value: string }[] =
      json.Results?.series?.[0]?.data ?? [];

    return rows
      .filter((r) => r.period.startsWith("M") && r.period !== "M13") // M13=연평균 제외
      .map(
        (r): SeriesPoint => ({
          date: `${r.year}-${r.period.slice(1)}`,
          value: Number(r.value),
        })
      )
      .reverse(); // BLS는 최신순 → 오래된순으로 정렬
  },
};
