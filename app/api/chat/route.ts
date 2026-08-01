import { indicators, getIndicator, Cycle } from "@/lib/indicators";
import { searchAll } from "@/lib/search";
import { Transform } from "@/lib/transforms";
import { sources } from "@/lib/sources";

/**
 * POST /api/chat — 자연어 질의 → 조회 계획(plan) 변환.
 * OpenAI Chat Completions function calling으로 등록 지표/카탈로그 검색을 조합해
 * finalize_plan(JSON)을 받아낸다. 숫자 답변은 만들지 않는다 — 실제 데이터 조회는
 * 기존 /api/series/[id] · /api/series/adhoc 경로가 수행한다.
 *
 * 응답:
 *  - { plan: { series, transform, startDate, endDate }, note?, usage } — 계획 수립 성공
 *  - { message, usage } — 되묻기 등 모델의 텍스트 응답
 *  - { error } — 실패
 */

/**
 * 기본 모델 — 유일한 기본값 상수. 환경변수 OPENAI_MODEL로 재정의 가능.
 * gpt-4o-mini는 전체 컨텍스트에서 기간("1년치")을 만기로 오해하고 중복
 * 시리즈를 넣는 오답이 반복돼(2026-08-01 배터리 실측) gpt-4o로 올렸다 —
 * 재시도 라운드가 사라져 응답도 더 빠르다(실측 1.7~2.1초 vs 3~8초).
 */
const DEFAULT_OPENAI_MODEL = "gpt-4o";

const MAX_TOOL_ROUNDS = 6;
const MAX_SERIES = 4;
const MAX_DERIVED = 2;
const TRANSFORMS: Transform[] = ["raw", "yoy", "pop", "rebase"];
const CYCLES: Cycle[] = ["D", "M", "Q", "A"];
const AXES = ["left", "right"] as const;
const STYLES = ["line", "bar", "area"] as const;
const DERIVED_OPS = ["spread", "ratio"] as const;

type Axis = (typeof AXES)[number];
type Style = (typeof STYLES)[number];
type DerivedOp = (typeof DERIVED_OPS)[number];

// ── OpenAI 와이어 타입 (필요한 부분만) ─────────────────────────
interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
}

// ── 계획 타입 ──────────────────────────────────────────────────
interface PlanSeriesItem {
  indicatorId?: string;
  source?: string;
  params?: Record<string, string>;
  cycle?: Cycle;
  name?: string;
  unit?: string;
  /** 이축·표현 지정 (선택) — 생략 시 좌축·전역 차트유형 */
  axis?: Axis;
  style?: Style;
}

/** 시리즈 간 파생 계산 — 값·단위는 시스템이 계산한다(모델은 숫자를 만들지 않는다) */
interface PlanDerivedItem {
  op: DerivedOp;
  /** series 배열의 0-기준 인덱스. spread = a−b, ratio = a÷b */
  a: number;
  b: number;
  name: string;
  axis?: Axis;
  style?: Style;
}

