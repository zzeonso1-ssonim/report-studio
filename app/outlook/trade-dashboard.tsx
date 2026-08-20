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

const COLORS = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-3)",
  "var(--series-4)",
];

interface SeriesSpec {
  indicatorId: string;
  label: string;
  render?: "bar" | "line";
  axis?: "left" | "right";
}

interface ChartSpec {
  id: string;
  title: string;
  description: string;
  unit: string;
  source: string;
  amount?: boolean;
  span: 4 | 6 | 8 | 12;
  pendingReason?: string;
  series: SeriesSpec[];
}

const CHARTS: ChartSpec[] = [
  {
    id: "trade-amount",
    title: "전체 수출·수입과 무역수지",
    description: "최근 3년 · 월별 통관 기준",
    unit: "억달러",
    source: "관세청 · 한국은행 ECOS 수록",
    amount: true,
    span: 8,
    series: [
      { indicatorId: "kr_customs_export_amount", label: "수출", render: "bar" },
      { indicatorId: "kr_customs_import_amount", label: "수입", render: "bar" },
      {
        indicatorId: "kr_customs_trade_balance",
        label: "무역수지",
        render: "line",
        axis: "right",
      },
    ],
  },
  {
    id: "daily-average-export-yoy",
    title: "일평균 수출금액 증가율",
    description: "관세청 공식 게시판 가용구간 · 월별 전년동월대비",
    unit: "%",
    source: "관세청 월간 수출입 현황 [잠정치]",
    span: 4,
    series: [
      { indicatorId: "kr_daily_average_export_yoy", label: "일평균 수출" },
    ],
  },
  {
    id: "trade-yoy",
    title: "수출·수입 증가율",
    description: "최근 3년 · 월별 전년동월대비",
    unit: "%",
    source: "관세청 · 한국은행 ECOS 수록",
    span: 6,
    series: [
      { indicatorId: "kr_customs_export_yoy", label: "수출" },
      { indicatorId: "kr_customs_import_yoy", label: "수입" },
    ],
  },
  {
    id: "export-index-yoy",
    title: "전체 수출물량지수 vs 수출금액지수",
    description: "최근 3년 · 월별 전년동월대비",
    unit: "%",
    source: "한국은행 ECOS",
    span: 6,
    series: [
      { indicatorId: "kr_export_value_idx_yoy", label: "수출금액지수" },
      { indicatorId: "kr_export_volume_idx_yoy", label: "수출물량지수" },
    ],
  },
  {
    id: "export-index-mom",
    title: "전체 수출물량지수 vs 수출금액지수",
    description: "최근 3년 · 월별 전월대비",
    unit: "%",
    source: "한국은행 ECOS",
    span: 6,
    series: [
      { indicatorId: "kr_export_value_idx_mom", label: "수출금액지수" },
      { indicatorId: "kr_export_volume_idx_mom", label: "수출물량지수" },
    ],
  },
  {
    id: "semiconductor-index-yoy",
    title: "반도체 수출물량지수 vs 수출금액지수",
    description: "최근 3년 · 월별 전년동월대비",
    unit: "%",
    source: "한국은행 ECOS",
    span: 6,
    series: [
      { indicatorId: "kr_semiconductor_export_value_idx_yoy", label: "수출금액지수" },
      { indicatorId: "kr_semiconductor_export_volume_idx_yoy", label: "수출물량지수" },
    ],
  },
  {
    id: "regional-export-yoy",
    title: "주요 수출국 상위 4개 · 전년동월비",
    description: "최근 3년 · 최신 12개월 누적 수출금액 기준 상위 4개국 고정",
    unit: "%",
    source: "관세청 · 한국은행 ECOS 수록",
    span: 12,
    series: [
      { indicatorId: "kr_export_country_rank1_yoy", label: "1위" },
      { indicatorId: "kr_export_country_rank2_yoy", label: "2위" },
      { indicatorId: "kr_export_country_rank3_yoy", label: "3위" },
      { indicatorId: "kr_export_country_rank4_yoy", label: "4위" },
    ],
  },
];

function rowsFor(snapshot: SectorSnapshot, spec: ChartSpec) {
  const byDate = new Map<string, Record<string, string | number>>();
  for (const series of spec.series) {
    if (series.indicatorId === "kr_customs_trade_balance") continue;
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
  if (spec.id === "trade-amount") {
    for (const row of byDate.values()) {
      const exports = row.kr_customs_export_amount;
      const imports = row.kr_customs_import_amount;
      if (typeof exports === "number" && typeof imports === "number") {
        row.kr_customs_trade_balance = exports - imports;
      }
    }
  }
  return [...byDate.values()].sort((a, b) =>
    String(a.date).localeCompare(String(b.date))
  ).slice(-36);
}

function latestObservedAt(snapshot: SectorSnapshot, spec: ChartSpec): string | null {
  return spec.series.reduce<string | null>((latest, series) => {
    const observedAt = snapshot.sourceResults.find(
      (item) => item.indicatorId === series.indicatorId
    )?.lastObservedAt;
    return observedAt && (!latest || observedAt > latest) ? observedAt : latest;
  }, null);
}

function formatAmount(value: number): string {
  return new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 }).format(value);
}

