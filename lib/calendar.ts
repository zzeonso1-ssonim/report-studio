import { requireKey, SourceError } from "./sources/types";

/**
 * 발표 캘린더 — 미국(FRED releases/dates 자동) 공통 타입.
 * 한국 시드는 lib/calendar-kr.ts, 한·미 병합은 /api/calendar 가 담당.
 */
export interface CalendarEvent {
  date: string; // YYYY-MM-DD
  name: string;
  org: string;
  country: "KR" | "US";
  time?: string; // HH:MM (현지 관례, 확인된 경우만)
  major: boolean; // 주요 릴리스 여부 — 정렬·강조에 사용
}

/**
 * 미국 주요 릴리스 판별 패턴 — 단일 소스 (UI·API 는 major 필드만 소비).
 * FRED release_name 기준.
 */
const US_MAJOR_PATTERNS: RegExp[] = [
  /consumer price index/i, // CPI (BLS)
  /employment situation/i, // 고용보고서 (BLS)
  /gross domestic product/i, // GDP (BEA)
  /FOMC/i, // FOMC 관련 (연준)
  /personal income and outlays/i, // PCE 물가 포함 (BEA)
  /producer price index/i, // PPI (BLS)
];

export function isUsMajorRelease(name: string): boolean {
  return US_MAJOR_PATTERNS.some((p) => p.test(name));
}

/** 로컬(서버) 기준 YYYY-MM-DD — toISOString 은 UTC 라 KST 아침에 하루 밀리므로 사용하지 않는다 */
export function localDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

interface FredReleaseDate {
  release_id: number;
  release_name: string;
  date: string;
}

/**
 * FRED releases/dates — 오늘부터 days일 내 발표 예정 릴리스 목록.
 * include_release_dates_with_no_data=true 로 미래 일정 포함 (PRD v2 발표 캘린더).
 * https://fred.stlouisfed.org/docs/api/fred/releases_dates.html
 */
export async function fetchUsReleaseDates(days = 14): Promise<CalendarEvent[]> {
  const key = requireKey("fred", "FRED_API_KEY");
  const start = new Date();
  const end = new Date();
  end.setDate(end.getDate() + days);

  const qs = new URLSearchParams({
    api_key: key,
    file_type: "json",
    realtime_start: localDate(start),
    realtime_end: localDate(end),
    include_release_dates_with_no_data: "true",
    order_by: "release_date",
    sort_order: "asc",
    limit: "1000",
  });
  const res = await fetch(`https://api.stlouisfed.org/fred/releases/dates?${qs}`, {
    next: { revalidate: 21600 }, // 6시간 — 일정 데이터는 자주 안 바뀜
  });
  if (!res.ok) throw new SourceError("fred", `releases/dates HTTP ${res.status}`);
  const json = await res.json();
  const rows: FredReleaseDate[] = json.release_dates ?? [];

  // 일간·상시 갱신 릴리스 판별 — 기간 내 거의 매일 등장하는 릴리스(예: 시장금리,
  // "FOMC Press Release"의 일간 갱신)는 이산적 '발표'가 아니므로 major에서 제외한다.
  // 임계값: 기간의 절반 이상(최소 4일) 등장하면 상시 갱신으로 본다.
  const countById = new Map<number, number>();
  for (const r of rows) {
    countById.set(r.release_id, (countById.get(r.release_id) ?? 0) + 1);
  }
  const frequentThreshold = Math.max(4, Math.floor(days / 2));

  return rows.map((r): CalendarEvent => {
    const frequent = (countById.get(r.release_id) ?? 0) >= frequentThreshold;
    return {
      date: r.date,
      name: r.release_name,
      org: "FRED",
      country: "US",
      major: !frequent && isUsMajorRelease(r.release_name),
    };
  });
}
