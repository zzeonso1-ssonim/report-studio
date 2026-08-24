"use client";

import {
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { SectorSnapshot } from "@/lib/outlook/types";
import { ChartFrame, LatestValueLabels } from "./chart-tools";

const COLORS = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-3)",
  "var(--series-4)",
];

interface LaborChartSpec {
  id: string;
  title: string;
  description: string;
  unit: "천명" | "%" | "지수";
  source: string;
  basis: string;
  span: 6 | 12;
  reference?: number;
  pendingNote?: string;
  series: { indicatorId: string; label: string }[];
}

const CHARTS: LaborChartSpec[] = [
  {
    id: "employment-total",
    title: "취업자 수 증감",
    description: "최근 3년 · 월별 전년동월 차이",
    unit: "천명",
    source: "국가데이터처 KOSIS",
    basis: "경제활동인구조사 · 전체 취업자",
    span: 6,
    reference: 0,
    series: [{ indicatorId: "kr_employed_total_yoy_delta", label: "전체" }],
  },
  {
    id: "employment-industry",
    title: "산업별 취업자 수 증감",
    description: "최근 3년 · 월별 전년동월 차이",
    unit: "천명",
    source: "국가데이터처 KOSIS",
    basis: "경제활동인구조사 · 한국표준산업분류 11차",
    span: 6,
    reference: 0,
    pendingNote:
      "서비스업은 제조업·건설업과 같은 표에 공식 단일 합계계열이 없어 하위 업종을 임의 합산하지 않았습니다.",
    series: [
      { indicatorId: "kr_employed_manufacturing_yoy_delta", label: "제조업" },
      { indicatorId: "kr_employed_construction_yoy_delta", label: "건설업" },
    ],
  },
  {
    id: "employment-status",
    title: "임금 vs 비임금근로자",
    description: "최근 3년 · 월별 전년동월 차이",
    unit: "천명",
    source: "국가데이터처 KOSIS",
    basis: "경제활동인구조사 · 종사상지위별 취업자",
    span: 6,
    reference: 0,
    series: [
      { indicatorId: "kr_employed_wage_yoy_delta", label: "임금" },
      { indicatorId: "kr_employed_nonwage_yoy_delta", label: "비임금" },
    ],
  },
  {
    id: "wage-status-detail",
    title: "임금근로자 세부 증감",
    description: "최근 3년 · 월별 전년동월 차이",
    unit: "천명",
    source: "국가데이터처 KOSIS",
    basis: "상용·임시·일용근로자",
    span: 6,
    reference: 0,
    series: [
      { indicatorId: "kr_employed_regular_yoy_delta", label: "상용" },
      { indicatorId: "kr_employed_temporary_yoy_delta", label: "임시" },
      { indicatorId: "kr_employed_daily_yoy_delta", label: "일용" },
    ],
  },
  {
    id: "nonwage-status-detail",
    title: "비임금근로자 세부 증감",
    description: "최근 3년 · 월별 전년동월 차이",
    unit: "천명",
    source: "국가데이터처 KOSIS",
    basis: "자영업자·무급가족종사자",
    span: 6,
    reference: 0,
    series: [
      { indicatorId: "kr_employed_self_yoy_delta", label: "자영업자" },
      { indicatorId: "kr_employed_unpaid_family_yoy_delta", label: "무급가족" },
    ],
  },
  {
    id: "sa-rates",
    title: "계절조정 고용률과 참가율",
    description: "최근 3년 · 월별 수준",
    unit: "%",
    source: "국가데이터처 KOSIS",
    basis: "계절조정 경제활동인구조사",
    span: 6,
    series: [
      { indicatorId: "kr_sa_employment_rate", label: "고용률" },
      { indicatorId: "kr_sa_labor_force_participation", label: "경제활동참가율" },
    ],
  },
  {
    id: "wage-growth",
    title: "임금상승률",
    description: "최근 5년 · 월별 전년동월대비",
    unit: "%",
    source: "고용노동부 KOSIS",
    basis: "사업체노동력조사 · 산업분류 개편 전후 표 연결",
    span: 12,
    reference: 0,
    series: [
      { indicatorId: "kr_wage_total_yoy", label: "전체" },
      { indicatorId: "kr_wage_regular_yoy", label: "상용" },
      { indicatorId: "kr_wage_temporary_daily_yoy", label: "임시일용" },
    ],
  },
  {
    id: "labor-csi",
    title: "임금수준전망 vs 취업기회전망",
    description: "최근 5년 · 월별 CSI 수준",
    unit: "지수",
    source: "한국은행 ECOS",
    basis: "소비자동향조사 · 전체 응답자 · 100 기준",
    span: 12,
    reference: 100,
    series: [
      { indicatorId: "kr_wage_outlook_csi", label: "임금수준전망" },
      { indicatorId: "kr_job_opportunity_csi", label: "취업기회전망" },
    ],
  },
];

function rowsFor(snapshot: SectorSnapshot, spec: LaborChartSpec) {
  const byDate = new Map<string, Record<string, string | number>>();
  for (const series of spec.series) {
    const result = snapshot.sourceResults.find(
      (item) => item.indicatorId === series.indicatorId
    );
    for (const point of result?.points ?? []) {
      if (point.value == null) continue;
      const row = byDate.get(point.date) ?? { date: point.date };
      row[series.indicatorId] = point.value;
      byDate.set(point.date, row);
    }
  }
  return [...byDate.values()].sort((a, b) =>
    String(a.date).localeCompare(String(b.date))
  );
}

