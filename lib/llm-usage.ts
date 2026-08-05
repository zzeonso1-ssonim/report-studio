import { AsyncLocalStorage } from "node:async_hooks";

/**
 * 요청 1건이 쓴 LLM 자원을 세는 계측 — **관측만 한다. 동작을 바꾸지 않는다.**
 *
 * 왜 있는가 (2026-08-05): /api/chat은 도구 호출을 최대 MAX_TOOL_ROUNDS까지
 * 반복하고, 검색이 지표를 못 찾으면 라운드를 더 태운다. 즉 **검색 결손이 곧
 * 비용**인데, 지금까지 "질의 1건에 얼마"를 잰 적이 없었다. 라운드 상한을 걸지
 * 말지는 품질 트레이드오프라 사람이 정할 일이고, 그 판단에는 숫자가 먼저 필요하다.
 *
 * 무엇을 세는가
 *  - 도구 호출 라운드 수
 *  - OpenAI 호출 횟수와 **모델별** prompt/completion 토큰 (플래너 gpt-4o와
 *    검색 보조 gpt-4o-mini가 한 요청 안에서 섞이므로 모델별로 나눈다)
 *  - 총 소요 시간
 *
 * 무엇을 세지 않는가
 *  - 질의 원문·프롬프트·응답 본문. 로그에는 숫자만 남긴다.
 *
 * 어떻게: AsyncLocalStorage로 요청 하나를 감싼다. 감싸지 않은 경로(예: /api/search)
 * 에서 호출하면 전부 no-op이라 기존 동작에 영향이 없다.
 */

export interface ModelUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  /**
   * 그중 **캐시 적중분**(OpenAI `usage.prompt_tokens_details.cached_tokens`).
   * 같은 시스템 프롬프트·도구 정의를 라운드마다 다시 보내는 구조라 캐시가
   * 들으면 입력 요금이 크게 내려간다. 0이 계속 나오면 접두가 매번 달라지거나
   * 최소 길이 미달이라는 뜻이므로, 진단 근거로 남긴다.
   */
  cachedPromptTokens: number;
}

export interface LlmUsageSummary {
  rounds: number;
  calls: number;
  elapsedMs: number;
  byModel: Record<string, ModelUsage>;
}

interface Store {
  rounds: number;
  startedAt: number;
  byModel: Map<string, ModelUsage>;
}

const storage = new AsyncLocalStorage<Store>();

/**
 * 계측 로그 on/off — 기본 on. 끄려면 `LLM_USAGE_LOG=off`.
 * 값은 여기 한 곳에서만 읽는다(단일 소스).
 */
export const LLM_USAGE_LOG = process.env.LLM_USAGE_LOG !== "off";

/** 요청 하나를 계측 범위로 감싼다. 이 안에서만 아래 기록 함수들이 동작한다. */
export function withLlmUsage<T>(fn: () => Promise<T>): Promise<T> {
  return storage.run({ rounds: 0, startedAt: Date.now(), byModel: new Map() }, fn);
}

function slot(model: string): ModelUsage | null {
  const store = storage.getStore();
  if (!store) return null;
  let m = store.byModel.get(model);
  if (!m) {
    m = { calls: 0, promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0 };
    store.byModel.set(model, m);
  }
  return m;
}

/** 도구 호출 라운드 1회 진입 */
export function countRound(): void {
  const store = storage.getStore();
  if (store) store.rounds += 1;
}

/** OpenAI HTTP 시도 1회 (실패·429 재시도도 호출이므로 함께 센다) */
export function recordLlmCall(model: string): void {
  const m = slot(model);
  if (m) m.calls += 1;
}

/** OpenAI 응답의 usage 필드 반영 — 값이 없으면 아무것도 더하지 않는다 */
export function addLlmTokens(
  model: string,
  prompt?: number,
  completion?: number,
  cachedPrompt?: number
): void {
  const m = slot(model);
  if (!m) return;
  m.promptTokens += prompt ?? 0;
  m.completionTokens += completion ?? 0;
  m.cachedPromptTokens += cachedPrompt ?? 0;
}

/** 현재 요청의 집계. 계측 범위 밖이면 null. */
export function llmUsageSummary(): LlmUsageSummary | null {
  const store = storage.getStore();
  if (!store) return null;
  let calls = 0;
  const byModel: Record<string, ModelUsage> = {};
  for (const [model, m] of store.byModel) {
    calls += m.calls;
    byModel[model] = { ...m };
  }
  return { rounds: store.rounds, calls, elapsedMs: Date.now() - store.startedAt, byModel };
}

/**
 * 한 줄 요약 로그. 질의 원문은 절대 넣지 않는다.
 * 예: `[usage] chat rounds=3 calls=5 elapsed=4210ms gpt-4o(3) p=24180 c=412 cached=0 | gpt-4o-mini(2) p=3110 c=180 cached=0`
 */
export function logLlmUsage(tag: string): void {
  if (!LLM_USAGE_LOG) return;
  const s = llmUsageSummary();
  if (!s) return;
  const perModel = Object.entries(s.byModel)
    .map(
      ([model, m]) =>
        `${model}(${m.calls}) p=${m.promptTokens} c=${m.completionTokens} cached=${m.cachedPromptTokens}`
    )
    .join(" | ");
  console.log(
    `[usage] ${tag} rounds=${s.rounds} calls=${s.calls} elapsed=${s.elapsedMs}ms ` +
      (perModel || "(호출 없음)")
  );
}
