import type { SectorId, SectorManifest } from "./types";

/**
 * 섹터 원장. 내용 확정 전에는 검증된 기존 지표만 기술 프로브로 연결한다.
 * probes가 빈 섹터는 값을 만들지 않고 `지표 구성 대기` 상태를 유지한다.
 */
export const sectorManifest: readonly SectorManifest[] = [
  {
    id: "growth",
    title: "성장",
    description: "GDP·생산·소비·투자의 분기 성장 흐름",
    probes: [
      ["kr_real_gdp_qoq", "실질 GDP 성장률 (전기대비)", 8],
      ["kr_real_gdp_yoy", "실질 GDP 성장률 (전년동기대비)", 8],
      ["kr_manufacturing_gdp_yoy", "제조업 생산 증가율 (전년동기대비)", 12],
      ["kr_services_gdp_yoy", "서비스업 생산 증가율 (전년동기대비)", 12],
      ["kr_construction_gdp_yoy", "건설업 생산 증가율 (전년동기대비)", 12],
      ["kr_private_consumption_yoy", "민간소비 증가율 (전년동기대비)", 12],
      ["kr_government_consumption_yoy", "정부소비 증가율 (전년동기대비)", 12],
      ["kr_equipment_investment_yoy", "설비투자 증가율 (전년동기대비)", 12],
      ["kr_construction_investment_yoy", "건설투자 증가율 (전년동기대비)", 12],
    ].map(([indicatorId, description, observations]) => ({
      indicatorId: String(indicatorId),
      source: "ecos" as const,
      sourceLabel: "ECOS" as const,
      description: String(description),
      observations: Number(observations),
    })),
  },
  {
    id: "trade",
    title: "수출입",
    description: "통관 수출입·수출지수·주요국 수출의 월별 흐름",
    probes: [
      ...([
      ["kr_customs_export_amount", undefined, undefined, "통관 수출금액"],
      ["kr_customs_import_amount", undefined, undefined, "통관 수입금액"],
      ["kr_customs_export_amount", "kr_customs_export_yoy", "yoy", "통관 수출금액 전년비"],
      ["kr_customs_import_amount", "kr_customs_import_yoy", "yoy", "통관 수입금액 전년비"],
      ["kr_export_volume_idx", "kr_export_volume_idx_yoy", "yoy", "전체 수출물량지수 전년비"],
      ["kr_export_value_idx", "kr_export_value_idx_yoy", "yoy", "전체 수출금액지수 전년비"],
      ["kr_export_volume_idx", "kr_export_volume_idx_mom", "mom", "전체 수출물량지수 전월비"],
      ["kr_export_value_idx", "kr_export_value_idx_mom", "mom", "전체 수출금액지수 전월비"],
      ["kr_semiconductor_export_volume_idx", "kr_semiconductor_export_volume_idx_yoy", "yoy", "반도체 수출물량지수 전년비"],
      ["kr_semiconductor_export_value_idx", "kr_semiconductor_export_value_idx_yoy", "yoy", "반도체 수출금액지수 전년비"],
      ["kr_export_by_country_amount", undefined, "top4_yoy", "주요 수출국 상위 4개 전년비"],
      ] as const).map(([indicatorId, resultIndicatorId, transform, description]) => ({
      indicatorId,
      ...(resultIndicatorId ? { resultIndicatorId } : {}),
      ...(transform ? { transform: transform as "yoy" | "mom" | "top4_yoy" } : {}),
      source: "ecos" as const,
      sourceLabel: "ECOS" as const,
      description,
      observations: 36,
      })),
      {
        indicatorId: "kr_daily_average_export_yoy",
        source: "kcs",
        sourceLabel: "관세청",
        description: "일평균 수출액 전년동월비",
        observations: 36,
      },
    ],
  },
  {
    id: "fiscal",
    title: "재정",
    description: "재정수입·지출·국가채무·국세수입의 연간 흐름",
    // 일반회계 국세수입과 3개년 예산규모는 국세총액·단일 빈티지로
    // 대체하지 않고 공식 원천이 확정될 때까지 대기로 둔다.
    pendingIndicators: 2,
    probes: [
      {
        indicatorId: "kr_national_debt_to_gdp",
        source: "kosis",
        sourceLabel: "KOSIS",
        description: "GDP 대비 국가채무 비율",
        observations: 5,
      },
      ...(
        [
          ["kr_national_tax_total", "국세총액 (일반회계와 정의 다름)"],
          ["kr_income_tax_revenue", "소득세"],
          ["kr_corporate_tax_revenue", "법인세"],
          ["kr_vat_revenue", "부가가치세"],
        ] as const
      ).map(([indicatorId, description]) => ({
        indicatorId,
        source: "ecos" as const,
        sourceLabel: "ECOS" as const,
        description,
        observations: 2,
      })),
      ...(
        [
          ["kr_fiscal_total_revenue_progress", "총수입 월별 진도율"],
          ["kr_fiscal_total_expenditure_progress", "총지출 월별 진도율"],
          ["kr_ktb_issuance_progress", "국고채 누계 발행 진도율"],
        ] as const
      ).map(([indicatorId, description]) => ({
        indicatorId,
        source: "mpb" as const,
        sourceLabel: "기획예산처" as const,
        description,
        observations: 24,
      })),
    ],
  },
  {
    id: "labor",
    title: "노동시장",
    description: "고용·종사상지위·임금·전망 CSI의 월별 흐름",
    // 제조업·건설업과 동일 분류의 '서비스업 합계' 단일 계열은
    // 공식 표에 없어 하위 업종을 임의 합산하지 않고 대기로 둔다.
    pendingIndicators: 1,
    probes: [
      {
        indicatorId: "kr_employed_total",
        resultIndicatorId: "kr_employed_total_yoy_delta",
        source: "kosis",
        sourceLabel: "KOSIS",
        description: "취업자 수 전년동월 증감",
        transform: "yoy_delta",
        observations: 36,
      },
      ...(
        [
          ["kr_employed_manufacturing", "제조업"],
          ["kr_employed_construction", "건설업"],
        ] as const
      ).map(([indicatorId, label]) => ({
        indicatorId,
        resultIndicatorId: `${indicatorId}_yoy_delta`,
        source: "kosis" as const,
        sourceLabel: "KOSIS" as const,
        description: `${label} 취업자 전년동월 증감`,
        transform: "yoy_delta" as const,
        observations: 36,
      })),
      ...(
        [
          ["kr_employed_wage", "임금근로자"],
          ["kr_employed_nonwage", "비임금근로자"],
          ["kr_employed_regular", "상용근로자"],
          ["kr_employed_temporary", "임시근로자"],
          ["kr_employed_daily", "일용근로자"],
          ["kr_employed_self", "자영업자"],
          ["kr_employed_unpaid_family", "무급가족종사자"],
        ] as const
      ).map(([indicatorId, label]) => ({
        indicatorId,
        resultIndicatorId: `${indicatorId}_yoy_delta`,
        source: "kosis" as const,
        sourceLabel: "KOSIS" as const,
        description: `${label} 전년동월 증감`,
        transform: "yoy_delta" as const,
        observations: 36,
      })),
      ...(
        [
          ["kr_sa_employment_rate", "계절조정 고용률"],
          ["kr_sa_labor_force_participation", "계절조정 경제활동참가율"],
        ] as const
      ).map(([indicatorId, description]) => ({
        indicatorId,
        source: "kosis" as const,
        sourceLabel: "KOSIS" as const,
        description,
        observations: 36,
      })),
      ...(
        [
          ["kr_wage_total", "전체"],
          ["kr_wage_regular", "상용"],
          ["kr_wage_temporary_daily", "임시일용"],
        ] as const
      ).map(([indicatorId, label]) => ({
        indicatorId,
        stitchIndicatorId: `${indicatorId}_history`,
        resultIndicatorId: `${indicatorId}_yoy`,
        source: "kosis" as const,
        sourceLabel: "KOSIS" as const,
        description: `${label} 임금총액 전년동월비`,
        transform: "yoy" as const,
        observations: 60,
        // 최신 임금 공표월이 현재월보다 느려 60개 전년비 산출에 여유를 둔다.
        lookbackYears: 7,
      })),
      ...(
        [
          ["kr_wage_outlook_csi", "임금수준전망 CSI"],
          ["kr_job_opportunity_csi", "취업기회전망 CSI"],
        ] as const
      ).map(([indicatorId, description]) => ({
        indicatorId,
        source: "ecos" as const,
        sourceLabel: "ECOS" as const,
        description,
        observations: 60,
      })),
    ],
  },
  {
    id: "capital-account",
    title: "자본계정",
    description: "국제수지 금융계정 지표를 연결할 자리",
    probes: [],
  },
  {
    id: "inflation",
    title: "물가",
    description: "소비자·수출입·생산자 물가와 기대인플레이션의 월별 흐름",
    probes: [
      ["kr_cpi", "kr_cpi_yoy", "kosis", "KOSIS", "헤드라인 소비자물가 전년비", "yoy", 60],
      ["kr_core_cpi", "kr_core_cpi_yoy", "kosis", "KOSIS", "근원 소비자물가 전년비", "yoy", 60],
      ["kr_goods_cpi", "kr_goods_cpi_yoy", "kosis", "KOSIS", "상품물가 전년비", "yoy", 60],
      ["kr_services_cpi", "kr_services_cpi_yoy", "kosis", "KOSIS", "서비스물가 전년비", "yoy", 60],
      ["kr_export_price_index", "kr_export_price_index_yoy", "ecos", "ECOS", "수출물가 전년비 (원화 기준)", "yoy", 60],
      ["kr_import_price_index", "kr_import_price_index_yoy", "ecos", "ECOS", "수입물가 전년비 (원화 기준)", "yoy", 60],
      ["kr_usdkrw_monthly_average", "kr_usdkrw_monthly_average_yoy", "ecos", "ECOS", "원/달러 환율 월평균 전년비", "yoy", 60],
      ["kr_ppi_total", "kr_ppi_total_yoy", "ecos", "ECOS", "생산자물가 전년비", "yoy", 60],
      ["kr_ppi_industrial_products", "kr_ppi_industrial_products_yoy", "ecos", "ECOS", "공산품 생산자물가 전년비", "yoy", 60],
      ["kr_ppi_services", "kr_ppi_services_yoy", "ecos", "ECOS", "서비스 생산자물가 전년비", "yoy", 60],
      ["kr_expected_inflation", undefined, "ecos", "ECOS", "향후 1년 기대인플레이션율", undefined, 60],
      ["dubai_crude_oil_price", undefined, "ecos", "ECOS", "Dubai유 가격", undefined, 12],
      ["kr_crude_import_unit_cost", undefined, "motir", "산업통상부", "원유 도입단가", undefined, 12],
    ].map(([indicatorId, resultIndicatorId, source, sourceLabel, description, transform, observations]) => ({
      indicatorId: String(indicatorId),
      ...(resultIndicatorId ? { resultIndicatorId: String(resultIndicatorId) } : {}),
      source: source as "ecos" | "kosis" | "motir",
      sourceLabel: sourceLabel as "ECOS" | "KOSIS" | "산업통상부",
      description: String(description),
      ...(transform ? { transform: transform as "yoy" } : {}),
      observations: Number(observations),
    })),
  },
  {
    id: "equipment-investment",
    title: "설비투자",
    description: "국민계정 설비투자·가동률·반도체 장비·투자전망의 흐름",
    probes: [
      ...(
        [
          ["kr_equipment_investment_na", "kr_equipment_investment_na_yoy", "설비투자 전년동기비"],
          ["kr_machinery_investment_na", "kr_machinery_investment_na_yoy", "기계류 투자 전년동기비"],
          ["kr_transport_equipment_investment_na", "kr_transport_equipment_investment_na_yoy", "운송장비 투자 전년동기비"],
        ] as const
      ).map(([indicatorId, resultIndicatorId, description]) => ({
        indicatorId,
        resultIndicatorId,
        source: "ecos" as const,
        sourceLabel: "ECOS" as const,
        description,
        transform: "yoy" as const,
        observations: 20,
        // 현재 분기가 아직 공표되지 않은 시점에도 비교 기준분기까지 확보한다.
        lookbackYears: 7,
      })),
      {
        indicatorId: "kr_manufacturing_utilization_rate",
        resultIndicatorId: "kr_manufacturing_utilization_rate_yoy",
        source: "kosis",
        sourceLabel: "KOSIS",
        description: "제조업 평균가동률 수준의 전년동월 대비 증감률",
        transform: "yoy",
        observations: 60,
        lookbackYears: 7,
      },
      {
        indicatorId: "kr_semiconductor_machinery_investment_index",
        resultIndicatorId: "kr_semiconductor_machinery_investment_index_yoy",
        source: "kosis",
        sourceLabel: "KOSIS",
        description: "반도체제조용기계 설비투자지수 전년동월비",
        transform: "yoy",
        observations: 60,
        lookbackYears: 7,
      },
      {
        indicatorId: "kr_semiconductor_equipment_import_amount",
        resultIndicatorId: "kr_semiconductor_equipment_import_amount_yoy",
        source: "kita",
        sourceLabel: "K-stat",
        description: "반도체 제조용 장비 수입액 전년동월비",
        transform: "yoy",
        observations: 60,
        lookbackYears: 6,
      },
      ...(
        [
          ["kr_equipment_investment_outlook_bsi_large", "대기업 설비투자전망 BSI"],
          ["kr_equipment_investment_outlook_bsi_manufacturing", "제조업 설비투자전망 BSI"],
          ["kr_equipment_investment_outlook_bsi_sme", "중소기업 설비투자전망 BSI"],
        ] as const
      ).map(([indicatorId, description]) => ({
        indicatorId,
        source: "ecos" as const,
        sourceLabel: "ECOS" as const,
        description,
        observations: 60,
        lookbackYears: 6,
      })),
    ],
  },
  {
    id: "construction-investment",
    title: "건설투자",
    description: "건설투자·기성·수주·착공·주택 공급의 분기 흐름",
    probes: [
      ["kr_construction_investment_na_yoy", undefined, "yoy", "건설투자 전년동기비", undefined],
      ["kr_building_construction_investment_yoy", undefined, "yoy", "건물건설 투자 전년동기비", undefined],
      ["kr_civil_construction_investment_yoy", undefined, "yoy", "토목건설 투자 전년동기비", undefined],
      ["kr_construction_completed_total", "kr_construction_completed_total_yoy", "quarterly_sum_yoy", "건설기성 전년동기비", undefined],
      ["kr_construction_completed_building", "kr_construction_completed_building_yoy", "quarterly_sum_yoy", "건축 기성 전년동기비", undefined],
      ["kr_construction_completed_civil", "kr_construction_completed_civil_yoy", "quarterly_sum_yoy", "토목 기성 전년동기비", undefined],
      ["kr_building_orders_amount", "kr_building_orders_6q_ma_yoy", "quarterly_sum_6q_ma_yoy", "건축 수주 6분기 이동평균 전년동기비", undefined],
      ["kr_building_start_area", "kr_building_start_area_6q_ma_yoy", "quarterly_sum_6q_ma_yoy", "건축 착공면적 6분기 이동평균 전년동기비", undefined],
      ["kr_construction_completed_current_value", "kr_construction_completed_deflator_yoy", "quarterly_ratio_yoy", "건설기성 디플레이터 전년동기비", "kr_construction_completed_total"],
      ["kr_housing_completions", "kr_housing_completions_4q_ma_yoy", "quarterly_sum_4q_ma_yoy", "주택 준공 4분기 이동평균 전년동기비", undefined],
      ["kr_housing_starts", "kr_housing_starts_4q_ma_yoy", "quarterly_sum_4q_ma_yoy", "주택 착공 4분기 이동평균 전년동기비", undefined],
      ["kr_housing_permits_cumulative", "kr_housing_permits_4q_ma_yoy", "cumulative_to_quarterly_sum_4q_ma_yoy", "주택 인허가 4분기 이동평균 전년동기비", undefined],
    ].map(([indicatorId, resultIndicatorId, transform, description, denominatorIndicatorId]) => ({
      indicatorId: String(indicatorId),
      ...(resultIndicatorId ? { resultIndicatorId: String(resultIndicatorId) } : {}),
      ...(denominatorIndicatorId ? { denominatorIndicatorId: String(denominatorIndicatorId) } : {}),
      ...(transform ? { transform: transform as
        | "yoy"
        | "quarterly_sum_yoy"
        | "quarterly_sum_6q_ma_yoy"
        | "quarterly_sum_4q_ma_yoy"
        | "quarterly_ratio_yoy"
        | "cumulative_to_quarterly_sum_4q_ma_yoy" } : {}),
      source: String(indicatorId).startsWith("kr_housing_permits") || String(indicatorId).includes("investment")
        ? "ecos" as const
        : "kosis" as const,
      sourceLabel: String(indicatorId).startsWith("kr_housing_permits") || String(indicatorId).includes("investment")
        ? "ECOS" as const
        : "KOSIS" as const,
      description: String(description),
      observations: 20,
      lookbackYears: 9,
    })),
  },
  {
    id: "national-fiscal-plan",
    title: "국가재정운용계획",
    description: "중기 재정 경로와 계획 빈티지를 연결할 자리",
    probes: [],
  },
  {
    id: "domestic-liquidity",
    title: "국내 유동성",
    description: "M2·예금·상품·경제주체별 월간 유동성 흐름",
    // 금융기관 수신 동일누적기간 비교와 금투협 일별 대기성 자금은
    // 정의가 고정된 구조화 API를 확정할 때까지 대기로 둔다.
    pendingIndicators: 2,
    probes: [
      {
        indicatorId: "kr_m2_sa_average",
        source: "ecos",
        sourceLabel: "ECOS",
        description: "M2 규모 (평잔, 계절조정)",
        observations: 42,
        lookbackYears: 5,
      },
      {
        indicatorId: "kr_m2_total_original",
        resultIndicatorId: "kr_m2_total_original_yoy",
        source: "ecos",
        sourceLabel: "ECOS",
        description: "M2 총계 (평잔, 원계열) 전년동월비",
        transform: "yoy",
        observations: 55,
        lookbackYears: 7,
      },
      ...(
        [
          ["kr_m2_demand_savings", "수시입출식저축성예금"],
          ["kr_m2_time_deposits_under_2y", "만기 2년 미만 정기예적금"],
          ["kr_m2_mmf", "MMF"],
          ["kr_m2_cma", "CMA"],
          ["kr_m2_households", "가계 및 비영리단체"],
          ["kr_m2_nonfinancial_corporations", "비금융기업"],
          ["kr_m2_other_financial_institutions", "기타금융기관"],
        ] as const
      ).map(([indicatorId, label]) => ({
        indicatorId,
        denominatorIndicatorId: "kr_m2_total_original",
        resultIndicatorId: `${indicatorId}_share_snapshots`,
        source: "ecos" as const,
        sourceLabel: "ECOS" as const,
        description: `${label} M2 비중`,
        transform: "share_snapshots" as const,
        observations: 3,
        lookbackYears: 4,
      })),
      ...(
        [
          ["kr_m2_demand_savings", "수시입출식저축성예금"],
          ["kr_m2_time_deposits_under_2y", "만기 2년 미만 정기예적금"],
          ["kr_m2_mmf", "MMF"],
          ["kr_m2_cma", "CMA"],
          ["kr_m2_households", "가계 및 비영리단체"],
          ["kr_m2_nonfinancial_corporations", "비금융기업"],
        ] as const
      ).map(([indicatorId, label]) => ({
        indicatorId,
        resultIndicatorId: `${indicatorId}_yoy`,
        source: "ecos" as const,
        sourceLabel: "ECOS" as const,
        description: `${label} M2 전년동월비`,
        transform: "yoy" as const,
        observations: 55,
        lookbackYears: 7,
      })),
      ...(
        [
          ["kr_household_deposits", "가계 총예금"],
          ["kr_corporate_deposits", "기업 총예금"],
        ] as const
      ).map(([indicatorId, label]) => ({
        indicatorId,
        resultIndicatorId: `${indicatorId}_year_end_latest`,
        source: "ecos" as const,
        sourceLabel: "ECOS" as const,
        description: `${label} 연말·최신월 잔액`,
        transform: "year_end_latest" as const,
        observations: 7,
        lookbackYears: 7,
      })),
      ...(
        [
          ["kr_total_deposits", "총예금"],
          ["kr_household_deposits", "가계 총예금"],
          ["kr_corporate_deposits", "기업 총예금"],
        ] as const
      ).map(([indicatorId, label]) => ({
        indicatorId,
        resultIndicatorId: `${indicatorId}_yoy`,
        source: "ecos" as const,
        sourceLabel: "ECOS" as const,
        description: `${label} 잔액 전년동월비`,
        transform: "yoy" as const,
        observations: 55,
        lookbackYears: 7,
      })),
    ],
  },
] as const;

const manifestById = new Map(sectorManifest.map((sector) => [sector.id, sector]));

export function getSectorManifest(id: SectorId): SectorManifest {
  const sector = manifestById.get(id);
  if (!sector) throw new Error(`알 수 없는 섹터: ${id}`);
  return sector;
}
