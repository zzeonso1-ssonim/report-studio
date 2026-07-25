"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { transformLabels } from "@/lib/transforms";
import { LOGIN_PATH, LOGOUT_API_PATH } from "@/lib/auth-config";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
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

/** /api/search 결과 한 건 — params는 어댑터에 그대로 전달 가능한 형태 */
interface SearchResult {
  source: string;
  name: string;
  params: Record<string, string>;
  cycle: string;
  unit?: string;
  origin: string;
}

/** 검색에서 추가된 임의 시계열 (등록 지표와 구분) */
interface AdhocItem extends SearchResult {
  id: string;
}

const SOURCE_LABELS: Record<string, string> = {
  ecos: "ECOS",
  kosis: "KOSIS",
  fred: "FRED",
};

/** 검색 결과 → 선택 목록/차트 dataKey로 쓸 안정적 id */
function adhocId(r: SearchResult): string {
  const sig = Object.values(r.params).join("_").replace(/[^a-zA-Z0-9]/g, "");
  return `adhoc_${r.source}_${sig}`;
}

const TRANSFORMS = Object.entries(transformLabels).map(([value, label]) => ({
  value,
  label,
}));

const YEAR_PRESETS = [1, 3, 5, 10] as const;
const MAX_SERIES = 4;
const SERIES_VARS = ["--series-1", "--series-2", "--series-3", "--series-4"];

const CHART_TYPES = [
  { value: "line", label: "꺾은선" },
  { value: "bar", label: "막대" },
  { value: "area", label: "영역" },
] as const;
type ChartType = (typeof CHART_TYPES)[number]["value"];

/**
 * 변환이 적용된 시리즈의 표시 단위 — 변환 라벨(단일 소스)의 괄호 표기에서 파생.
 * 예: "전년동기대비 (%)" → "%", "재기준화 (시작=100)" → "시작=100", "원계열" → null(원단위 사용).
 */
function transformUnit(tf: string): string | null {
  const label = (transformLabels as Record<string, string>)[tf];
  const m = label?.match(/\(([^)]+)\)\s*$/);
  return m ? m[1] : null;
}

/**
 * 차트 컨테이너 내부의 recharts SVG를 PNG Blob으로 변환한다.
 * SVG의 색이 CSS 변수(var(--series-1) 등)로 지정돼 있어 그대로 직렬화하면
 * 색이 사라지므로, 원본 요소를 순회하며 getComputedStyle로 resolve된
 * stroke/fill(텍스트는 font까지)을 복제본에 인라인으로 박은 뒤 직렬화한다.
 * 버튼 핸들러와 검증이 동일하게 이 함수를 거친다.
 */
async function chartContainerToPngBlob(container: HTMLElement): Promise<Blob> {
  // 범례가 있으면 legend-wrapper의 14px 아이콘 svg가 DOM상 메인 차트 svg보다
  // 먼저 오므로, 반드시 .recharts-wrapper 직계 자식인 차트 표면 svg를 잡는다.
  const svg =
    container.querySelector<SVGSVGElement>(".recharts-wrapper > svg") ??
    container.querySelector("svg");
  if (!svg) throw new Error("차트 SVG를 찾을 수 없습니다");

  const rect = svg.getBoundingClientRect();
  const clone = svg.cloneNode(true) as SVGSVGElement;

  // cloneNode는 문서 순서를 보존하므로 index로 원본↔복제본을 짝지을 수 있다.
  const srcEls: SVGElement[] = [svg, ...svg.querySelectorAll<SVGElement>("*")];
  const dstEls: SVGElement[] = [clone, ...clone.querySelectorAll<SVGElement>("*")];
  for (let i = 0; i < srcEls.length; i++) {
    const cs = getComputedStyle(srcEls[i]);
    const dst = dstEls[i];
    dst.setAttribute("stroke", cs.stroke);
    dst.setAttribute("fill", cs.fill);
    // 영역 차트의 반투명 채움 등 opacity 계열도 resolve된 값으로 보존한다.
    if (cs.fillOpacity !== "1") dst.setAttribute("fill-opacity", cs.fillOpacity);
    if (cs.strokeOpacity !== "1") dst.setAttribute("stroke-opacity", cs.strokeOpacity);
    if (srcEls[i].tagName === "text" || srcEls[i].tagName === "tspan") {
      dst.setAttribute("font-family", cs.fontFamily);
      dst.setAttribute("font-size", cs.fontSize);
    }
    // 독립 문서에서 의미 없는 class를 제거해 속성값이 확실히 적용되게 한다.
    dst.removeAttribute("class");
  }

  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(rect.width));
  clone.setAttribute("height", String(rect.height));

  const xml = new XMLSerializer().serializeToString(clone);
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("SVG 이미지 로드 실패"));
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml);
  });

  // 배경은 투명 대신 현재 테마의 --surface 계산값으로 채운다 (다크모드 대응).
  const surface =
    getComputedStyle(container).getPropertyValue("--surface").trim() ||
    "#ffffff";

  const scale = 2; // 2배 해상도
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(rect.width * scale);
  canvas.height = Math.round(rect.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context를 얻을 수 없습니다");
  ctx.fillStyle = surface;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0, rect.width, rect.height);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png")
  );
  if (!blob) throw new Error("PNG 변환에 실패했습니다");
  return blob;
}

