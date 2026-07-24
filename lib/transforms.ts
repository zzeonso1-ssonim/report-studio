import { Cycle } from "./indicators";
import { SeriesPoint } from "./sources/types";

export type Transform = "raw" | "yoy" | "pop" | "rebase";

export const transformLabels: Record<Transform, string> = {
  raw: "원계열",
  yoy: "전년동기대비 (%)",
  pop: "전기대비 (%)",
  rebase: "재기준화 (시작=100)",
};

const periodsPerYear: Record<Cycle, number | null> = { D: null, M: 12, Q: 4, A: 1 };

export function applyTransform(
  points: SeriesPoint[],
  transform: Transform,
  cycle: Cycle
): SeriesPoint[] {
  switch (transform) {
    case "raw":
      return points;
    case "yoy":
      return yoy(points, cycle);
    case "pop":
      return shiftPct(points, 1);
    case "rebase":
      return rebase(points);
  }
}

function yoy(points: SeriesPoint[], cycle: Cycle): SeriesPoint[] {
  const k = periodsPerYear[cycle];
  if (k === null) {
    // 일간 시계열: 1년 전 같은 날짜를 조회 (휴일 등으로 없으면 null)
    const byDate = new Map(points.map((p) => [p.date, p.value]));
    return points.map((p) => {
      const prevDate = `${Number(p.date.slice(0, 4)) - 1}${p.date.slice(4)}`;
      const prev = byDate.get(prevDate);
      return {
        date: p.date,
        value:
          p.value != null && prev != null && prev !== 0
            ? round4((p.value / prev - 1) * 100)
            : null,
      };
    });
  }
  return shiftPct(points, k);
}

/** k기 전 대비 증감률(%) */
function shiftPct(points: SeriesPoint[], k: number): SeriesPoint[] {
  return points.map((p, i) => {
    const prev = i >= k ? points[i - k].value : null;
    return {
      date: p.date,
      value:
        p.value != null && prev != null && prev !== 0
          ? round4((p.value / prev - 1) * 100)
          : null,
    };
  });
}

/** 구간 첫 유효값 = 100 — 단위가 다른 지표 비교용 */
function rebase(points: SeriesPoint[]): SeriesPoint[] {
  const base = points.find((p) => p.value != null && p.value !== 0)?.value;
  if (base == null) return points;
  return points.map((p) => ({
    date: p.date,
    value: p.value != null ? round4((p.value / base) * 100) : null,
  }));
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
