import { Cycle } from "./indicators";
import { EcosItemIndexStatus } from "./ecos-item-index";
import { SourceId } from "./sources/types";

/**
 * 통합검색 결과 타입 — lib/search.ts와 lib/search-llm.ts가 함께 쓴다.
 * 두 모듈이 서로를 import하면 순환이 되므로 타입만 여기로 분리했다.
 */
export interface SearchResult {
  source: SourceId;
  name: string;
  params: Record<string, string>;
  cycle: Cycle;
  unit?: string;
  origin: string;
}

/**
 * 항목이 일부만 노출된 통계표 — "더 있다"는 사실을 드러내기 위한 신호.
 * 이게 없으면 모델도 사용자도 결손을 인지할 수 없어 표를 열어볼 이유를 못 찾는다.
 */
export interface TableTruncation {
  source: SourceId;
  /** ECOS는 statCode, KOSIS는 "orgId/tblId" */
  statCode: string;
  statName: string;
  shownItems: number;
  totalItems: number;
}

export interface SearchOutcome {
  results: SearchResult[];
  /** 소스별 부분 실패 메시지 (키 미설정, HTTP 오류, 제한시간 초과 등) */
  errors: string[];
  /** 실패가 아닌 안내 — 조회 대상이 아니라 건너뛴 소스, 항목 절단 등 */
  notes: string[];
  /** 항목이 잘린 통계표 목록 — 챗 도구가 모델에 그대로 전달한다 */
  truncated: TableTruncation[];
  /**
   * ECOS 항목명 색인 상태 + 기준일(builtAt).
   * 색인이 빠지면 검색 품질이 수정 전으로 되돌아가므로 응답에 항상 싣는다.
   */
  indexStatus: EcosItemIndexStatus;
}
