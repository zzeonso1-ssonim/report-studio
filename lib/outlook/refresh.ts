import { indicators } from "@/lib/indicators";
import { sources } from "@/lib/sources";
import { getSectorManifest } from "./sector-manifest";
import { beginSectorRefresh, finishSectorRefresh } from "./store";
import type {
  SectorId,
  SectorObservation,
  SectorSnapshot,
  SectorSourceResult,
} from "./types";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function yearsAgo(years = 6): string {
  const date = new Date();
  // 5년치 전년비 60개를 만들려면 비교 기준월 12개를 앞서 받아야 한다.
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return date.toISOString().slice(0, 10);
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/환경변수가 설정되지 않았습니다/.test(message)) return message;
  if (/HTTP \d{3}|^\[(?:kcs|mpb|motir)\]/i.test(message)) return message;
  return "API 호출에 실패했습니다";
}

function previousMonth(date: string): string {
  const [year, month] = date.split("-").map(Number);
  const previous = new Date(Date.UTC(year, month - 2, 1));
  return `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, "0")}`;
}

function transformPoints(
  points: SectorObservation[],
  transform: "yoy" | "yoy_delta" | "mom" | undefined
): SectorObservation[] {
  if (!transform) return points;
  const values = new Map(points.map((point) => [point.date, point.value]));
  return points.flatMap((point) => {
    const priorDate = transform === "yoy" || transform === "yoy_delta"
      ? `${Number(point.date.slice(0, 4)) - 1}${point.date.slice(4)}`
      : previousMonth(point.date);
    const prior = values.get(priorDate);
    if (point.value == null || prior == null) return [];
    if (transform === "yoy_delta") {
      return [{ date: point.date, value: Math.round((point.value - prior) * 10) / 10 }];
    }
    if (prior === 0) return [];
    return [{ date: point.date, value: ((point.value / prior) - 1) * 100 }];
  });
}

/** 직전 2개 연말과 가장 최신의 공통 기준월만 분자/분모 비중으로 저장한다. */
function shareSnapshots(
  points: SectorObservation[],
  denominatorPoints: SectorObservation[]
): SectorObservation[] {
  const numerator = new Map(
    points.filter((point) => point.value != null).map((point) => [point.date, point.value!])
  );
  const denominator = new Map(
    denominatorPoints
      .filter((point) => point.value != null)
      .map((point) => [point.date, point.value!])
  );
  const commonDates = [...numerator.keys()]
    .filter((date) => denominator.has(date))
    .sort();
  const latest = commonDates.at(-1);
  if (!latest) return [];
  const latestYear = Number(latest.slice(0, 4));
  const targetDates = [
    `${latestYear - 2}-12`,
    `${latestYear - 1}-12`,
    latest,
  ];
  return [...new Set(targetDates)].flatMap((date) => {
    const value = numerator.get(date);
    const base = denominator.get(date);
    if (value == null || base == null || base === 0) return [];
    return [{ date, value: (value / base) * 100 }];
  });
}

/** 각 연도 12월과 아직 연말이 아닌 최신월만 선택한다. */
function yearEndAndLatest(points: SectorObservation[]): SectorObservation[] {
  const observed = points
    .filter((point) => point.value != null)
    .sort((a, b) => a.date.localeCompare(b.date));
  const latest = observed.at(-1);
  if (!latest) return [];
  return observed.filter(
    (point) => point.date.endsWith("-12") || point.date === latest.date
  );
}

function quarterIndex(date: string): number | null {
  const match = /^(\d{4})-Q([1-4])$/.exec(date);
  return match ? Number(match[1]) * 4 + Number(match[2]) - 1 : null;
}

