import Link from "next/link";
import { getIndicator } from "@/lib/indicators";
import { listSectorSnapshots } from "@/lib/outlook/store";
import OutlookReportEditor from "./report-editor";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "경제전망 보고서 작업공간",
  description: "경제전망 HTML 초안 편집과 PDF 저장",
};

export default async function OutlookReportPage() {
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

  return (
    <main className="outlook-report-shell">
      <header className="outlook-report-app-header">
        <div>
          <p className="outlook-eyebrow">ECON COCKPIT REPORT</p>
          <h1>경제전망 보고서 작업공간</h1>
          <p>본문을 직접 수정한 뒤 HTML 또는 PDF로 저장합니다.</p>
        </div>
        <Link href="/outlook" className="outlook-home-link">
          ← 경제전망으로
        </Link>
      </header>
      <OutlookReportEditor sectors={reportSectors} indicatorMetadata={indicatorMetadata} />
    </main>
  );
}
