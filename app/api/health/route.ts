import { ecosItemIndexStatus } from "@/lib/ecos-item-index";

/**
 * GET /api/health — 조용히 품질이 떨어진 상태를 드러내는 점검 창구.
 *
 * 지금 담는 것은 ECOS 항목명 색인 하나다. 이 색인이 빠지면 검색이 수정 전
 * 상태로 회귀하는데(항목 이름에만 있는 국고채 계열이 통째로 안 잡힘) 겉으로는
 * "결과가 좀 적네"로만 보여서 아무도 눈치채지 못한다. 배포 후 이 엔드포인트로
 * `indexAvailable`과 `builtAt`(색인 기준일)을 확인한다.
 *
 * 응답: { ok, checkedAt, ecosItemIndex: { available, builtAt, indexedTables, reason? } }
 * ok=false면 기능이 죽은 것은 아니고 **품질이 떨어진 상태**다.
 */
export async function GET() {
  const index = ecosItemIndexStatus();
  return Response.json(
    {
      ok: index.available,
      checkedAt: new Date().toISOString(),
      ecosItemIndex: index,
    },
    { status: index.available ? 200 : 503 }
  );
}
