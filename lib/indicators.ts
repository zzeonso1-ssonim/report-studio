import { SourceId } from "./sources/types";

export type Cycle = "D" | "M" | "Q" | "A";

export interface IndicatorDef {
  id: string;
  name: string;
  country: "KR" | "US";
  unit: string;
  cycle: Cycle;
  origin: string; // 작성기관 — 원천 우선 원칙의 근거
  /** 사용자가 쓰는 별칭 (챗 플래너의 지표 매칭용 — 예: "슈퍼코어") */
  aliases?: string[];
  source: SourceId;
  params: Record<string, string>;
  fallback?: { source: SourceId; params: Record<string, string> };
  /** false면 포털에서 실코드 검증 전 — UI에 표시됨 */
  verified: boolean;
}

/**
 * 지표 레지스트리 — 지표→소스 매핑의 단일 소스.
 * 새 지표는 여기에만 추가한다. 중복 수록 지표는 작성기관(원천)을 source로,
 * 재수록본은 fallback으로 지정한다.
 */
export const indicators: IndicatorDef[] = [
  // ── 한국 ──────────────────────────────────────────────
  {
    id: "kr_base_rate",
    name: "한국 기준금리",
    country: "KR",
    unit: "%",
    cycle: "D",
    origin: "한국은행",
    source: "ecos",
    params: { statCode: "722Y001", cycle: "D", itemCode1: "0101000" },
    verified: true,
  },
  {
    id: "kr_usdkrw",
    name: "원/달러 환율 (매매기준율)",
    country: "KR",
    unit: "원",
    cycle: "D",
    origin: "한국은행",
    source: "ecos",
    params: { statCode: "731Y001", cycle: "D", itemCode1: "0000001" },
    verified: true,
  },
  {
    id: "kr_cpi",
    name: "한국 소비자물가지수 (2020=100)",
    country: "KR",
    unit: "지수",
    cycle: "M",
    origin: "통계청",
    source: "kosis",
    // KOSIS 통계자료 API 실검증 완료: DT_1J22003 소비자물가지수(2020=100),
    // itmId T=총지수, objL1 T10=전국 (2025-01 실측 115.71)
    params: { orgId: "101", tblId: "DT_1J22003", itmId: "T", objL1: "T10", prdSe: "M" },
    verified: true,
  },
  {
    id: "kr_gdp",
    name: "한국 실질 GDP (계절조정, 분기)",
    country: "KR",
    unit: "십억원",
    cycle: "Q",
    origin: "한국은행",
    source: "ecos",
    // ECOS StatisticTableList/ItemList 실검증 완료: 200Y104 경제활동별 GDP 및 GNI(계절조정, 실질, 분기),
    // itemCode1 1400=국내총생산(시장가격, GDP) (2026Q2 실측 600,405.7 십억원)
    params: { statCode: "200Y104", cycle: "Q", itemCode1: "1400" },
    verified: true,
  },
  // ── 시장금리 (ECOS 817Y002 시장금리·일별 — 1콜 조회) ──────────
  // KRX 영업일 순회(1년치 40~70초 > Vercel 20초 상한) 대신 ECOS로 전환 (2026-08-01).
  // item_code는 2026-07-31 weekly_charts.py --discover-items 817Y002로 확정,
  // 2026-08-01 실호출 재검증 완료 (2026-07-29 국고3년 3.800 / 10년 4.257).
  ...(
    [
      ["kr_ktb_1y_yield", "국고채 1년 금리", "010190000"],
      ["kr_ktb_2y_yield", "국고채 2년 금리", "010195000"],
      ["kr_ktb_3y_yield", "국고채 3년 금리", "010200000"],
      ["kr_ktb_5y_yield", "국고채 5년 금리", "010200001"],
      ["kr_ktb_10y_yield", "국고채 10년 금리", "010210000"],
      ["kr_ktb_20y_yield", "국고채 20년 금리", "010220000"],
      ["kr_ktb_30y_yield", "국고채 30년 금리", "010230000"],
      ["kr_corp_3y_aa_yield", "회사채 3년 AA- 금리", "010300000"],
      ["kr_corp_3y_bbb_yield", "회사채 3년 BBB- 금리", "010320000"],
      ["kr_cd_91d_yield", "CD 91일 금리", "010502000"],
    ] as const
  ).map(
    ([id, name, itemCode1]): IndicatorDef => ({
      id,
      name: `${name} (최종호가수익률)`,
      country: "KR",
      unit: "%",
      cycle: "D",
      origin: "금융투자협회 (ECOS 수록)",
      source: "ecos",
      params: { statCode: "817Y002", cycle: "D", itemCode1 },
      verified: true,
    })
  ),
  {
    id: "kr_ktb_fut10y_index",
    name: "10년국채선물지수",
    country: "KR",
    unit: "지수",
    cycle: "D",
    origin: "한국거래소",
    source: "krx",
    params: {
      endpoint: "idx/drvprod_dd_trd",
      valueField: "CLSPRC_IDX",
      IDX_NM: "10년국채선물지수",
    },
    verified: true,
  },
  {
    id: "kr_apt_sale_idx",
    name: "전국 아파트 매매가격지수 (2026.01=100)",
    country: "KR",
    unit: "지수",
    cycle: "M",
    origin: "한국부동산원",
    source: "rone",
    // R-ONE 자체 OpenAPI 실검증 완료: A_2024_00045 (월) 매매가격지수_아파트,
    // clsId 500001=전국, itmId 100001=지수 (2025-05 실측 98.31)
    params: { statblId: "A_2024_00045", cycle: "MM", clsId: "500001", itmId: "100001" },
    verified: true,
  },
  {
    id: "kr_apt_jeonse_idx",
    name: "전국 아파트 전세가격지수 (2026.01=100)",
    country: "KR",
    unit: "지수",
    cycle: "M",
    origin: "한국부동산원",
    source: "rone",
    // R-ONE 실검증 완료: A_2024_00050 (월) 전세가격지수_아파트 (2025-06 실측 98.44)
    params: { statblId: "A_2024_00050", cycle: "MM", clsId: "500001", itmId: "100001" },
    verified: true,
  },

  // ── 미국 ──────────────────────────────────────────────
  {
    id: "us_cpi",
    name: "미국 소비자물가지수 CPI-U (SA)",
    country: "US",
    unit: "지수",
    cycle: "M",
    origin: "미 노동통계국(BLS)",
    source: "bls",
    params: { seriesId: "CUSR0000SA0" },
    fallback: { source: "fred", params: { seriesId: "CPIAUCSL" } },
    verified: true,
  },
  {
    id: "us_fedfunds",
    name: "미국 연방기금금리 (실효, 월평균)",
    country: "US",
    unit: "%",
    cycle: "M",
    origin: "미 연준 (FRED 수록)",
    source: "fred",
    params: { seriesId: "FEDFUNDS" },
    verified: true,
  },
  {
    id: "us_gdp",
    name: "미국 실질 GDP (연율, 2017$)",
    country: "US",
    unit: "십억 달러",
    cycle: "Q",
    origin: "미 경제분석국(BEA) — 당분간 FRED 재수록본",
    source: "fred",
    params: { seriesId: "GDPC1" },
    verified: true,
  },
  {
    id: "us_10y",
    name: "미 국채 10년 금리",
    country: "US",
    unit: "%",
    cycle: "D",
    origin: "미 재무부 (FRED 수록)",
    source: "fred",
    params: { seriesId: "DGS10" },
    verified: true,
  },
  {
    id: "us_unemployment",
    name: "미국 실업률 (SA)",
    country: "US",
    unit: "%",
    cycle: "M",
    origin: "미 노동통계국(BLS)",
    source: "bls",
    // BLS LNS14000000 = 실업률(계절조정). 2026-08-01 실호출 검증
    params: { seriesId: "LNS14000000" },
    fallback: { source: "fred", params: { seriesId: "UNRATE" } },
    verified: true,
  },
  {
    id: "us_nonfarm_payrolls",
    name: "미국 비농업 고용 (SA)",
    country: "US",
    unit: "천 명",
    cycle: "M",
    origin: "미 노동통계국(BLS)",
    source: "bls",
    // BLS CES0000000001 = 비농업 전체 고용(계절조정, 천 명). 2026-08-01 실호출 검증
    params: { seriesId: "CES0000000001" },
    fallback: { source: "fred", params: { seriesId: "PAYEMS" } },
    verified: true,
  },
  {
    id: "us_core_pce",
    name: "미국 근원 PCE 물가지수 (식품·에너지 제외, SA)",
    country: "US",
    unit: "지수",
    cycle: "M",
    origin: "미 경제분석국(BEA) — 당분간 FRED 재수록본",
    source: "fred",
    params: { seriesId: "PCEPILFE" },
    verified: true,
  },
  {
    id: "us_cpi_services_less_shelter",
    name: "미국 CPI 서비스(주거임차료 제외, SA) — 통칭 슈퍼코어 근사",
    country: "US",
    unit: "지수",
    cycle: "M",
    origin: "미 노동통계국(BLS)",
    aliases: ["슈퍼코어", "supercore"],
    source: "bls",
    // BLS CUSR0000SASL2RS = Services Less Rent of Shelter (SA). 공식 슈퍼코어
    // (서비스−에너지서비스−주거)와 정의가 완전히 같지는 않은 근사 지표.
    // 2026-08-01 BLS·FRED 실호출 교차검증 (2026-06 지수 445.144 양쪽 일치)
    params: { seriesId: "CUSR0000SASL2RS" },
    fallback: { source: "fred", params: { seriesId: "CUSR0000SASL2RS" } },
    verified: true,
  },
  {
    id: "us_retail_sales",
    name: "미국 소매판매 (소매·외식, SA)",
    country: "US",
    unit: "백만 달러",
    cycle: "M",
    origin: "미 센서스국 — 당분간 FRED 재수록본",
    source: "fred",
    params: { seriesId: "RSAFS" },
    verified: true,
  },
];

export function getIndicator(id: string): IndicatorDef | undefined {
  return indicators.find((i) => i.id === id);
}
