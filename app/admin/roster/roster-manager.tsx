"use client";

import { useState } from "react";
import { ADMIN_ROSTER_API_PATH } from "@/lib/auth-config";

type Entry = { id: string; name: string; role: "ADMIN" | "STAFF"; hasPhone: boolean };

const ROLE_LABEL: Record<Entry["role"], string> = { ADMIN: "관리자", STAFF: "팀원" };

/**
 * 명단 편집 UI.
 * 전화번호는 서버로 보내기만 하고(해시 변환용) 화면 상태에는 남기지 않는다 —
 * 제출 직후 입력칸을 비운다.
 */
export default function RosterManager({
  initialEntries,
  envName,
}: {
  initialEntries: Entry[];
  envName: string;
}) {
  const [entries, setEntries] = useState<Entry[]>(initialEntries);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState<Entry["role"]>("STAFF");
  const [rosterValue, setRosterValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  // 번호를 채워 넣는 중인 사람(id) — 한 번에 한 명만 연다
  const [phoneTarget, setPhoneTarget] = useState<string | null>(null);
  const [phoneFill, setPhoneFill] = useState("");
  // 한 번이라도 편집했으면 이후 요청은 화면의 명단을 기준으로 삼는다(환경변수로 되돌아가지 않게).
  const [edited, setEdited] = useState(false);

  /**
   * 서버에는 저장소가 없어 요청 사이에 아무것도 기억하지 못한다.
   * 그래서 편집 중인 명단(rosterValue)을 매번 base로 되돌려 보낸다 —
   * 이게 없으면 두 명을 연달아 추가할 때 앞사람이 조용히 사라진다.
   */
  async function send(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const res = await fetch(ADMIN_ROSTER_API_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, base: rosterValue, hasBase: edited }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      setEntries(json.entries ?? []);
      setRosterValue(json.roster ?? "");
      setEdited(true);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    // 전화번호는 선택 — 비우면 이름만 등록된다(그 사람은 번호를 넣기 전까지 로그인 불가).
    if (busy || !name.trim()) return;
    await send({ action: "add", name, phone, role });
    // 전화번호는 화면에 남기지 않는다
    setPhone("");
    setName("");
    setRole("STAFF");
  }

  async function fillPhone(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !phoneTarget || !phoneFill.trim()) return;
    await send({ action: "setPhone", id: phoneTarget, phone: phoneFill });
    setPhoneFill("");
    setPhoneTarget(null);
  }

  const fieldStyle = {
    borderColor: "var(--border)",
    background: "var(--surface)",
    color: "var(--foreground)",
  } as const;

  return (
    <div className="mt-6 flex flex-col gap-6">
      <form
        onSubmit={add}
        className="flex flex-wrap items-end gap-3 rounded-xl border p-4"
        style={{ borderColor: "var(--border)", background: "var(--surface)" }}
      >
        <label className="flex flex-col gap-1 text-xs" style={{ color: "var(--muted)" }}>
          이름
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="예: 홍길동"
            required
            className="rounded-lg border px-3 py-2 text-sm outline-none"
            style={fieldStyle}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs" style={{ color: "var(--muted)" }}>
          전화번호 (선택 — 나중에 채워도 됩니다)
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="비워두면 이름만 등록"
            autoComplete="off"
            className="rounded-lg border px-3 py-2 text-sm outline-none"
            style={fieldStyle}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs" style={{ color: "var(--muted)" }}>
          역할
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Entry["role"])}
            className="rounded-lg border px-3 py-2 text-sm outline-none"
            style={fieldStyle}
          >
            <option value="STAFF">팀원 (명단 관리 불가)</option>
            <option value="ADMIN">관리자 (명단 관리 가능)</option>
          </select>
        </label>
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
          style={{ background: "var(--primary)" }}
        >
          {busy ? "처리 중…" : "명단에 추가"}
        </button>
      </form>

      {error && (
        <p className="text-sm" role="alert" style={{ color: "var(--muted)" }}>
          ⚠ {error}
        </p>
      )}

      <div className="overflow-x-auto rounded-xl border" style={{ borderColor: "var(--border)" }}>
        <table className="w-full min-w-[420px] border-collapse text-sm">
          <thead>
            <tr className="text-left" style={{ color: "var(--muted)" }}>
              <th className="px-4 py-2.5 font-normal">이름</th>
              <th className="px-4 py-2.5 font-normal">역할</th>
              <th className="px-4 py-2.5 font-normal">전화번호</th>
              <th className="px-4 py-2.5 font-normal">관리</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center" style={{ color: "var(--muted)" }}>
                  등록된 사용자가 없습니다.
                </td>
              </tr>
            )}
            {entries.map((e) => (
              <tr key={e.id} className="border-t" style={{ borderColor: "var(--border)" }}>
                <td className="px-4 py-3 font-medium">{e.name}</td>
                <td className="px-4 py-3" style={{ color: "var(--muted)" }}>
                  {ROLE_LABEL[e.role]}
                </td>
                <td className="px-4 py-3" style={{ color: "var(--muted)" }}>
                  {e.hasPhone ? (
                    "등록됨"
                  ) : (
                    <span style={{ color: "var(--primary)" }}>미등록 — 로그인 불가</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setPhoneFill("");
                        setPhoneTarget(phoneTarget === e.id ? null : e.id);
                      }}
                      className="rounded-lg border px-3 py-1.5 text-xs disabled:opacity-40"
                      style={{ borderColor: "var(--border)", color: "var(--muted)" }}
                    >
                      {e.hasPhone ? "번호 교체" : "번호 등록"}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => send({ action: "remove", id: e.id })}
                      className="rounded-lg border px-3 py-1.5 text-xs disabled:opacity-40"
                      style={{ borderColor: "var(--border)", color: "var(--muted)" }}
                    >
                      빼기
                    </button>
                  </div>
                  {phoneTarget === e.id && (
                    <form onSubmit={fillPhone} className="mt-2 flex flex-wrap items-center gap-2">
                      <input
                        value={phoneFill}
                        onChange={(ev) => setPhoneFill(ev.target.value)}
                        placeholder="010-1234-5678"
                        autoComplete="off"
                        autoFocus
                        className="rounded-lg border px-3 py-1.5 text-xs outline-none"
                        style={fieldStyle}
                      />
                      <button
                        type="submit"
                        disabled={busy || !phoneFill.trim()}
                        className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
                        style={{ background: "var(--primary)" }}
                      >
                        저장
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rosterValue && (
        <div
          className="flex flex-col gap-2 rounded-xl border p-4"
          style={{ borderColor: "var(--primary)", background: "var(--surface)" }}
        >
          <p className="text-sm font-semibold">
            새 <code>{envName}</code> 값 — Vercel 환경변수에 덮어쓰고 재배포하세요
          </p>
          <textarea
            readOnly
            value={rosterValue}
            rows={4}
            onFocus={(e) => e.currentTarget.select()}
            className="w-full rounded-lg border px-3 py-2 font-mono text-xs"
            style={fieldStyle}
          />
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(rosterValue);
                  setCopied(true);
                } catch {
                  setError("클립보드 복사에 실패했습니다 — 위 상자에서 직접 복사하세요.");
                }
              }}
              className="rounded-lg px-4 py-2 text-sm font-semibold text-white"
              style={{ background: "var(--primary)" }}
            >
              복사
            </button>
            {copied && (
              <span className="text-xs" style={{ color: "var(--muted)" }}>
                복사했습니다.
              </span>
            )}
          </div>
          <p className="text-xs" style={{ color: "var(--muted)" }}>
            이 값에는 전화번호가 들어 있지 않습니다(뒤 4자리의 salt+scrypt 해시). 그래도 자격증명이므로
            저장소에 커밋하거나 메신저로 돌리지 마세요.
          </p>
        </div>
      )}
    </div>
  );
}
