import { Suspense } from "react";
import Link from "next/link";
import { ModelLink, modelKindMeta, models, modelsByKind } from "@/lib/models";
import { fetchModelStatus, formatAsOf } from "@/lib/model-status";

export const metadata = {
  title: "내 모델 바로가기",
  description: "직접 만든 경제지표 모델·앱 바로가기",
};

/** 상태 줄 공통 껍데기 — 로딩·성공·실패가 같은 자리에 같은 크기로 들어간다 */
function StatusLine({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
      style={{ color: "var(--muted)" }}
    >
      {children}
    </span>
  );
}

/**
 * health를 선언한 모델의 실시간 상태.
 * 외부 앱 응답을 기다리므로 Suspense 안에서만 쓴다 — 목록 렌더를 막지 않는다.
 */
async function ModelStatus({ model }: { model: ModelLink }) {
  const status = await fetchModelStatus(model);
  if (!status) return null;

  if (!status.ok) {
    return (
      <StatusLine>
        <span
          className="rounded px-1.5 py-0.5 font-semibold"
          style={{ background: "var(--primary-soft)", color: "var(--series-3)" }}
        >
          상태 불러오지 못함
        </span>
        <span>{status.reason}</span>
      </StatusLine>
    );
  }

  const confirmLabel =
    status.confirmed === null
      ? null
      : status.confirmed
        ? (model.health?.confirmedLabel ?? "확정")
        : (model.health?.draftLabel ?? "미확정 초안");

  return (
    <StatusLine>
      {confirmLabel && (
        <span
          className="rounded px-1.5 py-0.5 font-semibold"
          style={{
            background: "var(--primary-soft)",
            color: status.confirmed ? "var(--primary)" : "var(--series-3)",
          }}
        >
          {confirmLabel}
        </span>
      )}
      {status.metrics.map((m) => (
        <span key={m.label}>
          {m.label} {m.value}
        </span>
      ))}
      <span>기준 {formatAsOf(status.generatedAt)}</span>
    </StatusLine>
  );
}

export default function ModelsPage() {
  const groups = modelsByKind();

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold" style={{ color: "var(--primary)" }}>
          내 모델 바로가기
        </h1>
        <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
          직접 만든 경제지표 모델·앱 {models.length}개 — 클릭하면 새 탭에서 열려요
        </p>
        <Link
          href="/"
          className="mt-1 inline-block text-xs underline"
          style={{ color: "var(--primary)" }}
        >
          ← 통합조회로
        </Link>
      </header>

      {groups.map(({ kind, items }) => {
        const meta = modelKindMeta[kind];
        return (
          <section key={kind} className="mb-6">
            <h2 className="flex flex-wrap items-center gap-2 text-sm font-bold">
              <span
                className="rounded px-1.5 py-0.5 text-xs font-semibold"
                style={{ background: "var(--primary-soft)", color: "var(--primary)" }}
              >
                {meta.badge}
              </span>
              <span>{meta.label}</span>
              <span className="text-xs font-normal" style={{ color: "var(--muted)" }}>
                {items.length}개 · {meta.hint}
              </span>
            </h2>

            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {items.map((m) => (
                <a
                  key={m.id}
                  href={m.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex flex-col rounded-xl border p-4 transition-colors hover:border-[var(--primary)]"
                  style={{
                    background: "var(--surface)",
                    borderColor: "var(--border)",
                  }}
                >
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="font-semibold" style={{ color: "var(--primary)" }}>
                      {m.name}
                    </span>
                    {m.note && (
                      <span
                        className="rounded px-1.5 py-0.5 text-xs font-semibold"
                        style={{
                          background: "var(--primary-soft)",
                          color: "var(--primary)",
                        }}
                      >
                        {m.note}
                      </span>
                    )}
                  </span>
                  <span className="mt-1 text-sm">{m.description}</span>
                  {m.health && (
                    <Suspense
                      fallback={<StatusLine>상태 확인 중…</StatusLine>}
                    >
                      <ModelStatus model={m} />
                    </Suspense>
                  )}
                  <span
                    className="mt-2 truncate text-xs"
                    style={{ color: "var(--muted)" }}
                  >
                    {m.url.replace(/^https:\/\//, "")} ↗
                  </span>
                </a>
              ))}
            </div>
          </section>
        );
      })}
    </main>
  );
}
