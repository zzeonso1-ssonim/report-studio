"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
import { CLIENT_TIMEOUT_MS, seconds } from "@/lib/search-config";
import type { LiquidityGroup } from "@/lib/liquidity";

/** /api/series/[id] 응답 — 대문(app/page.tsx)과 같은 형태 */
interface SeriesResponse {
  indicator: { id: string; name: string; unit: string; cycle: string };
  source: string;
  transform: string;
  points: { date: string; value: number | null }[];
  note?: string;
}

interface Point {
  date: string;
  value: number | null;
}

const SERIES_VARS = ["--series-1", "--series-2", "--series-3", "--series-4"];

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function yearsAgo(n: number): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - n);
  return d.toISOString().slice(0, 10);
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** 최신 관측일 — 값이 있는 마지막 날짜. 없으면 null */
function latestDate(points: Point[]): string | null {
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i].value != null) return points[i].date;
  }
  return null;
}

/**
 * 주간 증감 — 직전 관측치와의 차. 모델이 아니라 코드가 계산한다.
 * 관측이 없는 날은 건너뛰므로 결측 주가 있으면 두 주치가 한 막대에 합쳐진다
 * (그 사실은 차트 주의 문구로 병기한다 — 값을 만들어 채우지 않는다).
 */
function weeklyDelta(points: Point[], digits: number): Point[] {
  const obs = points.filter((p) => p.value != null) as { date: string; value: number }[];
  return obs.slice(1).map((p, i) => ({
    date: p.date,
    value: round(p.value - obs[i].value, digits),
  }));
}

/**
 * 스프레드 — 두 계열이 모두 관측된 날짜에서만 계산한다(전방 채움 없음).
 * 계산식·계수는 config.derived에서 온다: round((a − b) × multiplier, roundTo).
 * 노션 브리핑(fetch_liquidity.build_derived)과 같은 식이라 두 곳의 값이 일치한다.
 */
function computeSpread(
  a: Point[],
  b: Point[],
  multiplier: number,
  roundTo: number
): Point[] {
  const bByDate = new Map(b.map((p) => [p.date, p.value]));
  const out: Point[] = [];
  for (const p of a) {
    const bv = bByDate.get(p.date);
    if (p.value == null || bv == null) continue;
    out.push({ date: p.date, value: round((p.value - bv) * multiplier, roundTo) });
  }
  return out;
}

interface GroupState {
  years: number;
  loading: boolean;
  error: string | null;
  data: Record<string, SeriesResponse>;
}

export default function LiquidityView({
  groups,
  yearPresets,
  sourceLabel,
}: {
  groups: LiquidityGroup[];
  yearPresets: number[];
  sourceLabel: string;
}) {
  const [state, setState] = useState<Record<string, GroupState>>(() =>
    Object.fromEntries(
      groups.map((g) => [g.key, { years: g.defaultYears, loading: true, error: null, data: {} }])
    )
  );

  const load = useCallback(async (group: LiquidityGroup, years: number) => {
    setState((prev) => ({
      ...prev,
      [group.key]: { ...prev[group.key], years, loading: true, error: null },
    }));

    const qs = `start=${yearsAgo(years)}&end=${today()}&transform=raw`;
    const abort = new AbortController();
    const killer = setTimeout(() => abort.abort(), CLIENT_TIMEOUT_MS);
    try {
      const results = await Promise.all(
        group.series.map(async (s) => {
          const res = await fetch(`/api/series/${s.indicatorId}?${qs}`, {
            signal: abort.signal,
          });
          const json = await res.json();
          if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
          return [s.indicatorId, json as SeriesResponse] as const;
        })
      );
      setState((prev) => ({
        ...prev,
        [group.key]: {
          years,
          loading: false,
          error: null,
          data: Object.fromEntries(results),
        },
      }));
    } catch (e) {
      setState((prev) => ({
        ...prev,
        [group.key]: {
          years,
          loading: false,
          error: abort.signal.aborted
            ? `${seconds(CLIENT_TIMEOUT_MS)}초 안에 응답이 오지 않았습니다 — 잠시 후 다시 시도하세요`
            : String(e),
          data: {},
        },
      }));
    } finally {
      clearTimeout(killer);
    }
  }, []);

  useEffect(() => {
    for (const g of groups) load(g, g.defaultYears);
    // 최초 1회 — 이후 조회는 기간 버튼이 트리거한다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      {groups.map((g) => (
        <GroupCard
          key={g.key}
          group={g}
          state={state[g.key]}
          yearPresets={yearPresets}
          sourceLabel={sourceLabel}
          onYears={(y) => load(g, y)}
        />
      ))}
    </>
  );
}

