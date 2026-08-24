import constructionInvestment from "@/data/outlook/construction-investment.json";
import domesticLiquidity from "@/data/outlook/domestic-liquidity.json";
import equipmentInvestment from "@/data/outlook/equipment-investment.json";
import fiscal from "@/data/outlook/fiscal.json";
import growth from "@/data/outlook/growth.json";
import inflation from "@/data/outlook/inflation.json";
import labor from "@/data/outlook/labor.json";
import trade from "@/data/outlook/trade.json";
import type { SectorId, SectorSourceResult, SectorStatus } from "./types";

export interface BundledOutlookState {
  status: SectorStatus;
  probeName: string | null;
  lastObservedAt: string | null;
  lastRefreshedAt: string | null;
  sourceResults: SectorSourceResult[];
  error: string | null;
}

const bundledStates: Partial<Record<SectorId, BundledOutlookState>> = {
  growth,
  trade,
  fiscal,
  labor,
  inflation,
  "equipment-investment": equipmentInvestment,
  "construction-investment": constructionInvestment,
  "domestic-liquidity": domesticLiquidity,
} as Partial<Record<SectorId, BundledOutlookState>>;

/**
 * 새 서버리스 인스턴스의 /tmp가 비어 있을 때 사용하는 검증 완료 스냅샷.
 * 런타임에서 섹터 갱신에 성공하면 /tmp의 최신 상태가 이 시드보다 우선한다.
 */
export function getBundledOutlookState(id: SectorId): BundledOutlookState | undefined {
  return bundledStates[id];
}
