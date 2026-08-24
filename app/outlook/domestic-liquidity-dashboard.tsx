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
import { ChartFrame, LatestValueLabels } from "./chart-tools";

const COLORS = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-3)",
  "var(--series-4)",
  "#7a8ba6",
  "#b77988",
  "#4f8b75",
];

interface SeriesSpec {
  indicatorId: string;
  label: string;
}

interface ChartSpec {
  id: string;
  title: string;
  description: string;
  unit: "%" | "조원";
  span: 6 | 12;
  basis: string;
  series: SeriesSpec[];
  kind?: "line" | "bar";
}

const YOY_CHARTS: ChartSpec[] = [
  {
    id: "demand-savings-yoy",
    title: "수시입출식저축성예금",
    description: "공식 현행계열 가용구간 · 월별 전년동월대비",
    unit: "%", span: 6, basis: "M2 평잔·원계열",
    series: [{ indicatorId: "kr_m2_demand_savings_yoy", label: "수시입출식저축성예금" }],
  },
  {
    id: "time-deposit-yoy",
    title: "만기 2년 미만 정기예적금",
    description: "공식 현행계열 가용구간 · 월별 전년동월대비",
    unit: "%", span: 6, basis: "M2 평잔·원계열",
    series: [{ indicatorId: "kr_m2_time_deposits_under_2y_yoy", label: "만기 2년 미만" }],
  },
  {
    id: "mmf-yoy",
    title: "MMF",
    description: "공식 현행계열 가용구간 · 월별 전년동월대비",
    unit: "%", span: 6, basis: "M2 평잔·원계열",
    series: [{ indicatorId: "kr_m2_mmf_yoy", label: "MMF" }],
  },
  {
    id: "cma-yoy",
    title: "CMA",
    description: "공식 현행계열 가용구간 · 월별 전년동월대비",
    unit: "%", span: 6, basis: "M2 평잔·원계열",
    series: [{ indicatorId: "kr_m2_cma_yoy", label: "CMA" }],
  },
  {
    id: "households-yoy",
    title: "가계 및 비영리단체",
    description: "공식 현행계열 가용구간 · 월별 전년동월대비",
    unit: "%", span: 6, basis: "M2 평잔·경제주체별",
    series: [{ indicatorId: "kr_m2_households_yoy", label: "가계 및 비영리단체" }],
  },
  {
    id: "corporations-yoy",
    title: "비금융기업",
    description: "공식 현행계열 가용구간 · 월별 전년동월대비",
    unit: "%", span: 6, basis: "M2 평잔·경제주체별",
    series: [{ indicatorId: "kr_m2_nonfinancial_corporations_yoy", label: "비금융기업" }],
  },
  {
    id: "deposit-yoy",
    title: "총예금과 가계·기업 예금 증가율",
    description: "2022년~ · 월별 전년동월대비",
    unit: "%", span: 6, basis: "예금은행 종별·주체별 말잔",
    series: [
      { indicatorId: "kr_total_deposits_yoy", label: "총예금" },
      { indicatorId: "kr_household_deposits_yoy", label: "가계" },
      { indicatorId: "kr_corporate_deposits_yoy", label: "기업" },
    ],
  },
];

const SHARE_SERIES: SeriesSpec[] = [
  { indicatorId: "kr_m2_demand_savings_share_snapshots", label: "수시입출식" },
  { indicatorId: "kr_m2_time_deposits_under_2y_share_snapshots", label: "만기 2년 미만" },
  { indicatorId: "kr_m2_mmf_share_snapshots", label: "MMF" },
  { indicatorId: "kr_m2_cma_share_snapshots", label: "CMA" },
  { indicatorId: "kr_m2_households_share_snapshots", label: "가계·비영리" },
  { indicatorId: "kr_m2_nonfinancial_corporations_share_snapshots", label: "비금융기업" },
  { indicatorId: "kr_m2_other_financial_institutions_share_snapshots", label: "기타금융기관" },
];

