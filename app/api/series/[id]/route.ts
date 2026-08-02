import { getIndicator } from "@/lib/indicators";
import { lookbackStart, normalizeDate, normalizePointDates } from "@/lib/dates";
import { applyTransform, REQUEST_TRANSFORMS, Transform } from "@/lib/transforms";
import { sources, SeriesPoint } from "@/lib/sources";

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
  const requested = (url.searchParams.get("transform") ?? "raw") as Transform;
  if (!(REQUEST_TRANSFORMS as readonly string[]).includes(requested)) {
    return Response.json({ error: `지원하지 않는 변환: ${requested}` }, { status: 400 });
  }

  // 지표 성격(kind) 기반 변환 대체 — 금리형에 비율 yoy를 걸면 "+130%" 같은
  // 무의미한 값이 나오므로 차(%p)로 바꾼다. 질의별 수리가 아니라 레지스트리
  // 메타데이터 하나로 전 지표에 일괄 적용되는 규칙.
  let transform = requested;
  let note: string | undefined;
  if (indicator.kind === "rate" && (requested === "yoy" || requested === "pop")) {
    transform = requested === "yoy" ? "yoy_diff" : "pop_diff";
    note = `"${indicator.name}"은(는) 금리형 지표라 ${requested === "yoy" ? "전년동기대비" : "전기대비"}를 %p 차이로 계산했어요`;
  }

  // yoy·pop 계열은 구간 앞 1년을 선행 조회해야 구간 첫 시점부터 값이 나온다
  const needsLookback = transform !== "raw" && transform !== "rebase";
  const fetchStart = needsLookback ? lookbackStart(start) : start;

  // 원천 소스 → 실패 시 fallback (재수록본 이중화)
  let points: SeriesPoint[];
  let usedSource = indicator.source;
  try {
    points = await sources[indicator.source].fetchSeries(indicator.params, { start: fetchStart, end });
  } catch (primaryErr) {
    if (!indicator.fallback) {
      return Response.json({ error: String(primaryErr) }, { status: 502 });
    }
    try {
      usedSource = indicator.fallback.source;
      points = await sources[usedSource].fetchSeries(indicator.fallback.params, { start: fetchStart, end });
    } catch (fallbackErr) {
      return Response.json(
        { error: `원천 실패: ${String(primaryErr)} / fallback 실패: ${String(fallbackErr)}` },
        { status: 502 }
      );
    }
  }

  // 표시단위 환산 — 원천이 백만 달러로 주는 계열을 십억 달러로 맞춘다.
  // 변환(yoy·rebase)보다 먼저 적용해야 원계열 단위와 표기가 어긋나지 않는다.
  // (fallback 경로도 같은 지표의 재수록본이므로 같은 계수를 쓴다.)
  const scaled =
    indicator.divideBy && indicator.divideBy !== 1
      ? points.map((p) => ({
          ...p,
          value: p.value == null ? null : p.value / indicator.divideBy!,
        }))
      : points;

  const transformed = applyTransform(
    normalizePointDates(scaled, indicator.cycle),
    transform,
    indicator.cycle
  );
  const fromDate = normalizeDate(start, indicator.cycle);

  return Response.json({
    indicator: { id: indicator.id, name: indicator.name, unit: indicator.unit, cycle: indicator.cycle },
    source: usedSource,
    transform,
    note,
    // 선행조회분은 계산에만 쓰고 응답은 요청 구간으로 잘라 돌려준다
    points: needsLookback ? transformed.filter((p) => p.date >= fromDate) : transformed,
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
