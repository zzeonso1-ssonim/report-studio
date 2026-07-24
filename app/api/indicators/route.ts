import { indicators } from "@/lib/indicators";

export async function GET() {
  return Response.json(
    indicators.map(({ id, name, country, unit, cycle, origin, source, verified }) => ({
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
