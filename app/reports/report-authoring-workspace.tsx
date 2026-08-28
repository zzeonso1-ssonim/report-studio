"use client";

import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";

type ReportKind = "outlook" | "weekly" | "issue";
type TextStyle = "plain" | "bullet" | "bar";
type InsightFields = { insightLabel: string; insightTitle: string; insightBody: string };
type TextBlock = { id: string; type: "text"; title: string; body: string; style: TextStyle };
type ImageBlock = { id: string; type: "image"; title: string; src: string; caption: string; source: string } & InsightFields;
type TableBlock = { id: string; type: "table"; title: string; columns: string[]; rows: string[][] } & InsightFields;
type ChartItem = { id: string; title: string; src: string; caption: string; source: string } & InsightFields;
type ChartBlock = { id: string; type: "chart"; title: string; columns: 1 | 2 | 3; charts: ChartItem[] };
type ReportBlock = TextBlock | ImageBlock | TableBlock | ChartBlock;
type ReportDraft = {
  kicker: string;
  title: string;
  subtitle: string;
  date: string;
  desk: string;
  workspaceLabel: string;
  templateLabel: string;
  reportTypeLabel: string;
  templateName: string;
  rangeTitle?: string;
  ranges?: { label: string; value: string; unit: string }[];
  showRanges?: boolean;
  blocks: ReportBlock[];
};
type DraftMap = Record<ReportKind, ReportDraft>;
type DeletedBlock = { report: ReportKind; block: ReportBlock; index: number };

const STORAGE_KEY = "econ-cockpit:report-authoring-drafts:v2";
const LEGACY_STORAGE_KEY = "econ-cockpit:report-authoring-drafts:v1";
const IMPORT_SCRIPT_ID = "econ-cockpit-report-draft";
const REPORT_LABELS: Record<ReportKind, string> = {
  outlook: "경제전망",
  weekly: "주간채권전략",
  issue: "이슈리포트",
};

function blockId(type: ReportBlock["type"]) {
  return `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function textBlock(title: string, body: string): TextBlock {
  return { id: blockId("text"), type: "text", title, body, style: "plain" };
}

function imageBlock(title = "근거 이미지"): ImageBlock {
  return {
    id: blockId("image"), type: "image", title, src: "", caption: "이미지 설명 입력", source: "자료 출처 입력",
    insightLabel: "INSIGHT", insightTitle: "핵심 해석 입력", insightBody: "차트가 말하는 방향과 시장 함의를 입력",
  };
}

function tableBlock(title: string, columns: string[], rows: string[][]): TableBlock {
  return {
    id: blockId("table"), type: "table", title, columns, rows,
    insightLabel: "INSIGHT", insightTitle: "표의 핵심 판단 입력", insightBody: "수치 비교에서 확인되는 결론과 전략 함의를 입력",
  };
}

function chartItem(index: number): ChartItem {
  return {
    id: `${blockId("chart")}-${index}`,
    title: `차트 ${index + 1} 제목`,
    src: "",
    caption: "차트 설명 입력",
    source: "자료 출처 입력",
    insightLabel: "INSIGHT",
    insightTitle: "핵심 해석 입력",
    insightBody: "차트가 말하는 방향과 시장 함의를 입력",
  };
}

function chartBlock(columns: 1 | 2 | 3 = 2): ChartBlock {
  return { id: blockId("chart"), type: "chart", title: "근거 차트", columns, charts: Array.from({ length: columns }, (_, index) => chartItem(index)) };
}

function reportMeta() {
  return {
    date: localDateStamp(),
    desk: "채권전략팀",
    workspaceLabel: "LIVE REPORT WORKSPACE",
    templateLabel: "TEMPLATE",
    templateName: "GitHub bond-strategy-reports",
  };
}

function createTemplates(): DraftMap {
  return {
    outlook: {
      ...reportMeta(),
      reportTypeLabel: "경제전망",
      kicker: "ECONOMIC OUTLOOK · LIVE REPORT",
      title: "한국 경제전망",
      subtitle: "공식 통계 기반 섹터 점검과 전망 판단",
      blocks: [
        textBlock("Executive Summary", "선택 섹터의 공식 관측값과 핵심 판단 입력"),
        tableBlock("전망·리스크 점검표", ["구분", "현재 판단", "확인 지표", "판정 기한"], [
          ["기본 전망", "작성 필요", "작성 필요", "작성 필요"],
          ["상방 리스크", "작성 필요", "작성 필요", "작성 필요"],
          ["하방 리스크", "작성 필요", "작성 필요", "작성 필요"],
        ]),
        textBlock("Editor’s Outlook", "전망과 리스크 판단, 다음 확인 조건 입력"),
      ],
    },
    weekly: {
      ...reportMeta(),
      reportTypeLabel: "주간채권전략",
      kicker: "WEEKLY STRATEGY · PRINT EDITION",
      title: "주간채권전략",
      subtitle: "금리·커브·수급·이벤트를 연결한 주간 전략 판단",
      rangeTitle: "WEEKLY RANGE",
      showRanges: true,
      ranges: [
        { label: "국고 3년", value: "—", unit: "%" },
        { label: "국고 10년", value: "—", unit: "%" },
        { label: "3/10년 커브", value: "—", unit: "bp" },
      ],
      blocks: [
        textBlock("이번 주 핵심 판단", "중앙 전망과 가장 중요한 전략 판단 입력"),
        textBlock("국내 매크로·정책 이벤트", "국내 지표와 정책 이벤트의 금리 영향 입력"),
        textBlock("해외 매크로·중앙은행·수급", "해외 이벤트와 장기물 수급 위험 입력"),
        tableBlock("시나리오·진입 레벨·리스크 관리", ["시나리오", "금리·커브", "진입 조건", "무효화 조건"], [
          ["Base", "작성 필요", "작성 필요", "작성 필요"],
          ["Upside", "작성 필요", "작성 필요", "작성 필요"],
          ["Downside", "작성 필요", "작성 필요", "작성 필요"],
        ]),
      ],
    },
    issue: {
      ...reportMeta(),
      reportTypeLabel: "이슈리포트",
      kicker: "FIXED INCOME ISSUE NOTE",
      title: "이슈리포트",
      subtitle: "핵심 이슈의 근거·전개·시장 함의를 한 흐름으로 구성",
      blocks: [
        textBlock("한 문장 이슈 정의", "핵심 쟁점을 한 문장으로 입력"),
        textBlock("왜 지금 중요한가", "현재 시점의 중요성과 확인된 사실 입력"),
        textBlock("메커니즘·전달 경로", "이슈가 금리·커브·수급으로 전달되는 경로 입력"),
        chartBlock(2),
        tableBlock("시나리오와 시장 함의", ["구분", "전개 조건", "시장 영향", "전략 대응"], [
          ["Base", "작성 필요", "작성 필요", "작성 필요"],
          ["Upside", "작성 필요", "작성 필요", "작성 필요"],
          ["Downside", "작성 필요", "작성 필요", "작성 필요"],
        ]),
        textBlock("전략 판단", "시장 함의, 진입 조건과 무효화 조건 입력"),
      ],
    },
  };
}

function cloneTemplates() {
  return structuredClone(createTemplates());
}

function localDateStamp() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function collectDocumentStyles() {
  return [...document.styleSheets].map((sheet) => {
    try {
      return [...sheet.cssRules].map((rule) => rule.cssText).join("\n");
    } catch {
      return "";
    }
  }).join("\n");
}

function cleanExportClone(report: HTMLElement) {
  const clone = report.cloneNode(true) as HTMLElement;
  clone.querySelectorAll<HTMLElement>(".report-authoring-insight-editor").forEach((editor) => {
    const inputs = editor.querySelectorAll<HTMLInputElement>("input");
    const textarea = editor.querySelector<HTMLTextAreaElement>("textarea");
    const insight = document.createElement("div");
    insight.className = "report-authoring-insight";
    const strong = document.createElement("strong");
    strong.textContent = `${inputs[0]?.value ?? "INSIGHT"}${inputs[1]?.value ? ` · ${inputs[1].value}` : ""}`;
    const paragraph = document.createElement("p");
    paragraph.textContent = textarea?.value ?? "";
    insight.append(strong, paragraph);
    editor.replaceWith(insight);
  });
  clone.querySelectorAll("[data-report-control]").forEach((node) => node.remove());
  clone.querySelectorAll("input").forEach((node) => {
    const span = document.createElement("span");
    span.textContent = (node as HTMLInputElement).value;
    span.className = (node as HTMLInputElement).className;
    node.replaceWith(span);
  });
  clone.querySelectorAll("textarea").forEach((node) => {
    const paragraph = document.createElement("p");
    paragraph.textContent = (node as HTMLTextAreaElement).value;
    paragraph.className = (node as HTMLTextAreaElement).className;
    node.replaceWith(paragraph);
  });
  return clone;
}

function standaloneDocument(report: HTMLElement, title: string, drafts: DraftMap, reportKind: ReportKind) {
  const clone = cleanExportClone(report);
  const safeTitle = title.replace(/[<>&"]/g, "");
  const editableDraft = JSON.stringify({ version: 1, reportKind, drafts }).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeTitle}</title><style>${collectDocumentStyles()}</style></head><body class="report-authoring-export">${clone.outerHTML}<script type="application/json" id="${IMPORT_SCRIPT_ID}">${editableDraft}</script></body></html>`;
}

