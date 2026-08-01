import { Cycle } from "@/lib/indicators";
import { normalizePointDates } from "@/lib/dates";
import { applyTransform, isRateUnit, rateUnitNote, Transform } from "@/lib/transforms";
import { sources } from "@/lib/sources";

const TRANSFORMS: Transform[] = ["raw", "yoy", "pop", "rebase"];
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
  let transform = (b.transform ?? "raw") as Transform;
  if (!TRANSFORMS.includes(transform)) {
    return Response.json({ error: `지원하지 않는 변환: ${String(b.transform)}` }, { status: 400 });
  }
  const start = typeof b.start === "string" ? b.start : defaultStart();
  const end = typeof b.end === "string" ? b.end : today();

  const name = typeof b.name === "string" ? b.name : "임의 시계열";
  const unit = typeof b.unit === "string" ? b.unit : "";

  // 이중 변환 가드 — 이미 전년비·전기비 단위인 시리즈(FRED "% Chg." 등)에
  // yoy/pop을 다시 걸면 변화율의 변화율이 나온다. 원계열로 강등하고 안내한다.
  let note: string | undefined;
  if ((transform === "yoy" || transform === "pop") && isRateUnit(unit)) {
    note = rateUnitNote(name, unit);
    transform = "raw";
  }

  try {
    const points = await sources[source as keyof typeof sources].fetchSeries(params, { start, end });
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
      points: applyTransform(normalizePointDates(points, cycle), transform, cycle),
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