interface Plan {
  series: PlanSeriesItem[];
  derived?: PlanDerivedItem[];
  transform: Transform;
  startDate: string;
  endDate: string;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function buildSystemPrompt(): string {
  const today = new Date();
  const fiveYearsAgo = new Date(today);
  fiveYearsAgo.setFullYear(fiveYearsAgo.getFullYear() - 5);
  return [
    `당신은 채권 애널리스트를 위한 경제데이터 조회 플래너입니다. 오늘은 ${isoDate(today)}입니다.`,
    `사용자의 한국어 질의(채권·거시 도메인)를 데이터 "조회 계획"으로 변환하는 것이 유일한 임무입니다.`,
    ``,
    `규칙:`,
    `- 절대 경제 수치를 직접 창작하거나 답하지 마세요. 실제 데이터 조회는 시스템이 수행하며, 당신은 계획만 세웁니다.`,
    `- 먼저 list_indicators로 등록 지표를 확인하세요. 등록 지표로 충분하면 series 항목을 {"indicatorId": "..."}로 지정하세요. 질의의 표현이 등록 지표의 name 또는 aliases와 맞으면 반드시 그 등록 지표를 쓰고 카탈로그 검색으로 대체하지 마세요.`,
    `- 등록 지표에 없는 데이터만 search_catalog(ECOS·KOSIS·FRED 카탈로그 검색)로 찾으세요. 검색 결과를 쓸 때는 그 결과의 source·params·cycle·name·unit을 변형 없이 그대로 finalize_plan의 series 항목에 넣으세요.`,
    `- 질의가 언급하는 모든 시계열 대상을 빠짐없이 series에 넣으세요. 두 나라·두 지표를 비교하는 질의("A랑 B", "A vs B")면 반드시 각각 별도의 series 항목으로 모두 포함해야 합니다. 시리즈는 최대 ${MAX_SERIES}개.`,
    `- transform: raw(원계열) | yoy(전년동기대비 %) | pop(전기대비 %) | rebase(구간 시작=100). 질의에 "전년동기대비"·"YoY"·"상승률"·"증가율" 등이 있으면 yoy. 단위가 서로 다른 지표를 한 차트에 비교할 때는 yoy 또는 rebase를 권장합니다. 금리처럼 단위(%)가 같은 수준(level) 비교는 raw.`,
    `- 파생 계산(스프레드·비율): 질의가 차나 비율을 명시적으로 요구할 때만("A-B 스프레드", "장단기 금리차", "A 대비 B 비율") derived에 {op, a, b, name}을 넣으세요. 단순 비교·겹치기 질의("A랑 B 보여줘/겹쳐줘")에는 derived를 넣지 마세요. op은 spread(a−b) 또는 ratio(a÷b), a·b는 series 배열의 0-기준 인덱스입니다. "10년-3년 스프레드"면 a=10년 인덱스, b=3년 인덱스. 원본 두 시리즈도 series에 그대로 두세요(함께 그려집니다). 값 계산은 시스템이 합니다.`,
    `- 이축·표현: 스케일이 다른 항목을 오른쪽 축에 두려면 그 항목(series 또는 derived)에 axis:"right"를 지정하세요. 스프레드는 원 시리즈와 스케일이 다르므로 기본적으로 axis:"right"를 권장합니다. "영역형"·"막대"처럼 특정 항목의 표현을 지정하면 style("line"|"bar"|"area")을 넣으세요. 예: "스프레드를 우축 영역형으로" → 해당 derived에 axis:"right", style:"area".`,
    `- 미국 데이터가 등록 지표에 없으면 search_catalog를 source:"fred"로 호출하되, FRED 카탈로그는 영문 전용이므로 검색어는 반드시 영어로 바꿔서 넣으세요 (예: "미국 실업률" → "unemployment rate").`,
    `- 한국어 별칭을 정확히 해석하세요. 특히 "슈퍼코어"가 나오면 반드시 등록 지표 us_cpi_services_less_shelter를 쓰세요 — FRED에 슈퍼코어 CPI 직수록 시리즈는 없고, 절사평균(trimmed mean) PCE는 슈퍼코어가 아니므로 대체 금지입니다. note에 "공식 슈퍼코어(서비스−에너지−주거)와 정의가 다른 근사 지표"임을 병기하세요. 비슷해 보인다고 다른 지표를 대신 쓰지 말고, 없으면 없다고 되물으세요.`,
    `- 검색 결과의 unit이 이미 변화율("% Chg.", "Percent Change" 등)인 시리즈에는 yoy·pop을 걸지 마세요 — 변화율의 변화율이 됩니다. 그런 시리즈가 섞이면 시스템이 해당 시리즈만 원계열로 강등하고 안내합니다.`,
    `- 기간 표현과 만기(테너)를 구분하세요. 지표명 뒤에 오는 "N년"·"N년치"는 조회 기간입니다. 예: "CD금리 1년" → series는 CD 91일 금리 단 1개, startDate만 1년 전으로 (국고채 1년을 추가하면 오답). 만기 지표는 "국고 1년물"처럼 종목으로 명시될 때만 포함하세요.`,
    `- 기간: endDate는 오늘(${isoDate(today)}). 질의에 "N년(치)"가 있으면 startDate는 오늘에서 정확히 N년 전 날짜로 계산하고, 기간 언급이 전혀 없을 때만 5년 전(${isoDate(fiveYearsAgo)})을 쓰세요. 날짜 형식은 YYYY-MM-DD.`,
    `- note에는 사용자 차트 위에 표시할 1문장 한국어 안내(선택 지표·변환·기간 요약 또는 주의점)를 적으세요.`,
    `- 질의가 모호해 계획을 세울 수 없으면 도구를 호출하지 말고 한국어로 짧게 되물으세요.`,
  ].join("\n");
}

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "list_indicators",
      description:
        "등록(검증)된 주요 지표 목록을 반환한다. 계획 수립 전 가장 먼저 호출할 것.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "search_catalog",
      description:
        "ECOS·KOSIS·FRED 전체 통계 카탈로그를 검색한다. 등록 지표에 없는 데이터를 찾을 때만 사용. 결과의 params는 조회 시스템에 그대로 전달되는 값이므로 변형 금지.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "검색어 (통계명·항목명, 한국어 또는 영어)" },
          source: {
            type: "string",
            enum: ["ecos", "kosis", "fred"],
            description: "특정 소스로 한정 (선택)",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "finalize_plan",
      description: "최종 조회 계획을 제출한다. 계획이 완성되면 반드시 이 도구로 끝낼 것.",
      parameters: {
        type: "object",
        properties: {
          series: {
            type: "array",
            maxItems: MAX_SERIES,
            description:
              "조회할 시계열 목록. 등록 지표는 {indicatorId}만, 검색 결과는 {source, params, cycle, name, unit}을 그대로.",
            items: {
              type: "object",
              properties: {
                indicatorId: { type: "string" },
                source: { type: "string" },
                params: { type: "object", additionalProperties: { type: "string" } },
                cycle: { type: "string", enum: CYCLES },
                name: { type: "string" },
                unit: { type: "string" },
                axis: { type: "string", enum: AXES },
                style: { type: "string", enum: STYLES },
              },
            },
          },
          derived: {
            type: "array",
            maxItems: MAX_DERIVED,
            description:
              "시리즈 간 파생 계산. spread=a−b, ratio=a÷b (a·b는 series의 0-기준 인덱스). 값 계산은 시스템이 수행.",
            items: {
              type: "object",
              properties: {
                op: { type: "string", enum: DERIVED_OPS },
                a: { type: "integer" },
                b: { type: "integer" },
                name: { type: "string", description: "차트 범례에 쓸 한국어 이름" },
                axis: { type: "string", enum: AXES },
                style: { type: "string", enum: STYLES },
              },
              required: ["op", "a", "b", "name"],
            },
          },
          transform: { type: "string", enum: TRANSFORMS },
          startDate: { type: "string", description: "YYYY-MM-DD" },
          endDate: { type: "string", description: "YYYY-MM-DD" },
          note: { type: "string", description: "차트 위에 표시할 1문장 한국어 안내" },
        },
        required: ["series", "transform", "startDate", "endDate"],
      },
    },
  },
];