function nodeText(root: ParentNode, selector: string) {
  return root.querySelector(selector)?.textContent?.trim() ?? "";
}

function parseLegacyExport(documentNode: Document, templates: DraftMap) {
  const report = documentNode.querySelector<HTMLElement>(".report-authoring-paper");
  if (!report) return null;
  const kicker = nodeText(report, ".report-authoring-kicker-input, .report-authoring-kicker");
  const reportType = nodeText(report, ".report-authoring-template-kind");
  const marker = `${kicker} ${reportType}`.toLowerCase();
  const kind: ReportKind = marker.includes("weekly") || marker.includes("주간") ? "weekly" : marker.includes("issue") || marker.includes("이슈") ? "issue" : "outlook";
  const base = structuredClone(templates[kind]);
  const meta = [...report.querySelectorAll<HTMLElement>(".report-authoring-cover-meta-inputs > *")].map((node) => node.textContent?.trim() ?? "");
  const aside = [...report.querySelectorAll<HTMLElement>(".report-authoring-cover aside > *")].map((node) => node.textContent?.trim() ?? "");
  const blocks = [...report.querySelectorAll<HTMLElement>(".report-authoring-block")].flatMap<ReportBlock>((block): ReportBlock[] => {
    const title = nodeText(block, ".report-authoring-title-input");
    if (block.classList.contains("report-authoring-block-text")) {
      const bullets = [...block.querySelectorAll<HTMLElement>(".report-authoring-bullet-editor li")].map((node) => node.textContent?.trim() ?? "").filter(Boolean);
      const body = bullets.length ? bullets.join("\n") : nodeText(block, ".report-authoring-textarea");
      const style: TextStyle = bullets.length ? "bullet" : block.querySelector(".report-authoring-text-editor-bar") ? "bar" : "plain";
      return [{ id: blockId("text"), type: "text", title, body, style } satisfies TextBlock];
    }
    if (block.classList.contains("report-authoring-block-image")) {
      const metaNodes = [...block.querySelectorAll<HTMLElement>(".report-authoring-image-meta > *")];
      const insight = nodeText(block, ".report-authoring-insight strong").split("·").map((value) => value.trim());
      return [{ ...imageBlock(title), title, src: block.querySelector<HTMLImageElement>("img")?.getAttribute("src") ?? "", caption: metaNodes[0]?.textContent?.trim() ?? "", source: metaNodes[1]?.textContent?.trim() ?? "", insightLabel: insight[0] || "INSIGHT", insightTitle: insight.slice(1).join(" · "), insightBody: nodeText(block, ".report-authoring-insight p") } satisfies ImageBlock];
    }
    if (block.classList.contains("report-authoring-block-table")) {
      const columns = [...block.querySelectorAll<HTMLElement>("table thead th")].map((node) => node.textContent?.trim() ?? "");
      const rows = [...block.querySelectorAll<HTMLTableRowElement>("table tbody tr")].map((row) => [...row.cells].map((cell) => cell.textContent?.trim() ?? ""));
      const insight = nodeText(block, ".report-authoring-insight strong").split("·").map((value) => value.trim());
      return [{ ...tableBlock(title, columns, rows), insightLabel: insight[0] || "INSIGHT", insightTitle: insight.slice(1).join(" · "), insightBody: nodeText(block, ".report-authoring-insight p") } satisfies TableBlock];
    }
    if (block.classList.contains("report-authoring-block-chart")) {
      const grid = block.querySelector<HTMLElement>(".report-authoring-chart-grid");
      const cards = [...(grid?.querySelectorAll<HTMLElement>(".report-authoring-chart-card") ?? [])];
      const columns = Math.min(3, Math.max(1, Number(grid?.className.match(/columns-(\d)/)?.[1]) || cards.length || 1)) as 1 | 2 | 3;
      const charts = cards.map((card, index) => {
        const metaNodes = [...card.querySelectorAll<HTMLElement>(".report-authoring-image-meta > *")];
        const insight = nodeText(card, ".report-authoring-insight strong").split("·").map((value) => value.trim());
        return { ...chartItem(index), title: nodeText(card, ".report-authoring-chart-title"), src: card.querySelector<HTMLImageElement>("img")?.getAttribute("src") ?? "", caption: metaNodes[0]?.textContent?.trim() ?? "", source: metaNodes[1]?.textContent?.trim() ?? "", insightLabel: insight[0] || "INSIGHT", insightTitle: insight.slice(1).join(" · "), insightBody: nodeText(card, ".report-authoring-insight p") };
      });
      return [{ id: blockId("chart"), type: "chart", title, columns, charts } satisfies ChartBlock];
    }
    return [];
  });
  const ranges = [...report.querySelectorAll<HTMLElement>(".report-authoring-ranges label")].map((range) => ({ label: nodeText(range, ".report-authoring-range-label-input, span:first-child"), value: nodeText(range, ".report-authoring-range-input > span:first-child, strong"), unit: nodeText(range, ".report-authoring-range-unit-input, .report-authoring-range-input > span:last-child") }));
  return { kind, draft: { ...base, kicker: kicker || base.kicker, title: nodeText(report, ".report-authoring-cover-title, .report-authoring-cover h1") || base.title, subtitle: nodeText(report, ".report-authoring-cover-subtitle, .report-authoring-subtitle") || base.subtitle, date: meta[0] || base.date, desk: meta[1] || base.desk, workspaceLabel: meta[2] ?? base.workspaceLabel, templateLabel: aside[0] ?? base.templateLabel, reportTypeLabel: reportType || base.reportTypeLabel, templateName: aside[2] ?? base.templateName, rangeTitle: nodeText(report, ".report-authoring-range-title, .report-authoring-ranges > p") || base.rangeTitle, ranges: ranges.length ? ranges : base.ranges, showRanges: ranges.length > 0, blocks: blocks.length ? blocks : base.blocks } satisfies ReportDraft };
}

