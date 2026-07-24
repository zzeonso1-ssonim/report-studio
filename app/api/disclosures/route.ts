import { searchDisclosures } from "@/lib/sources/dart";
import { searchCorpsByName, type CorpEntry } from "@/lib/sources/dart-corp";
import { SourceError } from "@/lib/sources/types";

/**
 * GET /api/disclosures?q=회사명&days=30&type=A&corp_code=00126380
 * - q 없음: 전체 최근 공시
 * - q 있음: 회사명 → corp_code 매칭 후 해당 회사 공시
 *   - 매칭 1건: 바로 검색
 *   - 매칭 여러 건: { candidates } 반환 → UI에서 선택 후 corp_code로 재요청
 * - corp_code 지정 시 회사명 매칭을 건너뛰고 그대로 검색
 * - type: DART pblntf_ty (A 정기공시 … J 공정위공시)
 * 응답: { disclosures, corp? } 또는 { candidates } 또는 { error }
 */

const DAYS_MAX = 365;

function yyyymmdd(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const corpCodeParam = (url.searchParams.get("corp_code") ?? "").trim();
  const type = (url.searchParams.get("type") ?? "").trim();
  const daysRaw = Number(url.searchParams.get("days") ?? "30");
  const days = Number.isFinite(daysRaw)
    ? Math.min(Math.max(Math.trunc(daysRaw), 1), DAYS_MAX)
    : 30;

  if (type && !/^[A-J]$/.test(type)) {
    return Response.json(
      { error: "type은 DART 공시유형 코드 A~J 중 하나여야 합니다" },
      { status: 400 }
    );
  }

  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);

  try {
    let corp: CorpEntry | null = null;
    let corpCode: string | undefined;

    if (corpCodeParam) {
      if (!/^\d{8}$/.test(corpCodeParam)) {
        return Response.json(
          { error: "corp_code는 8자리 숫자여야 합니다" },
          { status: 400 }
        );
      }
      corpCode = corpCodeParam;
    } else if (q) {
      const matches = await searchCorpsByName(q, 20);
      if (matches.length === 0) {
        return Response.json(
          { error: `"${q}"와 일치하는 회사를 찾지 못했습니다` },
          { status: 404 }
        );
      }
      if (matches.length > 1) {
        return Response.json({ candidates: matches });
      }
      corp = matches[0];
      corpCode = corp.corpCode;
    }

    const disclosures = await searchDisclosures({
      corpCode,
      startDate: yyyymmdd(start),
      endDate: yyyymmdd(end),
      pblntfTy: type || undefined,
    });

    return Response.json({
      disclosures,
      ...(corp ? { corp } : {}),
      range: { start: yyyymmdd(start), end: yyyymmdd(end), days },
    });
  } catch (e) {
    // DART "조회된 데이타가 없습니다"(013)는 빈 결과로 취급
    if (e instanceof SourceError && e.message.includes("013")) {
      return Response.json({
        disclosures: [],
        range: { start: yyyymmdd(start), end: yyyymmdd(end), days },
      });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 502 });
  }
}
