import Link from "next/link";
import ReportAuthoringWorkspace from "./report-authoring-workspace";

export const metadata = {
  title: "보고서작성",
  description: "경제전망·주간채권전략·이슈리포트 편집과 PDF·Word 저장",
};

export default function ReportsPage() {
  return (
    <main className="report-authoring-shell">
      <header className="report-authoring-app-header">
        <div>
          <p className="report-authoring-eyebrow">ECON COCKPIT REPORTS</p>
          <h1>보고서작성</h1>
          <p>GitHub 보고서 양식을 적용해 텍스트·차트·이미지·표를 한 화면에서 편집</p>
        </div>
        <div className="report-authoring-header-links">
          <Link href="/outlook/report?sectors=growth,trade">경제전망 데이터 초안</Link>
          <Link href="/">← 통합조회로</Link>
        </div>
      </header>
      <ReportAuthoringWorkspace />
    </main>
  );
}
