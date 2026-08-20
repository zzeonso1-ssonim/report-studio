import Link from "next/link";
import { listSectorSnapshots } from "@/lib/outlook/store";
import OutlookWorkbench from "./outlook-workbench";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "경제전망",
  description: "섹터별 독립 데이터 갱신 워크벤치",
};

export default async function OutlookPage() {
  return (
    <main className="outlook-shell">
      <header className="outlook-header">
        <div>
          <p className="outlook-eyebrow">ECON COCKPIT</p>
          <h1>경제전망</h1>
          <p>
            섹터마다 공표일이 다른 데이터를 독립적으로 갱신합니다. 전체 업데이트는
            제공하지 않습니다.
          </p>
        </div>
        <Link href="/" className="outlook-home-link">
          ← 통합조회로
        </Link>
      </header>
      <OutlookWorkbench initialSectors={await listSectorSnapshots()} />
    </main>
  );
}
