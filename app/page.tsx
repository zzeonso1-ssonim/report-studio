"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface IndicatorMeta {
  id: string;
  name: string;
  country: "KR" | "US";
  unit: string;
  cycle: string;
  origin: string;
  source: string;
  verified: boolean;
}

interface SeriesResponse {
  indicator: { id: string; name: string; unit: string; cycle: string };
  source: string;
  transform: string;
  points: { date: string; value: number | null }[];
  error?: string;
}

const TRANSFORMS = [
  { value: "raw", label: "원계열" },
  { value: "yoy", label: "전년동기대비 %" },
  { value: "pop", label: "전기대비 %" },
  { value: "rebase", label: "재기준화 (시작=100)" },
] as const;

const YEAR_PRESETS = [1, 3, 5, 10] as const;
const MAX_SERIES = 4;
const SERIES_VARS = ["--series-1", "--series-2", "--series-3", "--series-4"];

export default function Home() {
  const [meta, setMeta] = useState<IndicatorMeta[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [transform, setTransform] = useState<string>("raw");
  const [years, setYears] = useState<number>(5);
  const [series, setSeries] = useState<Record<string, SeriesResponse>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [showTable, setShowTable] = useState(false);

  useEffect(() => {
    fetch("/api/indicators")
      .then((r) => r.json())
      .then(setMeta)
      .catch(() => setMeta([]));
  }, []);

  const toggle = useCallback((id: string) => {
    setSelected((prev) =>
      prev.includes(id)
        ? prev.filter((x) => x !== id)
        : prev.length >= MAX_SERIES
          ? prev
          : [...prev, id]
    );
  }, []);

  const load = useCallback(async () => {
    if (selected.length === 0) return;
    setLoading(true);
    const start = new Date();
    start.setFullYear(start.getFullYear() - years);
    const qs = `start=${start.toISOString().slice(0, 10)}&end=${new Date()
      .toISOString()
      .slice(0, 10)}&transform=${transform}`;

    const results: Record<string, SeriesResponse> = {};
    const errs: Record<string, string> = {};
    await Promise.all(
      selected.map(async (id) => {
        try {
          const res = await fetch(`/api/series/${id}?${qs}`);
          const json = await res.json();
          if (!res.ok) errs[id] = json.error ?? `HTTP ${res.status}`;
          else results[id] = json;
        } catch (e) {
          errs[id] = String(e);
        }
      })
    );
    setSeries(results);
    setErrors(errs);
    setLoading(false);
  }, [selected, transform, years]);

  const chartData = useMemo(() => {
    const byDate = new Map<string, Record<string, string | number | null>>();
    for (const [id, s] of Object.entries(series)) {
      for (const p of s.points) {
        if (!byDate.has(p.date)) byDate.set(p.date, { date: p.date });
        byDate.get(p.date)![id] = p.value;
      }
    }
    return [...byDate.values()].sort((a, b) =>
      String(a.date).localeCompare(String(b.date))
    );
  }, [series]);

  const loadedIds = Object.keys(series);
  const units = new Set(loadedIds.map((id) => series[id].indicator.unit));
  const mixedUnits = transform === "raw" && units.size > 1;
  const nameOf = (id: string) => meta.find((m) => m.id === id)?.name ?? id;

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold" style={{ color: "var(--primary)" }}>
          경제데이터 콕핏
        </h1>
        <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
          한국·미국 공공 경제데이터 통합 조회 — 원천기관 우선
        </p>
      </header>

      {/* 지표 선택 */}
      <section
        className="rounded-xl border p-4"
        style={{ background: "var(--surface)", borderColor: "var(--border)" }}
      >
        <h2 className="mb-3 text-sm font-semibold">지표 선택 (최대 {MAX_SERIES}개)</h2>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {meta.map((m) => (
            <label
              key={m.id}
              className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm"
              style={{
                borderColor: selected.includes(m.id) ? "var(--primary)" : "var(--border)",
                background: selected.includes(m.id) ? "var(--primary-soft)" : "transparent",
              }}
            >
              <input
                type="checkbox"
                checked={selected.includes(m.id)}
                onChange={() => toggle(m.id)}
                className="accent-[var(--primary)]"
              />
              <span className="flex-1">
                {m.name}
                <span className="ml-1 text-xs" style={{ color: "var(--muted)" }}>
                  {m.country} · {m.origin}
                </span>
              </span>
              {!m.verified && (
                <span
                  className="rounded px-1.5 py-0.5 text-xs"
                  style={{ background: "var(--primary-soft)", color: "var(--primary)" }}
                >
                  코드 미검증
                </span>
              )}
            </label>
          ))}
          {meta.length === 0 && (
            <p className="text-sm" style={{ color: "var(--muted)" }}>
              지표 목록을 불러오는 중…
            </p>
          )}
        </div>

        {/* 옵션 */}
        <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
          <select
            value={transform}
            onChange={(e) => setTransform(e.target.value)}
            className="rounded-lg border px-2 py-1.5"
            style={{ borderColor: "var(--border)", background: "var(--surface)" }}
          >
            {TRANSFORMS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <div className="flex gap-1">
            {YEAR_PRESETS.map((y) => (
              <button
                key={y}
                onClick={() => setYears(y)}
                className="rounded-lg border px-2.5 py-1.5"
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
          <button
            onClick={load}
            disabled={selected.length === 0 || loading}
            className="rounded-lg px-4 py-1.5 font-semibold text-white disabled:opacity-40"
            style={{ background: "var(--primary)" }}
          >
            {loading ? "불러오는 중…" : "조회"}
          </button>
        </div>
      </section>

      {/* 오류 */}
      {Object.entries(errors).length > 0 && (
        <section
          className="mt-4 rounded-xl border p-4 text-sm"
          style={{ borderColor: "var(--border)", background: "var(--surface)" }}
        >
          {Object.entries(errors).map(([id, msg]) => (
            <p key={id} style={{ color: "var(--muted)" }}>
              ⚠ {nameOf(id)}: {msg}
            </p>
          ))}
        </section>
      )}

      {/* 차트 */}
      {chartData.length > 0 && (
        <section
          className="mt-4 rounded-xl border p-4"
          style={{ background: "var(--surface)", borderColor: "var(--border)" }}
        >
          {mixedUnits && (
            <p className="mb-2 text-xs" style={{ color: "var(--muted)" }}>
              단위가 다른 지표를 원계열로 겹쳤어요 — 비교하려면 전년동기대비(%)나
              재기준화를 권장해요.
            </p>
          )}
          <div className="h-96">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
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
                {loadedIds.length > 1 && (
                  <Legend
                    formatter={(id) => (
                      <span style={{ color: "var(--foreground)", fontSize: 12 }}>
                        {nameOf(String(id))}
                      </span>
                    )}
                  />
                )}
                {loadedIds.map((id, i) => (
                  <Line
                    key={id}
                    type="monotone"
                    dataKey={id}
                    stroke={`var(${SERIES_VARS[i]})`}
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* 테이블 뷰 (접근성) */}
          <button
            onClick={() => setShowTable((s) => !s)}
            className="mt-3 text-xs underline"
            style={{ color: "var(--primary)" }}
          >
            {showTable ? "테이블 접기" : "테이블로 보기"}
          </button>
          {showTable && (
            <div className="mt-2 max-h-72 overflow-auto rounded-lg border" style={{ borderColor: "var(--border)" }}>
              <table className="w-full text-xs" style={{ fontVariantNumeric: "tabular-nums" }}>
                <thead>
                  <tr style={{ background: "var(--primary-soft)" }}>
                    <th className="px-2 py-1.5 text-left">날짜</th>
                    {loadedIds.map((id) => (
                      <th key={id} className="px-2 py-1.5 text-right">
                        {nameOf(id)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {chartData.map((row) => (
                    <tr key={String(row.date)} style={{ borderTop: "1px solid var(--border)" }}>
                      <td className="px-2 py-1">{String(row.date)}</td>
                      {loadedIds.map((id) => (
                        <td key={id} className="px-2 py-1 text-right">
                          {row[id] != null ? Number(row[id]).toLocaleString() : "—"}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
