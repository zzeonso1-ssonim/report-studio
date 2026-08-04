import { Cycle } from "./indicators";
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

export interface SearchOutcome {
  results: SearchResult[];
  /** 소스별 부분 실패 메시지 (키 미설정, HTTP 오류, 제한시간 초과 등) */
  errors: string[];
  /** 실패가 아닌 안내 — 조회 대상이 아니라 건너뛴 소스 등 */
  notes: string[];
}
