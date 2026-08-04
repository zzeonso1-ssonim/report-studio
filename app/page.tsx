"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { REQUEST_TRANSFORMS, transformLabels } from "@/lib/transforms";
import { LOGIN_PATH, LOGOUT_API_PATH } from "@/lib/auth-config";
import { CLIENT_TIMEOUT_MS, seconds } from "@/lib/search-config";
import { MAX_SERIES, seriesStyle } from "@/lib/chart-config";
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
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
  /** false면 주요지표 체크리스트에 상시 노출하지 않는 지표 (챗 전용) */
  featured: boolean;
}

interface SeriesResponse {
  indicator: { id: string; name: string; unit: string; cycle: string };
  source: string;
  transform: string;
  points: { date: string; value: number | null }[];
  /** 서버 안내문 — 예: 이미 변화율 단위라 변환을 원계열로 강등한 경우 */
  note?: string;
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

// 사용자가 고르는 변환만 노출 — 차(%p) 변환은 서버가 지표 성격에 따라 자동 대체
const TRANSFORMS = Object.entries(transformLabels)
  .filter(([value]) => (REQUEST_TRANSFORMS as readonly string[]).includes(value))
  .map(([value, label]) => ({ value, label }));

const YEAR_PRESETS = [1, 3, 5, 10] as const;

/**
 * 표시 단위 정규화 — 같은 뜻의 다른 표기가 서로 다른 축으로 갈라지는 것을 막는다.
 * (레지스트리 "십억 달러" vs 유동성 config 파생 "십억 USD"가 실제로 그랬다)
 */
function normalizeUnit(u: string): string {
  return u
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/usd/g, "달러")
    .replace(/percent|퍼센트/g, "%");
}

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

type Axis = "left" | "right";

/** /api/chat 응답의 plan.series 항목 */
interface PlanSeriesItem {
  indicatorId?: string;
  source?: string;
  params?: Record<string, string>;
  cycle?: string;
  name?: string;
  unit?: string;
  axis?: Axis;
  style?: ChartType;
}

/** /api/chat 응답의 plan.derived 항목 — a·b는 plan.series 인덱스 */
interface PlanDerivedItem {
  op: "spread" | "ratio";
  a: number;
  b: number;
  name: string;
  unit?: string;
  axis?: Axis;
  style?: ChartType;
}

interface ChatPlan {
  series: PlanSeriesItem[];
  derived?: PlanDerivedItem[];
  transform: string;
  startDate: string;
  endDate: string;
}

/** 파생 계산 사양 — 계획 인덱스를 실제 시리즈 id로 해석해 보관 (수동 재조회에도 유지) */
interface DerivedSpec {
  op: "spread" | "ratio";
  aId: string;
  bId: string;
  name: string;
  unit?: string;
}

function derivedKey(d: DerivedSpec): string {
  return `derived_${d.op}_${d.aId}_${d.bId}`;
}

/**
 * 파생 시리즈 계산 — spread=a−b, ratio=a÷b. 모델이 아니라 코드가 계산한다.
 * 날짜는 서버에서 주기별 정규형으로 통일돼 오므로 문자열 일치로 짝짓는다.
 */
function computeDerived(d: DerivedSpec, a: SeriesResponse, b: SeriesResponse): SeriesResponse {
  const bByDate = new Map(b.points.map((p) => [p.date, p.value]));
  const points = a.points.map((p) => {
    const bv = bByDate.get(p.date);
    let v: number | null = null;
    if (p.value != null && bv != null) {
      v = d.op === "spread" ? p.value - bv : bv !== 0 ? p.value / bv : null;
    }
    return { date: p.date, value: v == null ? null : Math.round(v * 10000) / 10000 };
  });
  const unit =
    d.unit ??
    (d.op === "spread"
      ? a.indicator.unit === "%" && b.indicator.unit === "%"
        ? "%p"
        : a.indicator.unit
      : "배");
  return {
    indicator: { id: derivedKey(d), name: d.name, unit, cycle: a.indicator.cycle },
    source: "계산",
    transform: a.transform,
    points,
  };
}

/** 시리즈가 그릴 값이 하나라도 있는지 — 빈 결과를 조용히 넘기지 않기 위한 판정 */
function hasAnyValue(s: SeriesResponse): boolean {
  return Array.isArray(s.points) && s.points.some((p) => p.value != null);
}

