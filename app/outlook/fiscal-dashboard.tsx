"use client";

import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
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

interface FiscalChartSpec {
  id: string;
  title: string;
  description: string;
  unit: "조원" | "%";
  source: string;
  basis: string;
  span: 4 | 6 | 12;
  pendingReason?: string;
  definitionNote?: string;
  manualRows?: Record<string, string | number>[];
  series: { indicatorId: string; label: string }[];
}

const CHARTS: FiscalChartSpec[] = [
  {
    id: "fiscal-revenue-expenditure",
    title: "총수입·총지출 추이",
    description: "최근 5개 완결 회계연도",
    unit: "조원",
    source: "국회예산정책처 2025회계연도 결산 재정총량 분석",
    basis: "결산 공식표 · 문서 빈티지 2025회계연도",
    span: 6,
    manualRows: [
      { date: "2021", kr_fiscal_total_revenue: 570.5, kr_fiscal_total_expenditure: 601.0 },
      { date: "2022", kr_fiscal_total_revenue: 617.8, kr_fiscal_total_expenditure: 682.4 },
      { date: "2023", kr_fiscal_total_revenue: 573.9, kr_fiscal_total_expenditure: 610.7 },
      { date: "2024", kr_fiscal_total_revenue: 594.5, kr_fiscal_total_expenditure: 638.0 },
      { date: "2025", kr_fiscal_total_revenue: 637.4, kr_fiscal_total_expenditure: 684.1 },
    ],
    series: [
      { indicatorId: "kr_fiscal_total_revenue", label: "총수입" },
      { indicatorId: "kr_fiscal_total_expenditure", label: "총지출" },
    ],
  },
  {
    id: "national-debt-ratio",
    title: "GDP 대비 국가채무비율",
    description: "최근 5개 공표연도",
    unit: "%",
    source: "기획예산처·한국은행 · 지표누리",
    basis: "정부가 직접 상환의무를 부담하는 국가채무 ÷ 명목 GDP",
    span: 6,
    series: [{ indicatorId: "kr_national_debt_to_gdp", label: "국가채무비율" }],
  },
  {
    id: "national-tax-detail",
    title: "국세수입 세부내역",
    description: "최근 2개 공표연도",
    unit: "조원",
    source: "기획예산처 · 한국은행 ECOS 수록",
    basis: "연간 국세총액 및 세목별 징수액",
    span: 12,
    definitionNote:
      "ECOS의 국세총액은 요청한 일반회계 국세수입과 범위가 같지 않습니다. 국세총액은 참고로 표시하고 일반회계 계열은 공식 자동 원천 확정 전까지 대기합니다.",
    series: [
      { indicatorId: "kr_national_tax_total", label: "국세총액(참고)" },
      { indicatorId: "kr_income_tax_revenue", label: "소득세" },
      { indicatorId: "kr_corporate_tax_revenue", label: "법인세" },
      { indicatorId: "kr_vat_revenue", label: "부가가치세" },
    ],
  },
  {
    id: "budget-scale",
    title: "예산규모와 전년비",
    description: "최근 3년 · 본예산·추경·총수입·총지출",
    unit: "조원",
    source: "기획예산처 예산안·추경안",
    basis: "계획 분모 빈티지 확정 필요",
    span: 4,
    pendingReason: "본예산·추경의 연도별 빈티지를 함께 제공하는 공식 자동 원천 연결 대기",
    series: [],
  },
  {
    id: "monthly-budget-progress",
    title: "세입·세출 월별 실적 진도율",
    description: "월별 누계 실적 ÷ 해당 연도 계획",
    unit: "%",
    source: "기획예산처 월간 재정동향",
    basis: "해당 월호에 공표된 최신 추경 계획 분모",
    span: 4,
    series: [
      { indicatorId: "kr_fiscal_total_revenue_progress", label: "총수입" },
      { indicatorId: "kr_fiscal_total_expenditure_progress", label: "총지출" },
    ],
  },
  {
    id: "ktb-issuance-progress",
    title: "국고채 발행 진도율",
    description: "실제 발행액 ÷ 연간 발행계획",
    unit: "%",
    source: "기획예산처 월간 재정동향",
    basis: "개인투자용 국고채를 제외한 누계 발행액 ÷ 연간 발행한도",
    span: 4,
    series: [{ indicatorId: "kr_ktb_issuance_progress", label: "발행 진도율" }],
  },
];

