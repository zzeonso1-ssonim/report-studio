import { connection } from "next/server";
import Link from "next/link";
import { currentUser } from "@/lib/auth";
import { ROSTER_ENV_NAME, hasCredential, loadRoster } from "@/lib/roster";
import RosterManager from "./roster-manager";

export const metadata = { title: "명단 관리 — Report Studio" };

/**
 * 명단 관리 화면 — ADMIN 전용(proxy가 /admin 접두사를 막고, 여기서도 한 번 더 본다).
 *
 * 이 앱에는 DB가 없어서 화면이 명단을 저장하지 못한다. 대신 **붙여넣을 APP_ROSTER 값**을 만들어 준다.
 * 전화번호는 입력 → 해시 변환 후 버려지고, 화면·응답·저장소 어디에도 남지 않는다.
 */
export default async function AdminRosterPage() {
  await connection();

  const me = await currentUser();
  // 로컬 개발(게이트 open)에서는 로그인 없이 들어올 수 있다 — 최초 명단을 만들 때 쓰는 경로다.
  if (me && me.role !== "ADMIN") {
    return (
      <main className="mx-auto w-full max-w-3xl px-6 py-16">
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          관리자 전용 화면입니다.{" "}
          <Link href="/" className="underline">
            홈으로
          </Link>
        </p>
      </main>
    );
  }

  const entries = loadRoster().map((e) => ({
    id: e.id,
    name: e.name,
    role: e.role,
    hasPhone: hasCredential(e),
  }));

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <h1 className="text-xl font-bold" style={{ color: "var(--primary)" }}>
        명단 관리
      </h1>
      <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
        로그인은 <strong>이름 선택 + 전화번호 뒤 4자리</strong>입니다. 비밀번호는 없습니다.
      </p>

      <div
        className="mt-5 rounded-xl border p-4 text-sm leading-relaxed"
        style={{ background: "var(--primary-soft)", borderColor: "var(--border)" }}
      >
        <p className="font-semibold">반영 절차 — 이 화면은 저장하지 않습니다</p>
        <ol className="mt-2 list-decimal space-y-1 pl-5" style={{ color: "var(--muted)" }}>
          <li>
            아래에서 이름을 넣으면 새 명단 값이 만들어집니다. <strong>전화번호는 비워도 됩니다</strong> —
            이름만 먼저 넣고 나중에 채울 수 있습니다(번호가 없으면 그 사람은 로그인할 수 없습니다).
          </li>
          <li>
            그 값을 Vercel → Settings → Environment Variables의 <code>{ROSTER_ENV_NAME}</code>에
            덮어씁니다.
          </li>
          <li>재배포해야 반영됩니다. (이 앱에는 DB가 없어 값을 서버에 저장할 곳이 없습니다.)</li>
        </ol>
        <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
          전화번호는 뒤 4자리 해시로만 보관되며 원문은 저장되지 않습니다. 등록된 번호는 다시 볼 수 없고,
          바뀌면 지웠다가 새로 등록하세요.
        </p>
      </div>

      <RosterManager initialEntries={entries} envName={ROSTER_ENV_NAME} />
    </main>
  );
}
