import { dataPath, isEphemeralDataRoot, readJsonFile, warnOnce, writeJsonFile } from "../data-dir";

/**
 * FISIS 증분 적재 저장소.
 * - 월 단위 값 + 월별 수집 시각(fetchedAt)을 기록해 재호출 여부를 판단한다.
 * - 일일 호출 카운터를 KST 날짜별로 영속화한다.
 * - 인터페이스(FisisStore)만 지키면 나중에 Supabase 등으로 교체 가능.
 *
 * ⚠️ 휘발성 환경(Vercel 등 → /tmp, lib/data-dir.ts 참조)에서의 의미:
 * - 시리즈 캐시: 인스턴스마다 별도 /tmp, 콜드스타트마다 초기화 → 이미 받은 월도
 *   다른 인스턴스에서는 다시 호출된다. 값의 정확성 문제는 없지만 "일 30회" 한도를
 *   그만큼 더 소모한다.
 * - 호출 카운터: 위와 같은 이유로 한도 추적이 느슨해진다(인스턴스 A가 20회 써도
 *   인스턴스 B는 0회로 본다). 즉 실제 사용량이 안전 한도(28)를 넘어 원천에서
 *   차단될 수 있다. 정확한 한도 관리가 필요하면 DATA_DIR을 영속 볼륨으로 지정하거나
 *   카운터를 외부 저장소(Supabase/Redis 등)로 옮겨야 한다.
 */

/** 저장 위치 — <데이터루트>/fisis/... (루트 결정은 lib/data-dir.ts) */
const SUBDIR = "fisis";
const CALL_COUNT_FILE = () => dataPath(SUBDIR, "call-counts.json");

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

/** 시리즈 키를 안전한 파일명으로 변환 */
function seriesFile(seriesKey: string): string {
  const safe = seriesKey.replace(/[^a-zA-Z0-9_-]/g, "_");
  return dataPath(SUBDIR, "series", `${safe}.json`);
}

/**
 * 프로세스 메모리 카운터 — 파일 쓰기가 실패하는 환경(읽기전용 FS 등)의 폴백.
 * 파일이 정상일 때도 항상 최신값을 담아 두어 파일값과 max()로 합산한다
 * (파일 쓰기가 도중에 실패해도 이번 프로세스에서는 카운트가 되감기지 않도록).
 * 한계: 프로세스가 죽으면(콜드스타트) 0으로 초기화되고 인스턴스 간 공유되지 않는다.
 */
const memCallCounts = new Map<string, number>();

/** 파일 기반 기본 구현 */
export const fileStore: FisisStore = {
  async loadSeries(seriesKey) {
    // 읽기 실패는 "캐시 없음"(빈 상태에서 시작)으로 간주 → 필요한 월을 재호출
    return readJsonFile<StoredSeries>(seriesFile(seriesKey), { values: {}, fetchedAt: {} });
  },

  async saveSeries(seriesKey, data) {
    // 쓰기 실패해도 조회는 성공시킨다 — 이번 요청은 이미 받은 값으로 응답하고,
    // 다음 요청에서 같은 월을 다시 호출하게 될 뿐이다(한도 소모는 아래 주석 참조).
    await writeJsonFile(seriesFile(seriesKey), data, { pretty: true, warnKey: "fisis:series" });
  },

  async getDailyCallCount(kstDate) {
    const counts = await readJsonFile<Record<string, number>>(CALL_COUNT_FILE(), {});
    const persisted = counts[kstDate] ?? 0;
    // 보수적으로 큰 쪽을 채택 — 한도 초과보다 과소 추정이 위험하다
    return Math.max(persisted, memCallCounts.get(kstDate) ?? 0);
  },

  async incrementDailyCallCount(kstDate) {
    const counts = await readJsonFile<Record<string, number>>(CALL_COUNT_FILE(), {});
    const next = Math.max(counts[kstDate] ?? 0, memCallCounts.get(kstDate) ?? 0) + 1;
    memCallCounts.set(kstDate, next); // 파일 쓰기 성공 여부와 무관하게 먼저 반영
    // 과거 날짜 카운트는 정리 (당일 것만 유지)
    const ok = await writeJsonFile(CALL_COUNT_FILE(), { [kstDate]: next }, { pretty: true, warnKey: "fisis:counter" });
    if (!ok) {
      warnOnce(
        "fisis:counter-volatile",
        `[fisis] 일일 호출 카운터를 영속화하지 못해 프로세스 메모리로 폴백합니다. ` +
          `프로세스 재시작·인스턴스 분산 시 카운터가 초기화되어 FISIS 일 30회 한도를 ` +
          `초과할 수 있습니다. DATA_DIR을 쓰기 가능·영속 경로로 지정하세요.`
      );
    } else if (isEphemeralDataRoot()) {
      warnOnce(
        "fisis:counter-ephemeral",
        `[fisis] 호출 카운터가 휘발성 경로에 저장됩니다(콜드스타트마다 초기화, 인스턴스 간 미공유). ` +
          `일 30회 한도 추적이 느슨해집니다.`
      );
    }
    return next;
  },
};
