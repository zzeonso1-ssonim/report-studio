"use client";

import { useEffect, useRef } from "react";
import type { SectorSnapshot } from "@/lib/outlook/types";

interface IndicatorMetadata {
  name: string;
  unit: string;
  origin: string;
}

type IndicatorMetadataMap = Record<string, IndicatorMetadata | null>;
const DRAFT_STORAGE_KEY = "econ-cockpit:outlook-report-draft:v1";

function latestPoint(result: SectorSnapshot["sourceResults"][number]) {
  return [...result.points]
    .filter((point) => point.value != null)
    .sort((a, b) => a.date.localeCompare(b.date))
    .at(-1);
}

function formatValue(value: number, unit: string | undefined): string {
  const digits = Math.abs(value) >= 100 ? 1 : 2;
  const number = new Intl.NumberFormat("ko-KR", {
    maximumFractionDigits: digits,
  }).format(value);
  return unit ? `${number} ${unit}` : `${number} (단위 확인 필요)`;
}

function documentHtml(content: string, title: string): string {
  const styles = `
    :root { color-scheme: light; font-family: Pretendard, "Noto Sans KR", Arial, sans-serif; }
    body { margin: 0; color: #17202d; background: #fff; line-height: 1.6; }
    article { box-sizing: border-box; width: min(210mm, 100%); margin: 0 auto; padding: 18mm 16mm; }
    h1 { margin: 0 0 4mm; font-size: 26px; } h2 { margin: 12mm 0 4mm; border-top: 2px solid #173b67; padding-top: 4mm; font-size: 19px; }
    h3 { margin: 6mm 0 2mm; font-size: 15px; } p { margin: 0 0 3mm; } .report-muted { color: #657082; font-size: 12px; }
    table { width: 100%; border-collapse: collapse; margin: 3mm 0 6mm; font-size: 11px; } th, td { border-bottom: 1px solid #d9dee7; padding: 2.5mm 2mm; text-align: left; vertical-align: top; }
    th { background: #eef3f8; font-weight: 700; } .report-callout { border-left: 3px solid #2670b8; background: #f4f7fb; padding: 4mm; }
    @page { size: A4; margin: 12mm; } @media print { article { width: auto; padding: 0; } h2, h3 { break-after: avoid; } table { break-inside: avoid; } }
  `;
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${styles}</style></head><body>${content}</body></html>`;
}

function localDateStamp(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export default function OutlookReportEditor({
  sectors,
  indicatorMetadata,
}: {
  sectors: SectorSnapshot[];
  indicatorMetadata: IndicatorMetadataMap;
}) {
  const reportRef = useRef<HTMLElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const savedDraft = window.localStorage.getItem(DRAFT_STORAGE_KEY);
    if (savedDraft && reportRef.current) {
      reportRef.current.innerHTML = savedDraft;
      if (statusRef.current) statusRef.current.textContent = "이 브라우저에 저장된 초안을 불러왔습니다.";
    }
  }, []);

  function saveDraft() {
    if (!reportRef.current) return;
    window.localStorage.setItem(DRAFT_STORAGE_KEY, reportRef.current.innerHTML);
    if (statusRef.current) statusRef.current.textContent = "수정 내용을 이 브라우저에 자동 저장했습니다.";
  }

  function downloadHtml() {
    if (!reportRef.current) return;
    const title = reportRef.current.querySelector("h1")?.textContent?.trim() || "경제전망 보고서";
    const blob = new Blob([documentHtml(reportRef.current.outerHTML, title)], {
      type: "text/html;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `econ-outlook-report-${localDateStamp()}.html`;
    anchor.style.display = "none";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
    if (statusRef.current) statusRef.current.textContent = "현재 편집본을 HTML로 저장했습니다.";
  }

  function printPdf() {
    if (statusRef.current) statusRef.current.textContent = "인쇄 창에서 대상을 ‘PDF로 저장’으로 선택하세요.";
    window.print();
  }

  return (
    <>
      <div className="outlook-report-toolbar" role="toolbar" aria-label="보고서 저장 도구">
        <div>
          <strong>편집 모드</strong>
          <span>아래 흰색 보고서의 제목·본문·표 셀을 클릭해 바로 수정</span>
        </div>
        <div className="outlook-report-toolbar-actions">
          <button type="button" onClick={downloadHtml}>HTML 저장</button>
          <button type="button" className="outlook-report-primary-action" onClick={printPdf}>PDF 저장</button>
        </div>
        <p ref={statusRef} aria-live="polite">초안은 수정할 때마다 현재 브라우저에 자동 저장됩니다.</p>
      </div>

      <article
        ref={reportRef}
        className="outlook-report-paper"
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        onInput={saveDraft}
        aria-label="편집 가능한 경제전망 보고서 초안"
      >
        <header className="outlook-report-cover">
          <p className="outlook-eyebrow">ECONOMIC OUTLOOK</p>
          <h1>한국 경제전망 보고서</h1>
          <p className="report-muted">초안 · 작성 기준일 {localDateStamp()}</p>
        </header>

        <section>
          <h2>핵심 판단</h2>
          <div className="report-callout">
            최신 공식 통계를 바탕으로 핵심 판단과 리스크를 이곳에 작성하세요. 원문에 없는 값은 추정하거나 보간하지 않습니다.
          </div>
        </section>

        {sectors.map((sector) => (
          <section key={sector.id}>
            <h2>{sector.title}</h2>
            <p>{sector.description}</p>
            <p className="report-muted">
              상태 {sector.status} · 섹터 최종 관측일 {sector.lastObservedAt ?? "미확인"} · 마지막 업데이트 {sector.lastRefreshedAt ?? "미실행"}
            </p>
            {sector.sourceResults.length > 0 ? (
              <table>
                <thead>
                  <tr>
                    <th>지표</th><th>최신 관측값</th><th>관측 기준일</th><th>발표일</th><th>출처·정의</th>
                  </tr>
                </thead>
                <tbody>
                  {sector.sourceResults.map((result) => {
                    const point = latestPoint(result);
                    const metadata = indicatorMetadata[result.indicatorId];
                    return (
                      <tr key={result.indicatorId}>
                        <td>{metadata?.name ?? result.probeName}</td>
                        <td>{point?.value != null ? formatValue(point.value, metadata?.unit) : "결측"}</td>
                        <td>{point?.date ?? result.lastObservedAt ?? "미확인"}</td>
                        <td>{point?.provenance?.publishedAt ?? "발표일 미연결"}</td>
                        <td>{metadata?.origin ?? result.sourceLabel} · {point?.provenance?.note ?? result.probeName}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <p className="report-callout">공식 계열이 아직 구성되지 않았습니다. 임의 수치를 채우지 않습니다.</p>
            )}
            <h3>해석과 전망</h3>
            <p>이 섹터의 방향, 전환점, 상방·하방 위험을 작성하세요.</p>
          </section>
        ))}

        <section>
          <h2>리스크와 확인 일정</h2>
          <table>
            <thead><tr><th>리스크</th><th>확인 지표</th><th>판정 기한</th><th>대응</th></tr></thead>
            <tbody><tr><td>작성 필요</td><td>작성 필요</td><td>작성 필요</td><td>작성 필요</td></tr></tbody>
          </table>
        </section>
      </article>
    </>
  );
}
