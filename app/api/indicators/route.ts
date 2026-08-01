import { indicators } from "@/lib/indicators";

export async function GET() {
  return Response.json(
    indicators
      // 주요지표 화면에는 featured=false 지표를 숨긴다 — 챗(list_indicators)은 전체를 본다
      .filter((i) => i.featured !== false)
      .map(({ id, name, country, unit, cycle, origin, source, verified }) => ({
        id,
        name,
        country,
        unit,
        cycle,
        origin,
        source,
        verified,
      }))
  );
}
