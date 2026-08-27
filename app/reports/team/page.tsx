import ReportAuthoringWorkspace from "../report-authoring-workspace";

export const metadata = {
  title: "본부 공용 보고서작성",
  description: "본부 구성원이 각자 보고서를 작성하고 HTML 작업본으로 이어서 편집하는 공용 도구",
};

export default function TeamReportsPage() {
  return (
    <main className="report-authoring-shell">
      <header className="report-authoring-app-header">
        <div>
          <p className="report-authoring-eyebrow">TEAM REPORT WORKSPACE</p>
          <h1>본부 공용 보고서작성</h1>
          <p>각자 자리에서 독립적으로 작성하고, HTML 작업본을 주고받아 이어서 편집</p>
        </div>
      </header>
      <ReportAuthoringWorkspace
        storageKey="econ-cockpit:team-report-authoring-drafts:v2"
        legacyStorageKey={null}
      />
    </main>
  );
}
