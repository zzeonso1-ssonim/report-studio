import Link from "next/link";
import { getIndicator } from "@/lib/indicators";
import { listSectorSnapshots } from "@/lib/outlook/store";
import type { SectorId } from "@/lib/outlook/types";
import OutlookReportWorkspace from "./report-workspace";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "경제전망 보고서 작업공간",
  description: "경제전망 HTML 초안 편집과 PDF 저장",
};

export default async function OutlookReportPage({
  searchParams,
}: {
  searchParams: Promise<{ sector?: string; sectors?: string }>;
}) {
  const sectors = await listSectorSnapshots();
  const reportSectors = sectors.filter(
    (sector) =>
      sector.id !== "capital-account" && sector.id !== "national-fiscal-plan"
  );
  const indicatorMetadata = Object.fromEntries(
    reportSectors.flatMap((sector) =>
      sector.sourceResults.map((result) => {
        const indicator = getIndicator(result.indicatorId);
        return [
          result.indicatorId,
          indicator
            ? { name: indicator.name, unit: indicator.unit, origin: indicator.origin }
            : null,
        ];
      })
    )
  );
  const params = await searchParams;
  const requestedSectors = (params.sectors ?? params.sector ?? "")
    .split(",")
    .filter((id): id is SectorId => reportSectors.some((sector) => sector.id === id));
  const initialSectorIds = requestedSectors.length
    ? requestedSectors
    : reportSectors[0] ? [reportSectors[0].id] : [];

  return (
    <main className="outlook-report-shell">
      <header className="outlook-report-app-header">
        <div>
          <p className="outlook-eyebrow">ECON COCKPIT REPORT</p>
          <h1>경제전망 보고서 작업공간</h1>
          <p>Cockpit 차트와 공식 데이터로 자동 구성된 초안을 편집·저장합니다.</p>
        </div>
        <Link href="/outlook" className="outlook-home-link">
          ← 경제전망으로
        </Link>
      </header>
      <OutlookReportWorkspace
        sectors={reportSectors}
        indicatorMetadata={indicatorMetadata}
        initialSectorIds={initialSectorIds}
      />
    </main>
  );
}
