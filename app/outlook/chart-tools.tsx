"use client";

import { createContext, useContext, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ReferenceDot } from "recharts";

export type ChartRow = Record<string, string | number>;

export interface ChartSeriesColumn {
  key: string;
  label: string;
  color?: string;
  yAxisId?: string;
  unit?: string;
}

interface LatestSeriesValue extends ChartSeriesColumn {
  date: string;
  value: number;
}

export interface ReportChartControls {
  hiddenChartIds: string[];
  addBox: () => void;
  removeChart: (chartId: string, title: string) => void;
}

export const ReportChartContext = createContext<ReportChartControls | null>(null);

function formatChartValue(value: number, unit = "") {
  return `${new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 }).format(value)}${unit}`;
}

function buildChartInsight(rows: ChartRow[], series: ChartSeriesColumn[]) {
  const signals = series.flatMap((item) => {
    const observed = rows
      .filter((row) => typeof row[item.key] === "number")
      .map((row) => ({ date: String(row.date), value: row[item.key] as number }));
    const latest = observed.at(-1);
    if (!latest) return [];
    const previous = observed.at(-2);
    if (!previous) {
      return [`${item.label} ${latest.date} ${formatChartValue(latest.value, item.unit)}`];
    }
    const delta = latest.value - previous.value;
    const direction = delta > 0 ? "상승" : delta < 0 ? "하락" : "보합";
    const deltaUnit = item.unit === "%" ? "%p" : item.unit ?? "";
    return [
      `${item.label} ${latest.date} ${formatChartValue(latest.value, item.unit)}, 직전 관측 대비 ${delta > 0 ? "+" : ""}${formatChartValue(delta, deltaUnit)} ${direction}`,
    ];
  });
  if (signals.length === 0) return null;
  return {
    signal: signals.join(" · "),
    implication: "직전 관측 대비 변화 확인, 전망 방향 반영 전 추가 공표 검증 필요",
    watch: "다음 공식 공표에서 최근 방향의 지속 여부 확인",
  };
}

function latestSeriesValues(rows: ChartRow[], series: ChartSeriesColumn[]): LatestSeriesValue[] {
  return series.flatMap((item) => {
    const latest = [...rows].reverse().find((row) => typeof row[item.key] === "number");
    return latest
      ? [{ ...item, date: String(latest.date), value: latest[item.key] as number }]
      : [];
  });
}

