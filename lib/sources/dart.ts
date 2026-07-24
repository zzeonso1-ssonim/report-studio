import { SourceAdapter, SourceError, requireKey } from "./types";

/**
 * 금융감독원 DART OpenAPI — 공시 검색 (시계열이 아닌 문서형 소스)
 * https://opendart.fss.or.kr/
 * fetchSeries는 지원하지 않고, searchDisclosures를 별도로 노출
 */
export const dart: SourceAdapter = {
  id: "dart",
  name: "금감원 DART",
  requiresKey: true,

  async fetchSeries() {
    throw new SourceError("dart", "DART는 시계열이 아닌 공시검색형 소스입니다. searchDisclosures를 사용하세요");
  },
};

export interface Disclosure {
  corpName: string;
  reportName: string;
  receiptNo: string;
  receiptDate: string;
  url: string;
}

export async function searchDisclosures(query: {
  corpCode?: string;
  startDate: string; // YYYYMMDD
  endDate: string;
  pblntfTy?: string; // 공시유형 A~J
}): Promise<Disclosure[]> {
  const key = requireKey("dart", "DART_API_KEY");
  const qs = new URLSearchParams({
    crtfc_key: key,
    bgn_de: query.startDate,
    end_de: query.endDate,
    page_count: "100",
  });
  if (query.corpCode) qs.set("corp_code", query.corpCode);
  if (query.pblntfTy) qs.set("pblntf_ty", query.pblntfTy);

  const res = await fetch(`https://opendart.fss.or.kr/api/list.json?${qs}`, {
    next: { revalidate: 600 },
  });
  if (!res.ok) throw new SourceError("dart", `HTTP ${res.status}`);
  const json = await res.json();
  if (json.status !== "000") throw new SourceError("dart", `${json.status} ${json.message}`);

  return (json.list ?? []).map(
    (r: { corp_name: string; report_nm: string; rcept_no: string; rcept_dt: string }): Disclosure => ({
      corpName: r.corp_name,
      reportName: r.report_nm,
      receiptNo: r.rcept_no,
      receiptDate: r.rcept_dt,
      url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${r.rcept_no}`,
    })
  );
}
