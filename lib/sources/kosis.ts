import { SeriesPoint, SourceAdapter, SourceError, requireKey } from "./types";

/**
 * 통계청 KOSIS 공유서비스 OpenAPI
 * https://kosis.kr/openapi/
 * params: { orgId, tblId, itmId, objL1, objL2?, prdSe(M|Q|Y) }
 */
export const kosis: SourceAdapter = {
  id: "kosis",
  name: "통계청 KOSIS",
  requiresKey: true,

  async fetchSeries(params, range) {
    // KOSIS 인증키는 base64 형태 — 복사 과정에서 끝의 '=' 패딩이 유실되면
    // err 11(유효하지 않은 인증KEY)이 나므로 길이가 4의 배수가 되도록 보정한다.
    const rawKey = requireKey("kosis", "KOSIS_API_KEY");
    const key = rawKey + "=".repeat((4 - (rawKey.length % 4)) % 4);
    const { orgId, tblId, itmId, objL1, objL2 = "", prdSe = "M" } = params;
    const start = toKosisPeriod(range.start, prdSe);
    const end = toKosisPeriod(range.end, prdSe);

    const qs = new URLSearchParams({
      method: "getList",
      apiKey: key,
      orgId,
      tblId,
      itmId,
      objL1,
      objL2,
      format: "json",
      jsonVD: "Y",
      prdSe,
      startPrdDe: start,
      endPrdDe: end,
    });
    const res = await fetch(`https://kosis.kr/openapi/Param/statisticsParameterData.do?${qs}`, {
      next: { revalidate: 600 },
    });
    if (!res.ok) throw new SourceError("kosis", `HTTP ${res.status}`);
    const json = await res.json();

    if (!Array.isArray(json)) {
      throw new SourceError("kosis", json?.err ?? json?.errMsg ?? "예상치 못한 응답 형식");
    }
    const rows: { PRD_DE: string; DT: string }[] = json;

    return rows.map(
      (r): SeriesPoint => ({
        date: fromKosisPeriod(r.PRD_DE, prdSe),
        value: r.DT === "" || r.DT === "-" ? null : Number(r.DT),
      })
    );
  },
};

/** YYYY-MM-DD → KOSIS 주기별 표기 (M: YYYYMM, Q: YYYY0n — KOSIS는 분기도 6자리, Y: YYYY) */
function toKosisPeriod(iso: string, prdSe: string): string {
  const [y, m] = iso.split("-");
  switch (prdSe) {
    case "M": return `${y}${m}`;
    case "Q": return `${y}${`0${Math.ceil(Number(m) / 3)}`.slice(-2)}`;
    default: return y;
  }
}

/**
 * KOSIS PRD_DE → 정규형. 분기도 6자리("202602"=2026 Q2)라 월과 구분이 안 되므로
 * 반드시 prdSe로 해석한다 — 월로 오독하면 분기 시계열의 시점이 통째로 틀린다.
 */
function fromKosisPeriod(prdDe: string, prdSe: string): string {
  if (prdDe.length === 6) {
    const y = prdDe.slice(0, 4);
    const tail = prdDe.slice(4, 6);
    return prdSe === "Q" ? `${y}-Q${Number(tail)}` : `${y}-${tail}`;
  }
  return prdDe;
}
