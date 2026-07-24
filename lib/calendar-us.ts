/**
 * 미국 발표 캘린더 시드파일 — FRED releases/dates가 일간 갱신 노이즈에 묻어
 * 실제 FOMC 결정일을 구분해주지 못하므로(2026-07 확인), 연준 공식 회의일정을
 * 수동 적재한다.
 *
 * ⚠ 연 1회 갱신 필요 — 마지막 갱신: 2026-07-24 (2026년 남은 일정만, 공식 출처 확인분).
 *   출처: https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
 *   정책 성명은 회의 둘째 날 14:00 ET 발표.
 */
export interface UsCalendarSeedEvent {
  date: string; // YYYY-MM-DD — 결정 발표일(회의 둘째 날)
  name: string;
  org: string;
  time?: string;
}

export const usCalendarSeed: UsCalendarSeedEvent[] = [
  // 2026년 잔여 FOMC (7/28–29, 9/15–16, 10/27–28, 12/8–9 — 2026-07-24 확인)
  { date: "2026-07-29", name: "FOMC 정책금리 결정 (7/28–29 회의)", org: "미 연준", time: "14:00 ET" },
  { date: "2026-09-16", name: "FOMC 정책금리 결정 (9/15–16 회의)", org: "미 연준", time: "14:00 ET" },
  { date: "2026-10-28", name: "FOMC 정책금리 결정 (10/27–28 회의)", org: "미 연준", time: "14:00 ET" },
  { date: "2026-12-09", name: "FOMC 정책금리 결정 (12/8–9 회의)", org: "미 연준", time: "14:00 ET" },
];
