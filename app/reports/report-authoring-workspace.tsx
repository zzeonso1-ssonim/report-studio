"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type ReportKind = "outlook" | "weekly" | "issue";
type TextBlock = { id: string; type: "text"; title: string; body: string };
type ImageBlock = { id: string; type: "image"; title: string; src: string; caption: string; source: string };
type TableBlock = { id: string; type: "table"; title: string; columns: string[]; rows: string[][] };
type ReportBlock = TextBlock | ImageBlock | TableBlock;
type ReportDraft = {
  kicker: string;
  title: string;
  subtitle: string;
  ranges?: { label: string; value: string; unit: "%" | "bp" }[];
  blocks: ReportBlock[];
};
type DraftMap = Record<ReportKind, ReportDraft>;
type DeletedBlock = { report: ReportKind; block: ReportBlock; index: number };

const STORAGE_KEY = "econ-cockpit:report-authoring-drafts:v1";
const REPORT_LABELS: Record<ReportKind, string> = {
  outlook: "경제전망",
  weekly: "주간채권전략",
  issue: "이슈리포트",
};

function blockId(type: ReportBlock["type"]) {
  return `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function textBlock(title: string, body: string): TextBlock {
  return { id: blockId("text"), type: "text", title, body };
}

function imageBlock(title = "근거 이미지"): ImageBlock {
  return { id: blockId("image"), type: "image", title, src: "", caption: "이미지 설명 입력", source: "자료 출처 입력" };
}

function tableBlock(title: string, columns: string[], rows: string[][]): TableBlock {
  return { id: blockId("table"), type: "table", title, columns, rows };
}

function createTemplates(): DraftMap {
  return {
    outlook: {
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
      kicker: "WEEKLY STRATEGY · PRINT EDITION",
      title: "주간채권전략",
      subtitle: "금리·커브·수급·이벤트를 연결한 주간 전략 판단",
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
      kicker: "FIXED INCOME ISSUE NOTE",
      title: "이슈리포트",
      subtitle: "핵심 이슈의 근거·전개·시장 함의를 한 흐름으로 구성",
      blocks: [
        textBlock("한 문장 이슈 정의", "핵심 쟁점을 한 문장으로 입력"),
        textBlock("왜 지금 중요한가", "현재 시점의 중요성과 확인된 사실 입력"),
        textBlock("메커니즘·전달 경로", "이슈가 금리·커브·수급으로 전달되는 경로 입력"),
        imageBlock("근거 차트·타임라인"),
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
  clone.querySelectorAll("[data-report-control]").forEach((node) => node.remove());
  clone.querySelectorAll("input").forEach((node) => {
    const span = document.createElement("span");
    span.textContent = (node as HTMLInputElement).value;
    node.replaceWith(span);
  });
  clone.querySelectorAll("textarea").forEach((node) => {
    const paragraph = document.createElement("p");
    paragraph.textContent = (node as HTMLTextAreaElement).value;
    node.replaceWith(paragraph);
  });
  return clone;
}

function standaloneDocument(report: HTMLElement, title: string) {
  const clone = cleanExportClone(report);
  const safeTitle = title.replace(/[<>&"]/g, "");
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeTitle}</title><style>${collectDocumentStyles()}</style></head><body class="report-authoring-export">${clone.outerHTML}</body></html>`;
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

function TextBlockEditor({ block, preview, onChange }: {
  block: TextBlock;
  preview: boolean;
  onChange: (patch: Partial<TextBlock>) => void;
}) {
  return (
    <div className="report-authoring-block-body">
      {preview ? (
        <>
          <h2>{block.title}</h2>
          <p className="report-authoring-body-copy">{block.body}</p>
        </>
      ) : (
        <>
          <input className="report-authoring-title-input" value={block.title} onChange={(event) => onChange({ title: event.target.value })} aria-label="텍스트 박스 제목" />
          <textarea className="report-authoring-textarea" value={block.body} onChange={(event) => onChange({ body: event.target.value })} aria-label="텍스트 박스 본문" rows={5} />
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
  }

  function addColumn() {
    onChange({
      columns: [...block.columns, "새 열"],
      rows: block.rows.map((row) => [...row, ""]),
    });
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
      {!preview ? <div className="report-authoring-table-actions" data-report-control><button type="button" onClick={addRow}>행 추가</button><button type="button" onClick={addColumn}>열 추가</button><button type="button" onClick={pasteTable}>CSV·표 붙여넣기</button></div> : null}
    </div>
  );
}

export default function ReportAuthoringWorkspace() {
  const templates = useMemo(() => cloneTemplates(), []);
  const [reportKind, setReportKind] = useState<ReportKind>("weekly");
  const [drafts, setDrafts] = useState<DraftMap>(templates);
  const [hydrated, setHydrated] = useState(false);
  const [preview, setPreview] = useState(false);
  const [status, setStatus] = useState("GitHub bond-strategy-reports 양식을 자동 적용했습니다.");
  const [deleted, setDeleted] = useState<DeletedBlock | null>(null);
  const reportRef = useRef<HTMLElement>(null);
  const draft = drafts[reportKind];

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) {
        try {
          setDrafts(JSON.parse(saved) as DraftMap);
          setStatus("이 브라우저에 저장된 리포트별 작업본을 불러왔습니다.");
        } catch {
          setStatus("저장본을 읽지 못해 기본 양식을 적용했습니다.");
        }
      }
      setHydrated(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
    } catch {
      window.setTimeout(() => setStatus("이미지 용량이 커 자동저장 한도를 넘었습니다. HTML 또는 Word로 먼저 저장하세요."), 0);
    }
  }, [drafts, hydrated]);

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
        : tableBlock("새 표", ["구분", "값", "판단"], [["", "", ""]]);
    updateDraft({ blocks: [...draft.blocks, block] });
    setStatus(`${type === "text" ? "텍스트" : type === "image" ? "이미지" : "표"} 박스를 추가했습니다.`);
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
    setReportKind(deleted.report);
    setDeleted(null);
    setStatus("삭제한 박스를 복원했습니다.");
  }

  function resetTemplate() {
    if (!window.confirm(`${REPORT_LABELS[reportKind]} 작업본을 지우고 기본 양식을 다시 적용할까요?`)) return;
    setDrafts((current) => ({ ...current, [reportKind]: structuredClone(templates[reportKind]) }));
    setDeleted(null);
    setStatus(`${REPORT_LABELS[reportKind]} 기본 양식을 다시 적용했습니다.`);
  }

  function saveHtml() {
    if (!reportRef.current) return;
    downloadBlob(standaloneDocument(reportRef.current, draft.title), "text/html;charset=utf-8", `${reportKind}-report-${localDateStamp()}.html`);
    setStatus("현재 작업본을 자체 포함 HTML로 저장했습니다.");
  }

  function saveWord() {
    if (!reportRef.current) return;
    const html = standaloneDocument(reportRef.current, draft.title);
    downloadBlob(html, "application/msword;charset=utf-8", `${reportKind}-report-${localDateStamp()}.doc`);
    setStatus("현재 작업본을 Word 호환 문서로 저장했습니다.");
  }

  function printPdf() {
    setPreview(true);
    setStatus("인쇄 창에서 대상을 ‘PDF로 저장’으로 선택하세요.");
    window.setTimeout(() => window.print(), 0);
  }

  return (
    <>
      <nav className="report-authoring-tabs" aria-label="보고서 유형">
        {(Object.keys(REPORT_LABELS) as ReportKind[]).map((kind) => (
          <button type="button" key={kind} aria-pressed={reportKind === kind} onClick={() => { setReportKind(kind); setPreview(false); setDeleted(null); setStatus(`${REPORT_LABELS[kind]} 작업공간으로 전환했습니다.`); }}>
            {REPORT_LABELS[kind]}
          </button>
        ))}
      </nav>

      <div className="report-authoring-toolbar" data-report-control>
        <div>
          <strong>{REPORT_LABELS[reportKind]} 양식 자동 적용</strong>
          <span>IBM × Coinbase 인쇄형 규격 · 리포트별 독립 자동저장</span>
          <p aria-live="polite">{status}</p>
        </div>
        <div className="report-authoring-toolbar-actions">
          <button type="button" onClick={() => setPreview((value) => !value)}>{preview ? "편집으로" : "미리보기"}</button>
          <button type="button" onClick={resetTemplate}>양식 초기화</button>
          <button type="button" onClick={saveHtml}>HTML 저장</button>
          <button type="button" onClick={saveWord}>Word 저장</button>
          <button type="button" className="report-authoring-primary" onClick={printPdf}>PDF 저장</button>
        </div>
      </div>

      <div className={`report-authoring-workspace${preview ? " is-preview" : ""}`}>
        {!preview ? (
          <aside className="report-authoring-palette" data-report-control>
            <p>CONTENT BOX</p>
            <h2>박스 추가</h2>
            <button type="button" onClick={() => addBlock("text")}><strong>텍스트</strong><span>제목·본문·전망 메모</span></button>
            <button type="button" onClick={() => addBlock("image")}><strong>이미지</strong><span>로컬 파일·외부 URL</span></button>
            <button type="button" onClick={() => addBlock("table")}><strong>표</strong><span>직접 편집·CSV 붙여넣기</span></button>
          </aside>
        ) : null}

        <article ref={reportRef} className="report-authoring-paper" aria-label={`${REPORT_LABELS[reportKind]} 편집 문서`}>
          <header className="report-authoring-cover">
            <div>
              <p className="report-authoring-kicker">{draft.kicker}</p>
              {preview ? <h1>{draft.title}</h1> : <input className="report-authoring-cover-title" value={draft.title} onChange={(event) => updateDraft({ title: event.target.value })} aria-label="보고서 제목" />}
              {preview ? <p className="report-authoring-subtitle">{draft.subtitle}</p> : <textarea className="report-authoring-cover-subtitle" value={draft.subtitle} onChange={(event) => updateDraft({ subtitle: event.target.value })} aria-label="보고서 부제" rows={2} />}
              <p className="report-authoring-cover-meta">{localDateStamp()} · 채권전략팀 · LIVE REPORT WORKSPACE</p>
            </div>
            <aside>
              <span>TEMPLATE</span>
              <strong>{REPORT_LABELS[reportKind]}</strong>
              <small>GitHub bond-strategy-reports</small>
            </aside>
          </header>

          {draft.ranges ? (
            <section className="report-authoring-ranges">
              <p>WEEKLY RANGE</p>
              <div>
                {draft.ranges.map((range, index) => (
                  <label key={range.label}>
                    <span>{range.label}</span>
                    {preview ? <strong>{range.value} {range.unit}</strong> : <span className="report-authoring-range-input"><input value={range.value} onChange={(event) => updateDraft({ ranges: draft.ranges!.map((item, itemIndex) => itemIndex === index ? { ...item, value: event.target.value } : item) })} aria-label={`${range.label} 범위`} /><b>{range.unit}</b></span>}
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
                    <span>{block.type === "text" ? "텍스트" : block.type === "image" ? "이미지" : "표"}</span>
                    <button type="button" onClick={() => moveBlock(index, -1)} aria-label="위로 이동">↑</button>
                    <button type="button" onClick={() => moveBlock(index, 1)} aria-label="아래로 이동">↓</button>
                    <button type="button" onClick={() => removeBlock(index)}>삭제</button>
                  </div>
                ) : null}
                {block.type === "text" ? <TextBlockEditor block={block} preview={preview} onChange={(patch) => updateBlock(block.id, patch)} /> : null}
                {block.type === "image" ? <ImageBlockEditor block={block} preview={preview} onChange={(patch) => updateBlock(block.id, patch)} onStatus={setStatus} /> : null}
                {block.type === "table" ? <TableBlockEditor block={block} preview={preview} onChange={(patch) => updateBlock(block.id, patch)} onStatus={setStatus} /> : null}
              </section>
            ))}
          </div>
        </article>
      </div>

      {deleted ? <div className="report-authoring-undo" data-report-control><span>박스 삭제됨</span><button type="button" onClick={undoDelete}>되돌리기</button></div> : null}
    </>
  );
}
