import { getIndicator } from "@/lib/indicators";
import { normalizePointDates } from "@/lib/dates";
import { applyTransform, Transform } from "@/lib/transforms";
import { sources, SeriesPoint } from "@/lib/sources";

const TRANSFORMS: Transform[] = ["raw", "yoy", "pop", "rebase"];

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const indicator = getIndicator(id);
  if (!indicator) {
    return Response.json({ error: `알 수 없는 지표: ${id}` }, { status: 404 });
  }

  const url = new URL(request.url);
  const start = url.searchParams.get("start") ?? defaultStart();
  const end = url.searchParams.get("end") ?? today();
  const transform = (url.searchParams.get("transform") ?? "raw") as Transform;
  if (!TRANSFORMS.includes(transform)) {
    return Response.json({ error: `지원하지 않는 변환: ${transform}` }, { status: 400 });
  }

  // 원천 소스 → 실패 시 fallback (재수록본 이중화)
  let points: SeriesPoint[];
  let usedSource = indicator.source;
  try {
    points = await sources[indicator.source].fetchSeries(indicator.params, { start, end });
  } catch (primaryErr) {
    if (!indicator.fallback) {
      return Response.json({ error: String(primaryErr) }, { status: 502 });
    }
    try {
      usedSource = indicator.fallback.source;
      points = await sources[usedSource].fetchSeries(indicator.fallback.params, { start, end });
    } catch (fallbackErr) {
      return Response.json(
        { error: `원천 실패: ${String(primaryErr)} / fallback 실패: ${String(fallbackErr)}` },
        { status: 502 }
      );
    }
  }

  return Response.json({
    indicator: { id: indicator.id, name: indicator.name, unit: indicator.unit, cycle: indicator.cycle },
    source: usedSource,
    transform,
    points: applyTransform(
      normalizePointDates(points, indicator.cycle),
      transform,
      indicator.cycle
    ),
  });
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function defaultStart(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 5);
  return d.toISOString().slice(0, 10);
}
