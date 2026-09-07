import { connection } from "next/server";
import { DEFAULT_REDIRECT_PATH, FROM_PARAM, gateMode, safeInternalPath } from "@/lib/auth";
import { ROSTER_ENV_NAME, publicRoster } from "@/lib/roster";
import LoginForm from "./login-form";

export const metadata = { title: "로그인 — Report Studio" };

/**
 * 로그인 화면 — 이름을 고르고 전화번호 뒤 4자리를 입력한다(DAAI와 동일한 방식).
 *
 * 명단은 서버에서 조회해 넘긴다. **전화번호도, 뒤 4자리도, 해시도 넘어가지 않는다** —
 * 이름과 불투명 id만 내려간다(lib/roster.ts publicRoster).
 *
 * 명단이 없는 프로덕션(gateMode = "unconfigured")에서는 폼 대신 설정 안내를 띄운다.
 * 이 상태에서는 어떤 요청도 통과하지 않는다.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  // 환경변수 기반 분기를 빌드타임에 고정하지 않도록 요청 시점 렌더로 전환
  await connection();

  const params = await searchParams;
  const rawFrom = params[FROM_PARAM];
  const from = safeInternalPath(typeof rawFrom === "string" ? rawFrom : DEFAULT_REDIRECT_PATH);
  const mode = gateMode();
  const roster = mode === "enforced" ? publicRoster() : [];

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-6 py-16">
      <section
        className="rounded-xl border p-6"
        style={{ background: "var(--surface)", borderColor: "var(--border)" }}
      >
        <h1 className="text-xl font-bold" style={{ color: "var(--primary)" }}>
          Report Studio
        </h1>

        {mode === "unconfigured" ? (
          <>
            <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
              앱이 잠겨 있습니다 — 사용자 명단(<code>{ROSTER_ENV_NAME}</code>)이 설정되지 않았습니다.
            </p>
            <div
              className="mt-4 rounded-lg border p-4 text-sm leading-relaxed"
              style={{ background: "var(--primary-soft)", borderColor: "var(--border)" }}
            >
              <p className="font-semibold">설정 방법</p>
              <ol className="mt-2 list-decimal space-y-1 pl-5" style={{ color: "var(--muted)" }}>
                <li>
                  로컬에서 <code>node scripts/roster.mjs add &quot;이름&quot; &quot;전화번호&quot; admin</code>{" "}
                  을 실행해 첫 관리자 항목을 만듭니다.
                </li>
                <li>
                  출력된 값을 Vercel 프로젝트 → Settings → Environment Variables의{" "}
                  <code>{ROSTER_ENV_NAME}</code>에 넣습니다.
                </li>
                <li>재배포하면 로그인 화면이 열리고, 이후 명단 추가는 앱 안의 명단 관리 화면에서 합니다.</li>
              </ol>
            </div>
          </>
        ) : (
          <>
            <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
              본부 공용 도구입니다. 이름을 고르고 전화번호 뒤 4자리를 입력하세요.
            </p>
            <LoginForm from={from} roster={roster} />
          </>
        )}
      </section>
    </main>
  );
}
