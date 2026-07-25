import Link from "next/link";
import { modelKindMeta, models, modelsByKind } from "@/lib/models";

export const metadata = {
  title: "내 모델 바로가기",
  description: "직접 만든 경제지표 모델·앱 바로가기",
};

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
