import {
  SEARCH_LLM_CACHE_SIZE,
  SEARCH_LLM_CACHE_TTL_MS,
  SEARCH_LLM_CANDIDATES,
  SEARCH_LLM_MODEL,
  SEARCH_LLM_TIMEOUT_MS,
} from "./search-config";
import { SearchResult } from "./search-types";

/**
 * 통합검색의 LLM 보조 — 서버 전용 (OPENAI_API_KEY 사용).
 *
 * 왜 필요한가: 문자열 대조만으로는 다음이 구조적으로 안 된다.
 *  - 한 질의 안에 여러 나라·기관이 섞인 경우("한국 대출금리랑 미국 모기지금리")
 *    → 소스마다 필요한 검색어가 다른데 원문 하나를 세 곳에 똑같이 보낸다.
 *    특히 한글이 그대로 FRED로 가면 0건 + 장시간 지연이다.
 *  - 후보가 수십 건일 때 "무엇이 질의에 맞는지"를 판단할 기준이 없다.
 *
 * ── 설계 원칙: 넓히는 데만 쓴다 ────────────────────────────────
 * **LLM은 후보를 좁히지 못한다.** 2026-08-05 실측에서 "필요 없는 소스는 null"
 * 권한을 줬더니 ON이 OFF보다 결과가 좁아지는 역전이 났다(생산자물가 세부품목
 * ON 36건 / OFF 96건 등). 그래서 지금 LLM이 하는 일은 둘뿐이다.
 *   ① 소스별 검색어를 **추가로** 제안한다 (원문 검색은 항상 그대로 돈다)
 *   ② 이미 모인 후보의 **순서만** 바꾼다 (후보를 버리지 않는다)
 *
 * 그 밖의 원칙
 *  - **폴백 우선**: 키 미설정·HTTP 오류·시간초과·형식 오류는 전부 null을 돌려주고
 *    호출부는 문자열 경로를 그대로 쓴다.
 *  - **호출 통제**: 질의 1건당 최대 2회(제안 1 + 정렬 1). 같은 입력은 프로세스
 *    메모리 캐시로 0회. 모델은 값싼 SEARCH_LLM_MODEL(기본 gpt-4o-mini).
 *  - **판단은 하되 숫자는 만들지 않는다**: 검색어와 후보 순서만 다룬다.
 */

/**
 * 질의에서 뽑아낸 소스별 **추가** 검색어.
 * 비어 있어도 그 소스를 건너뛴다는 뜻이 아니다 — 원문 검색은 언제나 별도로 돈다.
 */
export interface SourcePlan {
  ecos?: string;
  kosis?: string;
  fred?: string;
  /** 질의가 콕 집은 세부 항목명(예: 기업대출·주택담보대출) — 항목 관련도 정렬에 쓴다 */
  items: string[];
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * 삽입 순서 기반 LRU + TTL — 프로세스 메모리, 서버리스에서는 인스턴스별.
 * TTL이 없으면 한 번 나온 오답이 인스턴스 수명 내내 고착된다.
 */
class Lru<T> {
  private map = new Map<string, CacheEntry<T>>();
  constructor(
    private limit: number,
    private ttlMs: number
  ) {}
  get(key: string): T | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // 최근 사용으로 갱신
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }
  set(key: string, value: T): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}

const planCache = new Lru<SourcePlan>(SEARCH_LLM_CACHE_SIZE, SEARCH_LLM_CACHE_TTL_MS);
const pickCache = new Lru<number[]>(SEARCH_LLM_CACHE_SIZE, SEARCH_LLM_CACHE_TTL_MS);

/** 캐시 키용 짧은 해시 (FNV-1a) — 후보 목록처럼 긴 입력을 키로 쓸 때 */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function isSearchLlmEnabled(): boolean {
  return Boolean(process.env.OPENAI_API_KEY) && process.env.SEARCH_LLM !== "off";
}

