"use client";

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { SectorSnapshot } from "@/lib/outlook/types";

const COLORS = ["var(--series-1)", "var(--series-2)", "var(--series-3)"];

interface ConstructionChartSpec {
  id: string;
  title: string;
  description: string;
  source: string;
  basis: string;
  span: 6 | 12;
  series: { indicatorId: string; label: string }[];
}

const CHARTS: ConstructionChartSpec[] = [
  {
    id: "investment",
    title: "건설투자 · 건물 · 토목",
    description: "최근 5년 · 분기 전년동기대비",
    source: "한국은행 ECOS",
    basis: "국민계정 공표 증가율",
    span: 6,
    series: [
      { indicatorId: "kr_construction_investment_na_yoy", label: "건설투자" },
      { indicatorId: "kr_building_construction_investment_yoy", label: "건물건설" },
      { indicatorId: "kr_civil_construction_investment_yoy", label: "토목건설" },
    ],
  },
  {
    id: "completed",
    title: "건설기성 · 건축 · 토목",
    description: "최근 5년 · 분기 합계 전년동기대비",
    source: "국가데이터처 KOSIS",
    basis: "월별 불변금액을 완결 분기로 합산",
    span: 6,
    series: [
      { indicatorId: "kr_construction_completed_total_yoy", label: "건설기성" },
      { indicatorId: "kr_construction_completed_building_yoy", label: "건축" },
      { indicatorId: "kr_construction_completed_civil_yoy", label: "토목" },
    ],
  },
  {
    id: "orders-starts",
    title: "건축수주 vs 착공면적",
    description: "최근 5년 · 6분기 이동평균 전년동기대비",
    source: "국가데이터처·국토교통부 KOSIS",
    basis: "월별 값을 분기 합산한 뒤 6분기 이동평균",
    span: 6,
    series: [
      { indicatorId: "kr_building_orders_6q_ma_yoy", label: "건축수주" },
      { indicatorId: "kr_building_start_area_6q_ma_yoy", label: "착공면적" },
    ],
  },
  {
    id: "deflator",
    title: "건설기성 디플레이터",
    description: "최근 5년 · 분기 전년동기대비",
    source: "국가데이터처 KOSIS",
    basis: "경상 기성액 ÷ 불변 기성액 × 100",
    span: 6,
    series: [
      { indicatorId: "kr_construction_completed_deflator_yoy", label: "건설기성 디플레이터" },
    ],
  },
  {
    id: "housing-supply",
    title: "주택 준공 · 인허가 · 착공",
    description: "최근 5년 · 4분기 이동평균 전년동기대비",
    source: "국토교통부 KOSIS·한국은행 ECOS",
    basis: "월별 실적을 분기 합산한 뒤 4분기 이동평균",
    span: 12,
    series: [
      { indicatorId: "kr_housing_completions_4q_ma_yoy", label: "주택준공" },
      { indicatorId: "kr_housing_permits_4q_ma_yoy", label: "주택인허가" },
      { indicatorId: "kr_housing_starts_4q_ma_yoy", label: "주택착공" },
    ],
  },
];

function rowsFor(snapshot: SectorSnapshot, spec: ConstructionChartSpec) {
  const byDate = new Map<string, Record<string, string | number>>();
  for (const series of spec.series) {
    const result = snapshot.sourceResults.find((item) => item.indicatorId === series.indicatorId);
    for (const point of result?.points ?? []) {
      if (point.value == null) continue;
      const row = byDate.get(point.date) ?? { date: point.date };
      row[series.indicatorId] = point.value;
      byDate.set(point.date, row);
    }
  }
  return [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function latestObservedAt(snapshot: SectorSnapshot, spec: ConstructionChartSpec): string | null {
  return spec.series.reduce<string | null>((latest, series) => {
    const observedAt = snapshot.sourceResults.find((item) => item.indicatorId === series.indicatorId)?.lastObservedAt;
    return observedAt && (!latest || observedAt > latest) ? observedAt : latest;
  }, null);
}

export default function ConstructionDashboard({ snapshot }: { snapshot: SectorSnapshot }) {
  return (
    <section className="outlook-growth-dashboard" aria-labelledby="construction-charts-heading">
      <div className="outlook-growth-heading">
        <div>
          <p className="outlook-eyebrow">CONSTRUCTION MONITOR</p>
          <h2 id="construction-charts-heading">건설투자 지표</h2>
        </div>
        <p>5개 차트 · 12개 공식 계열 · 결측 보간 없음</p>
      </div>

      <div className="outlook-growth-grid">
        {CHARTS.map((spec) => {
          const rows = rowsFor(snapshot, spec);
          const results = spec.series.map((series) => snapshot.sourceResults.find((item) => item.indicatorId === series.indicatorId));
          const errors = results.filter((result) => result?.status === "error");
          const observedAt = latestObservedAt(snapshot, spec);

          return (
            <article key={spec.id} className={`outlook-growth-chart outlook-trade-chart-${spec.span}`}>
              <header>
                <div><h3>{spec.title}</h3><p>{spec.description}</p></div>
                <span>단위 %</span>
              </header>

              {rows.length > 0 ? (
                <div className="outlook-growth-chart-canvas">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
                      <CartesianGrid stroke="var(--grid)" vertical={false} />
                      <XAxis
                        dataKey="date"
                        tick={{ fill: "var(--axis)", fontSize: 11 }}
                        tickLine={false}
                        axisLine={{ stroke: "var(--grid)" }}
                        minTickGap={28}
                        tickFormatter={(value) => String(value).replace(/^(\d{2})(\d{2})-Q/, "$2.Q")}
                      />
                      <YAxis
                        tick={{ fill: "var(--axis)", fontSize: 11 }}
                        tickLine={false}
                        axisLine={false}
                        width={52}
                        domain={[(min: number) => Math.min(0, min), (max: number) => Math.max(0, max)]}
                        tickFormatter={(value) => new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 }).format(Number(value))}
                      />
                      <Tooltip
                        contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--foreground)", fontSize: 12 }}
                        formatter={(value) => typeof value === "number" ? `${value.toFixed(1)}%` : "—"}
                      />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <ReferenceLine y={0} stroke="var(--axis)" strokeDasharray="3 3" />
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
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="outlook-growth-chart-empty">건설투자 섹터의 데이터 업데이트를 실행하면 차트가 표시됩니다.</div>
              )}

              {errors.map((result) => (
                <p key={result!.indicatorId} className="outlook-error">⚠ {result!.probeName}: {result!.error}</p>
              ))}
              <footer>출처 {spec.source} · 기준분기 {observedAt ?? "업데이트 대기"} · {spec.basis}</footer>
            </article>
          );
        })}
      </div>
    </section>
  );
}