/** 월 원자료는 세 달이 모두 존재하는 완결 분기만 합산한다. */
function quarterlySums(points: SectorObservation[]): SectorObservation[] {
  const groups = new Map<string, Map<number, number>>();
  for (const point of points) {
    const match = /^(\d{4})-(\d{2})$/.exec(point.date);
    if (!match || point.value == null) continue;
    const month = Number(match[2]);
    if (month < 1 || month > 12) continue;
    const quarter = Math.ceil(month / 3);
    const key = `${match[1]}-Q${quarter}`;
    const months = groups.get(key) ?? new Map<number, number>();
    months.set(month, point.value);
    groups.set(key, months);
  }
  return [...groups.entries()]
    .filter(([, months]) => months.size === 3)
    .map(([date, months]) => ({
      date,
      value: [...months.values()].reduce((sum, value) => sum + value, 0),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function quarterlyYoy(points: SectorObservation[]): SectorObservation[] {
  const values = new Map(points.map((point) => [quarterIndex(point.date), point.value]));
  return points.flatMap((point) => {
    const index = quarterIndex(point.date);
    const prior = index == null ? undefined : values.get(index - 4);
    if (index == null || point.value == null || prior == null || prior === 0) return [];
    return [{ date: point.date, value: ((point.value / prior) - 1) * 100 }];
  });
}

/** 결측 분기를 건너뛰지 않고, 연속된 완결 분기만 이동평균으로 계산한다. */
function quarterlyMovingAverage(
  points: SectorObservation[],
  window: number
): SectorObservation[] {
  const sorted = points
    .filter((point) => point.value != null && quarterIndex(point.date) != null)
    .sort((a, b) => a.date.localeCompare(b.date));
  const result: SectorObservation[] = [];
  for (let end = window - 1; end < sorted.length; end++) {
    const slice = sorted.slice(end - window + 1, end + 1);
    const indexes = slice.map((point) => quarterIndex(point.date)!);
    if (!indexes.every((index, offset) => offset === 0 || index === indexes[offset - 1] + 1)) {
      continue;
    }
    result.push({
      date: slice.at(-1)!.date,
      value: slice.reduce((sum, point) => sum + point.value!, 0) / window,
    });
  }
  return result;
}

function monthlyCumulativeToFlows(points: SectorObservation[]): SectorObservation[] {
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  const values = new Map(sorted.map((point) => [point.date, point.value]));
  return sorted.flatMap((point) => {
    const match = /^(\d{4})-(\d{2})$/.exec(point.date);
    if (!match || point.value == null) return [];
    const month = Number(match[2]);
    if (month === 1) return [{ date: point.date, value: point.value }];
    const prior = values.get(`${match[1]}-${String(month - 1).padStart(2, "0")}`);
    if (prior == null) return [];
    return [{ date: point.date, value: point.value - prior }];
  });
}

type ConstructionTransform =
  | "quarterly_sum_yoy"
  | "quarterly_sum_6q_ma_yoy"
  | "quarterly_sum_4q_ma_yoy"
  | "quarterly_ratio_yoy"
  | "cumulative_to_quarterly_sum_4q_ma_yoy";

function transformConstructionPoints(
  points: SectorObservation[],
  transform: ConstructionTransform,
  denominatorPoints?: SectorObservation[]
): SectorObservation[] {
  if (transform === "quarterly_ratio_yoy") {
    const numerator = quarterlySums(points);
    const denominator = new Map(
      quarterlySums(denominatorPoints ?? []).map((point) => [point.date, point.value])
    );
    return quarterlyYoy(numerator.flatMap((point) => {
      const base = denominator.get(point.date);
      if (point.value == null || base == null || base === 0) return [];
      return [{ date: point.date, value: (point.value / base) * 100 }];
    }));
  }

  const monthly = transform === "cumulative_to_quarterly_sum_4q_ma_yoy"
    ? monthlyCumulativeToFlows(points)
    : points;
  const quarters = quarterlySums(monthly);
  if (transform === "quarterly_sum_yoy") return quarterlyYoy(quarters);
  const window = transform === "quarterly_sum_6q_ma_yoy" ? 6 : 4;
  return quarterlyYoy(quarterlyMovingAverage(quarters, window));
}

function topFourCountryResults(
  points: SectorObservation[],
  sourceLabel: SectorSourceResult["sourceLabel"]
): SectorSourceResult[] {
  const byCountry = new Map<string, { name: string; points: SectorObservation[] }>();
  for (const point of points) {
    if (!point.dimensionCode || point.value == null) continue;
    const country = byCountry.get(point.dimensionCode) ?? {
      name: point.dimensionName ?? point.dimensionCode,
      points: [],
    };
    country.points.push(point);
    byCountry.set(point.dimensionCode, country);
  }
  const allDates = [...new Set(points.map((point) => point.date))].sort();
  const latestDate = allDates.at(-1);
  if (!latestDate || byCountry.size < 4) {
    throw new Error("주요국별 수출 표에서 상위 4개국을 산정할 수 없습니다");
  }
  const rankingDates = new Set(allDates.slice(-12));
  const ranking = [...byCountry.entries()]
    .filter(([, country]) => country.points.some((point) => point.date === latestDate))
    .map(([code, country]) => ({
      code,
      ...country,
      total: country.points.reduce(
        (sum, point) => sum + (rankingDates.has(point.date) && point.value != null ? point.value : 0),
        0
      ),
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 4);

  return ranking.map((country, index) => {
    const transformed = transformPoints(
      [...country.points].sort((a, b) => a.date.localeCompare(b.date)),
      "yoy"
    ).slice(-36);
    return {
      indicatorId: `kr_export_country_rank${index + 1}_yoy`,
      probeName: country.name,
      sourceLabel,
      lastObservedAt: transformed.at(-1)?.date ?? null,
      status: "success",
      error: null,
      points: transformed,
    };
  });
}

/**
 * 지정 섹터의 기술 프로브만 갱신한다. 전체 섹터를 순회하는 함수는 두지 않는다.
 * API 키는 기존 서버 어댑터에서만 읽으며 응답에는 키나 원본 요청 URL을 싣지 않는다.
 */
export async function refreshSector(id: SectorId): Promise<SectorSnapshot> {
  const manifest = getSectorManifest(id);
  if (!manifest.probes.length) {
    throw new Error("지표 구성 대기: 이 섹터에는 아직 데이터 프로브가 없습니다");
  }

  await beginSectorRefresh(id);
  const rawSeriesCache = new Map<string, Promise<SectorObservation[]>>();
  const resultGroups = await Promise.all(
    manifest.probes.map(async (probe): Promise<SectorSourceResult[]> => {
      const indicator = indicators.find((item) => item.id === probe.indicatorId);
      if (!indicator || !indicator.verified || indicator.source !== probe.source) {
        return [{
          indicatorId: probe.indicatorId,
          probeName: probe.description,
          sourceLabel: probe.sourceLabel,
          lastObservedAt: null,
          status: "error",
          error: "섹터 원장과 검증 지표 원장이 일치하지 않습니다",
          points: [],
        }];
      }

      try {
        let rawSeries = rawSeriesCache.get(indicator.id);
        if (!rawSeries) {
          rawSeries = sources[indicator.source]
            .fetchSeries(indicator.params, { start: yearsAgo(probe.lookbackYears), end: today() })
            .then((points) => points.map((point) => ({
              ...point,
              value:
                point.value != null && indicator.divideBy
                  ? point.value / indicator.divideBy
                  : point.value,
            })));
          rawSeriesCache.set(indicator.id, rawSeries);
        }
        let fetchedPoints = await rawSeries;
        if (probe.stitchIndicatorId) {
          const historyIndicator = indicators.find(
            (item) => item.id === probe.stitchIndicatorId
          );
          if (
            !historyIndicator ||
            !historyIndicator.verified ||
            historyIndicator.source !== probe.source
          ) {
            throw new Error("과거 연결 계열이 검증 지표 원장과 일치하지 않습니다");
          }
          let historySeries = rawSeriesCache.get(historyIndicator.id);
          if (!historySeries) {
            historySeries = sources[historyIndicator.source]
              .fetchSeries(historyIndicator.params, {
                start: yearsAgo(probe.lookbackYears),
                end: today(),
              })
              .then((points) => points.map((point) => ({
                ...point,
                value:
                  point.value != null && historyIndicator.divideBy
                    ? point.value / historyIndicator.divideBy
                    : point.value,
              })));
            rawSeriesCache.set(historyIndicator.id, historySeries);
          }
          const historyPoints = await historySeries;
          const stitched = new Map(
            historyPoints.map((point) => [point.date, point] as const)
          );
          // 같은 월이 겹치면 최신 분류의 현행 표를 우선한다.
          for (const point of fetchedPoints) stitched.set(point.date, point);
          fetchedPoints = [...stitched.values()].sort((a, b) =>
            a.date.localeCompare(b.date)
          );
        }
        if (probe.transform === "top4_yoy") {
          return topFourCountryResults(fetchedPoints, probe.sourceLabel);
        }
        let denominatorPoints: SectorObservation[] | undefined;
        if (probe.denominatorIndicatorId) {
          const denominator = indicators.find(
            (item) => item.id === probe.denominatorIndicatorId
          );
          if (!denominator || !denominator.verified || denominator.source !== probe.source) {
            throw new Error("분모 계열이 검증 지표 원장과 일치하지 않습니다");
          }
          let denominatorSeries = rawSeriesCache.get(denominator.id);
          if (!denominatorSeries) {
            denominatorSeries = sources[denominator.source]
              .fetchSeries(denominator.params, {
                start: yearsAgo(probe.lookbackYears),
                end: today(),
              })
              .then((points) => points.map((point) => ({
                ...point,
                value:
                  point.value != null && denominator.divideBy
                    ? point.value / denominator.divideBy
                    : point.value,
              })));
            rawSeriesCache.set(denominator.id, denominatorSeries);
          }
          denominatorPoints = await denominatorSeries;
        }
        const constructionTransforms = new Set<ConstructionTransform>([
          "quarterly_sum_yoy",
          "quarterly_sum_6q_ma_yoy",
          "quarterly_sum_4q_ma_yoy",
          "quarterly_ratio_yoy",
          "cumulative_to_quarterly_sum_4q_ma_yoy",
        ]);
        const transform = probe.transform;
        const transformedPoints = transform === "share_snapshots"
          ? shareSnapshots(fetchedPoints, denominatorPoints ?? [])
          : transform === "year_end_latest"
            ? yearEndAndLatest(fetchedPoints)
            : transform && constructionTransforms.has(transform as ConstructionTransform)
              ? transformConstructionPoints(
                  fetchedPoints,
                  transform as ConstructionTransform,
                  denominatorPoints
                )
              : transformPoints(fetchedPoints, transform as "yoy" | "yoy_delta" | "mom" | undefined);
        const observedPoints = transformedPoints
          .filter((point) => point.value != null)
          .sort((a, b) => a.date.localeCompare(b.date));
        const storedPoints = probe.observations
          ? observedPoints.slice(-probe.observations)
          : observedPoints;
        const lastObservedAt = storedPoints.reduce<string | null>(
          (latest, point) =>
            point.value != null && (!latest || point.date > latest) ? point.date : latest,
          null
        );
        return [{
          indicatorId: probe.resultIndicatorId ?? indicator.id,
          probeName: probe.description,
          sourceLabel: probe.sourceLabel,
          lastObservedAt,
          status: "success",
          error: null,
          points: storedPoints,
        }];
      } catch (error) {
        return [{
          indicatorId: probe.resultIndicatorId ?? indicator.id,
          probeName: probe.description,
          sourceLabel: probe.sourceLabel,
          lastObservedAt: null,
          status: "error",
          error: safeErrorMessage(error),
          points: [],
        }];
      }
    })
  );
  const sourceResults = resultGroups.flat();

  return finishSectorRefresh(id, { sourceResults });
}