/** OpenAI JSON 응답 1회 호출. 실패·시간초과는 전부 null (호출부가 폴백) */
async function callJson(
  system: string,
  user: string,
  maxTokens: number
): Promise<Record<string, unknown> | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), SEARCH_LLM_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      signal: abort.signal,
      body: JSON.stringify({
        model: SEARCH_LLM_MODEL,
        temperature: 0,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) {
      console.warn(`[search-llm] HTTP ${res.status} — 문자열 경로로 폴백`);
      return null;
    }
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== "string") return null;
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch (err) {
    const why = (err as Error)?.name === "AbortError" ? "시간초과" : String(err);
    console.warn(`[search-llm] 실패(${why}) — 문자열 경로로 폴백`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const PLAN_SYSTEM = [
  "당신은 경제통계 카탈로그 검색어 생성기입니다. 사용자의 한국어 질의를 보고, 각 소스에서 **추가로** 찾아볼 검색어를 만듭니다.",
  "",
  "중요: 사용자의 원문 검색은 이미 세 소스 모두에서 별도로 실행됩니다. 당신의 검색어는 거기에 **더해질** 뿐입니다.",
  "따라서 '이 소스는 필요 없다'는 판단은 하지 마세요. 당신이 비워도 그 소스 조회가 취소되지 않으며, 좋은 검색어를 못 넣으면 찾을 기회만 줄어듭니다.",
  "",
  "소스:",
  "- ecos: 한국은행 경제통계시스템. 한국 금리·환율·통화·국제수지·자금순환, 국제 비교표(주요국 물가·금리)도 있음. 검색어는 한국어 통계표/항목 이름 표현.",
  "- kosis: 통계청 국가통계포털. 한국 물가·고용·인구·산업·소비·가계수지. 검색어는 한국어 통계표 이름 표현.",
  "- fred: 미국 세인트루이스 연은. 미국·글로벌 지표. 검색어는 반드시 영어. 한국어를 넣으면 결과가 0건입니다.",
  "",
  "규칙:",
  "- 세 소스를 되도록 모두 채우세요. 한국 지표 질의라도 ecos·kosis 양쪽에 각각 맞는 표현을 넣으세요(같은 주제를 두 기관이 다르게 부릅니다).",
  "- fred는 질의가 한국 지표만 다루더라도 대응되는 미국·국제 계열이 있으면 영어로 채우세요. 정말 대응물이 없을 때만 null.",
  "- 검색어는 통계표나 항목 이름에 실제로 들어갈 만한 짧은 명사구로 쓰세요. 문장·조사·기간 표현(3년치)·변환 표현(전년대비)은 빼세요.",
  '- 질의가 표 안의 세부 항목을 콕 집으면(예: "기업대출, 가계대출, 주택담보대출") 그 이름들을 items 배열에 그대로 담으세요. 없으면 빈 배열.',
  '- 질의에 목차번호(예: 1.3.3.2.1)가 있으면 해당 소스 검색어 앞에 그대로 남기세요.',
  "",
  '출력은 JSON만: {"ecos": string|null, "kosis": string|null, "fred": string|null, "items": string[]}',
].join("\n");

/**
 * 질의 → 소스별 **추가** 검색어. 실패하면 null이고, 호출부는 원문만으로 검색한다.
 * 같은 질의는 캐시에서 돌려주므로 반복 호출 비용이 0이다.
 * 실패(null)는 캐시하지 않는다 — 일시적 오류를 TTL 내내 고착시키지 않기 위함.
 */
export async function planSourceQueries(q: string): Promise<SourcePlan | null> {
  if (!isSearchLlmEnabled()) return null;
  const key = `plan:${q}`;
  const cached = planCache.get(key);
  if (cached !== undefined) return cached;

  const json = await callJson(PLAN_SYSTEM, q, 300);
  if (!json) return null;

  const str = (v: unknown): string | undefined => {
    const s = typeof v === "string" ? v.trim() : "";
    return s.length >= 2 ? s : undefined;
  };
  const items = Array.isArray(json.items)
    ? json.items.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    : [];
  const plan: SourcePlan = {
    ecos: str(json.ecos),
    kosis: str(json.kosis),
    fred: str(json.fred),
    items,
  };
  if (!plan.ecos && !plan.kosis && !plan.fred && items.length === 0) return null;
  planCache.set(key, plan);
  return plan;
}

const PICK_SYSTEM = [
  "당신은 경제통계 후보 선별기입니다. 사용자의 질의와 검색 후보 목록을 받아, 질의에 맞는 후보를 고릅니다.",
  "",
  "규칙:",
  "- 질의가 여러 계열을 요구하면(예: 기업대출·가계대출·주택담보대출 셋) 해당하는 후보를 모두 고르세요.",
  "- 질의가 여러 나라·기관을 비교하면 각 나라·기관의 후보를 최소 1건씩 남기세요.",
  "- 관련도가 높은 순으로 정렬해 인덱스만 배열로 돌려주세요. 관련 없는 후보는 빼세요.",
  "- 후보를 하나도 못 고르겠으면 빈 배열을 돌려주세요. 인덱스를 지어내지 마세요.",
  "",
  '출력은 JSON만: {"picks": number[]}',
].join("\n");

/**
 * 후보를 질의 관련도 순으로 재정렬한다(선별이 아니라 정렬 — 후보를 버리지 않는다).
 * 고른 것을 앞으로 보내고 나머지는 원래 순서로 뒤에 붙인다. 실패하면 원본 그대로.
 *
 * 버리지 않는 이유: LLM이 잘못 골라도 뒤쪽에 남아 있으면 상한 안에서 회복 가능하고,
 * UI 검색 결과에서 사용자가 직접 고를 수 있다.
 */
export async function rankByRelevance(
  q: string,
  candidates: SearchResult[]
): Promise<SearchResult[]> {
  if (!isSearchLlmEnabled() || candidates.length <= 1) return candidates;
  const pool = candidates.slice(0, SEARCH_LLM_CANDIDATES);
  const listing = pool
    .map((r, i) => `${i}\t${r.source}\t${r.name}\t${r.cycle}\t${r.unit ?? ""}`)
    .join("\n");
  const key = `pick:${q}:${hash(listing)}`;
  let picks = pickCache.get(key);
  if (picks === undefined) {
    const json = await callJson(
      PICK_SYSTEM,
      `질의: ${q}\n\n후보(인덱스\\t소스\\t이름\\t주기\\t단위):\n${listing}`,
      400
    );
    const raw = json?.picks;
    const parsed = Array.isArray(raw)
      ? raw
          .filter((n): n is number => Number.isInteger(n) && n >= 0 && n < pool.length)
          .filter((n, i, a) => a.indexOf(n) === i)
      : null;
    if (!parsed || parsed.length === 0) return candidates; // 실패는 캐시하지 않는다
    picks = parsed;
    pickCache.set(key, picks);
  }

  const chosen = new Set(picks);
  return [
    ...picks.map((i) => pool[i]),
    ...candidates.filter((_, i) => !(i < pool.length && chosen.has(i))),
  ];
}
