import Link from "next/link";
import {
  LIQUIDITY_CONFIG_AS_OF,
  LIQUIDITY_SOURCE_LABEL,
  LIQUIDITY_YEAR_PRESETS,
  liquidityGroups,
} from "@/lib/liquidity";
import LiquidityView from "./liquidity-view";

export const metadata = {
  title: "미 유동성 프리셋",
  description: "지준·ON RRP·TGA 수준과 주간 증감, SOFR−IORB 스프레드",
};

/**
 * /liquidity — 유동성 워치 프리셋 화면.
 * 구성(계열·기본 기간·주장·주의)은 전부 scripts/liquidity/config.json에서
 * 파생한다. 서버 컴포넌트가 config를 읽고, 값 조회·계산은 클라이언트가
 * 기존 /api/series/[id] 경로로 한다.
 */
export default function LiquidityPage() {
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold" style={{ color: "var(--primary)" }}>
          미 유동성 프리셋
        </h1>
        <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
          지준·ON RRP·TGA 수준과 주간 증감, SOFR−IORB 스프레드 — 출처{" "}
          {LIQUIDITY_SOURCE_LABEL} · 계열 정의 기준일 {LIQUIDITY_CONFIG_AS_OF}
        </p>
        <Link
          href="/"
          className="mt-1 inline-block text-xs underline"
          style={{ color: "var(--primary)" }}
        >
          ← 통합조회로
        </Link>
      </header>

      <LiquidityView
        groups={liquidityGroups()}
        yearPresets={[...LIQUIDITY_YEAR_PRESETS]}
        sourceLabel={LIQUIDITY_SOURCE_LABEL}
      />
    </main>
  );
}
