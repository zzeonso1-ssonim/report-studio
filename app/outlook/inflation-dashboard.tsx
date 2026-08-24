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

interface InflationChartSpec {
  id: string;
  title: string;
  description: string;
  unit: "%" | "달러/배럴";
  source: string;
  basis: string;
  span: 6 | 12;
  pendingNote?: string;
  series: { indicatorId: string; label: string }[];
}

const CHARTS: InflationChartSpec[] = [
  {
    id: "headline-core",
    title: "헤드라인 vs 근원물가",
    description: "최근 5년 · 월별 전년동월대비",
    unit: "%",
    source: "통계청 KOSIS",
    basis: "근원=식료품 및 에너지 제외지수",
    span: 6,
    series: [
      { indicatorId: "kr_cpi_yoy", label: "헤드라인" },
      { indicatorId: "kr_core_cpi_yoy", label: "근원" },
    ],
  },
  {
    id: "goods-services",
    title: "상품물가 vs 서비스물가",
    description: "최근 5년 · 월별 전년동월대비",
    unit: "%",
    source: "통계청 KOSIS",
    basis: "소비자물가지수 지출목적별 분류",
    span: 6,
    series: [
      { indicatorId: "kr_goods_cpi_yoy", label: "상품" },
      { indicatorId: "kr_services_cpi_yoy", label: "서비스" },
    ],
  },
  {
    id: "export-import-prices",
    title: "수출물가 vs 수입물가",
    description: "최근 5년 · 월별 전년동월대비",
    unit: "%",
    source: "한국은행 ECOS",
    basis: "계약통화가 아닌 원화 기준 지수",
    span: 6,
    series: [
      { indicatorId: "kr_export_price_index_yoy", label: "수출물가" },
      { indicatorId: "kr_import_price_index_yoy", label: "수입물가" },
    ],
  },
  {
    id: "import-prices-fx",
    title: "수입물가 vs 원/달러 환율",
    description: "최근 5년 · 월별 전년동월대비",
    unit: "%",
    source: "한국은행 ECOS",
    basis: "수입물가 원화 기준 · 환율 월평균",
    span: 6,
    series: [
      { indicatorId: "kr_import_price_index_yoy", label: "수입물가" },
      { indicatorId: "kr_usdkrw_monthly_average_yoy", label: "원/달러 환율" },
    ],
  },
  {
    id: "ppi-components",
    title: "생산자물가와 주요 부문",
    description: "최근 5년 · 월별 전년동월대비",
    unit: "%",
    source: "한국은행 ECOS",
    basis: "총지수·공산품·서비스 생산자물가지수",
    span: 12,
    series: [
      { indicatorId: "kr_ppi_total_yoy", label: "PPI" },
      { indicatorId: "kr_ppi_industrial_products_yoy", label: "공산품 PPI" },
      { indicatorId: "kr_ppi_services_yoy", label: "서비스 PPI" },
    ],
  },
  {
    id: "expected-inflation",
    title: "기대인플레이션",
    description: "최근 5년 · 월별 수준",
    unit: "%",
    source: "한국은행 ECOS 소비자동향조사",
    basis: "향후 1년 소비자물가 상승률 전망",
    span: 6,
    series: [{ indicatorId: "kr_expected_inflation", label: "기대인플레이션" }],
  },
  {
    id: "oil-import-cost",
    title: "국제유가 vs 원유도입단가",
    description: "최근 1년 · 월별 수준",
    unit: "달러/배럴",
    source: "한국석유공사·한국은행 ECOS / 산업통상부 수출입 동향",
    basis: "Dubai유 월평균 · 원유도입단가 달러/배럴",
    span: 6,
    series: [
      { indicatorId: "dubai_crude_oil_price", label: "Dubai유" },
      { indicatorId: "kr_crude_import_unit_cost", label: "원유도입단가" },
    ],
  },
];

function rowsFor(snapshot: SectorSnapshot, spec: InflationChartSpec) {
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

function latestObservedAt(snapshot: SectorSnapshot, spec: InflationChartSpec): string | null {
  return spec.series.reduce<string | null>((latest, series) => {
    const observedAt = snapshot.sourceResults.find(
      (item) => item.indicatorId === series.indicatorId
    )?.lastObservedAt;
    return observedAt && (!latest || observedAt > latest) ? observedAt : latest;
  }, null);
}

export default function InflationDashboard({ snapshot }: { snapshot: SectorSnapshot }) {
  return (
    <section className="outlook-growth-dashboard" aria-labelledby="inflation-charts-heading">
      <div className="outlook-growth-heading">
        <div>
          <p className="outlook-eyebrow">INFLATION MONITOR</p>
          <h2 id="inflation-charts-heading">물가 지표</h2>
        </div>
        <p>7개 차트 · 공식 원유도입단가 계열 연결</p>
      </div>

      <div className="outlook-growth-grid">
        {CHARTS.map((spec) => {
          const rows = rowsFor(snapshot, spec);
          const results = spec.series.map((series) =>
            snapshot.sourceResults.find((item) => item.indicatorId === series.indicatorId)
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
                <ChartFrame title={spec.title} chartId={`inflation-${spec.id}`} rows={rows} series={spec.series.map((series, index) => ({ key: series.indicatorId, label: series.label, unit: spec.unit, color: COLORS[index % COLORS.length] }))}>
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={rows} margin={{ top: 24, right: 12, bottom: 4, left: 0 }}>
                      <CartesianGrid stroke="var(--grid)" vertical={false} />
                      <XAxis
                        dataKey="date"
                        tick={{ fill: "var(--axis)", fontSize: 11 }}
                        tickLine={false}
                        axisLine={{ stroke: "var(--grid)" }}
                        minTickGap={28}
                        tickFormatter={(value) => String(value).replace(/^(\d{2})(\d{2})-/, "$2.")}
                      />
                      <YAxis
                        tick={{ fill: "var(--axis)", fontSize: 11 }}
                        tickLine={false}
                        axisLine={false}
                        width={52}
                        domain={spec.unit === "%" ? [(min: number) => Math.min(0, min), (max: number) => Math.max(0, max)] : [0, "auto"]}
                        tickFormatter={(value) => new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 }).format(Number(value))}
                      />
                      <Tooltip
                        contentStyle={{
                          background: "var(--surface)",
                          border: "1px solid var(--border)",
                          borderRadius: 8,
                          color: "var(--foreground)",
                          fontSize: 12,
                        }}
                        formatter={(value) => typeof value === "number"
                          ? `${value.toFixed(1)}${spec.unit === "%" ? "%" : "달러/배럴"}`
                          : "—"}
                      />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      {spec.unit === "%" && <ReferenceLine y={0} stroke="var(--axis)" strokeDasharray="3 3" />}
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
                  물가 섹터의 데이터 업데이트를 실행하면 차트가 표시됩니다.
                </div>
              )}

              {spec.pendingNote && <p className="outlook-definition-note">{spec.pendingNote}</p>}
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
