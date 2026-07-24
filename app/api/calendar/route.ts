import { CalendarEvent, fetchUsReleaseDates, localDate } from "@/lib/calendar";
import { krCalendarSeed } from "@/lib/calendar-kr";
import { usCalendarSeed } from "@/lib/calendar-us";

const MIN_DAYS = 1;
const MAX_DAYS = 90;
const DEFAULT_DAYS = 14;

/**
 * GET /api/calendar?days=14
 * 오늘부터 days일 내 한(시드)·미(FRED releases/dates) 발표 일정 병합, 날짜순.
 * 미국 소스 실패 시에도 한국 시드는 반환하고 errors[]에 표기한다.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const raw = Number(url.searchParams.get("days") ?? DEFAULT_DAYS);
  const days = Number.isFinite(raw)
    ? Math.min(Math.max(Math.trunc(raw), MIN_DAYS), MAX_DAYS)
    : DEFAULT_DAYS;

  const startD = new Date();
  const endD = new Date();
  endD.setDate(endD.getDate() + days);
  const start = localDate(startD);
  const end = localDate(endD);

  const errors: string[] = [];

  let us: CalendarEvent[] = [];
  try {
    us = await fetchUsReleaseDates(days);
  } catch (e) {
    errors.push(`미국(FRED) 일정 조회 실패: ${String(e)}`);
  }

  // 한국 시드 — 기간 내 항목만. 시드는 전부 주요 지표(금통위·CPI·GDP)라 major 고정.
  const kr: CalendarEvent[] = krCalendarSeed
    .filter((e) => e.date >= start && e.date <= end)
    .map((e) => ({ ...e, country: "KR" as const, major: true }));

  // 미국 시드(FOMC 결정일) — FRED 일간 노이즈에 묻히는 항목을 major로 보강.
  const usSeed: CalendarEvent[] = usCalendarSeed
    .filter((e) => e.date >= start && e.date <= end)
    .map((e) => ({ ...e, country: "US" as const, major: true }));

  const events = [...kr, ...usSeed, ...us].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      Number(b.major) - Number(a.major) ||
      a.country.localeCompare(b.country) || // 동순위면 KR 먼저
      a.name.localeCompare(b.name)
  );

  return Response.json({ start, end, days, events, errors });
}