function downloadBlob(contents: BlobPart, type: string, filename: string) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function parseDelimited(value: string) {
  const lines = value.trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return null;
  const delimiter = lines.some((line) => line.includes("\t")) ? "\t" : ",";
  const cells = lines.map((line) => line.split(delimiter).map((cell) => cell.trim()));
  const width = Math.max(...cells.map((row) => row.length));
  return cells.map((row) => [...row, ...Array(Math.max(0, width - row.length)).fill("")]);
}

function normalizeBlock(block: ReportBlock): ReportBlock {
  if (block.type === "text") {
    return { ...block, style: (["plain", "bullet", "bar"] as TextStyle[]).includes(block.style) ? block.style : "plain" };
  }
  if (block.type === "image") {
    return { ...imageBlock(block.title), ...block };
  }
  if (block.type === "table") {
    return { ...tableBlock(block.title, block.columns, block.rows), ...block };
  }
  const columns = ([1, 2, 3] as const).includes(block.columns) ? block.columns : 2;
  const charts = [...(block.charts ?? [])].slice(0, columns).map((item, index) => ({ ...chartItem(index), ...item }));
  while (charts.length < columns) charts.push(chartItem(charts.length));
  return { ...block, columns, charts };
}

function normalizeDrafts(value: Partial<DraftMap>, templates: DraftMap): DraftMap {
  return (Object.keys(REPORT_LABELS) as ReportKind[]).reduce((result, kind) => {
    const saved = value[kind];
    const base = templates[kind];
    result[kind] = {
      ...base,
      ...saved,
      ranges: saved?.ranges?.map((range, index) => ({ ...base.ranges?.[index], ...range })) ?? base.ranges,
      showRanges: saved?.showRanges ?? base.showRanges,
      blocks: saved?.blocks?.map((block) => normalizeBlock(block)) ?? base.blocks,
    };
    return result;
  }, {} as DraftMap);
}

