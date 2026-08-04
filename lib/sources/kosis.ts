import { KOSIS_OBJ_LEVELS } from "../search-config";
import { SeriesPoint, SourceAdapter, SourceError, requireKey } from "./types";

/**
 * 통계청 KOSIS 공유서비스 OpenAPI
 * https://kosis.kr/openapi/
 * params: { orgId, tblId, itmId, objL1, objL2?…objL8?, prdSe(M|Q|Y) }
 *
 * 분류 차수(objL)는 표마다 다르다. **지원 차수는 KOSIS_OBJ_LEVELS 하나로 정하고,
 * 검색 쪽 상한(lib/search-config.ts의 KOSIS_OBJ_CAPS)은 이 값에서 파생시킨다.**
 * 두 곳을 따로 적었다가 사고가 났다 — 2026-08-05, 검색 상한만 8단으로 올리고
 * 어댑터는 3단에 머물러, 4단 이상 표가 결과에 올라온 뒤 조회하면 KOSIS가
 * `err 20 필수요청변수값이 누락되었습니다`로 거절했다("취업자수 산업별"의
 * KOSIS 42건 중 36건이 조회 불가, 그중 1건이 전체 순위 2위).
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
    const { orgId, tblId, itmId, prdSe = "M" } = params;
    const start = toKosisPeriod(range.start, prdSe);
    const end = toKosisPeriod(range.end, prdSe);

    const qs = new URLSearchParams({
      method: "getList",
      apiKey: key,
      orgId,
      tblId,
      itmId,
      format: "json",
      jsonVD: "Y",
      prdSe,
      startPrdDe: start,
      endPrdDe: end,
    });
    // 분류축은 지원 차수만큼 전부 실어 보낸다. 값이 없는 차수는 빈 문자열로
    // 보내야 KOSIS가 "필수요청변수 누락"으로 거절하지 않는다.
    for (let i = 1; i <= KOSIS_OBJ_LEVELS; i++) {
      qs.set(`objL${i}`, params[`objL${i}`] ?? "");
    }
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
