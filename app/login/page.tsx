import { connection } from "next/server";
import { DEFAULT_REDIRECT_PATH, FROM_PARAM, gateMode, safeInternalPath } from "@/lib/auth";
import LoginForm from "./login-form";

export const metadata = { title: "로그인 — 경제데이터 통합조회" };

/**
 * 로그인 화면.
 * APP_PASSWORD가 없는 프로덕션(gateMode = "unconfigured")에서는 폼 대신
 * 설정 안내를 띄운다 — 이 상태에서는 어떤 요청도 통과하지 않는다.
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

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-6 py-16">
      <section
        className="rounded-xl border p-6"
        style={{ background: "var(--surface)", borderColor: "var(--border)" }}
      >
        <h1 className="text-xl font-bold" style={{ color: "var(--primary)" }}>
          경제데이터 통합조회
        </h1>

        {mode === "unconfigured" ? (
          <>
            <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
              앱이 잠겨 있습니다 — 환경변수 <code>APP_PASSWORD</code>가 설정되지 않았습니다.
            </p>
            <div
              className="mt-4 rounded-lg border p-4 text-sm leading-relaxed"
              style={{ background: "var(--primary-soft)", borderColor: "var(--border)" }}
            >
              <p className="font-semibold">설정 방법</p>
              <ol className="mt-2 list-decimal space-y-1 pl-5" style={{ color: "var(--muted)" }}>
                <li>
                  Vercel 프로젝트 → Settings → Environment Variables에{" "}
                  <code>APP_PASSWORD</code> 추가 (선택: <code>APP_SECRET</code>)
                </li>
                <li>재배포하면 로그인 화면이 열립니다.</li>
              </ol>
            </div>
          </>
        ) : (
          <>
            <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
              개인용 앱입니다. 비밀번호를 입력하세요.
            </p>
            <LoginForm from={from} />
          </>
        )}
      </section>
    </main>
  );
}
