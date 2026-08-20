"use client";

import { useMemo, useState } from "react";
import type { SectorId, SectorSnapshot, SectorStatus } from "@/lib/outlook/types";
import GrowthDashboard from "./growth-dashboard";
import TradeDashboard from "./trade-dashboard";
import FiscalDashboard from "./fiscal-dashboard";
import InflationDashboard from "./inflation-dashboard";
import LaborDashboard from "./labor-dashboard";
import ConstructionDashboard from "./construction-dashboard";
import EquipmentDashboard from "./equipment-dashboard";
import DomesticLiquidityDashboard from "./domestic-liquidity-dashboard";

const STATUS_LABELS: Record<SectorStatus, string> = {
  pending_config: "지표 구성 대기",
  ready: "연결 확인 가능",
  refreshing: "업데이트 중",
  success: "연결 정상",
  partial: "일부 연결",
  error: "업데이트 실패",
};

function displayTime(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function replaceSector(
  sectors: SectorSnapshot[],
  replacement: SectorSnapshot
): SectorSnapshot[] {
  return sectors.map((sector) =>
    sector.id === replacement.id ? replacement : sector
  );
}

export default function OutlookWorkbench({
  initialSectors,
}: {
  initialSectors: SectorSnapshot[];
}) {
  const [sectors, setSectors] = useState(initialSectors);
  const [selectedId, setSelectedId] = useState<SectorId>(
    initialSectors[0]?.id ?? "growth"
  );
  const [requestError, setRequestError] = useState<string | null>(null);

  const selected = useMemo(
    () => sectors.find((sector) => sector.id === selectedId) ?? sectors[0],
    [sectors, selectedId]
  );

  async function refresh(sector: SectorSnapshot) {
    if (!sector.hasProbe || sector.status === "refreshing") return;
    setRequestError(null);
    setSectors((current) =>
      current.map((item) =>
        item.id === sector.id
          ? { ...item, status: "refreshing", error: null }
          : item
      )
    );

    try {
      const response = await fetch(`/api/outlook/sectors/${sector.id}/refresh`, {
        method: "POST",
      });
      const payload = (await response.json()) as {
        sector?: SectorSnapshot;
        error?: string;
      };
      if (payload.sector) {
        setSectors((current) => replaceSector(current, payload.sector!));
      }
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : String(error));
      setSectors((current) =>
        current.map((item) =>
          item.id === sector.id && item.status === "refreshing"
            ? { ...item, status: "error" }
            : item
        )
      );
    }
  }

  if (!selected) return null;
  const hasDashboard = [
    "growth", "trade", "fiscal", "inflation", "labor", "equipment-investment", "construction-investment", "domestic-liquidity",
  ].includes(selected.id);

  return (
    <div className="outlook-workbench">
      <section aria-labelledby="outlook-sector-heading">
        <div className="outlook-section-heading">
          <div>
            <p className="outlook-eyebrow">SECTOR MANIFEST</p>
            <h2 id="outlook-sector-heading">{sectors.length}개 섹터</h2>
          </div>
          <p>필요한 섹터만 업데이트</p>
        </div>
        <div className="outlook-card-grid">
          {sectors.map((sector) => (
            <article
              key={sector.id}
              className={`outlook-card${
                sector.id === selected.id ? " outlook-card-selected" : ""
              }`}
            >
              <button
                type="button"
                className="outlook-card-select"
                onClick={() => {
                  setSelectedId(sector.id);
                  setRequestError(null);
                }}
                aria-pressed={sector.id === selected.id}
              >
                <span className={`outlook-status outlook-status-${sector.status}`}>
                  {STATUS_LABELS[sector.status]}
                </span>
                <strong>{sector.title}</strong>
                <small>{sector.description}</small>
                <span className="outlook-card-date">
                  최종 관측일 {sector.lastObservedAt ?? "—"}
                </span>
              </button>
              <button
                type="button"
                className="outlook-refresh-button"
                disabled={!sector.hasProbe || sector.status === "refreshing"}
                onClick={() => refresh(sector)}
              >
                {sector.status === "refreshing" ? "업데이트 중…" : "데이터 업데이트"}
              </button>
            </article>
          ))}
        </div>
      </section>

      <aside
        className={`outlook-detail${
          hasDashboard
            ? " outlook-detail-static"
            : ""
        }`}
        aria-live="polite"
      >
        <div className="outlook-detail-title">
          <div>
            <p className="outlook-eyebrow">SECTOR DETAIL</p>
            <h2>{selected.title}</h2>
          </div>
          <span className={`outlook-status outlook-status-${selected.status}`}>
            {STATUS_LABELS[selected.status]}
          </span>
        </div>
        <p className="outlook-detail-description">{selected.description}</p>
        <dl className="outlook-metadata">
          <div>
            <dt>데이터 소스</dt>
            <dd>{selected.sourceLabel ?? "지표 구성 대기"}</dd>
          </div>
          <div>
            <dt>{hasDashboard ? "연결 지표" : "기술 프로브"}</dt>
            <dd>
              {hasDashboard && selected.probeName
                ? `${selected.sourceResults.filter((result) => result.status === "success").length}개 계열`
                : selected.probeName ?? (selected.hasProbe ? "미실행" : "—")}
            </dd>
          </div>
          <div>
            <dt>최종 관측일</dt>
            <dd>{selected.lastObservedAt ?? "—"}</dd>
          </div>
          <div>
            <dt>마지막 업데이트</dt>
            <dd>{displayTime(selected.lastRefreshedAt)}</dd>
          </div>
          <div>
            <dt>다음 공표일</dt>
            <dd>{selected.nextReleaseAt ?? "공표일 연결 대기"}</dd>
          </div>
        </dl>
        {selected.error && <p className="outlook-error">⚠ {selected.error}</p>}
        {requestError && <p className="outlook-error">⚠ {requestError}</p>}
        {!hasDashboard && (
          <div className="outlook-empty-panel">
            <strong>상세 지표 구성 대기</strong>
            <p>
              차트·판정·공표 일정은 섹터 내용을 확정한 뒤 이 영역에 연결합니다.
              기술 프로브는 API 연결과 최종 관측일만 확인하며 전망 수치를 만들지
              않습니다.
            </p>
          </div>
        )}
      </aside>

      {selected.id === "growth" && <GrowthDashboard snapshot={selected} />}
      {selected.id === "trade" && <TradeDashboard snapshot={selected} />}
      {selected.id === "fiscal" && <FiscalDashboard snapshot={selected} />}
      {selected.id === "inflation" && <InflationDashboard snapshot={selected} />}
      {selected.id === "labor" && <LaborDashboard snapshot={selected} />}
      {selected.id === "equipment-investment" && <EquipmentDashboard snapshot={selected} />}
      {selected.id === "construction-investment" && <ConstructionDashboard snapshot={selected} />}
      {selected.id === "domestic-liquidity" && <DomesticLiquidityDashboard snapshot={selected} />}
    </div>
  );
}
