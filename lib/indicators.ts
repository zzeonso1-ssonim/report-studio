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
  /**
   * false면 주요지표 화면(수동 선택 목록)에서 숨김 — 챗·검색 조회는 그대로 된다.
   * 화면을 간결하게 유지하면서 "국고 5년 보여줘" 같은 질의는 살리기 위한 구분.
   */
  featured?: boolean;
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
    aliases: ["한국 기준금리", "한은 기준금리", "한국은행 기준금리"],
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
    aliases: ["원달러", "원/달러", "달러원"],
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
    aliases: ["한국 소비자물가", "한국 CPI", "국내 소비자물가"],
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
    aliases: ["한국 GDP", "한국 국내총생산", "한국 성장률"],
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
  // featured=false 테너는 주요지표 화면에서 숨김(2026-08-01 디렉터 지시:
  // 국고는 3년·10년만 노출). 챗 질의("국고 5년 보여줘")는 그대로 동작한다.
  ...(
    [
      ["kr_ktb_1y_yield", "국고채 1년 금리", "010190000", ["국고 1년", "국고채 1년"], false],
      ["kr_ktb_2y_yield", "국고채 2년 금리", "010195000", ["국고 2년", "국고채 2년"], false],
      ["kr_ktb_3y_yield", "국고채 3년 금리", "010200000", ["국고 3년", "국고채 3년"], true],
      ["kr_ktb_5y_yield", "국고채 5년 금리", "010200001", ["국고 5년", "국고채 5년"], false],
      ["kr_ktb_10y_yield", "국고채 10년 금리", "010210000", ["국고 10년", "국고채 10년"], true],
      ["kr_ktb_20y_yield", "국고채 20년 금리", "010220000", ["국고 20년", "국고채 20년"], false],
      ["kr_ktb_30y_yield", "국고채 30년 금리", "010230000", ["국고 30년", "국고채 30년"], false],
      ["kr_corp_3y_aa_yield", "회사채 3년 AA- 금리", "010300000", ["회사채 AA-"], true],
      ["kr_corp_3y_bbb_yield", "회사채 3년 BBB- 금리", "010320000", ["회사채 BBB-"], true],
      ["kr_cd_91d_yield", "CD 91일 금리", "010502000", ["CD금리", "CD 91일", "시디금리"], true],
    ] as const
  ).map(
    ([id, name, itemCode1, aliases, featured]): IndicatorDef => ({
      id,
      name: `${name} (최종호가수익률)`,
      country: "KR",
      unit: "%",
      cycle: "D",
      origin: "금융투자협회 (ECOS 수록)",
      aliases: [...aliases],
      featured,
      source: "ecos",
      params: { statCode: "817Y002", cycle: "D", itemCode1 },
      verified: true,
    })
  ),
  // ── 한국 실물 지표 (2026-08-01 디렉터 지시로 주요지표 추가, 전부 실호출 검증) ──
  {
    id: "kr_export_value_idx",
    name: "수출금액지수 (총지수, 2020=100)",
    country: "KR",
    unit: "지수",
    cycle: "M",
    origin: "한국은행",
    aliases: ["수출금액지수"],
    source: "ecos",
    // ECOS 403Y001 수출금액지수, itemCode1 *AA=총지수 (2026-06 실측 242.98)
    params: { statCode: "403Y001", cycle: "M", itemCode1: "*AA" },
    verified: true,
  },
  {
    id: "kr_export_volume_idx",
    name: "수출물량지수 (총지수, 2020=100)",
    country: "KR",
    unit: "지수",
    cycle: "M",
    origin: "한국은행",
    aliases: ["수출물량지수"],
    source: "ecos",
    // ECOS 403Y002 수출물량지수, itemCode1 *AA=총지수 (2026-06 실측 163.44)
    params: { statCode: "403Y002", cycle: "M", itemCode1: "*AA" },
    verified: true,
  },
  {
    id: "kr_ip_index",
    name: "광공업생산지수 (계절조정, 전국 총지수, 2020=100)",
    country: "KR",
    unit: "지수",
    cycle: "M",
    origin: "통계청",
    aliases: ["광공업생산", "광공업 생산지수"],
    source: "kosis",
    // KOSIS DT_1F02001 시도/산업별 광공업생산지수: T20=생산지수(계절조정),
    // objL1 00=전국, objL2 0=총지수 (2026-06 실측 121.3)
    params: { orgId: "101", tblId: "DT_1F02001", itmId: "T20", objL1: "00", objL2: "0", prdSe: "M" },
    verified: true,
  },
  {
    id: "kr_leading_index",
    name: "선행지수 순환변동치 (경기선행지수)",
    country: "KR",
    unit: "지수",
    cycle: "M",
    origin: "통계청",
    aliases: ["경기선행지수", "선행지수"],
    source: "kosis",
    // KOSIS DT_1C8015 경기종합지수(10차): T1, objL1 A03=선행지수 순환변동치
    // (2026-06 실측 105.7)
    params: { orgId: "101", tblId: "DT_1C8015", itmId: "T1", objL1: "A03", prdSe: "M" },
    verified: true,
  },
  {
    id: "kr_ktb_fut10y_index",
    name: "10년국채선물지수",
    country: "KR",
    unit: "지수",
    cycle: "D",
    origin: "한국거래소",
    aliases: ["10년 국채선물", "국채선물 지수"],
    featured: false, // 2026-08-01 디렉터 지시 — 화면에서만 숨김, 챗 조회는 유지
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
    aliases: ["아파트 매매가격", "아파트 매매지수", "아파트값"],
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
    aliases: ["아파트 전세가격", "전세가격지수"],
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
    aliases: ["미국 CPI", "미국 소비자물가"],
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
    aliases: ["미국 기준금리", "연준 기준금리", "연방기금금리", "페드펀드"],
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
    aliases: ["미국 GDP", "미국 국내총생산", "미국 성장률"],
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
    aliases: ["미국채 10년", "미 국채 10년", "미국 국채 10년", "미국 10년물"],
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
    aliases: ["미국 실업률"],
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
    aliases: ["비농업", "논팜"],
    source: "bls",
    // BLS CES0000000001 = 비농업 전체 고용(계절조정, 천 명). 2026-08-01 실호출 검증
    params: { seriesId: "CES0000000001" },
    fallback: { source: "fred", params: { seriesId: "PAYEMS" } },
    verified: true,
  },
  {
    id: "us_pce",
    name: "미국 PCE 물가지수 (SA)",
    country: "US",
    unit: "지수",
    cycle: "M",
    origin: "미 경제분석국(BEA) — 당분간 FRED 재수록본",
    aliases: ["미국 PCE"],
    source: "fred",
    // FRED PCEPI = 헤드라인 PCE 물가지수 (2026-06 실측 131.392)
    params: { seriesId: "PCEPI" },
    verified: true,
  },
  {
    id: "us_core_cpi",
    name: "미국 근원 소비자물가지수 (식품·에너지 제외, SA)",
    country: "US",
    unit: "지수",
    cycle: "M",
    origin: "미 노동통계국(BLS)",
    aliases: ["미국 근원 CPI", "미국 근원소비자물가"],
    source: "bls",
    // BLS CUSR0000SA0L1E = 근원 CPI(SA). 2026-08-01 BLS·FRED(CPILFESL)
    // 교차검증 — 2026-06 지수 336.065 양쪽 일치
    params: { seriesId: "CUSR0000SA0L1E" },
    fallback: { source: "fred", params: { seriesId: "CPILFESL" } },
    verified: true,
  },
  {
    id: "us_core_pce",
    name: "미국 근원 PCE 물가지수 (식품·에너지 제외, SA)",
    country: "US",
    unit: "지수",
    cycle: "M",
    origin: "미 경제분석국(BEA) — 당분간 FRED 재수록본",
    aliases: ["근원 PCE", "코어 PCE"],
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
    aliases: ["미국 소매판매"],
    source: "fred",
    params: { seriesId: "RSAFS" },
    verified: true,
  },
];

export function getIndicator(id: string): IndicatorDef | undefined {
  return indicators.find((i) => i.id === id);
}
