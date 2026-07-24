import { SourceId } from "./sources/types";

export type Cycle = "D" | "M" | "Q" | "A";

export interface IndicatorDef {
  id: string;
  name: string;
  country: "KR" | "US";
  unit: string;
  cycle: Cycle;
  origin: string; // 작성기관 — 원천 우선 원칙의 근거
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
];

export function getIndicator(id: string): IndicatorDef | undefined {
  return indicators.find((i) => i.id === id);
}
