import { Cycle } from "./indicators";
import { SeriesPoint } from "./sources/types";

/**
 * 소스별 날짜 표기 정규화 — 병합의 단일 규약.
 *
 * 클라이언트는 날짜 문자열 완전일치로 시리즈를 병합하므로, 소스마다 다른
 * 표기(FRED 월간 "2026-07-01" vs KOSIS "2026-07" vs ECOS 분기 "2026Q2")를
 * 주기별 정규형으로 통일해야 한·미 비교가 같은 X축에 정렬된다.
 *
 * 정규형 (localeCompare 정렬이 시간순과 일치하도록 설계):
 *   D → YYYY-MM-DD · M → YYYY-MM · Q → YYYY-Qn · A → YYYY
 */
export function normalizeDate(date: string, cycle: Cycle): string {
  const d = date.trim();
  switch (cycle) {
    case "D":
      // "YYYYMMDD" → "YYYY-MM-DD"
      if (/^\d{8}$/.test(d)) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
      return d;
    case "M":
      // "YYYY-MM-DD"(FRED) → "YYYY-MM", "YYYYMM" → "YYYY-MM"
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d.slice(0, 7);
      if (/^\d{6}$/.test(d)) return `${d.slice(0, 4)}-${d.slice(4, 6)}`;
      return d;
    case "Q": {
      // "YYYYQn"(ECOS) · "YYYY-Qn" → "YYYY-Qn"
      const q = d.match(/^(\d{4})-?Q(\d)$/i);
      if (q) return `${q[1]}-Q${q[2]}`;
      // "YYYY-MM(-DD)?"(FRED 분기 시작일) → 월에서 분기 도출
      const md = d.match(/^(\d{4})-(\d{2})(-\d{2})?$/);
      if (md) return `${md[1]}-Q${Math.ceil(Number(md[2]) / 3)}`;
      return d;
    }
    case "A": {
      const y = d.match(/^\d{4}/);
      return y ? y[0] : d;
    }
  }
}

export function normalizePointDates(points: SeriesPoint[], cycle: Cycle): SeriesPoint[] {
  return points.map((p) => ({ ...p, date: normalizeDate(p.date, cycle) }));
}
