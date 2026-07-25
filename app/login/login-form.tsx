"use client";

import { useState } from "react";
import { LOGIN_API_PATH } from "@/lib/auth-config";

/** 비밀번호 입력 폼 — 성공 시 `from` 경로로 이동한다. */
export default function LoginForm({ from }: { from: string }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting || password.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(LOGIN_API_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        setPassword("");
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

  return (
    <form onSubmit={submit} className="mt-5 flex flex-col gap-3">
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoFocus
        autoComplete="current-password"
        aria-label="비밀번호"
        placeholder="비밀번호"
        className="rounded-xl border px-4 py-3 text-base outline-none focus:ring-2"
        style={{
          borderColor: "var(--primary)",
          background: "var(--surface)",
          color: "var(--foreground)",
        }}
      />
      <button
        type="submit"
        disabled={submitting || password.length === 0}
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
