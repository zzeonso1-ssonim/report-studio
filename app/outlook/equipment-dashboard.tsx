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

const COLORS = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-3)",
  "var(--series-4)",
];

interface EquipmentChartSpec {
  id: string;
  title: string;
  description: string;
  unit: "%" | "지수";
  source: string;
  basis: string;
  reference: number;
  span: 6 | 12;
  series: { indicatorId: string; label: string }[];
}

const CHARTS: EquipmentChartSpec[] = [
  {
    id: "national-accounts",
    title: "설비투자 vs 기계류 vs 운송장비",
    description: "최근 5년 · 분기 전년동기대비",
    unit: "%",
    source: "한국은행 ECOS",
    basis: "국민계정 실질 원계열을 전년동기비로 변환",
    reference: 0,
    span: 6,
    series: [
      { indicatorId: "kr_equipment_investment_na_yoy", label: "설비투자" },
      { indicatorId: "kr_machinery_investment_na_yoy", label: "기계류" },
      { indicatorId: "kr_transport_equipment_investment_na_yoy", label: "운송장비" },
    ],
  },
  {
    id: "manufacturing-utilization",
    title: "제조업 평균가동률",
    description: "최근 5년 · 평균가동률 수준의 전년동월 대비 증감률",
    unit: "%",
    source: "국가데이터처 KOSIS",
    basis: "제조업 평균가동률(%) 원계열을 전년동월비로 변환",
    reference: 0,
    span: 6,
    series: [
      { indicatorId: "kr_manufacturing_utilization_rate_yoy", label: "평균가동률 전년비" },
    ],
  },
  {
    id: "semiconductor-equipment",
    title: "반도체 제조용 장비와 설비투자지수",
    description: "최근 5년 · 월별 전년동월대비",
    unit: "%",
    source: "한국무역협회 K-stat / 국가데이터처 KOSIS",
    basis: "K-stat MTI 732 수입금액 · 반도체제조용기계 설비투자지수",
    reference: 0,
    span: 6,
    series: [
      { indicatorId: "kr_semiconductor_equipment_import_amount_yoy", label: "장비 수입액" },
      { indicatorId: "kr_semiconductor_machinery_investment_index_yoy", label: "설비투자지수" },
    ],
  },
  {
    id: "equipment-bsi",
    title: "설비투자전망 BSI",
    description: "최근 5년 · 월별 수준",
    unit: "지수",
    source: "한국은행 ECOS 기업경기조사",
    basis: "100 초과는 긍정 응답 우위 · 100 미만은 부정 응답 우위",
    reference: 100,
    span: 6,
    series: [
      { indicatorId: "kr_equipment_investment_outlook_bsi_large", label: "대기업" },
      { indicatorId: "kr_equipment_investment_outlook_bsi_manufacturing", label: "제조업" },
      { indicatorId: "kr_equipment_investment_outlook_bsi_sme", label: "중소기업" },
    ],
  },
];

function rowsFor(snapshot: SectorSnapshot, spec: EquipmentChartSpec) {
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

function latestObservedAt(snapshot: SectorSnapshot, spec: EquipmentChartSpec) {
  return spec.series.reduce<string | null>((latest, series) => {
    const observedAt = snapshot.sourceResults.find(
      (item) => item.indicatorId === series.indicatorId
    )?.lastObservedAt;
    return observedAt && (!latest || observedAt > latest) ? observedAt : latest;
  }, null);
}

export default function EquipmentDashboard({ snapshot }: { snapshot: SectorSnapshot }) {
  return (
    <section className="outlook-growth-dashboard" aria-labelledby="equipment-charts-heading">
      <div className="outlook-growth-heading">
        <div>
          <p className="outlook-eyebrow">EQUIPMENT INVESTMENT MONITOR</p>
          <h2 id="equipment-charts-heading">설비투자 지표</h2>
        </div>
        <p>4개 차트 · 9개 공식 계열 연결</p>
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
                          String(value)
                            .replace(/^(\d{4})-Q(\d)$/, "$1 Q$2")
                            .replace(/^(\d{4})-(\d{2})$/, "$2")
                        }
                      />
                      <YAxis
                        tick={{ fill: "var(--axis)", fontSize: 11 }}
                        tickLine={false}
                        axisLine={false}
                        width={52}
                        domain={
                          spec.reference === 0
                            ? [
                                (min: number) => Math.min(0, min),
                                (max: number) => Math.max(0, max),
                              ]
                            : ["auto", "auto"]
                        }
                        tickFormatter={(value) =>
                          new Intl.NumberFormat("ko-KR", {
                            maximumFractionDigits: 0,
                          }).format(Number(value))
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
                          typeof value === "number"
                            ? `${value.toFixed(1)}${spec.unit === "%" ? "%" : ""}`
                            : "—"
                        }
                      />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <ReferenceLine
                        y={spec.reference}
                        stroke="var(--axis)"
                        strokeDasharray="3 3"
                      />
                      {spec.series.map((series, index) => (
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
                      ))}
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="outlook-growth-chart-empty">
                  설비투자 섹터의 데이터 업데이트를 실행하면 차트가 표시됩니다.
                </div>
              )}

              {errors.map((result) => (
                <p key={result!.indicatorId} className="outlook-error">
                  ⚠ {result!.probeName}: {result!.error}
                </p>
              ))}
              <footer>
                출처 {spec.source} · {spec.id === "national-accounts" ? "기준분기" : "기준월"} {observedAt ?? "업데이트 대기"} · {spec.basis}
              </footer>
            </article>
          );
        })}
      </div>
    </section>
  );
}
