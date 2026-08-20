import { SourceId } from "./sources/types";
import { liquidityAliases, liquiditySeries } from "./liquidity";

export type Cycle = "D" | "M" | "Q" | "A";

/**
 * 지표 성격 — 변환·축 자동 결정의 근거 (질의마다 개별 수리하는 대신
 * 여기 메타데이터 하나로 시스템 전체가 올바르게 동작하게 하는 장치).
 * - rate:   수준 자체가 %(금리·실업률). 전년대비는 비율이 아니라 차(%p)가 맞다
 * - index:  지수(물가·생산·가격지수). 전년대비 %가 자연스럽다
 * - amount: 금액·수량(GDP·고용자수·환율). 전년대비 %가 자연스럽다
 */
export type IndicatorKind = "rate" | "index" | "amount";

export interface IndicatorDef {
  id: string;
  name: string;
  country: "KR" | "US";
  unit: string;
  cycle: Cycle;
  origin: string; // 작성기관 — 원천 우선 원칙의 근거
  /** 지표 성격 — rate면 yoy/pop을 차(%p) 변환으로 자동 대체 */
  kind: IndicatorKind;
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
  /**
   * 원자료 → 표시단위 환산 제수. 조회 직후 `/api/series/[id]`가 나눈다.
   * 원천이 백만 달러로 주는 계열과 십억 달러로 주는 계열을 같은 축에 놓으려면
   * 단위를 먼저 맞춰야 한다(1,000배 차이가 조용히 섞이는 것을 막는다).
   * 값의 출처는 지표 정의 단일 소스 — 유동성 계열은 config.json의 display.divide_by.
   */
  divideBy?: number;
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
    kind: "rate",
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
    kind: "amount",
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
    kind: "index",
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
    kind: "amount",
    cycle: "Q",
    origin: "한국은행",
    aliases: ["한국 GDP", "한국 국내총생산", "한국 성장률"],
    source: "ecos",
    // ECOS StatisticTableList/ItemList 실검증 완료: 200Y104 경제활동별 GDP 및 GNI(계절조정, 실질, 분기),
    // itemCode1 1400=국내총생산(시장가격, GDP) (2026Q2 실측 600,405.7 십억원)
    params: { statCode: "200Y104", cycle: "Q", itemCode1: "1400" },
    verified: true,
  },
  // ECOS 200Y102 국민계정 주요지표의 공식 증가율 계열.
  // 성장 워크벤치는 수준값을 재계산하지 않고 이 공표 증가율을 그대로 표시한다.
  ...(
    [
      ["kr_real_gdp_qoq", "실질 GDP 성장률 (전기대비)", "10111"],
      ["kr_real_gdp_yoy", "실질 GDP 성장률 (전년동기대비)", "10211"],
      ["kr_manufacturing_gdp_yoy", "제조업 생산 증가율 (전년동기대비)", "10213"],
      ["kr_construction_gdp_yoy", "건설업 생산 증가율 (전년동기대비)", "10215"],
      ["kr_services_gdp_yoy", "서비스업 생산 증가율 (전년동기대비)", "10216"],
      ["kr_private_consumption_yoy", "민간소비 증가율 (전년동기대비)", "10222"],
      ["kr_government_consumption_yoy", "정부소비 증가율 (전년동기대비)", "10228"],
      ["kr_equipment_investment_yoy", "설비투자 증가율 (전년동기대비)", "10223"],
      ["kr_construction_investment_yoy", "건설투자 증가율 (전년동기대비)", "10224"],
    ] as const
  ).map(
    ([id, name, itemCode1]): IndicatorDef => ({
      id,
      name,
      country: "KR",
      unit: "%",
      kind: "rate",
      cycle: "Q",
      origin: "한국은행",
      featured: false,
      source: "ecos",
      params: { statCode: "200Y102", cycle: "Q", itemCode1 },
      verified: true,
    })
  ),
  // ── 재정 워크벤치 ──────────────────────────────────────
  // 총수입·총지출은 월간 누계표이므로 전망 화면에서 12월 값만 연간 결산치로 선택한다.
  ...(
    [
      ["kr_national_tax_total", "국세총액", "901Y081", "G2AA", 10_000],
      ["kr_income_tax_revenue", "소득세", "901Y081", "G2AAAAA", 10_000],
      ["kr_corporate_tax_revenue", "법인세", "901Y081", "G2AAAAB", 10_000],
      ["kr_vat_revenue", "부가가치세", "901Y081", "G2AAABA", 10_000],
    ] as const
  ).map(
    ([id, name, statCode, itemCode1, divideBy]): IndicatorDef => ({
      id,
      name,
      country: "KR",
      unit: "조원",
      kind: "amount",
      cycle: "A",
      origin: "기획예산처 (한국은행 ECOS 수록)",
      featured: false,
      source: "ecos",
      params: {
        statCode,
        cycle: "A",
        itemCode1,
      },
      divideBy,
      verified: true,
    })
  ),
  {
    id: "kr_national_debt_to_gdp",
    name: "GDP 대비 국가채무 비율",
    country: "KR",
    unit: "%",
    kind: "rate",
    cycle: "A",
    origin: "기획예산처 (KOSIS)",
    featured: false,
    source: "kosis",
    params: {
      orgId: "184",
      tblId: "DT_102006_001",
      itmId: "T001",
      objL1: "A02",
      prdSe: "Y",
    },
    verified: true,
  },
  ...(
    [
      ["kr_fiscal_total_revenue_progress", "총수입 월별 진도율", "total_revenue_progress"],
      ["kr_fiscal_total_expenditure_progress", "총지출 월별 진도율", "total_expenditure_progress"],
      ["kr_ktb_issuance_progress", "국고채 누계 발행 진도율", "ktb_issuance_progress"],
    ] as const
  ).map(([id, name, metric]): IndicatorDef => ({
    id,
    name,
    country: "KR",
    unit: "%",
    kind: "rate",
    cycle: "M",
    origin: "기획예산처 월간 재정동향",
    featured: false,
    source: "mpb",
    params: { metric },
    verified: true,
  })),
  // ── 물가 워크벤치 ──────────────────────────────────────
  // CPI·PPI·수출입물가는 원지수를 받아 전망 화면에서 전년동월비로 변환한다.
  ...(
    [
      ["kr_core_cpi", "근원 소비자물가지수 (식료품 및 에너지 제외)", "DT_1J22009", "T", "DB", undefined],
      ["kr_goods_cpi", "상품 소비자물가지수", "DT_1J22002", "T", "T10", "21"],
      ["kr_services_cpi", "서비스 소비자물가지수", "DT_1J22002", "T", "T10", "22"],
    ] as const
  ).map(
    ([id, name, tblId, itmId, objL1, objL2]): IndicatorDef => ({
      id,
      name,
      country: "KR",
      unit: "지수",
      kind: "index",
      cycle: "M",
      origin: "통계청",
      featured: false,
      source: "kosis",
      params: {
        orgId: "101",
        tblId,
        itmId,
        objL1,
        ...(objL2 ? { objL2 } : {}),
        prdSe: "M",
      },
      verified: true,
    })
  ),
  ...(
    [
      ["kr_export_price_index", "수출물가지수 (원화 기준)", "402Y014", "*AA", "W"],
      ["kr_import_price_index", "수입물가지수 (원화 기준)", "401Y015", "*AA", "W"],
      ["kr_ppi_total", "생산자물가지수 총지수", "404Y014", "*AA", undefined],
      ["kr_ppi_industrial_products", "공산품 생산자물가지수", "404Y014", "3AA", undefined],
      ["kr_ppi_services", "서비스 생산자물가지수", "404Y014", "5AA", undefined],
    ] as const
  ).map(
    ([id, name, statCode, itemCode1, itemCode2]): IndicatorDef => ({
      id,
      name,
      country: "KR",
      unit: "지수",
      kind: "index",
      cycle: "M",
      origin: "한국은행",
      featured: false,
      source: "ecos",
      params: {
        statCode,
        cycle: "M",
        itemCode1,
        ...(itemCode2 ? { itemCode2 } : {}),
      },
      verified: true,
    })
  ),
  {
    id: "kr_usdkrw_monthly_average",
    name: "원/달러 환율 (월평균)",
    country: "KR",
    unit: "원",
    kind: "amount",
    cycle: "M",
    origin: "한국은행",
    featured: false,
    source: "ecos",
    params: {
      statCode: "731Y004",
      cycle: "M",
      itemCode1: "0000001",
      itemCode2: "0000100",
    },
    verified: true,
  },
  {
    id: "kr_expected_inflation",
    name: "기대인플레이션율 (향후 1년)",
    country: "KR",
    unit: "%",
    kind: "rate",
    cycle: "M",
    origin: "한국은행",
    featured: false,
    source: "ecos",
    params: { statCode: "511Y003", cycle: "M", itemCode1: "FMB" },
    verified: true,
  },
  {
    id: "dubai_crude_oil_price",
    name: "Dubai유 가격",
    country: "KR",
    unit: "달러/배럴",
    kind: "amount",
    cycle: "M",
    origin: "한국석유공사 (한국은행 ECOS 수록)",
    featured: false,
    source: "ecos",
    params: { statCode: "902Y003", cycle: "M", itemCode1: "010102" },
    verified: true,
  },
  {
    id: "kr_crude_import_unit_cost",
    name: "원유 도입단가",
    country: "KR",
    unit: "달러/배럴",
    kind: "amount",
    cycle: "M",
    origin: "산업통상부 수출입 동향",
    featured: false,
    source: "motir",
    params: { metric: "crude_import_unit_cost" },
    verified: true,
  },
  // ── 설비투자 워크벤치 ─────────────────────────────
  // 국민계정 실질 원계열과 월별 동행·전망 지표. 전망 화면에서 전년비를 계산하며,
  // 기업경기조사 BSI는 공표 수준을 그대로 사용한다.
  ...(
    [
      ["kr_equipment_investment_na", "설비투자 (실질 원계열)", "10105"],
      ["kr_machinery_investment_na", "기계류 투자 (실질 원계열)", "1010520"],
      ["kr_transport_equipment_investment_na", "운송장비 투자 (실질 원계열)", "1010510"],
    ] as const
  ).map(
    ([id, name, itemCode1]): IndicatorDef => ({
      id,
      name,
      country: "KR",
      unit: "십억원",
      kind: "amount",
      cycle: "Q",
      origin: "한국은행",
      featured: false,
      source: "ecos",
      params: { statCode: "200Y130", cycle: "Q", itemCode1 },
      verified: true,
    })
  ),
  {
    id: "kr_manufacturing_utilization_rate",
    name: "제조업 평균가동률",
    country: "KR",
    unit: "%",
    kind: "rate",
    cycle: "M",
    origin: "국가데이터처",
    featured: false,
    source: "kosis",
    params: {
      orgId: "101",
      tblId: "DT_1F32002",
      itmId: "T50",
      objL1: "C",
      prdSe: "M",
    },
    verified: true,
  },
  {
    id: "kr_semiconductor_machinery_investment_index",
    name: "반도체제조용기계 설비투자지수",
    country: "KR",
    unit: "지수",
    kind: "index",
    cycle: "M",
    origin: "국가데이터처",
    featured: false,
    source: "kosis",
    params: {
      orgId: "101",
      tblId: "DT_1F70011",
      itmId: "T3",
      objL1: "S",
      objL2: "C1122",
      prdSe: "M",
    },
    verified: true,
  },
  {
    id: "kr_semiconductor_equipment_import_amount",
    name: "반도체 제조용 장비 수입액",
    country: "KR",
    unit: "달러",
    kind: "amount",
    cycle: "M",
    origin: "한국무역협회 K-stat (산업통상자원부·관세청 통관자료)",
    featured: false,
    source: "kita",
    // KDI와 동일한 한국무역협회 MTI 3단위 '732 반도체제조용장비'.
    params: { itemCode: "732" },
    verified: true,
  },
  ...(
    [
      ["kr_equipment_investment_outlook_bsi_large", "대기업 설비투자전망 BSI", "X5000"],
      ["kr_equipment_investment_outlook_bsi_manufacturing", "제조업 설비투자전망 BSI", "C0000"],
      ["kr_equipment_investment_outlook_bsi_sme", "중소기업 설비투자전망 BSI", "X6000"],
    ] as const
  ).map(
    ([id, name, itemCode1]): IndicatorDef => ({
      id,
      name,
      country: "KR",
      unit: "지수",
      kind: "index",
      cycle: "M",
      origin: "한국은행",
      featured: false,
      source: "ecos",
      params: {
        statCode: "512Y014",
        cycle: "M",
        itemCode1,
        itemCode2: "BI",
      },
      verified: true,
    })
  ),
  // ── 건설투자 워크벤치 ─────────────────────────────
  // 국민계정 실질 원계열과 건설경기 동행·선행 원계열. 전망 화면에서
  // 완결된 분기만 합산하고 이동평균·전년비를 계산한다(결측 보간 없음).
  ...(
    [
      ["kr_construction_investment_na_yoy", "건설투자 (실질 원계열)", "10102"],
      ["kr_building_construction_investment_yoy", "건물건설 투자 (실질 원계열)", "10103"],
      ["kr_civil_construction_investment_yoy", "토목건설 투자 (실질 원계열)", "10104"],
    ] as const
  ).map(
    ([id, name, itemCode1]): IndicatorDef => ({
      id,
      name,
      country: "KR",
      unit: "십억원",
      kind: "amount",
      cycle: "Q",
      origin: "한국은행",
      featured: false,
      source: "ecos",
      params: { statCode: "200Y130", cycle: "Q", itemCode1 },
      verified: true,
    })
  ),
  ...(
    [
      ["kr_construction_completed_total", "건설기성 총계", "0"],
      ["kr_construction_completed_building", "건축 기성", "1"],
      ["kr_construction_completed_civil", "토목 기성", "2"],
    ] as const
  ).map(
    ([id, name, objL1]): IndicatorDef => ({
      id,
      name,
      country: "KR",
      unit: "백만원",
      kind: "amount",
      cycle: "M",
      origin: "국가데이터처",
      featured: false,
      source: "kosis",
      params: { orgId: "101", tblId: "DT_1G18011", itmId: "T10", objL1, prdSe: "M" },
      verified: true,
    })
  ),
  {
    id: "kr_building_orders_amount",
    name: "건축 수주액",
    country: "KR",
    unit: "백만원",
    kind: "amount",
    cycle: "M",
    origin: "국가데이터처",
    featured: false,
    source: "kosis",
    params: { orgId: "101", tblId: "DT_1G1B002", itmId: "T10", objL1: "0", objL2: "1", prdSe: "M" },
    verified: true,
  },
  {
    id: "kr_building_start_area",
    name: "건축 착공면적",
    country: "KR",
    unit: "㎡",
    kind: "amount",
    cycle: "M",
    origin: "국토교통부",
    featured: false,
    source: "kosis",
    params: { orgId: "101", tblId: "DT_1YL7402E", itmId: "13103792712T1", objL1: "13102792712A.0001", prdSe: "M" },
    verified: true,
  },
  {
    id: "kr_construction_completed_current_value",
    name: "건설기성 경상금액",
    country: "KR",
    unit: "백만원",
    kind: "amount",
    cycle: "M",
    origin: "국가데이터처",
    featured: false,
    source: "kosis",
    params: { orgId: "101", tblId: "DT_1G18007", itmId: "T30", objL1: "0", prdSe: "M" },
    verified: true,
  },
  ...(
    [
      ["kr_housing_completions", "주택 준공", "DT_MLTM_5372", "13103766972T1", "13102766972"],
      ["kr_housing_starts", "주택 착공", "DT_MLTM_5386", "13103766971T1", "13102766971"],
    ] as const
  ).map(
    ([id, name, tblId, itmId, prefix]): IndicatorDef => ({
      id,
      name,
      country: "KR",
      unit: "호",
      kind: "amount",
      cycle: "M",
      origin: "국토교통부",
      featured: false,
      source: "kosis",
      params: {
        orgId: "116",
        tblId,
        itmId,
        objL1: `${prefix}A.0001`,
        objL2: `${prefix}B.0001`,
        objL3: `${prefix}C.0001`,
        prdSe: "M",
      },
      verified: true,
    })
  ),
  {
    id: "kr_housing_permits_cumulative",
    name: "주택 인허가 (누계)",
    country: "KR",
    unit: "호",
    kind: "amount",
    cycle: "M",
    origin: "국토교통부 (한국은행 ECOS 수록)",
    featured: false,
    source: "ecos",
    params: { statCode: "901Y105", cycle: "M", itemCode1: "ALL" },
    verified: true,
  },
  {
    id: "kr_m2_sa_average",
    name: "M2 (평잔, 계절조정)",
    country: "KR",
    unit: "조원",
    kind: "amount",
    cycle: "M",
    origin: "한국은행",
    featured: false,
    source: "ecos",
    params: { statCode: "161Y005", cycle: "M", itemCode1: "BBHS00" },
    divideBy: 1_000,
    verified: true,
  },
  ...(
    [
      ["kr_m2_total_original", "M2 총계 (평잔, 원계열)", "BBHA00"],
      ["kr_m2_demand_savings", "수시입출식저축성예금 (평잔)", "BBHA03"],
      ["kr_m2_time_deposits_under_2y", "만기 2년 미만 정기예적금 (평잔)", "BBHA05"],
      ["kr_m2_mmf", "MMF (평잔)", "BBHA04"],
      ["kr_m2_cma", "CMA (평잔)", "BBHA08"],
    ] as const
  ).map(([id, name, itemCode1]): IndicatorDef => ({
    id, name, country: "KR", unit: "조원", kind: "amount", cycle: "M",
    origin: "한국은행", featured: false, source: "ecos",
    params: { statCode: "161Y006", cycle: "M", itemCode1 },
    divideBy: 1_000, verified: true,
  })),
  ...(
    [
      ["kr_m2_households", "가계 및 비영리단체 M2 (평잔)", "BBHAJ1"],
      ["kr_m2_nonfinancial_corporations", "비금융기업 M2 (평잔)", "BBHAJ2"],
      ["kr_m2_other_financial_institutions", "기타금융기관 M2 (평잔)", "BBHAJ3"],
    ] as const
  ).map(([id, name, itemCode1]): IndicatorDef => ({
    id, name, country: "KR", unit: "조원", kind: "amount", cycle: "M",
    origin: "한국은행", featured: false, source: "ecos",
    params: { statCode: "161Y010", cycle: "M", itemCode1 },
    divideBy: 1_000, verified: true,
  })),
  ...(
    [
      ["kr_total_deposits", "총예금 (말잔)", "1000000"],
      ["kr_household_deposits", "가계 예금 (말잔)", "1010000"],
      ["kr_corporate_deposits", "기업 예금 (말잔)", "1020000"],
    ] as const
  ).map(([id, name, itemCode1]): IndicatorDef => ({
    id, name, country: "KR", unit: "조원", kind: "amount", cycle: "M",
    origin: "한국은행", featured: false, source: "ecos",
    params: { statCode: "104Y009", cycle: "M", itemCode1 },
    divideBy: 1_000, verified: true,
  })),
  // ── 노동시장 워크벤치 ─────────────────────────────
  ...(
    [
      ["kr_employed_total", "취업자", "DT_1DA7001S", "T30", "0"],
      ["kr_employed_manufacturing", "제조업 취업자", "DT_1DA7E06S_NEW", "T30", "10"],
      ["kr_employed_construction", "건설업 취업자", "DT_1DA7E06S_NEW", "T30", "41"],
      ["kr_employed_nonwage", "비임금근로자", "DT_1DA7010S", "T30", "05"],
      ["kr_employed_self", "자영업자", "DT_1DA7010S", "T30", "06"],
      ["kr_employed_unpaid_family", "무급가족종사자", "DT_1DA7010S", "T30", "22"],
      ["kr_employed_wage", "임금근로자", "DT_1DA7010S", "T30", "30"],
      ["kr_employed_regular", "상용근로자", "DT_1DA7010S", "T30", "41"],
      ["kr_employed_temporary", "임시근로자", "DT_1DA7010S", "T30", "51"],
      ["kr_employed_daily", "일용근로자", "DT_1DA7010S", "T30", "52"],
    ] as const
  ).map(
    ([id, name, tblId, itmId, objL1]): IndicatorDef => ({
      id,
      name,
      country: "KR",
      unit: "천명",
      kind: "amount",
      cycle: "M",
      origin: "국가데이터처",
      featured: false,
      source: "kosis",
      params: { orgId: "101", tblId, itmId, objL1, prdSe: "M" },
      verified: true,
    })
  ),
  ...(
    [
      ["kr_sa_employment_rate", "계절조정 고용률", "T90"],
      ["kr_sa_labor_force_participation", "계절조정 경제활동참가율", "T60"],
    ] as const
  ).map(
    ([id, name, itmId]): IndicatorDef => ({
      id,
      name,
      country: "KR",
      unit: "%",
      kind: "rate",
      cycle: "M",
      origin: "국가데이터처",
      featured: false,
      source: "kosis",
      params: { orgId: "101", tblId: "DT_1DA9001S", itmId, objL1: "00", prdSe: "M" },
      verified: true,
    })
  ),
  // 2026년 사업체노동력조사 산업분류 개편에 따라 현행·과거 표를 이어 사용한다.
  ...(
    [
      ["total", "전체 임금총액", "13103110311MD_12"],
      ["regular", "상용 임금총액", "13103110311MD_13"],
      ["temporary_daily", "임시일용 임금총액", "13103110311MD_17"],
    ] as const
  ).flatMap(([suffix, name, itmId]): IndicatorDef[] => [
    {
      id: `kr_wage_${suffix}`,
      name,
      country: "KR",
      unit: "원",
      kind: "amount",
      cycle: "M",
      origin: "고용노동부",
      featured: false,
      source: "kosis",
      params: { orgId: "118", tblId: "DT_118N_MON054", itmId, objL1: "260225INDUSTRY_11S0", objL2: "size01", prdSe: "M" },
      verified: true,
    },
    {
      id: `kr_wage_${suffix}_history`,
      name: `${name} (2025년 이전 연결계열)`,
      country: "KR",
      unit: "원",
      kind: "amount",
      cycle: "M",
      origin: "고용노동부",
      featured: false,
      source: "kosis",
      params: { orgId: "118", tblId: "DT_118N_MON051", itmId, objL1: "190326INDUSTRY_10S0", objL2: "size01", prdSe: "M" },
      verified: true,
    },
  ]),
  ...(
    [
      ["kr_job_opportunity_csi", "취업기회전망 CSI", "FMBE"],
      ["kr_wage_outlook_csi", "임금수준전망 CSI", "FMFC"],
    ] as const
  ).map(
    ([id, name, itemCode1]): IndicatorDef => ({
      id,
      name,
      country: "KR",
      unit: "지수",
      kind: "index",
      cycle: "M",
      origin: "한국은행",
      featured: false,
      source: "ecos",
      params: { statCode: "511Y002", cycle: "M", itemCode1, itemCode2: "99988" },
      verified: true,
    })
  ),
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
      kind: "rate",
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
    kind: "index",
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
    kind: "index",
    cycle: "M",
    origin: "한국은행",
    aliases: ["수출물량지수"],
    source: "ecos",
    // ECOS 403Y002 수출물량지수, itemCode1 *AA=총지수 (2026-06 실측 163.44)
    params: { statCode: "403Y002", cycle: "M", itemCode1: "*AA" },
    verified: true,
  },
  // 관세청 통관 수출입(ECOS 수록). 원자료 단위 천달러를 화면 단위 억달러로 환산한다.
  {
    id: "kr_daily_average_export_yoy",
    name: "일평균 수출액 전년동월비",
    country: "KR",
    unit: "%",
    kind: "rate",
    cycle: "M",
    origin: "관세청 월간 수출입 현황 [잠정치]",
    featured: false,
    source: "kcs",
    params: { metric: "daily_average_export_yoy" },
    verified: true,
  },
  ...(
    [
      ["kr_customs_export_amount", "통관 수출금액", "901Y118", "T002", undefined],
      ["kr_customs_import_amount", "통관 수입금액", "901Y118", "T004", undefined],
      ["kr_export_by_country_amount", "주요국별 수출금액", "901Y121", "T002", "?"],
    ] as const
  ).map(
    ([id, name, statCode, itemCode1, itemCode2]): IndicatorDef => ({
      id,
      name,
      country: "KR",
      unit: "억달러",
      kind: "amount",
      cycle: "M",
      origin: "관세청 (한국은행 ECOS 수록)",
      featured: false,
      source: "ecos",
      params: {
        statCode,
        cycle: "M",
        itemCode1,
        ...(itemCode2 ? { itemCode2 } : {}),
      },
      divideBy: 100_000,
      verified: true,
    })
  ),
  ...(
    [
      ["kr_semiconductor_export_value_idx", "반도체 수출금액지수", "403Y001"],
      ["kr_semiconductor_export_volume_idx", "반도체 수출물량지수", "403Y002"],
    ] as const
  ).map(
    ([id, name, statCode]): IndicatorDef => ({
      id,
      name,
      country: "KR",
      unit: "지수",
      kind: "index",
      cycle: "M",
      origin: "한국은행",
      featured: false,
      source: "ecos",
      params: { statCode, cycle: "M", itemCode1: "30911AA" },
      verified: true,
    })
  ),
  {
    id: "kr_ip_index",
    name: "광공업생산지수 (계절조정, 전국 총지수, 2020=100)",
    country: "KR",
    unit: "지수",
    kind: "index",
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
    kind: "index",
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
    kind: "index",
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
    kind: "index",
    cycle: "M",
    origin: "한국부동산원",
    // "아파트값"류 광범위 별칭은 서울 질의까지 전국으로 강제해 제거 (2026-08-01)
    aliases: ["전국 아파트 매매"],
    source: "rone",
    // R-ONE 자체 OpenAPI 실검증 완료: A_2024_00045 (월) 매매가격지수_아파트,
    // clsId 500001=전국, itmId 100001=지수 (2025-05 실측 98.31)
    params: { statblId: "A_2024_00045", cycle: "MM", clsId: "500001", itmId: "100001" },
    verified: true,
  },
  {
    id: "kr_apt_sale_idx_seoul",
    name: "서울 아파트 매매가격지수 (2026.01=100)",
    country: "KR",
    unit: "지수",
    kind: "index",
    cycle: "M",
    origin: "한국부동산원",
    aliases: ["서울 아파트 매매", "서울 아파트값"],
    featured: false, // 주요지표 목록은 디렉터 확정 구성 유지 — 챗 질의용
    source: "rone",
    // 전국과 같은 표, clsId 500008=서울 (2026-06 실측 103.9566)
    params: { statblId: "A_2024_00045", cycle: "MM", clsId: "500008", itmId: "100001" },
    verified: true,
  },
  {
    id: "kr_apt_jeonse_idx",
    name: "전국 아파트 전세가격지수 (2026.01=100)",
    country: "KR",
    unit: "지수",
    kind: "index",
    cycle: "M",
    origin: "한국부동산원",
    aliases: ["전국 아파트 전세"],
    source: "rone",
    // R-ONE 실검증 완료: A_2024_00050 (월) 전세가격지수_아파트 (2025-06 실측 98.44)
    params: { statblId: "A_2024_00050", cycle: "MM", clsId: "500001", itmId: "100001" },
    verified: true,
  },
  {
    id: "kr_apt_jeonse_idx_seoul",
    name: "서울 아파트 전세가격지수 (2026.01=100)",
    country: "KR",
    unit: "지수",
    kind: "index",
    cycle: "M",
    origin: "한국부동산원",
    aliases: ["서울 아파트 전세", "서울 전세"],
    featured: false,
    source: "rone",
    // 전국과 같은 표, clsId 500008=서울 (2026-06 실측 104.3898)
    params: { statblId: "A_2024_00050", cycle: "MM", clsId: "500008", itmId: "100001" },
    verified: true,
  },

  // ── 미국 ──────────────────────────────────────────────
  {
    id: "us_cpi",
    name: "미국 소비자물가지수 CPI-U (SA)",
    country: "US",
    unit: "지수",
    kind: "index",
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
    kind: "rate",
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
    kind: "amount",
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
    kind: "rate",
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
    kind: "rate",
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
    kind: "amount",
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
    kind: "index",
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
    kind: "index",
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
    kind: "index",
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
    kind: "index",
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
    kind: "amount",
    cycle: "M",
    origin: "미 센서스국 — 당분간 FRED 재수록본",
    aliases: ["미국 소매판매"],
    source: "fred",
    params: { seriesId: "RSAFS" },
    verified: true,
  },

  // ── 미 유동성 (H.4.1·머니마켓) ─────────────────────────────
  // 계열 정의(FRED ID·표시명·단위·환산계수)는 scripts/liquidity/config.json에서
  // 파생한다 — 노션 유동성 워치 파이프라인과 같은 파일을 본다. 여기에 시리즈
  // ID를 다시 적지 않는다(lib/liquidity.ts 주석 참조).
  //
  // cycle은 전부 "D"다. 주간계열(H.4.1)도 FRED가 수요일 날짜의 YYYY-MM-DD로
  // 주기 때문이고, 카탈로그 검색의 기존 관례(lib/search.ts FRED_FREQ: W→D)와도
  // 같다. 시점 정의(주평균·수요일 잔액·일간)는 지표명 괄호에 적는다.
  //
  // featured=false — 주요지표 체크리스트는 디렉터 확정 구성을 유지하고,
  // 이 12종은 챗 질의와 /liquidity 프리셋 화면에서 쓴다.
  ...liquiditySeries.map(
    (s): IndicatorDef => ({
      id: s.indicatorId,
      name: `${s.label}${s.qualifier ? ` (${s.qualifier})` : ""}`,
      country: "US",
      unit: s.unit,
      kind: s.unit === "%" ? "rate" : "amount",
      cycle: "D",
      origin: "미 연준 (FRED 수록)",
      aliases: liquidityAliases(s.fredId),
      featured: false,
      source: "fred",
      params: { seriesId: s.fredId },
      divideBy: s.divideBy,
      verified: true,
    })
  ),
];

export function getIndicator(id: string): IndicatorDef | undefined {
  return indicators.find((i) => i.id === id);
}
