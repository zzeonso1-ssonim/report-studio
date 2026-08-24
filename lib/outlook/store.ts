import { dataPath, readJsonFile, writeJsonFile } from "@/lib/data-dir";
import { getSectorManifest, sectorManifest } from "./sector-manifest";
import { getBundledOutlookState } from "./seed";
import type { SectorId, SectorSnapshot, SectorSourceResult, SectorStatus } from "./types";

interface MutableSectorState {
  status: SectorStatus;
  probeName: string | null;
  lastObservedAt: string | null;
  lastRefreshedAt: string | null;
  sourceResults: SectorSourceResult[];
  error: string | null;
}

type OutlookGlobal = typeof globalThis & {
  __econCockpitOutlookState?: Map<SectorId, MutableSectorState>;
};

/** 서로 다른 주기의 관측일을 실제 기간 말 기준으로 비교한다. */
function observedSortKey(value: string): string {
  const quarter = /^(\d{4})-Q([1-4])$/.exec(value);
  if (quarter) {
    return `${quarter[1]}-${String(Number(quarter[2]) * 3).padStart(2, "0")}-31`;
  }
  if (/^\d{4}-\d{2}$/.test(value)) return `${value}-31`;
  if (/^\d{4}$/.test(value)) return `${value}-12-31`;
  return value;
}

const outlookGlobal = globalThis as OutlookGlobal;
const sectorState =
  outlookGlobal.__econCockpitOutlookState ?? new Map<SectorId, MutableSectorState>();
outlookGlobal.__econCockpitOutlookState = sectorState;

function initialState(id: SectorId): MutableSectorState {
  const manifest = getSectorManifest(id);
  return {
    status: manifest.probes.length ? "ready" : "pending_config",
    probeName: null,
    lastObservedAt: null,
    lastRefreshedAt: null,
    sourceResults: [],
    error: null,
  };
}

function stateFile(id: SectorId): string {
  return dataPath("outlook", `${id}.json`);
}

async function readState(id: SectorId): Promise<MutableSectorState> {
  // 매번 파일을 다시 읽어 공유 DATA_DIR을 쓰는 다중 인스턴스에서도 최신 상태를 본다.
  // 파일이 없는 새 서버리스 인스턴스에서는 검증 완료 배포 시드를 사용한다.
  // 현재 프로세스에서 갱신한 상태가 있으면 시드보다 우선한다.
  const fallback = sectorState.get(id) ?? getBundledOutlookState(id) ?? initialState(id);
  const stored = await readJsonFile<MutableSectorState>(stateFile(id), fallback);
  const normalized: MutableSectorState = {
    ...initialState(id),
    ...stored,
    sourceResults: Array.isArray(stored.sourceResults)
      ? stored.sourceResults.map((result) => ({
          ...result,
          points: Array.isArray(result.points) ? result.points : [],
        }))
      : [],
  };
  sectorState.set(id, normalized);
  return normalized;
}

async function persistState(id: SectorId, state: MutableSectorState): Promise<void> {
  sectorState.set(id, state);
  await writeJsonFile(stateFile(id), state, {
    pretty: true,
    warnKey: `outlook-${id}`,
  });
}

export async function getSectorSnapshot(id: SectorId): Promise<SectorSnapshot> {
  const manifest = getSectorManifest(id);
  const state = await readState(id);
  return {
    id,
    title: manifest.title,
    description: manifest.description,
    status: state.status,
    hasProbe: manifest.probes.length > 0,
    sourceLabel: manifest.probes.length
      ? [...new Set(manifest.probes.map((probe) => probe.sourceLabel))].join(" · ")
      : null,
    probeName: state.probeName,
    lastObservedAt: state.lastObservedAt,
    lastRefreshedAt: state.lastRefreshedAt,
    nextReleaseAt: null,
    sourceResults: state.sourceResults,
    error: state.error,
  };
}

export async function listSectorSnapshots(): Promise<SectorSnapshot[]> {
  return Promise.all(sectorManifest.map((sector) => getSectorSnapshot(sector.id)));
}

export async function beginSectorRefresh(id: SectorId): Promise<void> {
  const current = await readState(id);
  await persistState(id, { ...current, status: "refreshing", error: null });
}

export async function finishSectorRefresh(
  id: SectorId,
  result: { sourceResults: SectorSourceResult[] }
): Promise<SectorSnapshot> {
  const manifest = getSectorManifest(id);
  const current = await readState(id);
  const previousById = new Map(current.sourceResults.map((item) => [item.indicatorId, item]));
  // 공식 문서 형식 변경·일시 장애가 기존 정상 관측치를 지우지 않게 한다.
  const mergedResults = result.sourceResults.map((item) => {
    const previous = previousById.get(item.indicatorId);
    return item.status === "error" && previous?.points.length
      ? { ...item, points: previous.points, lastObservedAt: previous.lastObservedAt }
      : item;
  });
  const successes = mergedResults.filter((item) => item.status === "success");
  const failures = mergedResults.filter((item) => item.status === "error");
  const lastObservedAt = successes.reduce<string | null>(
    (latest, item) =>
      item.lastObservedAt &&
      (!latest || observedSortKey(item.lastObservedAt) > observedSortKey(latest))
        ? item.lastObservedAt
        : latest,
    null
  );
  await persistState(id, {
    status: failures.length
      ? successes.length
        ? "partial"
        : "error"
      : manifest.pendingIndicators
        ? "partial"
        : "success",
    probeName: successes.map((item) => item.probeName).join(" · ") || null,
    lastObservedAt,
    lastRefreshedAt: new Date().toISOString(),
    sourceResults: mergedResults,
    error: failures.map((item) => item.error).filter(Boolean).join(" / ") || null,
  });
  return getSectorSnapshot(id);
}
