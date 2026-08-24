"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

interface CalendarEvent {
  date: string; // YYYY-MM-DD
  name: string;
  org: string;
  country: "KR" | "US";
  time?: string;
  major: boolean;
}

interface CalendarResponse {
  start: string;
  end: string;
  days: number;
  events: CalendarEvent[];
  errors: string[];
}

const DAY_PRESETS = [7, 14, 30] as const;
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

/** 브라우저 로컬 기준 YYYY-MM-DD */
function localDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatDateHeading(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAYS[d.getDay()]})`;
}

/** 한 날짜의 이벤트 목록 — 주요는 항상 표시, 그 외(일간·상시 갱신 포함)는 접이식으로 전체 열람 */
function EventList({
  events,
  highlighted,
}: {
  events: CalendarEvent[];
  highlighted: boolean;
}) {
  const majors = events.filter((e) => e.major);
  const others = events.filter((e) => !e.major);

  const row = (e: CalendarEvent, i: number) => (
    <li
      key={`${e.country}_${e.name}_${i}`}
      className="flex items-center gap-2 py-1.5 text-sm"
      style={{ borderTop: i > 0 ? "1px solid var(--border)" : undefined }}
    >
      <span
        className="w-8 shrink-0 rounded px-1 py-0.5 text-center text-xs font-bold"
        style={
          e.country === "KR"
            ? { background: "var(--primary)", color: "#ffffff" }
            : {
                background: "var(--surface)",
                color: "var(--primary)",
                border: "1px solid var(--primary)",
              }
        }
      >
        {e.country}
      </span>
      <span className="flex-1" style={{ fontWeight: e.major ? 600 : 400 }}>
        {e.name}
        <span className="ml-1.5 text-xs" style={{ color: "var(--muted)" }}>
          {e.org}
          {e.time ? ` · ${e.time}` : ""}
        </span>
      </span>
      {e.major && (
        <span
          className="shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold"
          style={{
            background: highlighted ? "var(--surface)" : "var(--primary-soft)",
            color: "var(--primary)",
          }}
        >
          주요
        </span>
      )}
    </li>
  );

  return (
    <div className="px-4 pb-3">
      {majors.length > 0 && <ul>{majors.map(row)}</ul>}
      {others.length > 0 && (
        <details>
          <summary
            className="cursor-pointer py-1 text-xs"
            style={{ color: "var(--muted)" }}
          >
            그 외 {others.length}건 (일간·상시 갱신 포함)
          </summary>
          <ul>{others.map(row)}</ul>
        </details>
      )}
      {majors.length === 0 && others.length === 0 && (
        <p className="py-1 text-sm" style={{ color: "var(--muted)" }}>
          일정 없음
        </p>
      )}
    </div>
  );
}

export default function CalendarPage() {
  const [days, setDays] = useState<number>(14);
  const [data, setData] = useState<CalendarResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        setLoading(true);
        setFetchError(null);
      }
    });
    fetch(`/api/calendar?days=${days}`)
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error ?? `HTTP ${r.status}`);
        return json as CalendarResponse;
      })
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch((e) => {
        if (!cancelled) setFetchError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  const today = localDate(new Date());
  const tomorrow = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return localDate(d);
  }, []);

  /** 날짜별 그룹 (API가 이미 날짜순 정렬) */
  const grouped = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const e of data?.events ?? []) {
      if (!map.has(e.date)) map.set(e.date, []);
      map.get(e.date)!.push(e);
    }
    return [...map.entries()];
  }, [data]);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold" style={{ color: "var(--primary)" }}>
          발표 캘린더
        </h1>
        <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
          이번 주·다음 주 한국(시드)·미국(FRED) 경제지표 발표 일정
        </p>
        <Link
          href="/"
          className="mt-1 inline-block text-xs underline"
          style={{ color: "var(--primary)" }}
        >
          ← 통합조회로
        </Link>
      </header>

      {/* 기간 선택 */}
      <div className="mb-4 flex items-center gap-2 text-sm">
        <span style={{ color: "var(--muted)" }}>기간</span>
        {DAY_PRESETS.map((d) => (
          <button
            key={d}
            onClick={() => setDays(d)}
            className="rounded-lg border px-3 py-1.5"
            style={{
              borderColor: days === d ? "var(--primary)" : "var(--border)",
              background: days === d ? "var(--primary-soft)" : "transparent",
              color: days === d ? "var(--primary)" : "inherit",
            }}
          >
            {d}일
          </button>
        ))}
        {data && (
          <span className="ml-auto text-xs" style={{ color: "var(--muted)" }}>
            {data.start} ~ {data.end}
          </span>
        )}
      </div>

      {/* 부분 실패 (미국 소스 등) */}
      {(data?.errors.length ?? 0) > 0 && (
        <div
          className="mb-4 rounded-xl border p-3 text-sm"
          style={{ borderColor: "var(--border)", background: "var(--surface)" }}
        >
          {data!.errors.map((e, i) => (
            <p key={i} style={{ color: "var(--muted)" }}>
              ⚠ {e}
            </p>
          ))}
        </div>
      )}

      {fetchError && (
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          ⚠ 일정을 불러오지 못했어요: {fetchError}
        </p>
      )}

      {loading && (
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          일정을 불러오는 중…
        </p>
      )}

      {!loading && !fetchError && grouped.length === 0 && (
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          기간 내 발표 일정이 없어요.
        </p>
      )}

      {/* 날짜별 그룹 리스트 */}
      <div className="flex flex-col gap-3">
        {grouped.map(([date, events]) => {
          const isToday = date === today;
          const isTomorrow = date === tomorrow;
          const highlighted = isToday || isTomorrow;
          return (
            <section
              key={date}
              className="rounded-xl border"
              style={{
                background: highlighted ? "var(--primary-soft)" : "var(--surface)",
                borderColor: highlighted ? "var(--primary)" : "var(--border)",
              }}
            >
              <h2
                className="flex items-center gap-2 px-4 pb-1 pt-3 text-sm font-bold"
                style={{ color: highlighted ? "var(--primary)" : "var(--foreground)" }}
              >
                {formatDateHeading(date)}
                {isToday && (
                  <span
                    className="rounded px-1.5 py-0.5 text-xs font-semibold text-white"
                    style={{ background: "var(--primary)" }}
                  >
                    오늘
                  </span>
                )}
                {isTomorrow && (
                  <span
                    className="rounded border px-1.5 py-0.5 text-xs font-semibold"
                    style={{ borderColor: "var(--primary)", color: "var(--primary)" }}
                  >
                    내일
                  </span>
                )}
              </h2>
              <EventList events={events} highlighted={highlighted} />
            </section>
          );
        })}
      </div>

      <p className="mt-4 text-xs" style={{ color: "var(--muted)" }}>
        미국: FRED releases/dates 자동 · 한국: 기관 연간 공표일정 시드(금통위·소비자물가동향·GDP, 연 1회 갱신)
      </p>
    </main>
  );
}
