export type SourceId =
  | "ecos"    // 한국은행 경제통계시스템
  | "kosis"   // 통계청 국가통계포털
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
