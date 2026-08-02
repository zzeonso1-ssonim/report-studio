import { Cycle } from "./indicators";
import { SeriesPoint } from "./sources/types";

/**
 * 사용자가 고르는 변환은 raw/yoy/pop/rebase 4종이지만, 금리처럼 수준 자체가
 * %인 지표(kind=rate)에 비율 yoy를 걸면 "+130%" 같은 무의미한 값이 나온다.
 * 그래서 서버가 지표 성격에 따라 yoy→yoy_diff(전년동기대비 차, %p),
 * pop→pop_diff로 자동 대체한다 — 요청 스키마는 4종 그대로, 대체는 코드가.
 */
export type Transform = "raw" | "yoy" | "pop" | "rebase" | "yoy_diff" | "pop_diff";

/** 요청(입력)으로 허용하는 변환 — 라우트 검증의 단일 소스 */
export const REQUEST_TRANSFORMS = ["raw", "yoy", "pop", "rebase"] as const;

export const transformLabels: Record<Transform, string> = {
  raw: "원계열",
  yoy: "전년동기대비 (%)",
  pop: "전기대비 (%)",
  rebase: "재기준화 (시작=100)",
  yoy_diff: "전년동기대비 차 (%p)",
  pop_diff: "전기대비 차 (%p)",
};

const periodsPerYear: Record<Cycle, number | null> = { D: null, M: 12, Q: 4, A: 1 };

/**
 * 단위가 이미 변화율인 시리즈 판정 — FRED 등이 "% Chg. from Yr. Ago" 같은
 * 전년비·전기비 시리즈를 직수록하는데, 여기에 yoy/pop을 다시 걸면
 * 변화율의 변화율이라는 무의미한 숫자가 나온다(이중 변환). 그 가드의 단일 소스.
 */
export function isRateUnit(unit: string | undefined): boolean {
  if (!unit) return false;
  return /%\s*chg|percent change|rate of change|전년\s*(동기)?\s*대비|전기\s*대비/i.test(unit);
}

/** 이중 변환을 막고 원계열로 강등했을 때 사용자에게 보여줄 안내문 */
export function rateUnitNote(name: string, unit: string): string {
  return `"${name}"은(는) 이미 변화율 단위(${unit})라 변환 없이 원계열로 표시합니다`;
}

export function applyTransform(
  points: SeriesPoint[],
  transform: Transform,
  cycle: Cycle
): SeriesPoint[] {
  switch (transform) {
    case "raw":
      return points;
    case "yoy":
      return yearShift(points, cycle, pctChange);
    case "yoy_diff":
      return yearShift(points, cycle, diff);
    case "pop":
      return shiftBy(points, 1, pctChange);
    case "pop_diff":
      return shiftBy(points, 1, diff);
    case "rebase":
      return rebase(points);
  }
}

type Combine = (cur: number, prev: number) => number | null;

const pctChange: Combine = (cur, prev) => (prev !== 0 ? round4((cur / prev - 1) * 100) : null);
const diff: Combine = (cur, prev) => round4(cur - prev);

/** 1년 전 값과 결합 — 일간은 1년 전 같은 날짜 조회(휴일 등으로 없으면 null) */
function yearShift(points: SeriesPoint[], cycle: Cycle, combine: Combine): SeriesPoint[] {
  const k = periodsPerYear[cycle];
  if (k === null) {
    const byDate = new Map(points.map((p) => [p.date, p.value]));
    return points.map((p) => {
      const prevDate = `${Number(p.date.slice(0, 4)) - 1}${p.date.slice(4)}`;
      const prev = byDate.get(prevDate);
      return {
        date: p.date,
        value: p.value != null && prev != null ? combine(p.value, prev) : null,
      };
    });
  }
  return shiftBy(points, k, combine);
}

/** k기 전 값과 결합 */
function shiftBy(points: SeriesPoint[], k: number, combine: Combine): SeriesPoint[] {
  return points.map((p, i) => {
    const prev = i >= k ? points[i - k].value : null;
    return {
      date: p.date,
      value: p.value != null && prev != null ? combine(p.value, prev) : null,
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