function latestObservedAt(snapshot: SectorSnapshot, spec: LaborChartSpec) {
  return spec.series.reduce<string | null>((latest, series) => {
    const observedAt = snapshot.sourceResults.find(
      (item) => item.indicatorId === series.indicatorId
    )?.lastObservedAt;
    return observedAt && (!latest || observedAt > latest) ? observedAt : latest;
  }, null);
}

function formatValue(value: number, unit: LaborChartSpec["unit"]): string {
  const formatted = new Intl.NumberFormat("ko-KR", {
    maximumFractionDigits: 1,
  }).format(value);
  return `${formatted}${unit === "지수" ? "" : unit}`;
}

export default function LaborDashboard({ snapshot }: { snapshot: SectorSnapshot }) {
  return (
    <section className="outlook-growth-dashboard" aria-labelledby="labor-charts-heading">
      <div className="outlook-growth-heading">
        <div>
          <p className="outlook-eyebrow">LABOR MARKET MONITOR</p>
          <h2 id="labor-charts-heading">노동시장 지표</h2>
        </div>
        <p>8개 차트 · 17개 계열 · 서비스업 합계 연결 대기</p>
      </div>

      <div className="outlook-growth-grid">
        {CHARTS.map((spec) => {
          const rows = rowsFor(snapshot, spec);
          const results = spec.series.map((series) =>
            snapshot.sourceResults.find(
              (item) => item.indicatorId === series.indicatorId
            )
          );
          const errors = results.filter((result) => result?.status === "error");
          const observedAt = latestObservedAt(snapshot, spec);

          return (
            <article
              key={spec.id}
              className={`outlook-growth-chart outlook-trade-chart-${spec.span}`}
            >
              <header>
                <div>
                  <h3>{spec.title}</h3>
                  <p>{spec.description}</p>
                </div>
                <span>단위 {spec.unit}</span>
              </header>

              {rows.length > 0 ? (
                <ChartFrame title={spec.title} chartId={`labor-${spec.id}`} rows={rows} series={spec.series.map((series, index) => ({ key: series.indicatorId, label: series.label, unit: spec.unit, color: COLORS[index % COLORS.length] }))}>
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart
                      data={rows}
                      margin={{ top: 24, right: 12, bottom: 4, left: 0 }}
                    >
                      <CartesianGrid stroke="var(--grid)" vertical={false} />
                      <XAxis
                        dataKey="date"
                        tick={{ fill: "var(--axis)", fontSize: 11 }}
                        tickLine={false}
                        axisLine={{ stroke: "var(--grid)" }}
                        minTickGap={28}
                        tickFormatter={(value) =>
                          String(value).replace(/^(\d{2})(\d{2})-(\d{2})$/, "$2.$3")
                        }
                      />
                      <YAxis
                        tick={{ fill: "var(--axis)", fontSize: 11 }}
                        tickLine={false}
                        axisLine={false}
                        width={52}
                        domain={spec.reference === 0 ? [(min: number) => Math.min(0, min), (max: number) => Math.max(0, max)] : ["auto", "auto"]}
                        tickFormatter={(value) =>
                          new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 }).format(Number(value))
                        }
                      />
                      <Tooltip
                        contentStyle={{
                          background: "var(--surface)",
                          border: "1px solid var(--border)",
                          borderRadius: 8,
                          color: "var(--foreground)",
                          fontSize: 12,
                        }}
                        formatter={(value) =>
                          typeof value === "number" ? formatValue(value, spec.unit) : "—"
                        }
                      />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      {spec.reference != null && (
                        <ReferenceLine
                          y={spec.reference}
                          stroke="var(--axis)"
                          strokeDasharray="3 3"
                        />
                      )}
                      {spec.series.map((series, index) => (
                        <Line
                          key={series.indicatorId}
                          type="linear"
                          dataKey={series.indicatorId}
                          name={series.label}
                          stroke={COLORS[index % COLORS.length]}
                          strokeWidth={2}
                          strokeDasharray={index === 1 ? "6 3" : index === 2 ? "2 3" : undefined}
                          dot={false}
                          connectNulls={false}
                          isAnimationActive={false}
                        />
                      ))}
                      <LatestValueLabels rows={rows} series={spec.series.map((series, index) => ({ key: series.indicatorId, label: series.label, unit: spec.unit, color: COLORS[index % COLORS.length] }))} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </ChartFrame>
              ) : (
                <div className="outlook-growth-chart-empty">
                  노동시장 섹터의 데이터 업데이트를 실행하면 차트가 표시됩니다.
                </div>
              )}

              {spec.pendingNote && (
                <p className="outlook-definition-note">{spec.pendingNote}</p>
              )}
              {errors.map((result) => (
                <p key={result!.indicatorId} className="outlook-error">
                  ⚠ {result!.probeName}: {result!.error}
                </p>
              ))}
              <footer>
                출처 {spec.source} · 기준월 {observedAt ?? "업데이트 대기"} · {spec.basis}
              </footer>
            </article>
          );
        })}
      </div>
    </section>
  );
}
