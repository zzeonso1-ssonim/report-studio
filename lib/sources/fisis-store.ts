import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * FISIS 증분 적재 저장소.
 * - 월 단위 값 + 월별 수집 시각(fetchedAt)을 기록해 재호출 여부를 판단한다.
 * - 일일 호출 카운터를 KST 날짜별로 영속화한다.
 * - 인터페이스(FisisStore)만 지키면 나중에 Supabase 등으로 교체 가능.
 */

/** 저장 위치 — 프로젝트 루트 .data/fisis/ (커밋 금지, .gitignore 등재) */
const DATA_DIR = path.join(process.cwd(), ".data", "fisis");
const SERIES_DIR = path.join(DATA_DIR, "series");
const CALL_COUNT_FILE = path.join(DATA_DIR, "call-counts.json");

export interface StoredSeries {
  /** "YYYYMM" → 값. 항목이 있으면 해당 월 데이터 존재. null은 원천이 빈 값("")을 준 경우 */
  values: Record<string, number | null>;
  /**
   * "YYYYMM" → ISO 수집 시각. values에 없어도 fetchedAt에 있으면
   * "호출했으나 데이터 없음"으로 간주해 재호출을 생략한다.
   */
  fetchedAt: Record<string, string>;
}

export interface FisisStore {
  loadSeries(seriesKey: string): Promise<StoredSeries>;
  saveSeries(seriesKey: string, data: StoredSeries): Promise<void>;
  /** kstDate: "YYYY-MM-DD" (KST 기준) */
  getDailyCallCount(kstDate: string): Promise<number>;
  incrementDailyCallCount(kstDate: string): Promise<number>;
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8")) as T;
  } catch {
    return fallback; // 파일 없음·파싱 실패 → 빈 상태에서 시작
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf-8");
}

/** 시리즈 키를 안전한 파일명으로 변환 */
function seriesFile(seriesKey: string): string {
  const safe = seriesKey.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(SERIES_DIR, `${safe}.json`);
}

/** 파일 기반 기본 구현 */
export const fileStore: FisisStore = {
  async loadSeries(seriesKey) {
    return readJson<StoredSeries>(seriesFile(seriesKey), { values: {}, fetchedAt: {} });
  },

  async saveSeries(seriesKey, data) {
    await writeJson(seriesFile(seriesKey), data);
  },

  async getDailyCallCount(kstDate) {
    const counts = await readJson<Record<string, number>>(CALL_COUNT_FILE, {});
    return counts[kstDate] ?? 0;
  },

  async incrementDailyCallCount(kstDate) {
    const counts = await readJson<Record<string, number>>(CALL_COUNT_FILE, {});
    const next = (counts[kstDate] ?? 0) + 1;
    // 과거 날짜 카운트는 정리 (당일 것만 유지)
    await writeJson(CALL_COUNT_FILE, { [kstDate]: next });
    return next;
  },
};
