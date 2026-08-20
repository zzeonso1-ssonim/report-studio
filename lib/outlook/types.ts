export const SECTOR_IDS = [
  "growth",
  "trade",
  "fiscal",
  "labor",
  "capital-account",
  "inflation",
  "equipment-investment",
  "construction-investment",
  "national-fiscal-plan",
  "domestic-liquidity",
] as const;

export type SectorId = (typeof SECTOR_IDS)[number];
export type SectorStatus =
  | "pending_config"
  | "ready"
  | "refreshing"
  | "success"
  | "partial"
  | "error";

export interface SectorProbe {
  indicatorId: string;
  /** 통계 개편으로 표가 나뉜 경우 현행 계열 앞에 이어 붙일 검증 원장의 과거 계열 ID. */
  stitchIndicatorId?: string;
  /** 같은 원계열에서 변환한 결과를 별도 차트 계열로 저장할 때의 ID. */
  resultIndicatorId?: string;
  /** 두 원계열의 분기 합계 비율로 지수를 만들 때 사용하는 분모 계열. */
  denominatorIndicatorId?: string;
  source: "ecos" | "kosis" | "kita" | "kcs" | "mpb" | "motir";
  sourceLabel: "ECOS" | "KOSIS" | "K-stat" | "관세청" | "기획예산처" | "산업통상부";
  description: string;
  /** 저장할 최신 비결측 관측치 수. 분기 2년=8, 3년=12. */
  observations?: number;
  transform?:
    | "yoy"
    | "yoy_delta"
    | "mom"
    | "top4_yoy"
    | "quarterly_sum_yoy"
    | "quarterly_sum_6q_ma_yoy"
    | "quarterly_sum_4q_ma_yoy"
    | "quarterly_ratio_yoy"
    | "cumulative_to_quarterly_sum_4q_ma_yoy"
    | "share_snapshots"
    | "year_end_latest";
  /** 이동평균·전년비 산출에 필요한 원자료 조회기간. 기본값은 6년. */
  lookbackYears?: number;
}

export interface SectorObservation {
  date: string;
  value: number | null;
  dimensionCode?: string;
  dimensionName?: string;
  provenance?: {
    publishedAt: string;
    sourceUrl: string;
    title: string;
    vintage?: string;
    note?: string;
  };
}

export interface SectorManifest {
  id: SectorId;
  title: string;
  description: string;
  probes: SectorProbe[];
  /** 공식 원천이 확인되지 않아 UI 자리만 마련한 지표 수. */
  pendingIndicators?: number;
}

export interface SectorSourceResult {
  indicatorId: string;
  probeName: string;
  sourceLabel: string;
  lastObservedAt: string | null;
  status: "success" | "error";
  error: string | null;
  /** 차트가 같은 섹터 저장 파일만 읽도록 갱신 시 함께 보관한다. */
  points: SectorObservation[];
}

export interface SectorSnapshot {
  id: SectorId;
  title: string;
  description: string;
  status: SectorStatus;
  hasProbe: boolean;
  sourceLabel: string | null;
  probeName: string | null;
  lastObservedAt: string | null;
  lastRefreshedAt: string | null;
  nextReleaseAt: string | null;
  sourceResults: SectorSourceResult[];
  error: string | null;
}

export function isSectorId(value: string): value is SectorId {
  return (SECTOR_IDS as readonly string[]).includes(value);
}