function rowsFor(snapshot: SectorSnapshot, spec: FiscalChartSpec) {
  if (spec.manualRows) return spec.manualRows;
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

function latestObservedAt(snapshot: SectorSnapshot, spec: FiscalChartSpec): string | null {
  if (spec.manualRows) return String(spec.manualRows.at(-1)?.date ?? "") || null;
  return spec.series.reduce<string | null>((latest, series) => {
    const observedAt = snapshot.sourceResults.find(
      (item) => item.indicatorId === series.indicatorId
    )?.lastObservedAt;
    return observedAt && (!latest || observedAt > latest) ? observedAt : latest;
  }, null);
}

function formatValue(value: number, unit: FiscalChartSpec["unit"]): string {
  return `${new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 }).format(value)}${unit}`;
}

export default function FiscalDashboard({ snapshot }: { snapshot: SectorSnapshot }) {
  return (
    <section className="outlook-growth-dashboard" aria-labelledby="fiscal-charts-heading">
      <div className="outlook-growth-heading">
        <div>
          <p className="outlook-eyebrow">FISCAL MONITOR</p>
          <h2 id="fiscal-charts-heading">재정 지표</h2>
        </div>
        <p>재정 실적·진도율 연결 · 예산규모·일반회계 세수 2개 묶음 대기</p>
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
                <ChartFrame title={spec.title} chartId={`fiscal-${spec.id}`} rows={rows} series={spec.series.map((series, index) => ({ key: series.indicatorId, label: series.label, unit: spec.unit, color: COLORS[index % COLORS.length] }))}>
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={rows} margin={{ top: 24, right: 12, bottom: 4, left: 0 }}>
                      <CartesianGrid stroke="var(--grid)" vertical={false} />
                      <XAxis
                        dataKey="date"
                        tick={{ fill: "var(--axis)", fontSize: 11 }}
                        tickLine={false}
                        axisLine={{ stroke: "var(--grid)" }}
                      />
                      <YAxis
                        tick={{ fill: "var(--axis)", fontSize: 11 }}
                        tickLine={false}
                        axisLine={false}
                        width={56}
                        domain={[0, "auto"]}
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
                      {spec.series.map((series, index) => (
                        <Bar
                          key={series.indicatorId}
                          dataKey={series.indicatorId}
                          name={series.label}
                          fill={COLORS[index % COLORS.length]}
                          maxBarSize={34}
                          isAnimationActive={false}
                        />
                      ))}
                      <LatestValueLabels rows={rows} series={spec.series.map((series, index) => ({ key: series.indicatorId, label: series.label, unit: spec.unit, color: COLORS[index % COLORS.length] }))} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </ChartFrame>
              ) : (
                <div className="outlook-growth-chart-empty">
                  {spec.pendingReason ?? "재정 섹터의 데이터 업데이트를 실행하면 차트가 표시됩니다."}
                </div>
              )}

              {spec.definitionNote && <p className="outlook-definition-note">{spec.definitionNote}</p>}
              {errors.map((result) => (
                <p key={result!.indicatorId} className="outlook-error">
                  ⚠ {result!.probeName}: {result!.error}
                </p>
              ))}
              <footer>
                출처 {spec.source} · 기준연도 {observedAt ?? "업데이트 대기"} · {spec.basis}
              </footer>
            </article>
          );
        })}
      </div>
    </section>
  );
}
