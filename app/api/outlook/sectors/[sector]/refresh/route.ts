import { getSectorManifest } from "@/lib/outlook/sector-manifest";
import { refreshSector } from "@/lib/outlook/refresh";
import { getSectorSnapshot } from "@/lib/outlook/store";
import { isSectorId } from "@/lib/outlook/types";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  context: { params: Promise<{ sector: string }> }
) {
  const { sector } = await context.params;
  if (!isSectorId(sector)) {
    return Response.json({ error: `알 수 없는 섹터: ${sector}` }, { status: 404 });
  }

  const manifest = getSectorManifest(sector);
  if (!manifest.probes.length) {
    return Response.json(
      {
        error: "지표 구성 대기: 섹터 내용을 확정한 뒤 데이터 소스를 연결합니다",
        sector: await getSectorSnapshot(sector),
      },
      { status: 409 }
    );
  }

  try {
    const snapshot = await refreshSector(sector);
    return Response.json(
      { sector: snapshot },
      { status: snapshot.status === "error" ? 502 : 200 }
    );
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : String(error),
        sector: await getSectorSnapshot(sector),
      },
      { status: 502 }
    );
  }
}