function rowsFor(snapshot: SectorSnapshot, series: SeriesSpec[]) {
  const byDate = new Map<string, Record<string, string | number>>();
  for (const item of series) {
    const result = snapshot.sourceResults.find((row) => row.indicatorId === item.indicatorId);
    for (const point of result?.points ?? []) {
      if (point.value == null) continue;
      const row = byDate.get(point.date) ?? { date: point.date };
      row[item.indicatorId] = point.value;
      byDate.set(point.date, row);
    }
  }
  return [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function observedAt(snapshot: SectorSnapshot, series: SeriesSpec[]) {
  return series.reduce<string | null>((latest, item) => {
    const value = snapshot.sourceResults.find((row) => row.indicatorId === item.indicatorId)?.lastObservedAt;
    return value && (!latest || value > latest) ? value : latest;
  }, null);
}

function formatTick(value: unknown) {
  const text = String(value);
  if (/^\d{4}-12$/.test(text)) return text.slice(0, 4);
  if (/^\d{4}-\d{2}$/.test(text)) return text.endsWith("-01") ? text.slice(0, 4) : text.slice(5);
  return text;
}

function ChartCard({ snapshot, spec }: { snapshot: SectorSnapshot; spec: ChartSpec }) {
  const rows = rowsFor(snapshot, spec.series).filter((row) =>
    spec.id === "deposit-level" || String(row.date) >= "2022-01"
  );
  const errors = spec.series.flatMap((item) => {
    const result = snapshot.sourceResults.find((row) => row.indicatorId === item.indicatorId);
    return result?.status === "error" ? [result] : [];
  });
  return (
    <article className={`outlook-growth-chart outlook-trade-chart-${spec.span}`}>
      <header><div><h3>{spec.title}</h3><p>{spec.description}</p></div><span>단위 {spec.unit}</span></header>
      {rows.length ? (
        <ChartFrame title={spec.title} chartId={`liquidity-${spec.id}`} rows={rows} series={spec.series.map((item, index) => ({ key: item.indicatorId, label: item.label, unit: spec.unit, color: COLORS[index % COLORS.length] }))}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} margin={{ top: 24, right: 12, bottom: 4, left: 0 }}>
              <CartesianGrid stroke="var(--grid)" vertical={false} />
              <XAxis dataKey="date" tick={{ fill: "var(--axis)", fontSize: 11 }} tickLine={false} axisLine={{ stroke: "var(--grid)" }} minTickGap={28} tickFormatter={formatTick} />
              <YAxis tick={{ fill: "var(--axis)", fontSize: 11 }} tickLine={false} axisLine={false} width={48} domain={spec.unit === "%" ? [(min: number) => Math.min(0, min), (max: number) => Math.max(0, max)] : [0, "auto"]} tickFormatter={(value) => new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 }).format(Number(value))} />
              <Tooltip contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--foreground)", fontSize: 12 }} formatter={(value) => typeof value === "number" ? `${value.toFixed(1)}${spec.unit === "%" ? "%" : ""}` : "—"} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {spec.unit === "%" && <ReferenceLine y={0} stroke="var(--axis)" strokeDasharray="3 3" />}
              {spec.series.map((item, index) => spec.kind === "bar" ? (
                <Bar key={item.indicatorId} dataKey={item.indicatorId} name={item.label} fill={COLORS[index % COLORS.length]} isAnimationActive={false} />
              ) : (
                <Line key={item.indicatorId} type="linear" dataKey={item.indicatorId} name={item.label} stroke={COLORS[index % COLORS.length]} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
              ))}
              <LatestValueLabels rows={rows} series={spec.series.map((item, index) => ({ key: item.indicatorId, label: item.label, unit: spec.unit, color: COLORS[index % COLORS.length] }))} />
            </ComposedChart>
          </ResponsiveContainer>
        </ChartFrame>
      ) : <div className="outlook-growth-chart-empty">국내 유동성 섹터의 데이터 업데이트를 실행하면 차트가 표시됩니다.</div>}
      {errors.map((error) => <p key={error.indicatorId} className="outlook-error">⚠ {error.probeName}: {error.error}</p>)}
      <footer>출처 한국은행 ECOS · 기준월 {observedAt(snapshot, spec.series) ?? "업데이트 대기"} · {spec.basis}</footer>
    </article>
  );
}

