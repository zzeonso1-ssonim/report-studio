export type SourceId =
  | "ecos"    // 한국은행 경제통계시스템
  | "kosis"   // 통계청 국가통계포털
  | "kita"    // 한국무역협회 K-stat
  | "kcs"     // 관세청 월간 수출입 현황
  | "mpb"     // 기획예산처 월간 재정동향
  | "motir"   // 산업통상부 월간 수출입 동향
  | "krx"     // 한국거래소
  | "rone"    // 부동산원 R-ONE
  | "dart"    // 금감원 전자공시
  | "fisis"   // 금융감독원 금융통계정보시스템
  | "fred"    // 세인트루이스 연은
  | "bls"     // 미 노동통계국
  | "bea";    // 미 경제분석국

export interface SeriesPoint {
  date: string; // YYYY-MM-DD 또는 YYYY-MM, YYYY-QQ — cycle에 따름
  value: number | null;
  /** 다차원 표를 와일드카드로 조회할 때의 하위 항목(예: 수출 대상국). */
  dimensionCode?: string;
  dimensionName?: string;
  /** 공식 문서 지표의 발표·기준월·분모 빈티지 감사 정보. */
  provenance?: {
    publishedAt: string;
    sourceUrl: string;
    title: string;
    vintage?: string;
    note?: string;
  };
}

export interface SeriesRange {
  start: string; // YYYYMMDD / YYYYMM 등 소스 관례 이전의 정규형 (YYYY-MM-DD)
  end: string;
}

export interface SourceAdapter {
  id: SourceId;
  name: string;
  requiresKey: boolean;
  /** 지표 레지스트리의 params를 받아 시계열을 반환. 키 미설정·미구현 시 throw */
  fetchSeries(
    params: Record<string, string>,
    range: SeriesRange
  ): Promise<SeriesPoint[]>;
}

export class SourceError extends Error {
  constructor(
    public source: SourceId,
    message: string
  ) {
    super(`[${source}] ${message}`);
  }
}

export function requireKey(source: SourceId, envName: string): string {
  const key = process.env[envName];
  if (!key) throw new SourceError(source, `${envName} 환경변수가 설정되지 않았습니다`);
  return key;
}
