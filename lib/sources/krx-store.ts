import path from "node:path";
import { dataPath, readJsonFile, writeJsonFile } from "../data-dir";

/**
 * KRX 일별 원시응답 영속 캐시.
 * - KRX openapi는 기준일(basDd) 1일 단위 조회이므로 endpoint+일자 단위로
 *   해당일 "전체 행"을 저장한다 → 같은 endpoint를 쓰는 지표들(예: 국고 3y/10y가
 *   같은 bon/kts_bydd_trd를 씀)이 캐시를 공유하고, 행 필터는 캐시 위에서 적용.
 * - rows가 빈 배열인 항목은 "휴장일(데이터 없음)"도 캐시한 것 — 재호출 방지용.
 * - 인터페이스(KrxStore)만 지키면 나중에 Supabase 등으로 교체 가능.
 *
 * 휘발성 환경(Vercel 등 → /tmp, lib/data-dir.ts 참조)에서의 의미:
 * - 인스턴스마다 별도의 /tmp이고 콜드스타트마다 비므로 캐시 적중률이 낮아진다.
 * - 정확성 문제는 없다: KRX 일별 확정치는 재호출해도 같은 값이고 호출 한도(과금)도
 *   없다. 다만 미캐시 일자가 많으면 응답이 느려지고, 연속 호출이 많아지면
 *   속도 제한(HTTP 403)에 걸릴 확률이 올라간다.
 * - 쓰기 실패는 조회를 실패시키지 않는다(경고 후 진행) — 캐시 없이 API 결과를 그대로 반환.
 */

/** 저장 위치 — <데이터루트>/krx/{endpoint}/{YYYYMMDD}.json (루트 결정은 lib/data-dir.ts) */
const SUBDIR = "krx";

export interface StoredKrxDay {
  /** ISO 수집 시각 — 빈 응답의 "장 마감 전 조회" 여부 판단에 사용 */
  fetchedAt: string;
  /** 해당일 전체 행 (필터 미적용 원시응답). 빈 배열 = 해당일 데이터 없음(휴장 등) */
  rows: Record<string, string>[];
}

export interface KrxStore {
  /** day: "YYYYMMDD". 없거나 형식이 깨졌으면 null */
  loadDay(endpoint: string, day: string): Promise<StoredKrxDay | null>;
  saveDay(endpoint: string, day: string, data: StoredKrxDay): Promise<void>;
}

/** endpoint 경로("bon/kts_bydd_trd")를 안전한 디렉터리명으로 변환 */
function dayFile(endpoint: string, day: string): string {
  const safe = endpoint.replace(/[^a-zA-Z0-9_-]/g, "_");
  return dataPath(SUBDIR, safe, `${day}.json`);
}

/** 파일 기반 기본 구현 */
export const fileStore: KrxStore = {
  async loadDay(endpoint, day) {
    // 읽기 실패(파일 없음·파싱 실패·권한 오류)는 모두 "캐시 없음"으로 간주 → 재수집
    const parsed = await readJsonFile<StoredKrxDay | null>(dayFile(endpoint, day), null);
    if (!parsed || typeof parsed.fetchedAt !== "string" || !Array.isArray(parsed.rows)) {
      return null;
    }
    return parsed;
  },

  async saveDay(endpoint, day, data) {
    // 쓰기 실패해도 예외를 던지지 않는다 — 캐시는 최적화일 뿐이고,
    // 실패 시 이번 요청은 이미 받아둔 API 결과로 정상 응답한다(다음 요청은 재호출).
    const file = dayFile(endpoint, day);
    await writeJsonFile(file, data, { warnKey: `krx:${path.dirname(file)}` });
  },
};