function GroupCard({
  group,
  state,
  yearPresets,
  sourceLabel,
  onYears,
}: {
  group: LiquidityGroup;
  state: GroupState | undefined;
  yearPresets: number[];
  sourceLabel: string;
  onYears: (years: number) => void;
}) {
  const years = state?.years ?? group.defaultYears;
  const data = useMemo(() => state?.data ?? {}, [state]);

  /** 그릴 계열 — id → {name, points}. 파생(증감·스프레드)은 여기서 계산한다 */
  const drawn = useMemo(() => {
    const out: { id: string; name: string; points: Point[] }[] = [];
    if (group.kind === "levels") {
      for (const s of group.series) {
        const r = data[s.indicatorId];
        if (r) out.push({ id: s.indicatorId, name: s.name, points: r.points });
      }
      return out;
    }
    if (group.kind === "delta") {
      const s = group.series[0];
      const r = data[s.indicatorId];
      if (r) {
        out.push({
          id: `${s.indicatorId}_delta`,
          name: group.deltaName ?? `${s.label} 주간 증감`,
          points: weeklyDelta(r.points, 1),
        });
      }
      return out;
    }
    const spec = group.spread;
    if (!spec) return out;
    const a = data[spec.minuendId];
    const b = data[spec.subtrahendId];
    if (a && b) {
      out.push({
        id: "spread",
        name: spec.name,
        points: computeSpread(a.points, b.points, spec.multiplier, spec.roundTo),
      });
    }
    return out;
  }, [group, data]);

  const rows = useMemo(() => {
    const byDate = new Map<string, Record<string, string | number | null>>();
    for (const s of drawn) {
      for (const p of s.points) {
        if (!byDate.has(p.date)) byDate.set(p.date, { date: p.date });
        byDate.get(p.date)![s.id] = p.value;
      }
    }
    return [...byDate.values()].sort((x, y) => String(x.date).localeCompare(String(y.date)));
  }, [drawn]);

  const nameOf = (id: string) => drawn.find((s) => s.id === id)?.name ?? id;

  /** 관측일 — 계열마다 다르므로 각각 적는다 (한 줄에 묶어 같은 시점처럼 보이게 하지 않는다) */
  const observed = drawn
    .map((s) => {
      const d = latestDate(s.points);
      return d ? `${s.name} ${d}` : null;
    })
    .filter((x): x is string => Boolean(x));

  const hasData = rows.length > 0;

  return (
    <section
      className="mt-4 rounded-xl border p-4"
      style={{ background: "var(--surface)", borderColor: "var(--border)" }}
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold">{group.title}</h2>
        <div className="flex gap-1 text-xs">
          {yearPresets.map((y) => (
            <button
              key={y}
              onClick={() => onYears(y)}
              disabled={state?.loading}
              aria-pressed={years === y}
              className="rounded-lg border px-2.5 py-1.5 disabled:opacity-40"
              style={{
                borderColor: years === y ? "var(--primary)" : "var(--border)",
                background: years === y ? "var(--primary-soft)" : "transparent",
                color: years === y ? "var(--primary)" : "inherit",
              }}
            >
              {y}년
            </button>
          ))}
        </div>
      </div>

      {/* 이 차트의 주장 — config의 claim을 그대로 싣는다 */}
      <p className="mb-1 text-xs" style={{ color: "var(--foreground)" }}>
        <span className="font-semibold" style={{ color: "var(--primary)" }}>
          이 차트의 주장
        </span>{" "}
        {group.claim}
      </p>
      <p className="mb-2 text-xs" style={{ color: "var(--muted)" }}>
        ℹ {group.note}
      </p>

      {state?.error && (
        <p className="mb-2 text-sm" style={{ color: "var(--muted)" }}>
          ⚠ {state.error}
        </p>
      )}
      {state?.loading && (
        <p className="mb-2 text-xs" style={{ color: "var(--muted)" }}>
          불러오는 중…
        </p>
      )}
      {!state?.loading && !state?.error && !hasData && (
        <p className="mb-2 text-xs" style={{ color: "var(--muted)" }}>
          조회 기간에 관측치가 없습니다.
        </p>
      )}

      {hasData && (
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
              <CartesianGrid stroke="var(--grid)" strokeWidth={1} vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fill: "var(--axis)", fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: "var(--grid)" }}
                minTickGap={48}
              />
              <YAxis
                tick={{ fill: "var(--axis)", fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={64}
                domain={["auto", "auto"]}
              />
              <Tooltip
                cursor={
                  group.kind === "delta"
                    ? { fill: "var(--primary-soft)", fillOpacity: 0.6 }
                    : { stroke: "var(--axis)", strokeOpacity: 0.4 }
                }
                contentStyle={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  color: "var(--foreground)",
                  fontSize: 12,
                }}
                formatter={(v, key) => [
                  typeof v === "number" ? v.toLocaleString() : "—",
                  nameOf(String(key)),
                ]}
              />
              {drawn.length > 1 && (
                <Legend
                  formatter={(id) => (
                    <span style={{ color: "var(--foreground)", fontSize: 12 }}>
                      {nameOf(String(id))}
                    </span>
                  )}
                />
              )}
              {group.zeroLine && <ReferenceLine y={0} stroke="var(--axis)" strokeDasharray="3 3" />}
              {/* isAnimationActive=false — 프리셋 화면은 열자마자 값이 보여야 하고,
                  그리기 애니메이션 중에는 빈 차트가 캡처된다(PNG·스크린샷 함정) */}
              {drawn.map((s, i) => {
                const color = `var(${SERIES_VARS[i % SERIES_VARS.length]})`;
                if (group.kind === "delta") {
                  return (
                    <Bar
                      key={s.id}
                      dataKey={s.id}
                      fill={color}
                      maxBarSize={6}
                      isAnimationActive={false}
                    />
                  );
                }
                return (
                  <Line
                    key={s.id}
                    type="monotone"
                    dataKey={s.id}
                    stroke={color}
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                    isAnimationActive={false}
                  />
                );
              })}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* 단위·출처·관측일 — 숫자에 기준일이 없는 화면을 만들지 않는다 */}
      <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
        단위 {group.unit} · 출처 {sourceLabel}
        {observed.length > 0 && <> · 관측일 {observed.join(" / ")}</>}
      </p>
      {group.series.some((s) => s.note) && (
        <details className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
          <summary className="cursor-pointer">계열 주의사항</summary>
          <ul className="mt-1 list-disc pl-5">
            {group.series.map((s) => (
              <li key={s.indicatorId}>
                <span style={{ color: "var(--foreground)" }}>{s.name}</span> — {s.note}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