function InsightEditor({ insight, preview, onChange }: {
  insight: InsightFields;
  preview: boolean;
  onChange: (patch: Partial<InsightFields>) => void;
}) {
  if (preview) {
    return (
      <div className="report-authoring-insight">
        <strong><span>{insight.insightLabel}</span>{insight.insightTitle ? ` · ${insight.insightTitle}` : ""}</strong>
        <p>{insight.insightBody}</p>
      </div>
    );
  }
  return (
    <div className="report-authoring-insight-editor">
      <input value={insight.insightLabel} onChange={(event) => onChange({ insightLabel: event.target.value })} aria-label="인사이트 라벨" />
      <input value={insight.insightTitle} onChange={(event) => onChange({ insightTitle: event.target.value })} aria-label="인사이트 제목" />
      <textarea value={insight.insightBody} onChange={(event) => onChange({ insightBody: event.target.value })} aria-label="인사이트 설명" rows={3} />
    </div>
  );
}

function TextBlockEditor({ block, preview, onChange }: {
  block: TextBlock;
  preview: boolean;
  onChange: (patch: Partial<TextBlock>) => void;
}) {
  const bulletEditorRef = useRef<HTMLUListElement>(null);
  const bulletLines = block.body.split(/\r?\n/);

  function focusBullet(index: number, position?: number) {
    window.requestAnimationFrame(() => {
      const input = bulletEditorRef.current?.querySelectorAll("input")[index];
      input?.focus();
      if (input && position !== undefined) input.setSelectionRange(position, position);
    });
  }

  return (
    <div className="report-authoring-block-body">
      {preview ? (
        <>
          <h2>{block.title}</h2>
          {block.style === "bullet" ? (
            <ul className="report-authoring-body-copy report-authoring-bullets">
              {block.body.split(/\r?\n/).filter(Boolean).map((line, index) => <li key={index}>{line}</li>)}
            </ul>
          ) : <p className={`report-authoring-body-copy${block.style === "bar" ? " report-authoring-left-bar" : ""}`}>{block.body}</p>}
        </>
      ) : (
        <>
          <input className="report-authoring-title-input" value={block.title} onChange={(event) => onChange({ title: event.target.value })} aria-label="텍스트 박스 제목" />
          <div className="report-authoring-text-style" data-report-control aria-label="문장 스타일">
            {(["plain", "bullet", "bar"] as TextStyle[]).map((style) => (
              <button type="button" key={style} aria-pressed={block.style === style} onClick={() => onChange({ style })}>
                {style === "plain" ? "본문" : style === "bullet" ? "• 불릿" : "▌ 좌측 바"}
              </button>
            ))}
          </div>
          {block.style === "bullet" ? (
            <ul ref={bulletEditorRef} className="report-authoring-bullet-editor" aria-label="불릿 본문 편집">
              {bulletLines.map((line, index) => (
                <li key={index}>
                  <input
                    value={line}
                    onChange={(event) => onChange({ body: bulletLines.map((item, itemIndex) => itemIndex === index ? event.target.value : item).join("\n") })}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        const cursor = event.currentTarget.selectionStart ?? line.length;
                        const nextLines = [...bulletLines];
                        nextLines.splice(index, 1, line.slice(0, cursor), line.slice(cursor));
                        onChange({ body: nextLines.join("\n") });
                        focusBullet(index + 1, 0);
                      } else if (event.key === "Backspace" && line === "" && bulletLines.length > 1) {
                        event.preventDefault();
                        const nextLines = bulletLines.filter((_, itemIndex) => itemIndex !== index);
                        const previousLength = nextLines[Math.max(0, index - 1)]?.length ?? 0;
                        onChange({ body: nextLines.join("\n") });
                        focusBullet(Math.max(0, index - 1), previousLength);
                      }
                    }}
                    aria-label={`${index + 1}번 불릿`}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <div className={`report-authoring-text-editor report-authoring-text-editor-${block.style}`}>
              <textarea className="report-authoring-textarea" value={block.body} onChange={(event) => onChange({ body: event.target.value })} aria-label="텍스트 박스 본문" rows={5} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ImageBlockEditor({ block, preview, onChange, onStatus }: {
  block: ImageBlock;
  preview: boolean;
  onChange: (patch: Partial<ImageBlock>) => void;
  onStatus: (message: string) => void;
}) {
  function loadFile(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      onStatus("이미지 파일만 추가할 수 있습니다.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      onChange({ src: String(reader.result), source: file.name });
      onStatus("로컬 이미지를 보고서에 넣었습니다.");
    };
    reader.readAsDataURL(file);
  }

  return (
    <div className="report-authoring-block-body">
      {preview ? <h2>{block.title}</h2> : <input className="report-authoring-title-input" value={block.title} onChange={(event) => onChange({ title: event.target.value })} aria-label="이미지 박스 제목" />}
      {block.src ? (
        // 사용자가 고른 data URL 또는 외부 원본 URL을 그대로 유지해야 하므로 next/image 최적화를 사용하지 않는다.
        // eslint-disable-next-line @next/next/no-img-element
        <img className="report-authoring-image" src={block.src} alt={block.caption || block.title} />
      ) : (
        <div className="report-authoring-image-empty">이미지 파일 또는 외부 이미지 URL 선택</div>
      )}
      {!preview ? (
        <div className="report-authoring-image-controls" data-report-control>
          <label>
            <span>로컬 이미지</span>
            <input type="file" accept="image/*" onChange={(event) => loadFile(event.target.files?.[0])} />
          </label>
          <label>
            <span>외부 이미지 URL</span>
            <input type="url" value={block.src.startsWith("data:") ? "" : block.src} placeholder="https://…" onChange={(event) => onChange({ src: event.target.value })} />
          </label>
        </div>
      ) : null}
      {preview ? (
        <figcaption><span>{block.caption}</span><small>{block.source}</small></figcaption>
      ) : (
        <div className="report-authoring-image-meta">
          <input value={block.caption} onChange={(event) => onChange({ caption: event.target.value })} aria-label="이미지 설명" />
          <input value={block.source} onChange={(event) => onChange({ source: event.target.value })} aria-label="이미지 출처" />
        </div>
      )}
      <InsightEditor insight={block} preview={preview} onChange={onChange} />
    </div>
  );
}

function TableBlockEditor({ block, preview, onChange, onStatus }: {
  block: TableBlock;
  preview: boolean;
  onChange: (patch: Partial<TableBlock>) => void;
  onStatus: (message: string) => void;
}) {
  function updateColumn(index: number, value: string) {
    const columns = [...block.columns];
    columns[index] = value;
    onChange({ columns });
  }

  function updateCell(rowIndex: number, columnIndex: number, value: string) {
    const rows = block.rows.map((row) => [...row]);
    rows[rowIndex][columnIndex] = value;
    onChange({ rows });
  }

  function addRow() {
    onChange({ rows: [...block.rows, Array(block.columns.length).fill("")] });
    onStatus("표에 행을 하나 추가했습니다.");
  }

  function addColumn() {
    onChange({
      columns: [...block.columns, "새 열"],
      rows: block.rows.map((row) => [...row, ""]),
    });
    onStatus("표에 열을 하나 추가했습니다.");
  }

  function removeRow() {
    if (block.rows.length <= 1) {
      onStatus("표에는 행이 최소 하나 필요합니다.");
      return;
    }
    onChange({ rows: block.rows.slice(0, -1) });
    onStatus("표의 마지막 행을 삭제했습니다.");
  }

  function removeColumn() {
    if (block.columns.length <= 1) {
      onStatus("표에는 열이 최소 하나 필요합니다.");
      return;
    }
    onChange({
      columns: block.columns.slice(0, -1),
      rows: block.rows.map((row) => row.slice(0, -1)),
    });
    onStatus("표의 마지막 열을 삭제했습니다.");
  }

  function pasteTable() {
    const value = window.prompt("CSV 또는 탭으로 구분된 표를 붙여넣으세요.");
    if (!value) return;
    const parsed = parseDelimited(value);
    if (!parsed || parsed.length < 1) return;
    const [columns, ...rows] = parsed;
    onChange({ columns, rows: rows.length ? rows : [Array(columns.length).fill("")] });
    onStatus("붙여넣은 표를 현재 박스에 적용했습니다.");
  }

  return (
    <div className="report-authoring-block-body">
      {preview ? <h2>{block.title}</h2> : <input className="report-authoring-title-input" value={block.title} onChange={(event) => onChange({ title: event.target.value })} aria-label="표 박스 제목" />}
      <div className="report-authoring-table-wrap">
        <table>
          <thead>
            <tr>{block.columns.map((column, index) => <th key={index}>{preview ? column : <input value={column} onChange={(event) => updateColumn(index, event.target.value)} aria-label={`${index + 1}열 제목`} />}</th>)}</tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>{block.columns.map((_, columnIndex) => <td key={columnIndex}>{preview ? row[columnIndex] : <input value={row[columnIndex] ?? ""} onChange={(event) => updateCell(rowIndex, columnIndex, event.target.value)} aria-label={`${rowIndex + 1}행 ${columnIndex + 1}열`} />}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
      {!preview ? (
        <div className="report-authoring-table-actions" data-report-control>
          <button type="button" onClick={addRow}>행 추가</button>
          <button type="button" onClick={removeRow} disabled={block.rows.length <= 1}>마지막 행 삭제</button>
          <button type="button" onClick={addColumn}>열 추가</button>
          <button type="button" onClick={removeColumn} disabled={block.columns.length <= 1}>마지막 열 삭제</button>
          <button type="button" onClick={pasteTable}>CSV·표 붙여넣기</button>
        </div>
      ) : null}
      <InsightEditor insight={block} preview={preview} onChange={onChange} />
    </div>
  );
}

function ChartBlockEditor({ block, preview, onChange, onStatus }: {
  block: ChartBlock;
  preview: boolean;
  onChange: (patch: Partial<ChartBlock>) => void;
  onStatus: (message: string) => void;
}) {
  function setColumns(columns: 1 | 2 | 3) {
    const charts = block.charts.slice(0, columns);
    while (charts.length < columns) charts.push(chartItem(charts.length));
    onChange({ columns, charts });
  }

  function updateChart(index: number, patch: Partial<ChartItem>) {
    onChange({ charts: block.charts.map((chart, itemIndex) => itemIndex === index ? { ...chart, ...patch } : chart) });
  }

  function loadFile(index: number, file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      onStatus("이미지 파일만 차트로 추가할 수 있습니다.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      updateChart(index, { src: String(reader.result), source: file.name });
      onStatus(`차트 ${index + 1} 이미지를 넣었습니다.`);
    };
    reader.readAsDataURL(file);
  }

  return (
    <div className="report-authoring-block-body">
      {preview ? <h2>{block.title}</h2> : (
        <>
          <input className="report-authoring-title-input" value={block.title} onChange={(event) => onChange({ title: event.target.value })} aria-label="차트 묶음 제목" />
          <div className="report-authoring-chart-layout" data-report-control>
            <span>한 줄 차트 수</span>
            {([1, 2, 3] as const).map((columns) => <button type="button" key={columns} aria-pressed={block.columns === columns} onClick={() => setColumns(columns)}>{columns}개</button>)}
          </div>
        </>
      )}
      <div className={`report-authoring-chart-grid columns-${block.columns}`}>
        {block.charts.map((chart, index) => (
          <figure className="report-authoring-chart-card" key={chart.id}>
            {preview ? <h3>{chart.title}</h3> : <input className="report-authoring-chart-title" value={chart.title} onChange={(event) => updateChart(index, { title: event.target.value })} aria-label={`${index + 1}번 차트 제목`} />}
            {chart.src ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={chart.src} alt={chart.caption || chart.title} />
            ) : <div className="report-authoring-chart-empty">차트 {index + 1} 이미지 선택</div>}
            {!preview ? (
              <>
                <div className="report-authoring-chart-inputs" data-report-control>
                  <label><span>로컬 차트</span><input type="file" accept="image/*" onChange={(event) => loadFile(index, event.target.files?.[0])} /></label>
                  <label><span>외부 URL</span><input type="url" value={chart.src.startsWith("data:") ? "" : chart.src} placeholder="https://…" onChange={(event) => updateChart(index, { src: event.target.value })} /></label>
                </div>
                <div className="report-authoring-chart-meta">
                  <input className="report-authoring-chart-meta-value" value={chart.caption} onChange={(event) => updateChart(index, { caption: event.target.value })} aria-label={`${index + 1}번 차트 설명`} />
                  <input className="report-authoring-chart-meta-value" value={chart.source} onChange={(event) => updateChart(index, { source: event.target.value })} aria-label={`${index + 1}번 차트 출처`} />
                </div>
              </>
            ) : <figcaption><span>{chart.caption}</span><small>{chart.source}</small></figcaption>}
            <InsightEditor insight={chart} preview={preview} onChange={(patch) => updateChart(index, patch)} />
          </figure>
        ))}
      </div>
    </div>
  );
}

export default function ReportAuthoringWorkspace({
  storageKey = STORAGE_KEY,
  legacyStorageKey = LEGACY_STORAGE_KEY,
}: {
  storageKey?: string;
  legacyStorageKey?: string | null;
} = {}) {
  const templates = useMemo(() => cloneTemplates(), []);
  const [reportKind, setReportKind] = useState<ReportKind>("weekly");
  const [drafts, setDrafts] = useState<DraftMap>(templates);
  const [hydrated, setHydrated] = useState(false);
  const [preview, setPreview] = useState(false);
  const [compactPrint, setCompactPrint] = useState(true);
  const [status, setStatus] = useState("");
  const [deleted, setDeleted] = useState<DeletedBlock | null>(null);
  const reportRef = useRef<HTMLElement>(null);
  const htmlImportRef = useRef<HTMLInputElement>(null);
  const draft = drafts[reportKind];

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const saved = window.localStorage.getItem(storageKey) ?? (legacyStorageKey ? window.localStorage.getItem(legacyStorageKey) : null);
      if (saved) {
        try {
          setDrafts(normalizeDrafts(JSON.parse(saved) as Partial<DraftMap>, templates));
        } catch {
          setStatus("저장본을 읽지 못해 기본 양식을 적용했습니다.");
        }
      }
      setHydrated(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [legacyStorageKey, storageKey, templates]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(drafts));
    } catch {
      window.setTimeout(() => setStatus("이미지 용량이 커 자동저장 한도를 넘었습니다. HTML 또는 Word로 먼저 저장하세요."), 0);
    }
  }, [drafts, hydrated, storageKey]);

  function updateDraft(patch: Partial<ReportDraft>) {
    setDrafts((current) => ({ ...current, [reportKind]: { ...current[reportKind], ...patch } }));
  }

  function updateBlock(id: string, patch: Partial<ReportBlock>) {
    updateDraft({ blocks: draft.blocks.map((block) => block.id === id ? { ...block, ...patch } as ReportBlock : block) });
  }

  function addBlock(type: ReportBlock["type"]) {
    const block = type === "text"
      ? textBlock("새 분석 제목", "분석 내용 입력")
      : type === "image"
        ? imageBlock()
        : type === "table"
          ? tableBlock("새 표", ["구분", "값", "판단"], [["", "", ""]])
          : chartBlock(2);
    updateDraft({ blocks: [...draft.blocks, block] });
    setStatus(`${type === "text" ? "텍스트" : type === "image" ? "이미지" : type === "table" ? "표" : "차트 묶음"} 박스를 추가했습니다.`);
  }

  function moveBlock(index: number, direction: -1 | 1) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= draft.blocks.length) return;
    const blocks = [...draft.blocks];
    [blocks[index], blocks[nextIndex]] = [blocks[nextIndex], blocks[index]];
    updateDraft({ blocks });
  }

  function removeBlock(index: number) {
    const block = draft.blocks[index];
    updateDraft({ blocks: draft.blocks.filter((_, itemIndex) => itemIndex !== index) });
    setDeleted({ report: reportKind, block, index });
    setStatus("박스를 보고서에서 삭제했습니다.");
  }

  function undoDelete() {
    if (!deleted) return;
    setDrafts((current) => {
      const report = current[deleted.report];
      const blocks = [...report.blocks];
      blocks.splice(deleted.index, 0, deleted.block);
      return { ...current, [deleted.report]: { ...report, blocks } };
    });
    setDeleted(null);
    setStatus("삭제한 박스를 복원했습니다.");
  }

  function resetTemplate() {
    if (!window.confirm("현재 작업본을 지우고 기본 보고서 양식을 다시 적용할까요?")) return;
    setDrafts((current) => ({ ...current, [reportKind]: structuredClone(templates[reportKind]) }));
    setDeleted(null);
    setStatus("기본 보고서 양식을 다시 적용했습니다.");
  }

  function saveHtml() {
    if (!reportRef.current) return;
    downloadBlob(standaloneDocument(reportRef.current, draft.title, drafts, reportKind), "text/html;charset=utf-8", `report-${localDateStamp()}.html`);
    setStatus("편집 데이터가 포함된 HTML 작업본을 저장했습니다.");
  }

  function saveWord() {
    if (!reportRef.current) return;
    const html = standaloneDocument(reportRef.current, draft.title, drafts, reportKind);
    downloadBlob(html, "application/msword;charset=utf-8", `report-${localDateStamp()}.doc`);
    setStatus("현재 작업본을 Word 호환 문서로 저장했습니다.");
  }

  async function importHtml(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) {
      setStatus("HTML 작업본은 25MB 이하 파일만 가져올 수 있습니다.");
      return;
    }
    try {
      const documentNode = new DOMParser().parseFromString(await file.text(), "text/html");
      const payloadNode = documentNode.getElementById(IMPORT_SCRIPT_ID);
      if (payloadNode?.textContent) {
        const payload = JSON.parse(payloadNode.textContent) as { version?: number; reportKind?: ReportKind; drafts?: Partial<DraftMap> };
        if (payload.version !== 1 || !payload.drafts) throw new Error("unsupported draft");
        setDrafts(normalizeDrafts(payload.drafts, templates));
        if (payload.reportKind && payload.reportKind in REPORT_LABELS) setReportKind(payload.reportKind);
      } else {
        const legacy = parseLegacyExport(documentNode, templates);
        if (!legacy) throw new Error("editable draft not found");
        setDrafts((current) => ({ ...current, [legacy.kind]: legacy.draft }));
        setReportKind(legacy.kind);
      }
      setPreview(false);
      setDeleted(null);
      setStatus(`${file.name} 작업본을 불러왔습니다. 바로 이어서 편집할 수 있습니다.`);
    } catch {
      setStatus("지원하는 보고서 HTML 작업본이 아니거나 파일이 손상되었습니다.");
    }
  }

  function printPdf() {
    setPreview(true);
    setStatus("인쇄 창에서 대상을 ‘PDF로 저장’으로 선택하세요. 브라우저의 ‘머리글과 바닥글’은 끄는 것을 권장합니다.");
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const cleanup = () => {
        document.body.classList.remove("report-authoring-printing");
      };
      window.addEventListener("afterprint", cleanup, { once: true });
      document.body.classList.add("report-authoring-printing");
      window.print();
    }));
  }

  return (
    <>
      <div className="report-authoring-tabs" data-report-control>
        {(Object.keys(REPORT_LABELS) as ReportKind[]).map((kind) => (
          <button key={kind} type="button" aria-pressed={reportKind === kind} onClick={() => setReportKind(kind)}>{REPORT_LABELS[kind]}</button>
        ))}
      </div>
      <div className="report-authoring-toolbar" data-report-control>
        <div className="report-authoring-usage-guide">
          <strong>사용 방법</strong>
          <span>① 내용을 직접 편집하고 필요한 텍스트·이미지·표·차트 박스를 추가합니다.</span>
          <span>② 작업을 넘길 때는 HTML 저장, 이어받을 때는 HTML 가져오기를 사용합니다.</span>
          <span>③ 미리보기로 확인한 뒤 PDF 저장을 누르면 페이지별 로고가 포함됩니다.</span>
          {status ? <p aria-live="polite">{status}</p> : null}
        </div>
        <div className="report-authoring-toolbar-actions">
          <button type="button" onClick={() => setPreview((value) => !value)}>{preview ? "편집으로" : "미리보기"}</button>
          <button
            type="button"
            aria-pressed={compactPrint}
            onClick={() => {
              setCompactPrint((value) => !value);
              setStatus(compactPrint ? "PDF 빈 공간 최소화를 껐습니다." : "PDF 빈 공간 최소화를 적용했습니다.");
            }}
          >
            빈 공간 최소화 {compactPrint ? "ON" : "OFF"}
          </button>
          <button type="button" onClick={resetTemplate}>양식 초기화</button>
          <button type="button" onClick={() => htmlImportRef.current?.click()}>HTML 가져오기</button>
          <button type="button" onClick={saveHtml}>HTML 저장</button>
          <button type="button" onClick={saveWord}>Word 저장</button>
          <button type="button" className="report-authoring-primary" onClick={printPdf}>PDF 저장</button>
          <input ref={htmlImportRef} type="file" accept=".html,.htm,text/html" onChange={importHtml} hidden />
        </div>
      </div>

      <div className={`report-authoring-workspace${preview ? " is-preview" : ""}`}>
        {!preview ? (
          <aside className="report-authoring-palette" data-report-control>
            <p>CONTENT BOX</p>
            <h2>박스 추가</h2>
            <button type="button" aria-pressed={Boolean(draft.showRanges)} onClick={() => { updateDraft({ showRanges: !draft.showRanges }); setStatus(draft.showRanges ? "주간채권전략 금리 박스를 삭제했습니다." : "제목과 발행일 아래에 주간채권전략 금리 박스를 추가했습니다."); }}><strong>주간채권전략 금리 박스</strong><span>{draft.showRanges ? "현재 표시 중 · 누르면 삭제" : "국고 3년·10년·커브"}</span></button>
            <button type="button" onClick={() => addBlock("text")}><strong>텍스트</strong><span>제목·본문·전망 메모</span></button>
            <button type="button" onClick={() => addBlock("image")}><strong>이미지</strong><span>로컬 파일·외부 URL</span></button>
            <button type="button" onClick={() => addBlock("table")}><strong>표</strong><span>직접 편집·CSV 붙여넣기</span></button>
            <button type="button" onClick={() => addBlock("chart")}><strong>차트 묶음</strong><span>한 줄에 1·2·3개 배치</span></button>
          </aside>
        ) : null}

        <article ref={reportRef} className={`report-authoring-paper${compactPrint ? " report-authoring-print-compact" : ""}`} aria-label="보고서 편집 문서">
          <header className="report-authoring-cover">
            <div>
              {preview ? <p className="report-authoring-kicker">{draft.kicker}</p> : <input className="report-authoring-kicker-input" value={draft.kicker} onChange={(event) => updateDraft({ kicker: event.target.value })} aria-label="보고서 영문 머리말" />}
              {preview ? <h1>{draft.title}</h1> : <input className="report-authoring-cover-title" value={draft.title} onChange={(event) => updateDraft({ title: event.target.value })} aria-label="보고서 제목" />}
              {preview ? <p className="report-authoring-subtitle">{draft.subtitle}</p> : <textarea className="report-authoring-cover-subtitle" value={draft.subtitle} onChange={(event) => updateDraft({ subtitle: event.target.value })} aria-label="보고서 부제" rows={2} />}
              {preview ? <p className="report-authoring-cover-meta">{draft.date} · {draft.desk} · {draft.workspaceLabel}</p> : (
                <div className="report-authoring-cover-meta-inputs">
                  <input value={draft.date} onChange={(event) => updateDraft({ date: event.target.value })} aria-label="보고서 날짜" />
                  <input value={draft.desk} onChange={(event) => updateDraft({ desk: event.target.value })} aria-label="작성 부서" />
                  <input value={draft.workspaceLabel} onChange={(event) => updateDraft({ workspaceLabel: event.target.value })} aria-label="작업공간 표기" />
                </div>
              )}
            </div>
            <aside>
              {preview ? <span>{draft.templateLabel}</span> : <input value={draft.templateLabel} onChange={(event) => updateDraft({ templateLabel: event.target.value })} aria-label="양식 라벨" />}
              {preview ? <strong>{draft.reportTypeLabel}</strong> : <input className="report-authoring-template-kind" value={draft.reportTypeLabel} onChange={(event) => updateDraft({ reportTypeLabel: event.target.value })} aria-label="보고서 유형" />}
              {preview ? <small>{draft.templateName}</small> : <input value={draft.templateName} onChange={(event) => updateDraft({ templateName: event.target.value })} aria-label="양식 출처" />}
            </aside>
          </header>

          {draft.showRanges && draft.ranges ? (
            <section className="report-authoring-ranges">
              {!preview ? <div className="report-authoring-range-tools" data-report-control><span>주간채권전략 금리 박스</span><button type="button" onClick={() => { updateDraft({ showRanges: false }); setStatus("주간채권전략 금리 박스를 삭제했습니다."); }}>삭제</button></div> : null}
              {preview ? <p>{draft.rangeTitle}</p> : <input className="report-authoring-range-title" value={draft.rangeTitle ?? ""} onChange={(event) => updateDraft({ rangeTitle: event.target.value })} aria-label="범위 제목" />}
              <div>
                {draft.ranges.map((range, index) => (
                  <label key={index}>
                    {preview ? <span>{range.label}</span> : <input className="report-authoring-range-label-input" value={range.label} onChange={(event) => updateDraft({ ranges: draft.ranges!.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item) })} aria-label={`${index + 1}번 범위 이름`} />}
                    {preview ? <strong>{range.value} {range.unit}</strong> : <span className="report-authoring-range-input"><input value={range.value} onChange={(event) => updateDraft({ ranges: draft.ranges!.map((item, itemIndex) => itemIndex === index ? { ...item, value: event.target.value } : item) })} aria-label={`${range.label} 범위`} /><input className="report-authoring-range-unit-input" value={range.unit} onChange={(event) => updateDraft({ ranges: draft.ranges!.map((item, itemIndex) => itemIndex === index ? { ...item, unit: event.target.value } : item) })} aria-label={`${range.label} 단위`} /></span>}
                  </label>
                ))}
              </div>
            </section>
          ) : null}

          <div className="report-authoring-blocks">
            {draft.blocks.map((block, index) => (
              <section className={`report-authoring-block report-authoring-block-${block.type}`} key={block.id}>
                {!preview ? (
                  <div className="report-authoring-block-tools" data-report-control>
                    <span>{block.type === "text" ? "텍스트" : block.type === "image" ? "이미지" : block.type === "table" ? "표" : "차트"}</span>
                    <button type="button" onClick={() => moveBlock(index, -1)} aria-label="위로 이동">↑</button>
                    <button type="button" onClick={() => moveBlock(index, 1)} aria-label="아래로 이동">↓</button>
                    <button type="button" onClick={() => removeBlock(index)}>삭제</button>
                  </div>
                ) : null}
                {block.type === "text" ? <TextBlockEditor block={block} preview={preview} onChange={(patch) => updateBlock(block.id, patch)} /> : null}
                {block.type === "image" ? <ImageBlockEditor block={block} preview={preview} onChange={(patch) => updateBlock(block.id, patch)} onStatus={setStatus} /> : null}
                {block.type === "table" ? <TableBlockEditor block={block} preview={preview} onChange={(patch) => updateBlock(block.id, patch)} onStatus={setStatus} /> : null}
                {block.type === "chart" ? <ChartBlockEditor block={block} preview={preview} onChange={(patch) => updateBlock(block.id, patch)} onStatus={setStatus} /> : null}
              </section>
            ))}
          </div>
          <footer className="report-authoring-footer-logo report-authoring-footer-logo-screen">
            {/* 로고 원본 비율을 유지하기 위해 next/image 최적화 대신 정적 이미지를 그대로 사용한다. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/daishin-asset-management.png" alt="Daishin Asset Management" />
          </footer>
        </article>
      </div>

      {deleted ? <div className="report-authoring-undo" data-report-control><span>박스 삭제됨</span><button type="button" onClick={undoDelete}>되돌리기</button></div> : null}
    </>
  );
}
