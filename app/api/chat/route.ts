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

/** 기본 모델 — 유일한 기본값 상수. 환경변수 OPENAI_MODEL로 재정의 가능. */
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

const MAX_TOOL_ROUNDS = 6;
const MAX_SERIES = 4;
const TRANSFORMS: Transform[] = ["raw", "yoy", "pop", "rebase"];
const CYCLES: Cycle[] = ["D", "M", "Q", "A"];

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
}

interface Plan {
  series: PlanSeriesItem[];
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
    `- 먼저 list_indicators로 등록 지표를 확인하세요. 등록 지표로 충분하면 series 항목을 {"indicatorId": "..."}로 지정하세요.`,
    `- 등록 지표에 없는 데이터만 search_catalog(ECOS·KOSIS·FRED 카탈로그 검색)로 찾으세요. 검색 결과를 쓸 때는 그 결과의 source·params·cycle·name·unit을 변형 없이 그대로 finalize_plan의 series 항목에 넣으세요.`,
    `- 질의가 언급하는 모든 시계열 대상을 빠짐없이 series에 넣으세요. 두 나라·두 지표를 비교하는 질의("A랑 B", "A vs B")면 반드시 각각 별도의 series 항목으로 모두 포함해야 합니다. 시리즈는 최대 ${MAX_SERIES}개.`,
    `- transform: raw(원계열) | yoy(전년동기대비 %) | pop(전기대비 %) | rebase(구간 시작=100). 질의에 "전년동기대비"·"YoY"·"상승률"·"증가율" 등이 있으면 yoy. 단위가 서로 다른 지표를 한 차트에 비교할 때는 yoy 또는 rebase를 권장합니다. 금리처럼 단위(%)가 같은 수준(level) 비교는 raw.`,
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
              },
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
    indicators.map(({ id, name, country, unit, cycle, origin }) => ({
      id,
      name,
      country,
      unit,
      cycle,
      origin,
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
  for (const item of b.series as Record<string, unknown>[]) {
    if (typeof item?.indicatorId === "string" && item.indicatorId) {
      if (!getIndicator(item.indicatorId)) {
        return { error: `알 수 없는 indicatorId: ${item.indicatorId}. list_indicators의 id를 사용하세요.` };
      }
      series.push({ indicatorId: item.indicatorId });
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
    series.push({
      source,
      params,
      cycle,
      name: typeof item.name === "string" ? item.name : "임의 시계열",
      unit: typeof item.unit === "string" ? item.unit : undefined,
    });
  }

  const transform = b.transform as Transform;
  if (!TRANSFORMS.includes(transform)) {
    return { error: `지원하지 않는 변환: ${String(b.transform)}` };
  }
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const startDate = typeof b.startDate === "string" && dateRe.test(b.startDate) ? b.startDate : null;
  const endDate = typeof b.endDate === "string" && dateRe.test(b.endDate) ? b.endDate : null;
  if (!startDate || !endDate) return { error: "startDate/endDate는 YYYY-MM-DD 형식이어야 합니다" };

  return { plan: { series, transform, startDate, endDate } };
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
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, messages, tools: TOOLS, temperature: 0 }),
      });
      if (!res.ok) {
        const errText = await res.text();
        console.error(`[chat] OpenAI HTTP ${res.status}: ${errText.slice(0, 500)}`);
        return Response.json({ error: `OpenAI 호출 실패 (HTTP ${res.status})` }, { status: 502 });
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
          const { plan, error } = validatePlan(args);
          if (plan) {
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
