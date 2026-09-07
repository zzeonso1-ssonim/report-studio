"use client";

import { useState } from "react";
// 클라이언트 번들이라 lib/roster.ts(node:crypto 의존)를 직접 참조하지 않는다.
import { CREDENTIAL_DIGITS, LOGIN_API_PATH, type RosterPublicEntry } from "@/lib/auth-config";

/**
 * 이름 + 전화번호 뒤 4자리 로그인 폼 (DAAI/mp-scoring-app과 같은 UX).
 * 입력은 4자리 하나뿐이고, 이름은 서버가 내려준 명단에서 고른다.
 * 명단에는 전화번호가 들어 있지 않다 — 이름과 불투명 id만 있다.
 */
export default function LoginForm({ from, roster }: { from: string; roster: RosterPublicEntry[] }) {
  const [userId, setUserId] = useState("");
  const [last4, setLast4] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const ready = userId !== "" && last4.length === CREDENTIAL_DIGITS;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting || !ready) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(LOGIN_API_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, last4 }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        setLast4("");
        return;
      }
      // 쿠키가 붙은 상태로 원래 가려던 경로를 새로 요청한다
      window.location.assign(from);
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const fieldStyle = {
    borderColor: "var(--primary)",
    background: "var(--surface)",
    color: "var(--foreground)",
  } as const;

  if (roster.length === 0) {
    return (
      <p className="mt-5 text-sm" role="alert" style={{ color: "var(--muted)" }}>
        등록된 사용자가 없습니다. 관리자에게 명단 등록을 요청하세요.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="mt-5 flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm" style={{ color: "var(--muted)" }}>
        이름
        <select
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          autoFocus
          required
          aria-label="이름"
          className="rounded-xl border px-4 py-3 text-base outline-none focus:ring-2"
          style={fieldStyle}
        >
          <option value="">선택하세요</option>
          {roster.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm" style={{ color: "var(--muted)" }}>
        전화번호 뒤 {CREDENTIAL_DIGITS}자리
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={CREDENTIAL_DIGITS}
          value={last4}
          onChange={(e) => setLast4(e.target.value.replace(/\D/g, "").slice(0, CREDENTIAL_DIGITS))}
          aria-label={`전화번호 뒤 ${CREDENTIAL_DIGITS}자리`}
          placeholder="••••"
          className="rounded-xl border px-4 py-3 text-base outline-none focus:ring-2"
          style={fieldStyle}
        />
      </label>

      <button
        type="submit"
        disabled={submitting || !ready}
        className="rounded-xl px-5 py-3 text-base font-semibold text-white disabled:opacity-40"
        style={{ background: "var(--primary)" }}
      >
        {submitting ? "확인 중…" : "로그인"}
      </button>

      {error && (
        <p className="text-sm" role="alert" style={{ color: "var(--muted)" }}>
          ⚠ {error}
        </p>
      )}
    </form>
  );
}
