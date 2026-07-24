"use client";

import { useCallback, useEffect, useState } from "react";

interface Disclosure {
  corpName: string;
  reportName: string;
  receiptNo: string;
  receiptDate: string;
  url: string;
}

interface CorpCandidate {
  corpCode: string;
  corpName: string;
  stockCode: string | null;
}

interface DisclosureResponse {
  disclosures?: Disclosure[];
  candidates?: CorpCandidate[];
  corp?: CorpCandidate;
  range?: { start: string; end: string; days: number };
  error?: string;
}

const DAY_PRESETS = [
  { value: 7, label: "1주" },
  { value: 30, label: "1개월" },
  { value: 90, label: "3개월" },
  { value: 180, label: "6개월" },
  { value: 365, label: "1년" },
] as const;

/** DART pblntf_ty 공시유형 */
const DISCLOSURE_TYPES = [
  { value: "", label: "전체 유형" },
  { value: "A", label: "A 정기공시" },
  { value: "B", label: "B 주요사항보고" },
  { value: "C", label: "C 발행공시" },
  { value: "D", label: "D 지분공시" },
  { value: "E", label: "E 기타공시" },
  { value: "F", label: "F 외부감사관련" },
  { value: "G", label: "G 펀드공시" },
  { value: "H", label: "H 자산유동화" },
  { value: "I", label: "I 거래소공시" },
  { value: "J", label: "J 공정위공시" },
] as const;

