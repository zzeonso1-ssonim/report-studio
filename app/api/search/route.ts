import { searchAll } from "@/lib/search";

/**
 * GET /api/search?q=검색어
 * ECOS·KOSIS·FRED 전체 통계 카탈로그 통합 검색.
 * 응답: { query, results: SearchResult[], errors: string[] }
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q.length < 2) {
    return Response.json({ error: "검색어는 2자 이상이어야 합니다" }, { status: 400 });
  }

  const { results, errors } = await searchAll(q);
  return Response.json({ query: q, results, errors });
}
