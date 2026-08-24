"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { SectorId, SectorSnapshot } from "@/lib/outlook/types";
import GrowthDashboard from "../growth-dashboard";
import TradeDashboard from "../trade-dashboard";
import FiscalDashboard from "../fiscal-dashboard";
import InflationDashboard from "../inflation-dashboard";
import LaborDashboard from "../labor-dashboard";
import ConstructionDashboard from "../construction-dashboard";
import EquipmentDashboard from "../equipment-dashboard";
import DomesticLiquidityDashboard from "../domestic-liquidity-dashboard";

interface IndicatorMetadata { name: string; unit: string; origin: string }
type IndicatorMetadataMap = Record<string, IndicatorMetadata | null>;
type ContentBox = { id: string; title: string; body: string };
type ModuleDraft = { headline: string; lead: string; interpretation: string; boxes: ContentBox[] };
type ReportDraft = {
  title: string;
  subtitle: string;
  executive: string;
  moduleOrder: SectorId[];
  selectedSectorIds: SectorId[];
  hiddenModules: SectorId[];
  modules: Partial<Record<SectorId, ModuleDraft>>;
};

const DRAFT_STORAGE_KEY = "econ-cockpit:outlook-report-draft:v3";

function localDateStamp() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function observedPoints(result: SectorSnapshot["sourceResults"][number]) {
  return result.points
    .filter((point): point is typeof point & { value: number } => point.value != null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function formatValue(value: number, unit = "") {
  return `${new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 }).format(value)}${unit}`;
}

function resultSignal(result: SectorSnapshot["sourceResults"][number], metadata: IndicatorMetadata | null | undefined) {
  const points = observedPoints(result);
  const latest = points.at(-1);
  if (!latest) return `${metadata?.name ?? result.probeName} 유효 관측값 미연결`;
  const previous = points.at(-2);
  const name = result.probeName;
  const transformedPercent = /전년|전월|전기|증가율|증감률|상승률|비중|비율|진도율|디플레이터/.test(name);
  const unit = transformedPercent ? "%" : metadata?.unit;
  const latestText = `${name} ${latest.date} ${formatValue(latest.value, unit)}`;
  if (!previous) return `${latestText} 확인`;
  const delta = latest.value - previous.value;
  const direction = delta > 0 ? "상승" : delta < 0 ? "하락" : "보합";
  const deltaUnit = unit === "%" ? "%p" : unit;
  return `${latestText}, 직전 관측 대비 ${delta > 0 ? "+" : ""}${formatValue(delta, deltaUnit)} ${direction}`;
}

function resultHeadline(result: SectorSnapshot["sourceResults"][number], metadata: IndicatorMetadata | null | undefined) {
  const points = observedPoints(result);
  const latest = points.at(-1);
  const previous = points.at(-2);
  const name = metadata?.name ?? result.probeName;
  if (!latest) return `${name} 공식 관측값 연결 대기`;
  if (!previous) return `${name} 최신 공식 관측값 확인`;
  const delta = latest.value - previous.value;
  return `${name}, 직전 관측 대비 ${delta > 0 ? "상승" : delta < 0 ? "하락" : "보합"}`;
}

function selectionExecutive(
  selectedIds: SectorId[],
  sectors: SectorSnapshot[],
  modules: ReportDraft["modules"]
) {
  const selected = selectedIds.flatMap((id) => {
    const sector = sectors.find((item) => item.id === id);
    const moduleDraft = modules[id];
    return sector && moduleDraft ? [`${sector.title}: ${moduleDraft.lead}`] : [];
  });
  return selected.length
    ? `${selected.join(" · ")}. 원인·전망 판단은 편집자 검토 필요`
    : "보고서에 포함할 섹터 선택 필요";
}

function createInitialDraft(sectors: SectorSnapshot[], metadata: IndicatorMetadataMap, initialSectorIds: SectorId[]): ReportDraft {
  const modules: ReportDraft["modules"] = {};
  for (const sector of sectors) {
    const available = sector.sourceResults.filter((result) => observedPoints(result).length > 0);
    const signals = available.slice(0, 2).map((result) => resultSignal(result, metadata[result.indicatorId]));
    modules[sector.id] = {
      headline: available[0]
        ? resultHeadline(available[0], metadata[available[0].indicatorId])
        : `${sector.title} 공식 계열 연결 대기`,
      lead: available.length
        ? `${sector.title} 공식 계열 ${available.length}개 연결, 최종 관측일 ${sector.lastObservedAt ?? "미확인"}`
        : `${sector.title} 공식 계열 연결 대기, 임의 수치 미기입`,
      interpretation: signals.length
        ? `${signals.join(". ")}. 다음 공식 공표에서 최근 방향의 지속 여부 확인 필요`
        : "유효 관측값 연결 후 방향 판단 가능",
      boxes: [],
    };
  }
  const selectedSectorIds = initialSectorIds.length ? initialSectorIds : sectors[0] ? [sectors[0].id] : [];
  return {
    title: "한국 경제전망",
    subtitle: "공식 통계 기반 섹터 점검과 전망 판단",
    executive: selectionExecutive(selectedSectorIds, sectors, modules),
    moduleOrder: sectors.map((sector) => sector.id),
    selectedSectorIds,
    hiddenModules: [],
    modules,
  };
}

function EditableText({ as = "p", value, editing, className, onChange }: {
  as?: "h1" | "h2" | "p";
  value: string;
  editing: boolean;
  className?: string;
  onChange: (value: string) => void;
}) {
  const Tag = as;
  return <Tag className={className} contentEditable={editing} suppressContentEditableWarning data-report-editable="true" onBlur={(event) => onChange(event.currentTarget.textContent?.trim() ?? "")}>{value}</Tag>;
}

function SectorDashboard({ sector }: { sector: SectorSnapshot }) {
  switch (sector.id) {
    case "growth": return <GrowthDashboard snapshot={sector} />;
    case "trade": return <TradeDashboard snapshot={sector} />;
    case "fiscal": return <FiscalDashboard snapshot={sector} />;
    case "inflation": return <InflationDashboard snapshot={sector} />;
    case "labor": return <LaborDashboard snapshot={sector} />;
    case "equipment-investment": return <EquipmentDashboard snapshot={sector} />;
    case "construction-investment": return <ConstructionDashboard snapshot={sector} />;
    case "domestic-liquidity": return <DomesticLiquidityDashboard snapshot={sector} />;
    default: return null;
  }
}

function collectDocumentStyles() {
  return [...document.styleSheets].map((sheet) => {
    try { return [...sheet.cssRules].map((rule) => rule.cssText).join("\n"); }
    catch { return ""; }
  }).join("\n");
}

function standaloneHtml(report: HTMLElement, title: string) {
  const clone = report.cloneNode(true) as HTMLElement;
  clone.contentEditable = "true";
  clone.querySelectorAll(".outlook-chart-actions, .outlook-chart-table-wrap").forEach((node) => node.remove());
  clone.querySelectorAll<HTMLElement>(".outlook-report-module-tools, .outlook-report-box-delete").forEach((node) => { node.contentEditable = "false"; });
  const safeTitle = title.replace(/[<>&"]/g, "");
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeTitle}</title><style>${collectDocumentStyles()}</style></head><body><div class="standalone-report-toolbar" data-report-control><button type="button" id="standaloneEdit">편집 완료</button><button type="button" onclick="window.print()">PDF 저장</button></div>${clone.outerHTML}<div class="outlook-report-undo" id="standaloneUndo" data-report-control hidden><span>항목 삭제됨</span><button type="button">되돌리기</button></div><script>(()=>{const report=document.querySelector('.outlook-report-paper');const undo=document.getElementById('standaloneUndo');let editing=true;let removed=null;const setEditing=(next)=>{editing=next;report.contentEditable=String(next);document.getElementById('standaloneEdit').textContent=next?'편집 완료':'전체 항목 편집';};const createBox=()=>{const box=document.createElement('section');box.className='outlook-report-custom-box';box.dataset.customBox='';box.innerHTML='<button type="button" class="outlook-report-box-delete" data-box-action="delete" data-report-control contenteditable="false">삭제</button><h2>새 분석 제목</h2><p>분석 내용 입력</p>';return box;};document.getElementById('standaloneEdit').addEventListener('click',()=>setEditing(!editing));report.addEventListener('click',(event)=>{const boxButton=event.target.closest('[data-box-action]');if(boxButton){const box=boxButton.closest('[data-custom-box]');removed={node:box,next:box.nextElementSibling,parent:box.parentElement};box.remove();undo.hidden=false;return;}const button=event.target.closest('[data-action]');if(!button)return;const module=button.closest('.outlook-report-module');if(button.dataset.action==='add-box'){module.querySelector('.outlook-report-custom-box-list').append(createBox());return;}if(button.dataset.action==='up'&&module.previousElementSibling)module.parentElement.insertBefore(module,module.previousElementSibling);if(button.dataset.action==='down'&&module.nextElementSibling)module.parentElement.insertBefore(module.nextElementSibling,module);if(button.dataset.action==='delete'){removed={node:module,next:module.nextElementSibling,parent:module.parentElement};module.remove();undo.hidden=false;}});undo.querySelector('button').addEventListener('click',()=>{if(!removed)return;removed.parent.insertBefore(removed.node,removed.next);removed=null;undo.hidden=true;});setEditing(true);})();</script></body></html>`;
}

function downloadText(contents: string, filename: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: "text/html;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export default function OutlookReportWorkspace({ sectors, indicatorMetadata, initialSectorIds }: { sectors: SectorSnapshot[]; indicatorMetadata: IndicatorMetadataMap; initialSectorIds: SectorId[] }) {
  const boxIdPrefix = useId();
  const boxCounterRef = useRef(0);
  const initialSelectionKey = initialSectorIds.join(",");
  const initialDraft = useMemo(
    () => createInitialDraft(sectors, indicatorMetadata, initialSelectionKey ? initialSelectionKey.split(",") as SectorId[] : []),
    [sectors, indicatorMetadata, initialSelectionKey]
  );
  const [draft, setDraft] = useState(initialDraft);
  const [editing, setEditing] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [deleted, setDeleted] = useState<SectorId | null>(null);
  const [deletedBox, setDeletedBox] = useState<{ sectorId: SectorId; box: ContentBox; index: number } | null>(null);
  const [status, setStatus] = useState("Cockpit 저장 데이터에서 초안을 자동 구성했습니다.");
  const reportRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const saved = window.localStorage.getItem(DRAFT_STORAGE_KEY);
      if (saved) {
        try {
          const savedDraft = JSON.parse(saved) as ReportDraft;
          const requestedIds = initialSelectionKey ? initialSelectionKey.split(",") as SectorId[] : [];
          if (requestedIds.length) {
            savedDraft.selectedSectorIds = requestedIds;
            savedDraft.hiddenModules = savedDraft.hiddenModules.filter((id) => !requestedIds.includes(id));
            savedDraft.executive = selectionExecutive(requestedIds, sectors, savedDraft.modules);
          }
          for (const sector of sectors) {
            const savedModule = savedDraft.modules[sector.id];
            if (savedModule && !savedModule.headline) {
              savedModule.headline = initialDraft.modules[sector.id]?.headline ?? sector.title;
            }
            if (savedModule && !Array.isArray(savedModule.boxes)) savedModule.boxes = [];
          }
          setDraft(savedDraft);
          setStatus("이 브라우저에 저장된 편집본을 불러왔습니다.");
        }
        catch { setStatus("저장본을 읽지 못해 최신 데이터 초안을 사용합니다."); }
      }
      setHydrated(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [initialDraft.modules, initialSelectionKey, sectors]);
  useEffect(() => { if (hydrated) window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft)); }, [draft, hydrated]);
  useEffect(() => {
    let printTimer: number | undefined;
    const resizeChartsForPrint = () => {
      window.dispatchEvent(new Event("resize"));
      printTimer = window.setTimeout(() => window.dispatchEvent(new Event("resize")), 120);
    };
    window.addEventListener("beforeprint", resizeChartsForPrint);
    return () => {
      window.removeEventListener("beforeprint", resizeChartsForPrint);
      if (printTimer) window.clearTimeout(printTimer);
    };
  }, []);

  const visibleSectors = draft.moduleOrder.filter((id) => draft.selectedSectorIds.includes(id) && !draft.hiddenModules.includes(id))
    .map((id) => sectors.find((sector) => sector.id === id)).filter((sector): sector is SectorSnapshot => Boolean(sector));
  const sourceCount = visibleSectors.reduce((sum, sector) => sum + sector.sourceResults.filter((result) => observedPoints(result).length > 0).length, 0);
  const latestDate = visibleSectors.reduce<string | null>((latest, sector) => !sector.lastObservedAt || (latest && latest >= sector.lastObservedAt) ? latest : sector.lastObservedAt, null);

  const updateDraft = (patch: Partial<ReportDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const updateModule = (id: SectorId, patch: Partial<ModuleDraft>) => setDraft((current) => ({ ...current, modules: { ...current.modules, [id]: { ...current.modules[id]!, ...patch } } }));
  function addBox(id: SectorId) {
    boxCounterRef.current += 1;
    const box: ContentBox = { id: `${boxIdPrefix}-box-${boxCounterRef.current}`, title: "새 분석 제목", body: "분석 내용 입력" };
    setDraft((current) => {
      const currentModule = current.modules[id]!;
      return { ...current, modules: { ...current.modules, [id]: { ...currentModule, boxes: [...currentModule.boxes, box] } } };
    });
    setDeleted(null);
    setDeletedBox(null);
    setStatus("편집 박스를 추가했습니다.");
  }
  function updateBox(sectorId: SectorId, boxId: string, patch: Partial<ContentBox>) {
    setDraft((current) => {
      const currentModule = current.modules[sectorId]!;
      return { ...current, modules: { ...current.modules, [sectorId]: { ...currentModule, boxes: currentModule.boxes.map((box) => box.id === boxId ? { ...box, ...patch } : box) } } };
    });
  }
  function removeBox(sectorId: SectorId, boxId: string) {
    const currentModule = draft.modules[sectorId];
    const index = currentModule?.boxes.findIndex((box) => box.id === boxId) ?? -1;
    if (!currentModule || index < 0) return;
    setDeleted(null);
    setDeletedBox({ sectorId, box: currentModule.boxes[index], index });
    setDraft((current) => ({ ...current, modules: { ...current.modules, [sectorId]: { ...current.modules[sectorId]!, boxes: current.modules[sectorId]!.boxes.filter((box) => box.id !== boxId) } } }));
    setStatus("편집 박스를 삭제했습니다.");
  }
  function moveModule(id: SectorId, direction: -1 | 1) {
    setDraft((current) => {
      const order = [...current.moduleOrder]; const from = order.indexOf(id); const to = from + direction;
      if (from < 0 || to < 0 || to >= order.length) return current;
      [order[from], order[to]] = [order[to], order[from]]; return { ...current, moduleOrder: order };
    });
  }
  function removeModule(id: SectorId) {
    setDraft((current) => ({ ...current, hiddenModules: [...current.hiddenModules, id] }));
    setDeletedBox(null);
    setDeleted(id); setStatus("섹터 모듈을 보고서에서 제외했습니다. 데이터 원본은 변경되지 않았습니다.");
  }
  function toggleSector(id: SectorId) {
    const isSelected = draft.selectedSectorIds.includes(id);
    if (isSelected && draft.selectedSectorIds.length === 1) {
      setStatus("보고서에는 최소 1개 섹터가 필요합니다.");
      return;
    }
    const selectedSectorIds = isSelected
      ? draft.selectedSectorIds.filter((selectedId) => selectedId !== id)
      : draft.moduleOrder.filter((sectorId) => draft.selectedSectorIds.includes(sectorId) || sectorId === id);
    const modules = { ...draft.modules, [id]: draft.modules[id] ?? initialDraft.modules[id] };
    setDraft((current) => ({
      ...current,
      selectedSectorIds,
      hiddenModules: current.hiddenModules.filter((hiddenId) => hiddenId !== id),
      executive: selectionExecutive(selectedSectorIds, sectors, modules),
      modules,
    }));
    window.history.replaceState(null, "", `/outlook/report?sectors=${selectedSectorIds.join(",")}`);
    setStatus(`${selectedSectorIds.length}개 섹터로 보고서를 다시 구성했습니다.`);
    setDeleted(null);
  }
  function resetDraft() {
    if (!window.confirm("편집본을 지우고 현재 Cockpit 데이터로 초안을 다시 만들까요?")) return;
    setDraft(initialDraft); setDeleted(null); setDeletedBox(null); setStatus("현재 Cockpit 데이터로 초안을 다시 만들었습니다.");
  }
  function saveHtml() {
    if (!reportRef.current) return;
    downloadText(standaloneHtml(reportRef.current, draft.title), `econ-outlook-${localDateStamp()}.html`);
    setStatus("차트와 편집문을 포함한 HTML을 저장했습니다.");
  }

  return <>
    <div className="outlook-report-toolbar" role="toolbar" aria-label="보고서 편집과 저장 도구" data-report-control>
      <div className="outlook-report-toolbar-copy"><strong>LIVE REPORT WORKSPACE</strong><span>복수 섹터 선택 · 보고서의 모든 텍스트 직접 편집 가능</span><p aria-live="polite">{status}</p></div>
      <div className="outlook-report-toolbar-actions">
        <button type="button" onClick={() => setEditing((value) => !value)}>{editing ? "편집 완료" : "전체 항목 편집"}</button>
        <button type="button" onClick={resetDraft}>데이터로 재작성</button>
        <button type="button" onClick={saveHtml}>HTML 저장</button>
        <button type="button" className="outlook-report-primary-action" onClick={() => { setStatus("인쇄 창에서 대상을 ‘PDF로 저장’으로 선택하세요."); window.print(); }}>PDF 저장</button>
      </div>
      <div className="outlook-report-sector-picker" aria-label="보고서 섹터 다중 선택">
        <span>REPORT SECTORS · MULTI SELECT</span>
        {sectors.map((sector) => (
          <button
            type="button"
            key={sector.id}
            aria-pressed={draft.selectedSectorIds.includes(sector.id)}
            onClick={() => toggleSector(sector.id)}
          >
            {sector.title}
          </button>
        ))}
      </div>
    </div>

    <article
      ref={reportRef}
      className={`outlook-report-paper${editing ? " is-editing" : ""}`}
      aria-label="경제전망 보고서"
      contentEditable={editing}
      suppressContentEditableWarning
    >
      <header className="outlook-report-cover">
        <div className="outlook-report-cover-main"><p className="outlook-report-kicker">ECONOMIC OUTLOOK / {localDateStamp()}</p><EditableText as="h1" value={draft.title} editing={editing} onChange={(title) => updateDraft({ title })} /><EditableText value={draft.subtitle} editing={editing} className="outlook-report-subtitle" onChange={(subtitle) => updateDraft({ subtitle })} /><p className="outlook-report-statusline">AI 데이터 초안 · 편집자 검토 대기</p></div>
        <aside className="outlook-report-cover-rail"><p>DATA COVERAGE</p><dl><div><dt>선택 섹터</dt><dd>{visibleSectors.length}</dd></div><div><dt>공식 계열</dt><dd>{sourceCount}</dd></div><div><dt>최종 관측</dt><dd>{latestDate ?? "—"}</dd></div></dl></aside>
      </header>

      <section className="outlook-report-summary">
        <div>
          <div className="outlook-report-section-label">EXECUTIVE SUMMARY</div>
          <h2>데이터 기반 핵심 판단 초안</h2>
          <EditableText value={draft.executive} editing={editing} onChange={(executive) => updateDraft({ executive })} />
          <p className="outlook-report-method">관측된 공식 수치만 반영 · 결측 추정 및 인과관계 자동 생성 없음</p>
        </div>
        <aside className="outlook-report-summary-rail">
          <span>BASE VIEW</span>
          <strong>{visibleSectors.length}개 섹터</strong>
          <small>공식 계열 {sourceCount}개 · 기준 {latestDate ?? "—"}</small>
        </aside>
      </section>

      <div className="outlook-report-content">
      {visibleSectors.map((sector, index) => {
        const moduleDraft = draft.modules[sector.id] ?? { headline: sector.title, lead: "", interpretation: "", boxes: [] };
        return <section className="outlook-report-module" key={sector.id} data-sector={sector.id}>
          <div className="outlook-report-module-tools" data-report-control contentEditable={false}><button type="button" data-action="add-box" aria-label={`${sector.title} 박스 추가`} onClick={() => addBox(sector.id)}>+ 박스</button><button type="button" data-action="up" aria-label={`${sector.title} 위로 이동`} onClick={() => moveModule(sector.id, -1)}>↑</button><button type="button" data-action="down" aria-label={`${sector.title} 아래로 이동`} onClick={() => moveModule(sector.id, 1)}>↓</button><button type="button" data-action="delete" aria-label={`${sector.title} 삭제`} onClick={() => removeModule(sector.id)}>삭제</button></div>
          <header className="outlook-report-module-header"><p className="outlook-report-kicker">{String(index + 1).padStart(2, "0")} · {sector.title}</p><EditableText as="h2" value={moduleDraft.headline} editing={editing} onChange={(headline) => updateModule(sector.id, { headline })} /><EditableText value={moduleDraft.lead} editing={editing} className="outlook-report-module-lead" onChange={(lead) => updateModule(sector.id, { lead })} /></header>
          <div className="outlook-report-draft-note"><strong>DATA DRAFT</strong><EditableText value={moduleDraft.interpretation} editing={editing} onChange={(interpretation) => updateModule(sector.id, { interpretation })} /></div>
          <div className="outlook-report-custom-box-list">
            {moduleDraft.boxes.map((box) => <section className="outlook-report-custom-box" data-custom-box key={box.id}>
              <button type="button" className="outlook-report-box-delete" data-box-action="delete" data-report-control contentEditable={false} aria-label={`${box.title} 박스 삭제`} onClick={() => removeBox(sector.id, box.id)}>삭제</button>
              <EditableText as="h2" value={box.title} editing={editing} onChange={(title) => updateBox(sector.id, box.id, { title })} />
              <EditableText value={box.body} editing={editing} onChange={(body) => updateBox(sector.id, box.id, { body })} />
            </section>)}
          </div>
          <div className="outlook-report-live-charts"><SectorDashboard sector={sector} /></div>
        </section>;
      })}

      <section className="outlook-report-closing"><p className="outlook-report-kicker">EDITOR&apos;S OUTLOOK</p><h2>전망과 리스크 판단</h2><p data-report-editable="true" contentEditable={editing} suppressContentEditableWarning>자동 초안에서 확인된 방향을 바탕으로 기본 전망, 상방·하방 리스크, 다음 판정 기한 작성 필요</p></section>
      </div>
    </article>

    {deleted ? <div className="outlook-report-undo" data-report-control><span>섹터 모듈 제외됨</span><button type="button" onClick={() => { setDraft((current) => ({ ...current, hiddenModules: current.hiddenModules.filter((id) => id !== deleted) })); setDeleted(null); setStatus("삭제한 섹터 모듈을 복원했습니다."); }}>되돌리기</button></div> : null}
    {deletedBox ? <div className="outlook-report-undo" data-report-control><span>편집 박스 삭제됨</span><button type="button" onClick={() => { const removed = deletedBox; setDraft((current) => { const currentModule = current.modules[removed.sectorId]!; const boxes = [...currentModule.boxes]; boxes.splice(removed.index, 0, removed.box); return { ...current, modules: { ...current.modules, [removed.sectorId]: { ...currentModule, boxes } } }; }); setDeletedBox(null); setStatus("삭제한 편집 박스를 복원했습니다."); }}>되돌리기</button></div> : null}
  </>;
}
