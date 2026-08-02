import { indicators } from "@/lib/indicators";

export async function GET() {
  // 전체를 내려주되 featured로 구분한다 — 주요지표 체크리스트는 featured만
  // 그리지만, 챗 계획이 선택한 숨김 지표도 이름을 알아야 화면에서 보이고
  // 제거할 수 있다(보이지 않는 유령 선택 금지).
  return Response.json(
    indicators.map(({ id, name, country, unit, cycle, origin, source, verified, featured }) => ({
      id,
      name,
      country,
      unit,
      cycle,
      origin,
      source,
      verified,
      featured: featured !== false,
    }))
  );
}