export default function TradeDashboard({ snapshot }: { snapshot: SectorSnapshot }) {
  return (
    <section className="outlook-growth-dashboard" aria-labelledby="trade-charts-heading">
      <div className="outlook-growth-heading">
        <div>
          <p className="outlook-eyebrow">TRADE MONITOR</p>
          <h2 id="trade-charts-heading">수출입 지표</h2>
        </div>
        <p>6개 연결 · 일평균 수출 공식 API 연결 대기</p>
      </div>

      <div className="outlook-growth-grid">
        {CHARTS.map((spec) => {
          const rows = rowsFor(snapshot, spec);
          const results = spec.series.map((series) =>
            snapshot.sourceResults.find((item) => item.indicatorId === series.indicatorId)
          );
          const errors = results.filter((result) => result?.status === "error");
          const observedAt = latestObservedAt(snapshot, spec);
          const maxTradeBalance = Math.max(
            1,
            ...rows.map((row) => Math.abs(Number(row.kr_customs_trade_balance ?? 0)))
          );

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
                <div className="outlook-growth-chart-canvas">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
                      <CartesianGrid stroke="var(--grid)" vertical={false} />
                      <XAxis
                        dataKey="date"
                        tick={{ fill: "var(--axis)", fontSize: 11 }}
                        tickLine={false}
                        axisLine={{ stroke: "var(--grid)" }}
                        minTickGap={28}
                        tickFormatter={(value) => String(value).replace(/^\d{2}(\d{2})-/, "$1.")}
                      />
                      <YAxis
                        yAxisId="left"
                        tick={{ fill: "var(--axis)", fontSize: 11 }}
                        tickLine={false}
                        axisLine={false}
                        width={52}
                        domain={spec.amount ? [0, "auto"] : [(min: number) => Math.min(0, min), (max: number) => Math.max(0, max)]}
                        tickFormatter={(value) => spec.amount ? formatAmount(Number(value)) : `${Number(value).toFixed(0)}%`}
                      />
                      {spec.amount && (
                        <YAxis
                          yAxisId="right"
                          orientation="right"
                          tick={{ fill: "var(--axis)", fontSize: 11 }}
                          tickLine={false}
                          axisLine={false}
                          width={48}
                          domain={[-maxTradeBalance, maxTradeBalance]}
                          tickFormatter={(value) => formatAmount(Number(value))}
                        />
                      )}
                      <Tooltip
                        contentStyle={{
                          background: "var(--surface)",
                          border: "1px solid var(--border)",
                          borderRadius: 8,
                          color: "var(--foreground)",
                          fontSize: 12,
                        }}
                        formatter={(value) => typeof value === "number"
                          ? `${spec.amount ? formatAmount(value) : value.toFixed(1)}${spec.amount ? "억달러" : "%"}`
                          : "—"}
                      />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      {!spec.amount && <ReferenceLine yAxisId="left" y={0} stroke="var(--axis)" strokeDasharray="3 3" />}
                      {spec.amount && <ReferenceLine yAxisId="right" y={0} stroke="var(--axis)" strokeDasharray="3 3" />}
                      {spec.series.map((series, index) =>
                        series.render === "bar" ? (
                          <Bar
                            key={series.indicatorId}
                            yAxisId={series.axis ?? "left"}
                            dataKey={series.indicatorId}
                            name={series.label}
                            fill={COLORS[index % COLORS.length]}
                            maxBarSize={18}
                            isAnimationActive={false}
                          />
                        ) : (
                          <Line
                            key={series.indicatorId}
                            yAxisId={series.axis ?? "left"}
                            type="linear"
                            dataKey={series.indicatorId}
                            name={
                              spec.id === "regional-export-yoy"
                                ? results[index]?.probeName ?? series.label
                                : series.label
                            }
                            stroke={COLORS[index % COLORS.length]}
                            strokeWidth={2}
                            strokeDasharray={
                              spec.amount
                                ? undefined
                                : index === 1
                                  ? "6 3"
                                  : index === 2
                                    ? "2 3"
                                    : index === 3
                                      ? "8 3 2 3"
                                      : undefined
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
                  {spec.pendingReason ?? "수출입 섹터의 데이터 업데이트를 실행하면 차트가 표시됩니다."}
                </div>
              )}

              {errors.map((result) => (
                <p key={result!.indicatorId} className="outlook-error">
                  ⚠ {result!.probeName}: {result!.error}
                </p>
              ))}
              <footer>
                출처 {spec.source} · 기준일 {observedAt ?? "업데이트 대기"}
                {spec.id === "trade-amount" ? " · 무역수지=수출-수입" : ""}
              </footer>
            </article>
          );
        })}
      </div>
    </section>
  );
}
