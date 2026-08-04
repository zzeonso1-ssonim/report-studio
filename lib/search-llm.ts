import {
  SEARCH_LLM_CACHE_SIZE,
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
 *    앞에서부터 N개를 자르면 찾는 항목이 통째로 밀려난다.
 *
 * 설계 원칙
 *  - **폴백 우선**: 키 미설정·HTTP 오류·시간초과·형식 오류는 전부 null을 돌려주고
 *    호출부는 기존 문자열 경로를 그대로 쓴다. LLM이 꺼져도 지금보다 나빠지지 않는다.
 *  - **호출 통제**: 질의 1건당 최대 2회(분해 1 + 선별 1). 같은 입력은 프로세스
 *    메모리 캐시로 0회. 모델은 값싼 SEARCH_LLM_MODEL(기본 gpt-4o-mini).
 *  - **판단은 하되 숫자는 만들지 않는다**: 검색어와 후보 순서만 다룬다.
 */

/** 질의를 소스별 검색어로 분해한 결과. 값이 없는 소스는 조회하지 않는다는 뜻 */
export interface SourcePlan {
  ecos?: string;
  kosis?: string;
  fred?: string;
  /** 질의가 콕 집은 세부 항목명(예: 기업대출·주택담보대출) — 항목 관련도 정렬에 쓴다 */
  items: string[];
}

interface CacheEntry<T> {
  value: T;
}

/** 삽입 순서 기반 LRU — 프로세스 메모리, 서버리스에서는 인스턴스별 */
class Lru<T> {
  private map = new Map<string, CacheEntry<T>>();
  constructor(private limit: number) {}
  get(key: string): T | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    // 최근 사용으로 갱신
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }
  set(key: string, value: T): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value });
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}

const planCache = new Lru<SourcePlan | null>(SEARCH_LLM_CACHE_SIZE);
const pickCache = new Lru<number[] | null>(SEARCH_LLM_CACHE_SIZE);

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
  "당신은 경제통계 카탈로그 검색어 분해기입니다. 사용자의 한국어 질의를 소스별 검색어로 나눕니다.",
  "",
  "소스:",
  "- ecos: 한국은행 경제통계시스템. 한국 금리·환율·통화·국제수지·자금순환. 검색어는 한국어 통계표 이름 표현.",
  "- kosis: 통계청 국가통계포털. 한국 물가·고용·인구·산업·소비. 검색어는 한국어 통계표 이름 표현.",
  "- fred: 미국 세인트루이스 연은. 미국·글로벌 지표. 검색어는 반드시 영어. 한국어를 넣으면 결과가 0건입니다.",
  "",
  "규칙:",
  '- 각 소스에 필요 없으면 null을 넣으세요. 한국 지표만 물으면 fred는 null, 미국 지표만 물으면 ecos·kosis는 null입니다.',
  '- 다만 질의가 미국·해외 지표를 조금이라도 언급하면 fred를 반드시 영어 검색어로 채우세요. 한국 지표를 언급하면 ecos나 kosis 중 맞는 쪽을 채우세요. 한 질의가 두 나라를 비교하면 양쪽을 모두 채웁니다.',
  "- 검색어는 통계표 이름에 실제로 들어갈 만한 짧은 명사구로 쓰세요. 문장·조사·기간 표현(3년치)·변환 표현(전년대비)은 빼세요.",
  '- 질의가 표 안의 세부 항목을 콕 집으면(예: "기업대출, 가계대출, 주택담보대출") 그 이름들을 items 배열에 그대로 담으세요. 없으면 빈 배열.',
  '- 질의에 목차번호(예: 1.3.3.2.1)가 있으면 해당 소스 검색어 앞에 그대로 남기세요.',
  "",
  '출력은 JSON만: {"ecos": string|null, "kosis": string|null, "fred": string|null, "items": string[]}',
].join("\n");

/**
 * 질의 → 소스별 검색어. 실패하면 null(호출부가 원문 그대로 쓰는 기존 경로로 폴백).
 * 같은 질의는 캐시에서 돌려주므로 반복 호출 비용이 0이다.
 */
export async function planSourceQueries(q: string): Promise<SourcePlan | null> {
  if (!isSearchLlmEnabled()) return null;
  const key = `plan:${q}`;
  const cached = planCache.get(key);
  if (cached !== undefined) return cached;

  const json = await callJson(PLAN_SYSTEM, q, 300);
  let plan: SourcePlan | null = null;
  if (json) {
    const str = (v: unknown): string | undefined => {
      const s = typeof v === "string" ? v.trim() : "";
      return s.length >= 2 ? s : undefined;
    };
    const items = Array.isArray(json.items)
      ? json.items.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      : [];
    const candidate: SourcePlan = {
      ecos: str(json.ecos),
      kosis: str(json.kosis),
      fred: str(json.fred),
      items,
    };
    // 세 소스가 전부 비면 분해 실패로 보고 폴백한다 (검색을 통째로 잃지 않게)
    if (candidate.ecos || candidate.kosis || candidate.fred) plan = candidate;
  }
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
    const json = await callJson(PICK_SYSTEM, `질의: ${q}\n\n후보(인덱스\\t소스\\t이름\\t주기\\t단위):\n${listing}`, 400);
    const raw = json?.picks;
    picks = Array.isArray(raw)
      ? raw
          .filter((n): n is number => Number.isInteger(n) && n >= 0 && n < pool.length)
          .filter((n, i, a) => a.indexOf(n) === i)
      : null;
    pickCache.set(key, picks);
  }
  if (!picks || picks.length === 0) return candidates;

  const chosen = new Set(picks);
  return [
    ...picks.map((i) => pool[i]),
    ...candidates.filter((_, i) => !(i < pool.length && chosen.has(i))),
  ];
}