function formatDate(yyyymmdd: string): string {
  if (!/^\d{8}$/.test(yyyymmdd)) return yyyymmdd;
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

export default function DisclosuresPage() {
  const [q, setQ] = useState("");
  const [days, setDays] = useState<number>(30);
  const [type, setType] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [disclosures, setDisclosures] = useState<Disclosure[] | null>(null);
  const [candidates, setCandidates] = useState<CorpCandidate[]>([]);
  const [corp, setCorp] = useState<CorpCandidate | null>(null);
  const [range, setRange] = useState<DisclosureResponse["range"] | null>(null);

  /** 조회 실행 — corpCode가 있으면 회사명 매칭을 건너뛴다 (후보 선택 경로) */
  const run = useCallback(
    async (opts?: { corpCode?: string; corpPick?: CorpCandidate }) => {
      setLoading(true);
      setError(null);
      setCandidates([]);
      try {
        const qs = new URLSearchParams({ days: String(days) });
        if (opts?.corpCode) qs.set("corp_code", opts.corpCode);
        else if (q.trim()) qs.set("q", q.trim());
        if (type) qs.set("type", type);

        const res = await fetch(`/api/disclosures?${qs}`);
        const json: DisclosureResponse = await res.json();
        if (!res.ok) {
          setDisclosures(null);
          setCorp(null);
          setError(json.error ?? `HTTP ${res.status}`);
          return;
        }
        if (json.candidates) {
          setDisclosures(null);
          setCorp(null);
          setCandidates(json.candidates);
          return;
        }
        setDisclosures(json.disclosures ?? []);
        setCorp(opts?.corpPick ?? json.corp ?? null);
        setRange(json.range ?? null);
      } catch (e) {
        setDisclosures(null);
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [q, days, type]
  );

  // 첫 진입 시 전체 최근 공시
  useEffect(() => {
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold" style={{ color: "var(--primary)" }}>
          DART 공시검색
        </h1>
        <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
          금감원 전자공시(DART) — 회사명·기간·유형으로 검색, 원문 링크 제공
        </p>
      </header>

      {/* 검색폼 */}
      <section
        className="rounded-xl border p-5"
        style={{ background: "var(--surface)", borderColor: "var(--border)" }}
      >
        <div className="flex flex-wrap gap-2">
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              // 한글 IME 조합 중 Enter는 조합 확정이므로 제출하지 않는다
              if (e.key === "Enter" && !e.nativeEvent.isComposing) run();
            }}
            disabled={loading}
            placeholder="회사명 (비우면 전체 최근 공시) — 예: 삼성전자"
            aria-label="회사명 검색"
            className="min-w-56 flex-1 rounded-xl border px-4 py-2.5 text-sm outline-none focus:ring-2 disabled:opacity-60"
            style={{
              borderColor: "var(--primary)",
              background: "var(--surface)",
              color: "var(--foreground)",
            }}
          />
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            aria-label="조회 기간"
            className="rounded-xl border px-3 py-2.5 text-sm"
            style={{
              borderColor: "var(--border)",
              background: "var(--surface)",
              color: "var(--foreground)",
            }}
          >
            {DAY_PRESETS.map((d) => (
              <option key={d.value} value={d.value}>
                최근 {d.label}
              </option>
            ))}
          </select>
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            aria-label="공시유형"
            className="rounded-xl border px-3 py-2.5 text-sm"
            style={{
              borderColor: "var(--border)",
              background: "var(--surface)",
              color: "var(--foreground)",
            }}
          >
            {DISCLOSURE_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <button
            onClick={() => run()}
            disabled={loading}
            className="rounded-xl px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-40"
            style={{ background: "var(--primary)" }}
          >
            {loading ? "검색 중…" : "검색"}
          </button>
        </div>
        <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
          회사명이 여러 회사와 일치하면 후보 목록에서 선택해요 — 상장사가 먼저
          나와요.
        </p>
      </section>

      {/* 회사 후보 선택 */}
      {candidates.length > 0 && (
        <section
          className="mt-4 rounded-xl border p-4"
          style={{ background: "var(--surface)", borderColor: "var(--border)" }}
        >
          <h2 className="mb-2 text-sm font-semibold">
            여러 회사가 일치해요 — 조회할 회사를 선택하세요
          </h2>
          <ul
            className="max-h-72 overflow-auto rounded-lg border"
            style={{ borderColor: "var(--border)" }}
          >
            {candidates.map((c) => (
              <li key={c.corpCode} style={{ borderTop: "1px solid var(--border)" }}>
                <button
                  onClick={() => run({ corpCode: c.corpCode, corpPick: c })}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
                >
                  <span className="flex-1">{c.corpName}</span>
                  {c.stockCode ? (
                    <span
                      className="shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold"
                      style={{
                        background: "var(--primary-soft)",
                        color: "var(--primary)",
                      }}
                    >
                      상장 {c.stockCode}
                    </span>
                  ) : (
                    <span className="shrink-0 text-xs" style={{ color: "var(--muted)" }}>
                      비상장
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 오류 */}
      {error && (
        <section
          className="mt-4 rounded-xl border p-4 text-sm"
          style={{ borderColor: "var(--border)", background: "var(--surface)" }}
        >
          <p style={{ color: "var(--muted)" }}>⚠ {error}</p>
        </section>
      )}

      {/* 결과 리스트 */}
      {disclosures && (
        <section
          className="mt-4 rounded-xl border p-4"
          style={{ background: "var(--surface)", borderColor: "var(--border)" }}
        >
          <div className="mb-2 flex flex-wrap items-baseline gap-2 text-sm">
            <h2 className="font-semibold">
              {corp ? `${corp.corpName} 공시` : "전체 최근 공시"}
            </h2>
            <span className="text-xs" style={{ color: "var(--muted)" }}>
              {range
                ? `${formatDate(range.start)} ~ ${formatDate(range.end)} · `
                : ""}
              {disclosures.length}건
              {disclosures.length >= 100 ? " (최근 100건 표시)" : ""}
            </span>
            {corp?.stockCode && (
              <span
                className="rounded px-1.5 py-0.5 text-xs font-semibold"
                style={{ background: "var(--primary-soft)", color: "var(--primary)" }}
              >
                상장 {corp.stockCode}
              </span>
            )}
          </div>
          {disclosures.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--muted)" }}>
              해당 조건의 공시가 없어요.
            </p>
          ) : (
            <ul className="rounded-lg border" style={{ borderColor: "var(--border)" }}>
              {disclosures.map((d) => (
                <li
                  key={d.receiptNo}
                  style={{ borderTop: "1px solid var(--border)" }}
                >
                  <a
                    href={d.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-2 text-sm hover:underline"
                  >
                    <span
                      className="shrink-0 text-xs font-semibold"
                      style={{ color: "var(--primary)" }}
                    >
                      {d.corpName}
                    </span>
                    <span className="flex-1">{d.reportName}</span>
                    <span
                      className="shrink-0 text-xs"
                      style={{
                        color: "var(--muted)",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {formatDate(d.receiptDate)}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
            항목을 클릭하면 dart.fss.or.kr 원문이 새 탭으로 열려요.
          </p>
        </section>
      )}
    </main>
  );
}