// ── 도구 실행 ──────────────────────────────────────────────────
function runListIndicators(): string {
  return JSON.stringify(
    indicators.map(({ id, name, country, unit, cycle, origin, aliases }) => ({
      id,
      name,
      country,
      unit,
      cycle,
      origin,
      ...(aliases ? { aliases } : {}),
    }))
  );
}

async function runSearchCatalog(args: { query?: unknown; source?: unknown }): Promise<string> {
  const q = typeof args.query === "string" ? args.query.trim() : "";
  if (q.length < 2) return JSON.stringify({ error: "검색어는 2자 이상이어야 합니다" });
  const { results, errors } = await searchAll(q);
  const filtered =
    typeof args.source === "string"
      ? results.filter((r) => r.source === args.source)
      : results;
  return JSON.stringify({
    results: filtered.slice(0, 15),
    errors,
  });
}

/** finalize_plan 인자 검증 — 실패 시 오류 메시지 반환(모델 재시도용), 성공 시 정제된 Plan */
function validatePlan(raw: unknown): { plan?: Plan; error?: string } {
  const b = raw as Record<string, unknown>;
  if (!Array.isArray(b?.series) || b.series.length === 0) {
    return { error: "series는 1개 이상의 배열이어야 합니다" };
  }
  if (b.series.length > MAX_SERIES) {
    return { error: `series는 최대 ${MAX_SERIES}개입니다` };
  }
  const series: PlanSeriesItem[] = [];
  const seen = new Set<string>(); // 같은 지표를 두 번 넣는 모델 실수 방지
  for (const item of b.series as Record<string, unknown>[]) {
    const axis = item?.axis;
    if (axis !== undefined && !AXES.includes(axis as Axis)) {
      return { error: `axis는 left 또는 right여야 합니다: ${String(axis)}` };
    }
    const style = item?.style;
    if (style !== undefined && !STYLES.includes(style as Style)) {
      return { error: `style은 line·bar·area 중 하나여야 합니다: ${String(style)}` };
    }
    const display = { axis: axis as Axis | undefined, style: style as Style | undefined };
    if (typeof item?.indicatorId === "string" && item.indicatorId) {
      if (!getIndicator(item.indicatorId)) {
        return { error: `알 수 없는 indicatorId: ${item.indicatorId}. list_indicators의 id를 사용하세요.` };
      }
      if (seen.has(item.indicatorId)) continue;
      seen.add(item.indicatorId);
      series.push({ indicatorId: item.indicatorId, ...display });
      continue;
    }
    const source = item?.source;
    if (typeof source !== "string" || !(source in sources)) {
      return { error: `series 항목에 유효한 indicatorId 또는 source가 필요합니다 (source: ${String(source)})` };
    }
    const rawParams = item.params;
    if (typeof rawParams !== "object" || rawParams === null || Array.isArray(rawParams)) {
      return { error: "검색 결과 series 항목에는 params 객체가 필요합니다" };
    }
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawParams as Record<string, unknown>)) {
      if (typeof v !== "string") return { error: `params.${k}는 문자열이어야 합니다` };
      params[k] = v;
    }
    const cycle = (typeof item.cycle === "string" ? item.cycle : "M") as Cycle;
    if (!CYCLES.includes(cycle)) return { error: `지원하지 않는 주기: ${String(item.cycle)}` };
    const sig = `${source}:${JSON.stringify(Object.entries(params).sort())}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    series.push({
      source,
      params,
      cycle,
      name: typeof item.name === "string" ? item.name : "임의 시계열",
      unit: typeof item.unit === "string" ? item.unit : undefined,
      ...display,
    });
  }

  // 파생 계산 검증 — 인덱스가 series 범위 안에 있어야 한다
  let derived: PlanDerivedItem[] | undefined;
  if (b.derived !== undefined) {
    if (!Array.isArray(b.derived)) return { error: "derived는 배열이어야 합니다" };
    if (b.derived.length > MAX_DERIVED) return { error: `derived는 최대 ${MAX_DERIVED}개입니다` };
    derived = [];
    for (const d of b.derived as Record<string, unknown>[]) {
      if (!DERIVED_OPS.includes(d?.op as DerivedOp)) {
        return { error: `derived.op은 spread 또는 ratio여야 합니다: ${String(d?.op)}` };
      }
      const a = d.a;
      const bIdx = d.b;
      if (
        !Number.isInteger(a) || !Number.isInteger(bIdx) ||
        (a as number) < 0 || (a as number) >= series.length ||
        (bIdx as number) < 0 || (bIdx as number) >= series.length
      ) {
        return { error: `derived의 a·b는 series의 0~${series.length - 1} 인덱스여야 합니다` };
      }
      if (a === bIdx) return { error: "derived의 a와 b는 서로 달라야 합니다" };
      if (typeof d.name !== "string" || !d.name) return { error: "derived.name이 필요합니다" };
      if (d.axis !== undefined && !AXES.includes(d.axis as Axis)) {
        return { error: `derived.axis는 left 또는 right여야 합니다: ${String(d.axis)}` };
      }
      if (d.style !== undefined && !STYLES.includes(d.style as Style)) {
        return { error: `derived.style은 line·bar·area 중 하나여야 합니다: ${String(d.style)}` };
      }
      derived.push({
        op: d.op as DerivedOp,
        a: a as number,
        b: bIdx as number,
        name: d.name,
        axis: d.axis as Axis | undefined,
        style: d.style as Style | undefined,
      });
    }
  }

  const transform = b.transform as Transform;
  if (!TRANSFORMS.includes(transform)) {
    return { error: `지원하지 않는 변환: ${String(b.transform)}` };
  }
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const startDate = typeof b.startDate === "string" && dateRe.test(b.startDate) ? b.startDate : null;
  const endDate = typeof b.endDate === "string" && dateRe.test(b.endDate) ? b.endDate : null;
  if (!startDate || !endDate) return { error: "startDate/endDate는 YYYY-MM-DD 형식이어야 합니다" };

  return { plan: { series, derived, transform, startDate, endDate } };
}

/**
 * 별칭 강제 — 질의에 등록 지표의 별칭("슈퍼코어" 등)이 있는데 계획이 그 지표를
 * 쓰지 않으면 반려한다. 모델이 비슷해 보이는 다른 시리즈에 이름만 붙여 오는
 * 사고(절사평균 PCE를 슈퍼코어로 라벨)를 프롬프트가 아니라 코드로 막는다.
 * 매칭 기준은 레지스트리의 aliases 필드 — 지표 정의 단일 소스에서 파생.
 */
function aliasViolation(query: string, plan: Plan): string | null {
  // 띄어쓰기 무시 매칭 — "국고10년"과 "국고 10년"을 같은 표현으로 취급
  const norm = (s: string) => s.toLowerCase().replace(/\s/g, "");
  const q = norm(query);
  for (const ind of indicators) {
    for (const alias of ind.aliases ?? []) {
      if (!q.includes(norm(alias))) continue;
      const used = plan.series.some((s) => s.indicatorId === ind.id);
      if (!used) {
        return `질의에 "${alias}"가 있으므로 반드시 등록 지표 {"indicatorId": "${ind.id}"}를 series에 포함하세요. 카탈로그 검색 결과로 대체하지 마세요.`;
      }
    }
  }
  return null;
}

// ── 라우트 ─────────────────────────────────────────────────────
export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "OPENAI_API_KEY 환경변수가 설정되지 않았습니다" }, { status: 500 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "JSON body가 필요합니다" }, { status: 400 });
  }
  const query = (body as Record<string, unknown>)?.query;
  if (typeof query !== "string" || query.trim().length < 2) {
    return Response.json({ error: "query는 2자 이상의 문자열이어야 합니다" }, { status: 400 });
  }

  const model = process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL;
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt() },
    { role: "user", content: query.trim() },
  ];

  let promptTokens = 0;
  let completionTokens = 0;

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // 429(분당 토큰 한도)는 몇 초 뒤 풀리므로 짧은 백오프로 최대 2회 재시도.
      // 총 대기는 Vercel 20초 상한 안에 들어오도록 6초로 제한한다.
      let res: Response | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ model, messages, tools: TOOLS, temperature: 0 }),
        });
        if (res.status !== 429 || attempt === 2) break;
        const retryAfter = Number(res.headers.get("retry-after"));
        const waitMs = Math.min(
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 + 300 : 3000,
          6000
        );
        console.log(`[chat] 429 — ${waitMs}ms 후 재시도 (${attempt + 1}/2)`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
      if (!res || !res.ok) {
        const status = res?.status ?? 0;
        const errText = res ? await res.text() : "no response";
        console.error(`[chat] OpenAI HTTP ${status}: ${errText.slice(0, 500)}`);
        const hint =
          status === 429 ? " — 요청이 몰렸습니다. 몇 초 뒤 다시 시도하세요" : "";
        return Response.json({ error: `OpenAI 호출 실패 (HTTP ${status})${hint}` }, { status: 502 });
      }
      const json = await res.json();
      const usage: Usage | undefined = json.usage;
      if (usage) {
        promptTokens += usage.prompt_tokens ?? 0;
        completionTokens += usage.completion_tokens ?? 0;
      }
      const msg: ChatMessage = json.choices?.[0]?.message;
      if (!msg) return Response.json({ error: "OpenAI 응답 형식 오류" }, { status: 502 });
      messages.push(msg);

      // 텍스트로 종료 → 되묻기 등 그대로 전달
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        console.log(`[chat] model=${model} message-end tokens p=${promptTokens} c=${completionTokens}`);
        return Response.json({
          message: msg.content ?? "",
          usage: { model, promptTokens, completionTokens },
        });
      }

      for (const tc of msg.tool_calls) {
        let args: unknown = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}");
        } catch {
          args = {};
        }

        if (tc.function.name === "finalize_plan") {
          const { plan, error: planError } = validatePlan(args);
          const error = planError ?? (plan ? aliasViolation(query.trim(), plan) : null);
          if (plan && !error) {
            const note = (args as Record<string, unknown>)?.note;
            console.log(
              `[chat] model=${model} plan ok rounds=${round + 1} tokens p=${promptTokens} c=${completionTokens}`
            );
            return Response.json({
              plan,
              note: typeof note === "string" ? note : undefined,
              usage: { model, promptTokens, completionTokens },
            });
          }
          // 검증 실패 → 모델에 피드백하고 재시도 기회 제공
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({ error }),
          });
          continue;
        }

        let result: string;
        if (tc.function.name === "list_indicators") {
          result = runListIndicators();
        } else if (tc.function.name === "search_catalog") {
          result = await runSearchCatalog(args as { query?: unknown; source?: unknown });
        } else {
          result = JSON.stringify({ error: `알 수 없는 도구: ${tc.function.name}` });
        }
        messages.push({ role: "tool", tool_call_id: tc.id, content: result });
      }
    }

    console.log(`[chat] model=${model} round-limit tokens p=${promptTokens} c=${completionTokens}`);
    return Response.json(
      { error: `계획을 완성하지 못했습니다 (도구 호출 ${MAX_TOOL_ROUNDS}회 한도 초과). 질의를 조금 더 구체적으로 해주세요.` },
      { status: 502 }
    );
  } catch (err) {
    console.error("[chat] error", err);
    return Response.json({ error: String(err) }, { status: 502 });
  }
}
