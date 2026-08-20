"use client";

import {
  Bar,
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

const COLORS = ["var(--series-1)", "var(--series-2)", "var(--series-3)"];

interface ChartSpec {
  id: string;
  title: string;
  description: string;
  type: "bar" | "line";
  wide?: boolean;
  series: { indicatorId: string; label: string }[];
}

const CHARTS: ChartSpec[] = [
  {
    id: "gdp-qoq",
    title: "경제성장률 — 전기대비",
    description: "최근 2년 · 계절조정 실질 GDP",
    type: "bar",
    series: [{ indicatorId: "kr_real_gdp_qoq", label: "전기대비" }],
  },
  {
    id: "gdp-yoy",
    title: "경제성장률 — 전년동기대비",
    description: "최근 2년 · 실질 GDP",
    type: "bar",
    series: [{ indicatorId: "kr_real_gdp_yoy", label: "전년동기대비" }],
  },
  {
    id: "production-yoy",
    title: "경제활동별 생산 증가율",
    description: "최근 3년 · 분기 전년동기대비",
    type: "line",
    wide: true,
    series: [
      { indicatorId: "kr_manufacturing_gdp_yoy", label: "제조업" },
      { indicatorId: "kr_services_gdp_yoy", label: "서비스업" },
      { indicatorId: "kr_construction_gdp_yoy", label: "건설업" },
    ],
  },
  {
    id: "consumption-yoy",
    title: "민간소비 vs 정부소비",
    description: "최근 3년 · 분기 전년동기대비",
    type: "line",
    series: [
      { indicatorId: "kr_private_consumption_yoy", label: "민간소비" },
      { indicatorId: "kr_government_consumption_yoy", label: "정부소비" },
    ],
  },
  {
    id: "investment-yoy",
    title: "설비투자 vs 건설투자",
    description: "최근 3년 · 분기 전년동기대비",
    type: "line",
    series: [
      { indicatorId: "kr_equipment_investment_yoy", label: "설비투자" },
      { indicatorId: "kr_construction_investment_yoy", label: "건설투자" },
    ],
  },
];

function rowsFor(snapshot: SectorSnapshot, spec: ChartSpec) {
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

function latestObservedAt(snapshot: SectorSnapshot, spec: ChartSpec): string | null {
  return spec.series.reduce<string | null>((latest, series) => {
    const observedAt = snapshot.sourceResults.find(
      (item) => item.indicatorId === series.indicatorId
    )?.lastObservedAt;
    return observedAt && (!latest || observedAt > latest) ? observedAt : latest;
  }, null);
}

export default function GrowthDashboard({ snapshot }: { snapshot: SectorSnapshot }) {
  return (
    <section className="outlook-growth-dashboard" aria-labelledby="growth-charts-heading">
      <div className="outlook-growth-heading">
        <div>
          <p className="outlook-eyebrow">GROWTH MONITOR</p>
          <h2 id="growth-charts-heading">성장 지표</h2>
        </div>
        <p>한국은행 공식 증가율 · 분기</p>
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
              className={`outlook-growth-chart${spec.wide ? " outlook-growth-chart-wide" : ""}`}
            >
              <header>
                <div>
                  <h3>{spec.title}</h3>
                  <p>{spec.description}</p>
                </div>
                <span>단위 %</span>
              </header>

              {rows.length > 0 ? (
                <div className="outlook-growth-chart-canvas">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart
                      data={rows}
                      margin={{ top: 8, right: 12, bottom: 4, left: 0 }}
                    >
                      <CartesianGrid stroke="var(--grid)" vertical={false} />
                      <XAxis
                        dataKey="date"
                        tick={{ fill: "var(--axis)", fontSize: 11 }}
                        tickLine={false}
                        axisLine={{ stroke: "var(--grid)" }}
                        minTickGap={28}
                        tickFormatter={(value) =>
                          String(value).replace(/^\d{2}(\d{2})-Q/, "$1Q")
                        }
                      />
                      <YAxis
                        tick={{ fill: "var(--axis)", fontSize: 11 }}
                        tickLine={false}
                        axisLine={false}
                        width={46}
                        domain={[
                          (dataMin: number) => Math.min(0, dataMin),
                          (dataMax: number) => Math.max(0, dataMax),
                        ]}
                        tickFormatter={(value) => `${Number(value).toFixed(1)}%`}
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
                          typeof value === "number" ? `${value.toFixed(1)}%` : "—"
                        }
                      />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <ReferenceLine y={0} stroke="var(--axis)" strokeDasharray="3 3" />
                      {spec.series.map((series, index) =>
                        spec.type === "bar" ? (
                          <Bar
                            key={series.indicatorId}
                            dataKey={series.indicatorId}
                            name={series.label}
                            fill={COLORS[index % COLORS.length]}
                            maxBarSize={30}
                            isAnimationActive={false}
                          />
                        ) : (
                          <Line
                            key={series.indicatorId}
                            type="linear"
                            dataKey={series.indicatorId}
                            name={series.label}
                            stroke={COLORS[index % COLORS.length]}
                            strokeWidth={2}
                            strokeDasharray={
                              index === 1 ? "6 3" : index === 2 ? "2 3" : undefined
                            }
                            dot={false}
                            connectNulls={false}
                            isAnimationActive={false}
                          />
                        )
                      )}
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="outlook-growth-chart-empty">
                  성장 섹터의 데이터 업데이트를 실행하면 차트가 표시됩니다.
                </div>
              )}

              {errors.map((result) => (
                <p key={result!.indicatorId} className="outlook-error">
                  ⚠ {result!.probeName}: {result!.error}
                </p>
              ))}
              <footer>
                출처 한국은행 ECOS · 기준일 {observedAt ?? "업데이트 대기"}
              </footer>
            </article>
          );
        })}
      </div>
    </section>
  );
}
