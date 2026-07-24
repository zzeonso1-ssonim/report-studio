import { SeriesPoint, SourceAdapter, SourceError, requireKey } from "./types";

/**
 * FRED (Federal Reserve Economic Data, 세인트루이스 연은)
 * https://fred.stlouisfed.org/docs/api/fred/
 * params: { seriesId }
 */
export const fred: SourceAdapter = {
  id: "fred",
  name: "FRED (세인트루이스 연은)",
  requiresKey: true,

  async fetchSeries(params, range) {
    const key = requireKey("fred", "FRED_API_KEY");
    const qs = new URLSearchParams({
      series_id: params.seriesId,
      api_key: key,
      file_type: "json",
      observation_start: range.start,
      observation_end: range.end,
    });
    const res = await fetch(`https://api.stlouisfed.org/fred/series/observations?${qs}`, {
      next: { revalidate: 600 },
    });
    if (!res.ok) throw new SourceError("fred", `HTTP ${res.status}`);
    const json = await res.json();

    const rows: { date: string; value: string }[] = json.observations ?? [];
    return rows.map(
      (r): SeriesPoint => ({
        date: r.date,
        value: r.value === "." ? null : Number(r.value),
      })
    );
  },
};
