import { searchAll } from "@/lib/search";
import { FUNCTION_MAX_DURATION_S } from "@/lib/search-config";

/**
 * GET /api/search?q=검색어
 * ECOS·KOSIS·FRED 전체 통계 카탈로그 통합 검색.
 * 응답: { query, results: SearchResult[], errors: string[], notes: string[] }
 */

/**
 * 서버리스 함수 상한(초).
 * Next는 이 값을 빌드타임 정적 리터럴로만 받아 상수 import를 쓸 수 없다.
 * 단일 소스는 lib/search-config.ts의 FUNCTION_MAX_DURATION_S이며,
 * 어긋나면 아래 대조에서 개발 중에 드러난다.
 */
export const maxDuration = 25;

if (process.env.NODE_ENV !== "production" && maxDuration !== FUNCTION_MAX_DURATION_S) {
  throw new Error(
    `maxDuration(${maxDuration})이 FUNCTION_MAX_DURATION_S(${FUNCTION_MAX_DURATION_S})와 다릅니다 — lib/search-config.ts와 맞추세요`
  );
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q.length < 2) {
    return Response.json({ error: "검색어는 2자 이상이어야 합니다" }, { status: 400 });
  }

  // llm=off — LLM 보조를 끈 결과를 같은 서버에서 대조하기 위한 진단 스위치.
  // "LLM ON은 OFF의 상위집합"이라는 불변조건은 측정으로만 지킬 수 있다
  // (scripts/search-ab-check.py가 이 파라미터를 쓴다).
  const llm = url.searchParams.get("llm") !== "off";
  const { results, errors, notes, truncated } = await searchAll(q, { llm });
  return Response.json({ query: q, llm, results, errors, notes, truncated });
}
