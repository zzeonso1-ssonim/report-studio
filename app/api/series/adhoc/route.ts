import { Cycle } from "@/lib/indicators";
import { lookbackStart, normalizeDate, normalizePointDates } from "@/lib/dates";
import { applyTransform, REQUEST_TRANSFORMS, resolveTransform, Transform } from "@/lib/transforms";
import { sources } from "@/lib/sources";
const CYCLES: Cycle[] = ["D", "M", "Q", "A"];

/**
 * POST /api/series/adhoc
 * body: { source, params, cycle, start?, end?, transform?, name?, unit? }
 * 검색으로 찾은 임의 시계열을 등록 지표와 동일한 경로(어댑터+변환)로 조회.
 * 소스는 레지스트리 화이트리스트로 검증하고, API 키는 서버에서만 사용된다.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "JSON body가 필요합니다" }, { status: 400 });
  }
  const b = body as Record<string, unknown>;

  const source = b.source;
  if (typeof source !== "string" || !(source in sources)) {
    return Response.json({ error: `알 수 없는 소스: ${String(source)}` }, { status: 400 });
  }

  const rawParams = b.params;
  if (typeof rawParams !== "object" || rawParams === null || Array.isArray(rawParams)) {
    return Response.json({ error: "params 객체가 필요합니다" }, { status: 400 });
  }
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawParams as Record<string, unknown>)) {
    if (typeof v !== "string") {
      return Response.json({ error: `params.${k}는 문자열이어야 합니다` }, { status: 400 });
    }
    params[k] = v;
  }

  const cycle = (b.cycle ?? "M") as Cycle;
  if (!CYCLES.includes(cycle)) {
    return Response.json({ error: `지원하지 않는 주기: ${String(b.cycle)}` }, { status: 400 });
  }
  const requested = (b.transform ?? "raw") as Transform;
  if (!(REQUEST_TRANSFORMS as readonly string[]).includes(requested)) {
    return Response.json({ error: `지원하지 않는 변환: ${String(b.transform)}` }, { status: 400 });
  }
  const start = typeof b.start === "string" ? b.start : defaultStart();
  const end = typeof b.end === "string" ? b.end : today();

  const name = typeof b.name === "string" ? b.name : "임의 시계열";
  const unit = typeof b.unit === "string" ? b.unit : "";

  // 검색 시리즈는 kind 메타데이터가 없어 단위 문자열로 성격을 판정한다.
  // ① 이미 변화율 단위("% Chg." 등) → 이중 변환 금지, 원계열로 강등
  // ② 수준이 %인 금리형("연%"·"％"·"Percent" 포함) → 비율 대신 차(%p)
  // 판정·안내문은 등록 지표 경로와 같은 resolveTransform을 쓴다.
  const { transform, note } = resolveTransform(requested, { name, unit });

  // yoy·pop 계열은 구간 앞 1년을 선행 조회해야 구간 첫 시점부터 값이 나온다
  const needsLookback = transform !== "raw" && transform !== "rebase";
  const fetchStart = needsLookback ? lookbackStart(start) : start;

  try {
    const points = await sources[source as keyof typeof sources].fetchSeries(params, {
      start: fetchStart,
      end,
    });
    const transformed = applyTransform(normalizePointDates(points, cycle), transform, cycle);
    const fromDate = normalizeDate(start, cycle);
    return Response.json({
      indicator: {
        id: typeof b.id === "string" ? b.id : "adhoc",
        name,
        unit,
        cycle,
      },
      source,
      transform,
      note,
      // 선행조회분은 계산에만 쓰고 응답은 요청 구간으로 잘라 돌려준다
      points: needsLookback ? transformed.filter((p) => p.date >= fromDate) : transformed,
    });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 502 });
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function defaultStart(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 5);
  return d.toISOString().slice(0, 10);
}
