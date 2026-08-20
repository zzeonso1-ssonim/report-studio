import { listSectorSnapshots } from "@/lib/outlook/store";

export const dynamic = "force-dynamic";

/** GET /api/outlook/sectors — 현재 섹터 원장 상태만 반환. */
export async function GET() {
  return Response.json({ sectors: await listSectorSnapshots() });
}
