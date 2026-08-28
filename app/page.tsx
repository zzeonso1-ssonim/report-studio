import ReportAuthoringWorkspace from "./reports/report-authoring-workspace";

export const metadata = {
  title: "보고서작성 — Report Studio",
  description: "경제전망·주간채권전략·이슈리포트 편집과 PDF·Word 저장",
};

export default function ReportStudioPage() {
  return (
    <main className="report-authoring-shell">
      <header className="report-authoring-app-header">
        <div>
          <p className="report-authoring-eyebrow">REPORT STUDIO</p>
          <h1>보고서작성</h1>
          <p>텍스트·차트·이미지·표를 한 화면에서 편집하고 작업본을 이어서 작성</p>
        </div>
      </header>
      <ReportAuthoringWorkspace
        storageKey="report-studio:report-authoring-drafts:v2"
        legacyStorageKey={null}
      />
    </main>
  );
}
