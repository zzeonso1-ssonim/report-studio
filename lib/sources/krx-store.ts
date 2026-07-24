import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * KRX 일별 원시응답 영속 캐시.
 * - KRX openapi는 기준일(basDd) 1일 단위 조회이므로 endpoint+일자 단위로
 *   해당일 "전체 행"을 저장한다 → 같은 endpoint를 쓰는 지표들(예: 국고 3y/10y가
 *   같은 bon/kts_bydd_trd를 씀)이 캐시를 공유하고, 행 필터는 캐시 위에서 적용.
 * - rows가 빈 배열인 항목은 "휴장일(데이터 없음)"도 캐시한 것 — 재호출 방지용.
 * - 인터페이스(KrxStore)만 지키면 나중에 Supabase 등으로 교체 가능.
 */

/** 저장 위치 — 프로젝트 루트 .data/krx/{endpoint}/{YYYYMMDD}.json (.gitignore 등재) */
const DATA_DIR = path.join(process.cwd(), ".data", "krx");

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
  return path.join(DATA_DIR, safe, `${day}.json`);
}

/** 파일 기반 기본 구현 */
export const fileStore: KrxStore = {
  async loadDay(endpoint, day) {
    try {
      const parsed = JSON.parse(
        await fs.readFile(dayFile(endpoint, day), "utf-8")
      ) as StoredKrxDay;
      if (!parsed || typeof parsed.fetchedAt !== "string" || !Array.isArray(parsed.rows)) {
        return null; // 형식이 깨진 파일은 미보유로 간주 → 재수집
      }
      return parsed;
    } catch {
      return null; // 파일 없음·파싱 실패 → 미보유
    }
  },

  async saveDay(endpoint, day, data) {
    const file = dayFile(endpoint, day);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // 원자적 쓰기: 임시 파일에 쓴 뒤 rename (동시 요청이 깨진 파일을 읽지 않도록)
    const tmp = `${file}.tmp-${randomUUID()}`;
    await fs.writeFile(tmp, JSON.stringify(data), "utf-8");
    await fs.rename(tmp, file);
  },
};