// ── 주기 정렬 ────────────────────────────────────────────────
// 일간·월간처럼 주기가 다른 시리즈를 겹치면 날짜 키가 서로 달라 병합 행마다
// 한쪽 값만 남는다(툴팁에 값이 하나만 보이는 원인). 가장 성긴 주기로
// 세밀한 시리즈를 평균 환산해 같은 키로 정렬한다 — 계산은 코드가 한다.
const CYCLE_RANK: Record<string, number> = { D: 0, M: 1, Q: 2, A: 3 };
const CYCLE_LABEL: Record<string, string> = { M: "월", Q: "분기", A: "연" };

function bucketDate(date: string, target: string): string {
  if (target === "M") return date.slice(0, 7);
  if (target === "Q") {
    if (date.includes("Q")) return date;
    return `${date.slice(0, 4)}-Q${Math.ceil(Number(date.slice(5, 7)) / 3)}`;
  }
  return date.slice(0, 4); // A
}

function resampleTo(s: SeriesResponse, target: string): SeriesResponse {
  const buckets = new Map<string, number[]>();
  for (const p of s.points) {
    if (p.value == null) continue;
    const k = bucketDate(p.date, target);
    const arr = buckets.get(k);
    if (arr) arr.push(p.value);
    else buckets.set(k, [p.value]);
  }
  const points = [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, vals]) => ({
      date,
      value: Math.round((vals.reduce((x, y) => x + y, 0) / vals.length) * 10000) / 10000,
    }));
  return { ...s, indicator: { ...s.indicator, cycle: target }, points };
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

  // 자연어 계획의 파생 계산·이축·항목별 표현 — id 기준이라 수동 재조회에도 유지된다
  const [derived, setDerived] = useState<DerivedSpec[]>([]);
  const [axes, setAxes] = useState<Record<string, Axis>>({});
  const [styles, setStyles] = useState<Record<string, ChartType>>({});
  // 조회 응답에 실린 서버 안내문 (변환 강등 등) — 차트 위에 표시
  const [dataNotes, setDataNotes] = useState<string[]>([]);
  // 축 반전(역축) — 금리↔가격처럼 역상관 시리즈를 포갤 때 쓴다
  const [invertAxes, setInvertAxes] = useState<{ left: boolean; right: boolean }>({
    left: false,
    right: false,
  });

  // 전체 통계 검색
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchErrors, setSearchErrors] = useState<string[]>([]);
  const [searchNotes, setSearchNotes] = useState<string[]>([]);
  const [searchDone, setSearchDone] = useState(false);
  /** 검색 시작 후 경과 초 — 멈춘 걸로 오인하지 않게 진행 상황을 보여준다 */
  const [searchElapsed, setSearchElapsed] = useState(0);
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
    setSearchNotes([]);
    setSearchElapsed(0);

    const startedAt = Date.now();
    const ticker = setInterval(
      () => setSearchElapsed(Math.floor((Date.now() - startedAt) / 1000)),
      1000
    );
    // 서버가 스스로 끊지 못한 경우의 마지막 안전장치 (모바일·사내망은 그 전에 끊긴다)
    const abort = new AbortController();
    const killer = setTimeout(() => abort.abort(), CLIENT_TIMEOUT_MS);

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
        signal: abort.signal,
      });
      const json = await res.json();
      if (!res.ok) {
        setSearchResults([]);
        setSearchErrors([json.error ?? `HTTP ${res.status}`]);
      } else {
        setSearchResults(json.results ?? []);
        setSearchErrors(json.errors ?? []);
        setSearchNotes(json.notes ?? []);
      }
    } catch (e) {
      setSearchResults([]);
      setSearchErrors([
        abort.signal.aborted
          ? `${seconds(CLIENT_TIMEOUT_MS)}초 안에 응답이 오지 않았습니다 — 잠시 후 다시 검색하거나 검색어를 더 구체적으로 입력해 보세요`
          : `검색 요청이 실패했습니다 (${String(e)}) — 네트워크를 확인하고 다시 시도하세요`,
      ]);
    } finally {
      clearInterval(ticker);
      clearTimeout(killer);
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
            else if (!hasAnyValue(json))
              errs[id] = "데이터 없음 — 조회 기간에 관측치가 없습니다 (기간·지표를 확인하세요)";
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
            else if (!hasAnyValue(json))
              errs[a.id] =
                "데이터 없음 — 조회 기간에 관측치가 없습니다 (검색 결과의 코드 조합이 유효하지 않을 수 있어요)";
            else results[a.id] = json;
          } catch (e) {
            errs[a.id] = String(e);
          }
        }),
      ]);
      setSeries(results);
      setErrors(errs);
      setDataNotes(
        Object.values(results)
          .map((r) => r.note)
          .filter((n): n is string => Boolean(n))
      );
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
      // planIds는 plan.series와 같은 순서 — derived의 인덱스(a·b)를 id로 해석하는 기준
      const planIds: string[] = [];
      const newAxes: Record<string, Axis> = {};
      const newStyles: Record<string, ChartType> = {};
      for (const s of plan.series) {
        let id: string | null = null;
        if (s.indicatorId) {
          regIds.push(s.indicatorId);
          id = s.indicatorId;
        } else if (s.source && s.params) {
          const r: SearchResult = {
            source: s.source,
            name: s.name ?? "임의 시계열",
            params: s.params,
            cycle: s.cycle ?? "M",
            unit: s.unit,
            origin: "AI 검색",
          };
          id = adhocId(r);
          adhocItems.push({ ...r, id });
        }
        if (id) {
          planIds.push(id);
          if (s.axis) newAxes[id] = s.axis;
          if (s.style) newStyles[id] = s.style;
        }
      }
      const specs: DerivedSpec[] = [];
      for (const d of plan.derived ?? []) {
        const aId = planIds[d.a];
        const bId = planIds[d.b];
        if (!aId || !bId) continue;
        const spec: DerivedSpec = { op: d.op, aId, bId, name: d.name, unit: d.unit };
        specs.push(spec);
        const k = derivedKey(spec);
        if (d.axis) newAxes[k] = d.axis;
        if (d.style) newStyles[k] = d.style;
      }
      // 수동 패널 상태를 계획과 동기화 — 이후 수동 재조회도 이어서 가능
      setSelected(regIds);
      setAdhoc(adhocItems);
      setTransform(plan.transform);
      setDerived(specs);
      setAxes(newAxes);
      setStyles(newStyles);
      setNote(typeof json.note === "string" ? json.note : null);
      await runLoad(regIds, adhocItems, plan.transform, plan.startDate, plan.endDate);
    } catch (e) {
      setChatError(String(e));
    } finally {
      setChatLoading(false);
    }
  }, [chatInput, chatLoading, runLoad]);

  /** 주기가 섞이면 가장 성긴 주기로 평균 환산해 날짜 키를 맞춘다 */
  const { alignedSeries, alignNote } = useMemo(() => {
    const entries = Object.entries(series);
    const cycles = new Set(entries.map(([, s]) => s.indicator.cycle));
    if (entries.length < 2 || cycles.size <= 1) {
      return { alignedSeries: series, alignNote: null as string | null };
    }
    const target = [...cycles].reduce((a, b) => ((CYCLE_RANK[b] ?? 0) > (CYCLE_RANK[a] ?? 0) ? b : a));
    const out: Record<string, SeriesResponse> = {};
    for (const [id, s] of entries) {
      out[id] = s.indicator.cycle === target ? s : resampleTo(s, target);
    }
    return {
      alignedSeries: out,
      alignNote: `주기가 달라 세밀한 시리즈는 ${CYCLE_LABEL[target] ?? target}평균으로 환산해 정렬했어요`,
    };
  }, [series]);

  /** 표시 대상 시리즈 = 주기 정렬된 조회 결과 + 파생 계산(스프레드·비율) */
  const displaySeries = useMemo(() => {
    const out: Record<string, SeriesResponse> = { ...alignedSeries };
    for (const d of derived) {
      const a = alignedSeries[d.aId];
      const b = alignedSeries[d.bId];
      if (!a || !b) continue; // 참조 시리즈가 로드되지 않으면 그리지 않는다
      out[derivedKey(d)] = computeDerived(d, a, b);
    }
    return out;
  }, [alignedSeries, derived]);

  const chartData = useMemo(() => {
    const byDate = new Map<string, Record<string, string | number | null>>();
    for (const [id, s] of Object.entries(displaySeries)) {
      for (const p of s.points) {
        if (!byDate.has(p.date)) byDate.set(p.date, { date: p.date });
        byDate.get(p.date)![id] = p.value;
      }
    }
    return [...byDate.values()].sort((a, b) =>
      String(a.date).localeCompare(String(b.date))
    );
  }, [displaySeries]);

  const loadedIds = Object.keys(displaySeries);

  /** 시리즈의 표시 단위 — 변환 적용 시 변환 단위, 파생은 자체 단위 */
  const displayUnitOf = useCallback((s: SeriesResponse): string => {
    return (
      (s.source === "계산" ? s.indicator.unit : transformUnit(s.transform)) ??
      (s.indicator.unit ?? "").trim()
    );
  }, []);

  /**
   * 축 자동 분리 — 계획이 축을 명시하지 않았으면 표시 단위로 좌·우를 나눈다.
   * 가장 많은 시리즈가 쓰는 단위를 좌축에 두고 나머지를 우축으로 보낸다.
   *
   * 종전에는 단위가 정확히 2종일 때만 동작해서, 한·미·기관을 섞어 3종 이상이
   * 되면 자동 분리가 통째로 꺼지고 %(0~5)와 억원(10^5)이 한 축에 눌렸다.
   * 3종 이상도 우축으로 묶고, 그때는 재기준화를 권하는 안내를 함께 낸다.
   */
  const { effectiveAxes, autoAxisNote } = useMemo(() => {
    const hasExplicit = loadedIds.some((id) => axes[id]);
    if (hasExplicit || loadedIds.length < 2) {
      return { effectiveAxes: axes, autoAxisNote: null as string | null };
    }
    const unitsSeen: string[] = [];
    const count = new Map<string, number>();
    for (const id of loadedIds) {
      const u = normalizeUnit(displayUnitOf(displaySeries[id]));
      if (!unitsSeen.includes(u)) unitsSeen.push(u);
      count.set(u, (count.get(u) ?? 0) + 1);
    }
    if (unitsSeen.length < 2) return { effectiveAxes: axes, autoAxisNote: null };
    // 최다 사용 단위를 좌축으로 (동수면 먼저 등장한 쪽)
    const leftUnit = unitsSeen.reduce((a, b) =>
      (count.get(b) ?? 0) > (count.get(a) ?? 0) ? b : a
    );
    const out: Record<string, Axis> = {};
    for (const id of loadedIds) {
      out[id] = normalizeUnit(displayUnitOf(displaySeries[id])) === leftUnit ? "left" : "right";
    }
    // 안내문에는 정규화 전 표기를 쓴다(사용자가 화면에서 보는 문자열)
    const labelOf = (norm: string) =>
      loadedIds
        .map((id) => displayUnitOf(displaySeries[id]))
        .find((u) => normalizeUnit(u) === norm) || "-";
    const rightUnits = unitsSeen.filter((u) => u !== leftUnit).map(labelOf);
    return {
      effectiveAxes: out,
      autoAxisNote:
        rightUnits.length === 1
          ? `단위가 달라 ${rightUnits[0]} 시리즈를 우축으로 분리했어요 (좌 ${labelOf(leftUnit)} · 우 ${rightUnits[0]})`
          : `단위가 ${unitsSeen.length}종이라 ${labelOf(leftUnit)}만 좌축에 두고 나머지(${rightUnits.join(" · ")})를 우축에 함께 표시했어요 — 스케일이 크게 다르면 재기준화(시작=100)로 보세요`,
    };
  }, [loadedIds, axes, displaySeries, displayUnitOf]);

  const axisOf = (id: string): Axis => effectiveAxes[id] ?? "left";
  const hasRightAxis = loadedIds.some((id) => axisOf(id) === "right");
  // 이축이면 축별로 단위 혼합을 판정한다 — 우축 분리가 단위 충돌의 해법이므로
  const mixedUnits =
    transform === "raw" &&
    (["left", "right"] as Axis[]).some(
      (ax) =>
        new Set(
          loadedIds.filter((id) => axisOf(id) === ax).map((id) => displaySeries[id].indicator.unit)
        ).size > 1
    );

  /** "단위: %" 표기 — 로드된 시리즈의 unit에서 파생, 변환 적용 시 변환 단위 우선 */
  const unitLabel = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const s of Object.values(displaySeries)) {
      const u =
        (s.source === "계산" ? s.indicator.unit : transformUnit(s.transform)) ??
        (s.indicator.unit ?? "").trim();
      if (u && !seen.has(u)) {
        seen.add(u);
        list.push(u);
      }
    }
    return list.length > 0 ? `단위: ${list.join(" · ")}` : null;
  }, [displaySeries]);
  const nameOf = (id: string) =>
    displaySeries[id]?.indicator.name ??
    meta.find((m) => m.id === id)?.name ??
    adhoc.find((a) => a.id === id)?.name ??
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
            href="/liquidity"
            className="rounded-lg border px-3 py-1.5"
            style={{ borderColor: "var(--border)", color: "var(--primary)" }}
          >
            미 유동성
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
          {meta.filter((m) => m.featured).map((m) => {
            // 상한을 넘으면 toggle이 조용히 무시했다 — 눌리지 않는 이유가 보이게 막는다
            const full = !selected.includes(m.id) && totalSelected >= MAX_SERIES;
            return (
            <label
              key={m.id}
              title={full ? `최대 ${MAX_SERIES}개까지 선택할 수 있어요` : undefined}
              className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                full ? "cursor-not-allowed opacity-40" : "cursor-pointer"
              }`}
              style={{
                borderColor: selected.includes(m.id) ? "var(--primary)" : "var(--border)",
                background: selected.includes(m.id) ? "var(--primary-soft)" : "transparent",
              }}
            >
              <input
                type="checkbox"
                checked={selected.includes(m.id)}
                disabled={full}
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
            );
          })}
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
            {searching ? (
              <span className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
                />
                검색 중…
              </span>
            ) : (
              "검색"
            )}
          </button>
        </div>

        {/* 진행 표시 — 멈춘 게 아니라 조회 중임을 알린다 */}
        {searching && (
          <p
            className="mt-2 flex items-center gap-1.5 text-xs"
            role="status"
            aria-live="polite"
            style={{ color: "var(--muted)" }}
          >
            <span
              aria-hidden
              className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
            />
            ECOS · KOSIS · FRED 조회 중 ({searchElapsed}초) — 최대{" "}
            {seconds(CLIENT_TIMEOUT_MS)}초까지 기다립니다
          </p>
        )}

        {/* 챗 질의가 선택한 비노출 지표 — 보이지 않는 채로 다음 조회에 끼지 않도록
            반드시 여기서 드러내고 제거할 수 있게 한다 */}
        {selected.some((id) => meta.find((m) => m.id === id)?.featured === false) && (
          <div className="mt-3 flex flex-wrap gap-2">
            {selected
              .filter((id) => meta.find((m) => m.id === id)?.featured === false)
              .map((id) => (
                <span
                  key={id}
                  className="flex items-center gap-1.5 rounded-lg border border-dashed px-2.5 py-1.5 text-xs"
                  style={{ borderColor: "var(--primary)", background: "var(--primary-soft)" }}
                >
                  <span
                    className="rounded px-1 py-0.5 font-semibold"
                    style={{ background: "var(--surface)", color: "var(--primary)" }}
                  >
                    질의 선택
                  </span>
                  <span>{meta.find((m) => m.id === id)?.name ?? id}</span>
                  <button
                    onClick={() => setSelected((prev) => prev.filter((x) => x !== id))}
                    aria-label={`${meta.find((m) => m.id === id)?.name ?? id} 제거`}
                    className="ml-0.5 font-bold"
                    style={{ color: "var(--muted)" }}
                  >
                    ×
                  </button>
                </span>
              ))}
          </div>
        )}

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
        {searchNotes.length > 0 && (
          <div className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
            {searchNotes.map((n, i) => (
              <p key={i}>ℹ {n}</p>
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
          {dataNotes.map((n, i) => (
            <p key={i} className="mb-2 text-xs" style={{ color: "var(--muted)" }}>
              ℹ {n}
            </p>
          ))}
          {alignNote && (
            <p className="mb-2 text-xs" style={{ color: "var(--muted)" }}>
              ℹ {alignNote}
            </p>
          )}
          {autoAxisNote && (
            <p className="mb-2 text-xs" style={{ color: "var(--muted)" }}>
              ℹ {autoAxisNote}
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
            {/* 역축 토글 — 금리↔가격 역상관 오버레이용 */}
            <div
              role="group"
              aria-label="축 반전"
              className="flex overflow-hidden rounded-lg border text-xs"
              style={{ borderColor: "var(--border)" }}
            >
              <button
                onClick={() => setInvertAxes((v) => ({ ...v, left: !v.left }))}
                aria-pressed={invertAxes.left}
                className="px-3 py-1.5 font-semibold"
                style={{
                  background: invertAxes.left ? "var(--primary-soft)" : "transparent",
                  color: invertAxes.left ? "var(--primary)" : "var(--muted)",
                }}
              >
                좌축 반전{invertAxes.left ? " ✓" : ""}
              </button>
              {hasRightAxis && (
                <button
                  onClick={() => setInvertAxes((v) => ({ ...v, right: !v.right }))}
                  aria-pressed={invertAxes.right}
                  className="px-3 py-1.5 font-semibold"
                  style={{
                    background: invertAxes.right ? "var(--primary-soft)" : "transparent",
                    color: invertAxes.right ? "var(--primary)" : "var(--muted)",
                  }}
                >
                  우축 반전{invertAxes.right ? " ✓" : ""}
                </button>
              )}
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
                // 항목별 표현(계획의 style) > 전역 차트유형 토글
                const styleOf = (id: string): ChartType => styles[id] ?? chartType;
                return (
                  <ComposedChart
                    data={chartData}
                    margin={margin}
                    barGap={2}
                    barCategoryGap="25%"
                  >
                    <CartesianGrid
                      stroke="var(--grid)"
                      strokeWidth={1}
                      vertical={false}
                    />
                    <XAxis
                      dataKey="date"
                      tick={{ fill: "var(--axis)", fontSize: 11 }}
                      tickLine={false}
                      axisLine={{ stroke: "var(--grid)" }}
                      minTickGap={48}
                    />
                    <YAxis
                      yAxisId="left"
                      reversed={invertAxes.left}
                      tick={{ fill: "var(--axis)", fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                      width={64}
                      domain={["auto", "auto"]}
                    />
                    {hasRightAxis && (
                      <YAxis
                        yAxisId="right"
                        orientation="right"
                        reversed={invertAxes.right}
                        tick={{ fill: "var(--axis)", fontSize: 11 }}
                        tickLine={false}
                        axisLine={false}
                        width={64}
                        domain={["auto", "auto"]}
                      />
                    )}
                    <Tooltip
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
                    />
                    {loadedIds.length > 1 && (
                      <Legend
                        formatter={(id) => (
                          <span
                            style={{ color: "var(--foreground)", fontSize: 12 }}
                          >
                            {nameOf(String(id))}
                          </span>
                        )}
                      />
                    )}
                    {loadedIds.map((id, i) => {
                      // 색만으로는 8~10계열을 구분하기 어렵다 — 5번째부터 파선을 함께 입힌다
                      const { colorVar, dash } = seriesStyle(i);
                      const color = `var(${colorVar})`;
                      const axis = axisOf(id);
                      const style = styleOf(id);
                      if (style === "bar") {
                        return (
                          <Bar
                            key={id}
                            dataKey={id}
                            yAxisId={axis}
                            fill={color}
                            maxBarSize={20}
                            radius={[2, 2, 0, 0]}
                          />
                        );
                      }
                      if (style === "area") {
                        return (
                          <Area
                            key={id}
                            type="monotone"
                            dataKey={id}
                            yAxisId={axis}
                            stroke={color}
                            strokeWidth={2}
                            fill={color}
                            fillOpacity={0.15}
                            dot={false}
                            connectNulls
                          />
                        );
                      }
                      return (
                        <Line
                          key={id}
                          type="monotone"
                          dataKey={id}
                          yAxisId={axis}
                          stroke={color}
                          strokeDasharray={dash}
                          strokeWidth={2}
                          dot={false}
                          connectNulls
                        />
                      );
                    })}
                  </ComposedChart>
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