/** /api/chat 응답의 plan.series 항목 */
interface PlanSeriesItem {
  indicatorId?: string;
  source?: string;
  params?: Record<string, string>;
  cycle?: string;
  name?: string;
  unit?: string;
}

interface ChatPlan {
  series: PlanSeriesItem[];
  transform: string;
  startDate: string;
  endDate: string;
}

export default function Home() {
  const [meta, setMeta] = useState<IndicatorMeta[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [transform, setTransform] = useState<string>("raw");
  const [years, setYears] = useState<number>(5);
  const [series, setSeries] = useState<Record<string, SeriesResponse>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [showTable, setShowTable] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [chartType, setChartType] = useState<ChartType>("line");
  const chartRef = useRef<HTMLDivElement>(null);

  // 자연어 조회
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [chatMessage, setChatMessage] = useState<string | null>(null); // 모델 되묻기
  const [chatError, setChatError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null); // 계획 안내문 (차트 위)
  const [manualOpen, setManualOpen] = useState(false); // 수동 선택 패널

  // 전체 통계 검색
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchErrors, setSearchErrors] = useState<string[]>([]);
  const [searchDone, setSearchDone] = useState(false);
  const [adhoc, setAdhoc] = useState<AdhocItem[]>([]);

  useEffect(() => {
    fetch("/api/indicators")
      .then((r) => r.json())
      .then(setMeta)
      .catch(() => setMeta([]));
  }, []);

  const totalSelected = selected.length + adhoc.length;

  const toggle = useCallback(
    (id: string) => {
      setSelected((prev) =>
        prev.includes(id)
          ? prev.filter((x) => x !== id)
          : totalSelected >= MAX_SERIES
            ? prev
            : [...prev, id]
      );
    },
    [totalSelected]
  );

  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (q.length < 2 || searching) return;
    setSearching(true);
    setSearchDone(false);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const json = await res.json();
      if (!res.ok) {
        setSearchResults([]);
        setSearchErrors([json.error ?? `HTTP ${res.status}`]);
      } else {
        setSearchResults(json.results ?? []);
        setSearchErrors(json.errors ?? []);
      }
    } catch (e) {
      setSearchResults([]);
      setSearchErrors([String(e)]);
    } finally {
      setSearching(false);
      setSearchDone(true);
    }
  }, [query, searching]);

  const addAdhoc = useCallback(
    (r: SearchResult) => {
      const id = adhocId(r);
      setAdhoc((prev) => {
        if (prev.some((a) => a.id === id)) return prev;
        if (selected.length + prev.length >= MAX_SERIES) return prev;
        return [...prev, { ...r, id }];
      });
    },
    [selected.length]
  );

  const removeAdhoc = useCallback((id: string) => {
    setAdhoc((prev) => prev.filter((a) => a.id !== id));
  }, []);

  /** 실제 조회 실행 — 수동 조회와 자연어 계획이 동일 경로를 쓴다 */
  const runLoad = useCallback(
    async (
      ids: string[],
      adhocItems: AdhocItem[],
      tf: string,
      start: string,
      end: string
    ) => {
      if (ids.length + adhocItems.length === 0) return;
      setLoading(true);
      const qs = `start=${start}&end=${end}&transform=${tf}`;

      const results: Record<string, SeriesResponse> = {};
      const errs: Record<string, string> = {};
      await Promise.all([
        ...ids.map(async (id) => {
          try {
            const res = await fetch(`/api/series/${id}?${qs}`);
            const json = await res.json();
            if (!res.ok) errs[id] = json.error ?? `HTTP ${res.status}`;
            else results[id] = json;
          } catch (e) {
            errs[id] = String(e);
          }
        }),
        ...adhocItems.map(async (a) => {
          try {
            const res = await fetch("/api/series/adhoc", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                id: a.id,
                source: a.source,
                params: a.params,
                cycle: a.cycle,
                name: a.name,
                unit: a.unit,
                start,
                end,
                transform: tf,
              }),
            });
            const json = await res.json();
            if (!res.ok) errs[a.id] = json.error ?? `HTTP ${res.status}`;
            else results[a.id] = json;
          } catch (e) {
            errs[a.id] = String(e);
          }
        }),
      ]);
      setSeries(results);
      setErrors(errs);
      setLoading(false);
    },
    []
  );

  /** 수동 선택 패널의 조회 버튼 — 연 프리셋에서 기간을 계산 */
  const load = useCallback(async () => {
    const startDate = new Date();
    startDate.setFullYear(startDate.getFullYear() - years);
    const start = startDate.toISOString().slice(0, 10);
    const end = new Date().toISOString().slice(0, 10);
    setNote(null);
    await runLoad(selected, adhoc, transform, start, end);
  }, [selected, adhoc, transform, years, runLoad]);

  /** 자연어 질의 → /api/chat 계획 → 기존 조회 경로 실행 */
  const runChat = useCallback(async () => {
    const q = chatInput.trim();
    if (q.length < 2 || chatLoading) return;
    setChatLoading(true);
    setChatMessage(null);
    setChatError(null);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q }),
      });
      const json = await res.json();
      if (!res.ok) {
        setChatError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      if (json.message) {
        setChatMessage(json.message);
        return;
      }
      const plan: ChatPlan | undefined = json.plan;
      if (!plan || !Array.isArray(plan.series)) {
        setChatError("계획 응답 형식이 올바르지 않습니다");
        return;
      }
      const regIds: string[] = [];
      const adhocItems: AdhocItem[] = [];
      for (const s of plan.series) {
        if (s.indicatorId) {
          regIds.push(s.indicatorId);
        } else if (s.source && s.params) {
          const r: SearchResult = {
            source: s.source,
            name: s.name ?? "임의 시계열",
            params: s.params,
            cycle: s.cycle ?? "M",
            unit: s.unit,
            origin: "AI 검색",
          };
          adhocItems.push({ ...r, id: adhocId(r) });
        }
      }
      // 수동 패널 상태를 계획과 동기화 — 이후 수동 재조회도 이어서 가능
      setSelected(regIds);
      setAdhoc(adhocItems);
      setTransform(plan.transform);
      setNote(typeof json.note === "string" ? json.note : null);
      await runLoad(regIds, adhocItems, plan.transform, plan.startDate, plan.endDate);
    } catch (e) {
      setChatError(String(e));
    } finally {
      setChatLoading(false);
    }
  }, [chatInput, chatLoading, runLoad]);

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

  /** "단위: %" 표기 — 로드된 시리즈의 unit에서 파생, 변환 적용 시 변환 단위 우선 */
  const unitLabel = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const s of Object.values(series)) {
      const u = transformUnit(s.transform) ?? (s.indicator.unit ?? "").trim();
      if (u && !seen.has(u)) {
        seen.add(u);
        list.push(u);
      }
    }
    return list.length > 0 ? `단위: ${list.join(" · ")}` : null;
  }, [series]);
  const nameOf = (id: string) =>
    meta.find((m) => m.id === id)?.name ??
    adhoc.find((a) => a.id === id)?.name ??
    series[id]?.indicator.name ??
    id;

  const downloadPng = useCallback(async () => {
    const container = chartRef.current;
    if (!container) return;
    setExporting(true);
    try {
      const blob = await chartContainerToPngBlob(container);
      // 파일명은 현재 상태에서 파생: 실제 로드된 지표 id들 + 응답의 변환값 + 오늘(로컬).
      const ids = Object.keys(series).join("-");
      const tf = Object.values(series)[0]?.transform ?? transform;
      const d = new Date();
      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `cockpit_${ids}_${tf}_${date}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } finally {
      setExporting(false);
    }
  }, [series, transform]);

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: "var(--primary)" }}>
            경제데이터 통합조회
          </h1>
          <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
            한국·미국 공공 경제데이터 통합 조회 — 원천기관 우선
          </p>
        </div>
        <nav className="flex gap-2 text-sm">
          <a
            href="/calendar"
            className="rounded-lg border px-3 py-1.5"
            style={{ borderColor: "var(--border)", color: "var(--primary)" }}
          >
            발표 캘린더
          </a>
          <a
            href="/disclosures"
            className="rounded-lg border px-3 py-1.5"
            style={{ borderColor: "var(--border)", color: "var(--primary)" }}
          >
            공시 검색
          </a>
          <a
            href="/models"
            className="rounded-lg border px-3 py-1.5"
            style={{ borderColor: "var(--border)", color: "var(--primary)" }}
          >
            내 모델
          </a>
          <button
            onClick={async () => {
              await fetch(LOGOUT_API_PATH, { method: "POST" });
              window.location.assign(LOGIN_PATH);
            }}
            className="rounded-lg border px-3 py-1.5"
            style={{ borderColor: "var(--border)", color: "var(--muted)" }}
          >
            로그아웃
          </button>
        </nav>
      </header>

      {/* 자연어 조회 */}
      <section
        className="rounded-xl border p-5"
        style={{ background: "var(--surface)", borderColor: "var(--border)" }}
      >
        <div className="flex gap-2">
          <input
            type="text"
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => {
              // 한글 IME 조합 중 Enter는 조합 확정이므로 제출하지 않는다
              if (e.key === "Enter" && !e.nativeEvent.isComposing) runChat();
            }}
            disabled={chatLoading}
            placeholder="예: 한국이랑 미국 CPI 전년동기대비 5년치 비교해줘"
            aria-label="자연어로 데이터 조회"
            className="flex-1 rounded-xl border px-4 py-3 text-base outline-none focus:ring-2 disabled:opacity-60"
            style={{
              borderColor: "var(--primary)",
              background: "var(--surface)",
              color: "var(--foreground)",
            }}
          />
          <button
            onClick={runChat}
            disabled={chatInput.trim().length < 2 || chatLoading}
            className="rounded-xl px-5 py-3 text-base font-semibold text-white disabled:opacity-40"
            style={{ background: "var(--primary)" }}
          >
            {chatLoading ? "분석 중…" : "조회"}
          </button>
        </div>
        <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
          질문하듯 입력하면 지표·변환·기간을 알아서 골라 조회해요 — 예: “국고채
          10년이랑 미국채 10년 금리 1년치”, “전국 아파트 매매가격지수 3년”
        </p>
        {chatMessage && (
          <div
            className="mt-3 max-w-xl rounded-xl rounded-tl-sm border px-4 py-3 text-sm"
            style={{
              background: "var(--primary-soft)",
              borderColor: "var(--border)",
              color: "var(--foreground)",
            }}
          >
            {chatMessage}
          </div>
        )}
        {chatError && (
          <p className="mt-3 text-sm" style={{ color: "var(--muted)" }}>
            ⚠ {chatError}
          </p>
        )}
      </section>

      {/* 수동 선택 (접이식) */}
      <section
        className="mt-4 rounded-xl border"
        style={{ background: "var(--surface)", borderColor: "var(--border)" }}
      >
        <button
          onClick={() => setManualOpen((o) => !o)}
          aria-expanded={manualOpen}
          className="flex w-full items-center justify-between px-4 py-3 text-sm font-semibold"
        >
          <span>
            수동 선택 — 지표 체크·통계 검색 (최대 {MAX_SERIES}개 · 현재{" "}
            {totalSelected}개)
          </span>
          <span style={{ color: "var(--muted)" }}>{manualOpen ? "▲ 접기" : "▼ 펼치기"}</span>
        </button>
        {manualOpen && (
        <div className="px-4 pb-4">
        <h3 className="mb-2 text-xs font-semibold" style={{ color: "var(--muted)" }}>
          주요 지표
        </h3>
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

        {/* 전체 통계 검색 */}
        <h3 className="mb-2 mt-5 text-xs font-semibold" style={{ color: "var(--muted)" }}>
          전체 통계 검색 (ECOS · KOSIS · FRED)
        </h3>
        <div className="flex gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") runSearch();
            }}
            placeholder="통계명·항목 검색 — 예: 소비자물가, housing starts"
            className="flex-1 rounded-lg border px-3 py-1.5 text-sm outline-none focus:ring-1"
            style={{
              borderColor: "var(--border)",
              background: "var(--surface)",
              color: "var(--foreground)",
            }}
          />
          <button
            onClick={runSearch}
            disabled={query.trim().length < 2 || searching}
            className="rounded-lg border px-4 py-1.5 text-sm font-semibold disabled:opacity-40"
            style={{
              borderColor: "var(--primary)",
              color: "var(--primary)",
              background: "var(--primary-soft)",
            }}
          >
            {searching ? "검색 중…" : "검색"}
          </button>
        </div>

        {/* 검색 추가분 (선택됨) */}
        {adhoc.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {adhoc.map((a) => (
              <span
                key={a.id}
                className="flex items-center gap-1.5 rounded-lg border border-dashed px-2.5 py-1.5 text-xs"
                style={{
                  borderColor: "var(--primary)",
                  background: "var(--primary-soft)",
                }}
              >
                <span
                  className="rounded px-1 py-0.5 font-semibold"
                  style={{ background: "var(--surface)", color: "var(--primary)" }}
                >
                  {SOURCE_LABELS[a.source] ?? a.source.toUpperCase()} 검색 추가
                </span>
                <span>{a.name}</span>
                <button
                  onClick={() => removeAdhoc(a.id)}
                  aria-label={`${a.name} 제거`}
                  className="ml-0.5 font-bold"
                  style={{ color: "var(--muted)" }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        {/* 검색 결과 */}
        {searchErrors.length > 0 && (
          <div className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
            {searchErrors.map((e, i) => (
              <p key={i}>⚠ {e}</p>
            ))}
          </div>
        )}
        {searchDone && searchResults.length === 0 && searchErrors.length === 0 && (
          <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
            검색 결과가 없어요.
          </p>
        )}
        {searchResults.length > 0 && (
          <ul
            className="mt-2 max-h-64 overflow-auto rounded-lg border"
            style={{ borderColor: "var(--border)" }}
          >
            {searchResults.map((r) => {
              const id = adhocId(r);
              const added = adhoc.some((a) => a.id === id);
              const full = !added && totalSelected >= MAX_SERIES;
              return (
                <li key={id} style={{ borderTop: "1px solid var(--border)" }}>
                  <button
                    onClick={() => (added ? removeAdhoc(id) : addAdhoc(r))}
                    disabled={full}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm disabled:opacity-40"
                    style={{
                      background: added ? "var(--primary-soft)" : "transparent",
                    }}
                  >
                    <span
                      className="shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold"
                      style={{ background: "var(--primary-soft)", color: "var(--primary)" }}
                    >
                      {SOURCE_LABELS[r.source] ?? r.source.toUpperCase()}
                    </span>
                    <span className="flex-1">
                      {r.name}
                      <span className="ml-1 text-xs" style={{ color: "var(--muted)" }}>
                        {r.cycle}
                        {r.unit ? ` · ${r.unit}` : ""} · {r.origin}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs" style={{ color: "var(--primary)" }}>
                      {added ? "선택됨 ✓" : full ? "가득 참" : "+ 추가"}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

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
            disabled={totalSelected === 0 || loading}
            className="rounded-lg px-4 py-1.5 font-semibold text-white disabled:opacity-40"
            style={{ background: "var(--primary)" }}
          >
            {loading ? "불러오는 중…" : "조회"}
          </button>
        </div>
        </div>
        )}
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
          {note && (
            <p className="mb-2 text-xs" style={{ color: "var(--primary)" }}>
              {note}
            </p>
          )}
          {mixedUnits && (
            <p className="mb-2 text-xs" style={{ color: "var(--muted)" }}>
              단위가 다른 지표를 원계열로 겹쳤어요 — 비교하려면 전년동기대비(%)나
              재기준화를 권장해요.
            </p>
          )}
          {/* 차트 옵션 — 유형 토글 + 단위 표기 */}
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div
              role="group"
              aria-label="차트 유형"
              className="flex overflow-hidden rounded-lg border text-xs"
              style={{ borderColor: "var(--border)" }}
            >
              {CHART_TYPES.map((t) => (
                <button
                  key={t.value}
                  onClick={() => setChartType(t.value)}
                  aria-pressed={chartType === t.value}
                  className="px-3 py-1.5 font-semibold"
                  style={{
                    background:
                      chartType === t.value ? "var(--primary-soft)" : "transparent",
                    color:
                      chartType === t.value ? "var(--primary)" : "var(--muted)",
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {unitLabel && (
              <span className="text-xs" style={{ color: "var(--muted)" }}>
                {unitLabel}
              </span>
            )}
          </div>
          <div className="h-96" ref={chartRef}>
            <ResponsiveContainer width="100%" height="100%">
              {(() => {
                const margin = { top: 8, right: 16, bottom: 4, left: 4 };
                // 축·그리드·툴팁·범례 — 세 차트 유형이 공유
                const common = [
                  <CartesianGrid
                    key="grid"
                    stroke="var(--grid)"
                    strokeWidth={1}
                    vertical={false}
                  />,
                  <XAxis
                    key="x"
                    dataKey="date"
                    tick={{ fill: "var(--axis)", fontSize: 11 }}
                    tickLine={false}
                    axisLine={{ stroke: "var(--grid)" }}
                    minTickGap={48}
                  />,
                  <YAxis
                    key="y"
                    tick={{ fill: "var(--axis)", fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    width={64}
                    domain={["auto", "auto"]}
                  />,
                  <Tooltip
                    key="tooltip"
                    cursor={
                      chartType === "bar"
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
                  />,
                  ...(loadedIds.length > 1
                    ? [
                        <Legend
                          key="legend"
                          formatter={(id) => (
                            <span
                              style={{ color: "var(--foreground)", fontSize: 12 }}
                            >
                              {nameOf(String(id))}
                            </span>
                          )}
                        />,
                      ]
                    : []),
                ];
                if (chartType === "bar") {
                  return (
                    <BarChart
                      data={chartData}
                      margin={margin}
                      barGap={2}
                      barCategoryGap="25%"
                    >
                      {common}
                      {loadedIds.map((id, i) => (
                        <Bar
                          key={id}
                          dataKey={id}
                          fill={`var(${SERIES_VARS[i]})`}
                          maxBarSize={20}
                          radius={[2, 2, 0, 0]}
                        />
                      ))}
                    </BarChart>
                  );
                }
                if (chartType === "area") {
                  return (
                    <AreaChart data={chartData} margin={margin}>
                      {common}
                      {loadedIds.map((id, i) => (
                        <Area
                          key={id}
                          type="monotone"
                          dataKey={id}
                          stroke={`var(${SERIES_VARS[i]})`}
                          strokeWidth={2}
                          fill={`var(${SERIES_VARS[i]})`}
                          fillOpacity={0.15}
                          dot={false}
                          connectNulls
                        />
                      ))}
                    </AreaChart>
                  );
                }
                return (
                  <LineChart data={chartData} margin={margin}>
                    {common}
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
                );
              })()}
            </ResponsiveContainer>
          </div>

          {/* 테이블 뷰 (접근성) · PNG 다운로드 */}
          <div className="mt-3 flex items-center gap-4">
            <button
              onClick={() => setShowTable((s) => !s)}
              className="text-xs underline"
              style={{ color: "var(--primary)" }}
            >
              {showTable ? "테이블 접기" : "테이블로 보기"}
            </button>
            <button
              onClick={downloadPng}
              disabled={exporting}
              className="text-xs underline disabled:opacity-40"
              style={{ color: "var(--primary)" }}
            >
              {exporting ? "변환 중…" : "PNG 다운로드"}
            </button>
          </div>
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