async function chartToPng(
  container: HTMLElement,
  title: string,
  series: ChartSeriesColumn[],
  latestValues: LatestSeriesValue[]
): Promise<Blob> {
  const svg =
    container.querySelector<SVGSVGElement>(".recharts-wrapper > svg") ??
    container.querySelector<SVGSVGElement>("svg");
  if (!svg) throw new Error("차트 SVG를 찾을 수 없습니다.");

  const rect = svg.getBoundingClientRect();
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const sourceElements: SVGElement[] = [svg, ...svg.querySelectorAll<SVGElement>("*")];
  const clonedElements: SVGElement[] = [clone, ...clone.querySelectorAll<SVGElement>("*")];
  sourceElements.forEach((source, index) => {
    const style = getComputedStyle(source);
    const target = clonedElements[index];
    target.setAttribute("stroke", style.stroke);
    target.setAttribute("fill", style.fill);
    target.setAttribute("fill-opacity", style.fillOpacity);
    target.setAttribute("stroke-opacity", style.strokeOpacity);
    if (source.tagName === "text" || source.tagName === "tspan") {
      target.setAttribute("font-family", style.fontFamily);
      target.setAttribute("font-size", style.fontSize);
      target.setAttribute("font-weight", style.fontWeight);
    }
    target.removeAttribute("class");
  });
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(rect.width));
  clone.setAttribute("height", String(rect.height));

  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("차트 이미지를 불러오지 못했습니다."));
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
      new XMLSerializer().serializeToString(clone)
    )}`;
  });

  const scale = 2;
  const canvas = document.createElement("canvas");
  const headerHeight = 34;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("PNG 변환을 시작할 수 없습니다.");
  context.font = "11px system-ui, sans-serif";
  const legendRows: { item: ChartSeriesColumn; x: number; row: number }[] = [];
  let legendX = 10;
  let legendRow = 0;
  for (const item of series) {
    const latest = latestValues.find((value) => value.key === item.key);
    const label = latest
      ? `${item.label} ${latest.date} ${formatChartValue(latest.value, item.unit)}`
      : `${item.label}${item.unit ? ` (${item.unit})` : ""}`;
    const width = context.measureText(label).width + 24;
    if (legendX > 10 && legendX + width > rect.width - 10) {
      legendX = 10;
      legendRow += 1;
    }
    legendRows.push({ item, x: legendX, row: legendRow });
    legendX += width;
  }
  const footerHeight = (legendRow + 1) * 18 + 12;
  canvas.width = Math.round(rect.width * scale);
  canvas.height = Math.round((rect.height + headerHeight + footerHeight) * scale);
  context.scale(scale, scale);
  const containerStyle = getComputedStyle(container);
  const surface = containerStyle.getPropertyValue("--surface").trim() || "#fff";
  const foreground = containerStyle.getPropertyValue("--foreground").trim() || "#111";
  context.fillStyle = surface;
  context.fillRect(0, 0, rect.width, rect.height + headerHeight + footerHeight);
  context.fillStyle = foreground;
  context.font = "700 14px system-ui, sans-serif";
  context.textBaseline = "middle";
  context.fillText(title, 10, headerHeight / 2);
  context.drawImage(image, 0, headerHeight, rect.width, rect.height);
  context.font = "11px system-ui, sans-serif";
  for (const { item, x, row } of legendRows) {
    const colorVariable = item.color?.match(/^var\((--[^)]+)\)$/)?.[1];
    const color = colorVariable
      ? containerStyle.getPropertyValue(colorVariable).trim()
      : item.color;
    const y = headerHeight + rect.height + 14 + row * 18;
    context.fillStyle = color || foreground;
    context.fillRect(x, y - 4, 9, 9);
    context.fillStyle = foreground;
    const latest = latestValues.find((value) => value.key === item.key);
    context.fillText(
      latest
        ? `${item.label} ${latest.date} ${formatChartValue(latest.value, item.unit)}`
        : `${item.label}${item.unit ? ` (${item.unit})` : ""}`,
      x + 14,
      y
    );
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("PNG 변환에 실패했습니다.");
  return blob;
}

function safeFileName(value: string) {
  return value.trim().replace(/[^0-9A-Za-z가-힣_-]+/g, "-").replace(/^-|-$/g, "");
}

export function ChartFrame({
  title,
  chartId,
  rows,
  series,
  children,
  canvasClassName = "",
}: {
  title: string;
  chartId: string;
  rows: ChartRow[];
  series: ChartSeriesColumn[];
  children: ReactNode;
  canvasClassName?: string;
}) {
  const chartRef = useRef<HTMLDivElement>(null);
  const reportControls = useContext(ReportChartContext);
  const [showTable, setShowTable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const insight = buildChartInsight(rows, series);
  const latestValues = latestSeriesValues(rows, series);

  if (reportControls?.hiddenChartIds.includes(chartId)) {
    return <span className="outlook-report-chart-hidden-marker" data-hidden-chart={chartId} hidden />;
  }

  async function download() {
    if (!chartRef.current) return;
    try {
      setError(null);
      const blob = await chartToPng(chartRef.current, title, series, latestValues);
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = `${safeFileName(chartId || title)}.png`;
      anchor.style.display = "none";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(href), 1_000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "PNG 다운로드에 실패했습니다.");
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      void download();
    }
  }

  return (
    <>
      {reportControls ? (
        <div className="outlook-report-item-tools" data-report-control contentEditable={false}>
          <button type="button" data-report-item-action="add" aria-label={`${title} 뒤에 박스 추가`} onClick={reportControls.addBox}>+ 박스</button>
          <button
            type="button"
            data-report-item-action="delete"
            aria-label={`${title} 차트 삭제`}
            onClick={(event) => {
              event.stopPropagation();
              reportControls.removeChart(chartId, title);
            }}
          >삭제</button>
        </div>
      ) : null}
      <div
        ref={chartRef}
        className={`outlook-growth-chart-canvas outlook-chart-download-target ${canvasClassName}`.trim()}
        role="button"
        tabIndex={0}
        aria-label={`${title} 차트를 PNG로 다운로드`}
        title="클릭하면 PNG로 다운로드합니다."
        onClick={() => void download()}
        onKeyDown={handleKeyDown}
      >
        {children}
      </div>
      <div className="outlook-chart-latest-values" aria-label={`${title} 최신 관측값`}>
        {latestValues.map((item) => (
          <div key={item.key}>
            <span className="outlook-chart-latest-swatch" style={{ background: item.color }} aria-hidden="true" />
            <span className="outlook-chart-latest-label">{item.label}</span>
            <strong>{formatChartValue(item.value, item.unit)}</strong>
            <time>{item.date}</time>
          </div>
        ))}
      </div>
      <div className="outlook-chart-actions">
        <button type="button" onClick={() => void download()}>PNG 다운로드</button>
        <button
          type="button"
          aria-expanded={showTable}
          onClick={() => setShowTable((value) => !value)}
        >
          데이터 표 {showTable ? "닫기" : "보기"}
        </button>
      </div>
      {insight ? (
        <div className="outlook-chart-insight">
          <strong>INSIGHT</strong>
          <p><b>신호</b> {insight.signal}. <b>판단</b> 전망 반영은 {insight.watch}</p>
        </div>
      ) : null}
      {error ? <p className="outlook-error" role="alert">⚠ {error}</p> : null}
      {showTable ? (
        <div className="outlook-chart-table-wrap">
          <table className="outlook-chart-table">
            <caption>{title} 원자료</caption>
            <thead><tr><th scope="col">관측시점</th>{series.map((item) => <th key={item.key} scope="col">{item.label}{item.unit ? ` (${item.unit})` : ""}</th>)}</tr></thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={`${String(row.date)}-${index}`}>
                  <th scope="row">{row.date}</th>
                  {series.map((item) => <td key={item.key}>{typeof row[item.key] === "number" ? new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 }).format(row[item.key] as number) : "—"}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}

export function LatestValueLabels({
  rows,
  series,
}: {
  rows: ChartRow[];
  series: ChartSeriesColumn[];
}) {
  return series.map((item) => {
    const latest = [...rows].reverse().find((row) => typeof row[item.key] === "number");
    if (!latest) return null;
    const value = latest[item.key] as number;
    const formatted = `${new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 }).format(value)}${item.unit ?? ""}`;
    return (
      <ReferenceDot
        key={item.key}
        x={String(latest.date)}
        y={value}
        yAxisId={item.yAxisId}
        r={3.5}
        fill={item.color ?? "var(--foreground)"}
        stroke="var(--surface)"
        strokeWidth={1.5}
        aria-label={`${item.label} 최신값 ${formatted}`}
      />
    );
  });
}