function PendingCard({ title, description }: { title: string; description: string }) {
  return (
    <article className="outlook-growth-chart outlook-trade-chart-6">
      <header><div><h3>{title}</h3><p>자동 업데이트 원천 확정 대기</p></div><span>PENDING</span></header>
      <div className="outlook-growth-chart-empty">{description}</div>
      <footer>결측값을 보간하거나 이미지의 수기 숫자를 재사용하지 않습니다.</footer>
    </article>
  );
}

export default function DomesticLiquidityDashboard({ snapshot }: { snapshot: SectorSnapshot }) {
  const m2Series: SeriesSpec[] = [
    { indicatorId: "kr_m2_sa_average", label: "M2 규모" },
    { indicatorId: "kr_m2_total_original_yoy", label: "M2 전년비" },
  ];
  const m2Rows = rowsFor(snapshot, m2Series).filter((row) => String(row.date) >= "2023-01");
  const depositSnapshot: ChartSpec = {
    id: "deposit-level", title: "가계와 기업의 총예금 잔고", description: "2020년말~ · 연말과 최신월 스냅샷",
    unit: "조원", span: 6, basis: "예금은행 주체별 말잔", kind: "bar",
    series: [
      { indicatorId: "kr_household_deposits_year_end_latest", label: "가계" },
      { indicatorId: "kr_corporate_deposits_year_end_latest", label: "기업" },
    ],
  };

  return (
    <section className="outlook-growth-dashboard" aria-labelledby="domestic-liquidity-charts-heading">
      <div className="outlook-growth-heading">
        <div><p className="outlook-eyebrow">DOMESTIC LIQUIDITY MONITOR</p><h2 id="domestic-liquidity-charts-heading">국내 유동성 지표</h2></div>
        <p>12개 차트 · 20개 공식 계열 · 2개 차트 연결 대기</p>
      </div>
      <div className="outlook-growth-grid">
        <article className="outlook-growth-chart outlook-trade-chart-12">
          <header><div><h3>국내 M2 규모와 증가율</h3><p>2023년~ · 월별 평잔</p></div><span>좌 조원 · 우 %</span></header>
          {m2Rows.length ? <ChartFrame title="국내 M2 규모와 증가율" chartId="liquidity-m2-level-yoy" rows={m2Rows} canvasClassName="outlook-liquidity-hero-canvas" series={m2Series.map((item, index) => ({ key: item.indicatorId, label: item.label, unit: index === 0 ? "조원" : "%", color: COLORS[index], yAxisId: index === 0 ? "level" : "yoy" }))}>
            <ResponsiveContainer width="100%" height="100%"><ComposedChart data={m2Rows} margin={{ top: 24, right: 8, bottom: 4, left: 0 }}>
              <CartesianGrid stroke="var(--grid)" vertical={false} />
              <XAxis dataKey="date" tick={{ fill: "var(--axis)", fontSize: 11 }} tickLine={false} axisLine={{ stroke: "var(--grid)" }} minTickGap={32} tickFormatter={formatTick} />
              <YAxis yAxisId="level" tick={{ fill: "var(--axis)", fontSize: 11 }} tickLine={false} axisLine={false} width={58} domain={["dataMin - 80", "dataMax + 30"]} tickFormatter={(value) => new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 }).format(Number(value))} />
              <YAxis yAxisId="yoy" orientation="right" tick={{ fill: "var(--axis)", fontSize: 11 }} tickLine={false} axisLine={false} width={38} unit="%" tickFormatter={(value) => new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 }).format(Number(value))} />
              <Tooltip contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--foreground)", fontSize: 12 }} formatter={(value, name) => typeof value === "number" ? [`${value.toFixed(name === "M2 규모" ? 1 : 2)}${name === "M2 규모" ? "조원" : "%"}`, name] : ["—", name]} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar yAxisId="level" dataKey="kr_m2_sa_average" name="M2 규모" fill={COLORS[0]} isAnimationActive={false} />
              <Line yAxisId="yoy" type="linear" dataKey="kr_m2_total_original_yoy" name="M2 전년비" stroke={COLORS[1]} strokeWidth={2.5} dot={false} connectNulls={false} isAnimationActive={false} />
              <LatestValueLabels rows={m2Rows} series={m2Series.map((item, index) => ({ key: item.indicatorId, label: item.label, unit: index === 0 ? "조원" : "%", color: COLORS[index], yAxisId: index === 0 ? "level" : "yoy" }))} />
            </ComposedChart></ResponsiveContainer>
          </ChartFrame> : <div className="outlook-growth-chart-empty">국내 유동성 데이터 업데이트 후 표시됩니다.</div>}
          <footer>출처 한국은행 ECOS · 기준월 {observedAt(snapshot, m2Series) ?? "업데이트 대기"} · 규모는 계절조정 평잔, 증가율은 원계열 평잔</footer>
        </article>

        <PendingCard title="국내 주요 금융기관 수신" description="은행·자산운용사별 동일 누적기간 잔액 증감은 각 기관의 공식 공표 기준을 동일하게 맞춘 구조화 API를 확정한 뒤 연결합니다." />

        <article className="outlook-growth-chart outlook-trade-chart-12">
          <header><div><h3>M2 내 상품별·경제주체별 비중</h3><p>직전 2개 연말과 최신월 · 총 M2 대비</p></div><span>단위 %</span></header>
          {rowsFor(snapshot, SHARE_SERIES).length ? <ChartFrame title="M2 내 상품별·경제주체별 비중" chartId="liquidity-m2-shares" rows={rowsFor(snapshot, SHARE_SERIES)} canvasClassName="outlook-liquidity-share-canvas" series={SHARE_SERIES.map((item, index) => ({ key: item.indicatorId, label: item.label, unit: "%", color: COLORS[index % COLORS.length] }))}>
            <ResponsiveContainer width="100%" height="100%"><ComposedChart data={rowsFor(snapshot, SHARE_SERIES)} margin={{ top: 58, right: 12, bottom: 4, left: 0 }}>
              <CartesianGrid stroke="var(--grid)" vertical={false} />
              <XAxis dataKey="date" tick={{ fill: "var(--axis)", fontSize: 11 }} tickLine={false} axisLine={{ stroke: "var(--grid)" }} tickFormatter={(value) => String(value).endsWith("-12") ? String(value).slice(0, 4) + "년말" : String(value)} />
              <YAxis tick={{ fill: "var(--axis)", fontSize: 11 }} tickLine={false} axisLine={false} width={44} unit="%" />
              <Tooltip contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--foreground)", fontSize: 12 }} formatter={(value) => typeof value === "number" ? `${value.toFixed(1)}%` : "—"} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {SHARE_SERIES.map((item, index) => <Bar key={item.indicatorId} dataKey={item.indicatorId} name={item.label} fill={COLORS[index % COLORS.length]} isAnimationActive={false} />)}
              <LatestValueLabels rows={rowsFor(snapshot, SHARE_SERIES)} series={SHARE_SERIES.map((item, index) => ({ key: item.indicatorId, label: item.label, unit: "%", color: COLORS[index % COLORS.length] }))} />
            </ComposedChart></ResponsiveContainer>
          </ChartFrame> : <div className="outlook-growth-chart-empty">국내 유동성 데이터 업데이트 후 표시됩니다.</div>}
          <footer>출처 한국은행 ECOS · 기준월 {observedAt(snapshot, SHARE_SERIES) ?? "업데이트 대기"} · 각 월 세부 계열 ÷ 동일월 M2 총계, 평잔·원계열</footer>
        </article>

        <PendingCard title="국내 대기성 자금 종류별 증감" description="투자자예탁금·CMA·MMF의 특정일 잔액은 금융투자협회 공식 일별 원천의 안정적인 자동 연결을 확정한 뒤 제공합니다." />

        {YOY_CHARTS.slice(0, 6).map((spec) => <ChartCard key={spec.id} snapshot={snapshot} spec={spec} />)}
        <ChartCard snapshot={snapshot} spec={depositSnapshot} />
        <ChartCard snapshot={snapshot} spec={YOY_CHARTS[6]} />
      </div>
    </section>
  );
}
