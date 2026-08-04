import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * ECOS 항목명 색인 로더 — 서버 전용.
 *
 * 표 이름만으로 통계표를 고르면 도달 못 하는 계열이 있다. 국고채가 대표 사례로,
 * ECOS에서 표 이름은 "시장금리(일별)"이고 "국고채"는 **항목 이름에만** 있다.
 * 항목 상한을 얼마로 올려도 표가 후보에 못 오르면 도달률은 0이다.
 *
 * 색인은 `scripts/build-ecos-item-index.mjs`가 만드는 빌드 산출물이며
 * 저장소에 커밋한다(런타임 생성은 ECOS 3분 300회 한도를 반드시 넘긴다).
 *
 * ── 실패를 조용히 넘기지 않는다 (2026-08-05 검증 지적) ──────────
 * 색인이 없으면 검색이 **즉시 수정 전 상태로 회귀**한다("국고채 커브" 0건,
 * "국고채 10년" 1위가 조선총독부 국채). 그런데 종전에는 console.warn 한 줄이
 * 전부였고, 모듈 로드 시 1회 메모이제이션이라 첫 시도에 실패하면 그 인스턴스
 * 수명 내내 꺼진 채 돌았다. 그래서
 *  ① 실패는 캐시하지 않고 RETRY_AFTER_MS 뒤 다시 읽는다,
 *  ② 상태(status)를 노출해 검색 응답·헬스체크가 드러낸다,
 *  ③ builtAt을 기준일로 병기한다.
 */
export interface EcosItemIndex {
  /** 색인 생성 시점(ISO) — 화면·응답에 기준일로 병기한다 */
  builtAt: string;
  searchableTables: number;
  indexedTables: number;
  /** statCode → { n: 항목 수, s: 항목명을 정규화해 '|'로 이은 블롭 } */
  tables: Record<string, { n: number; s: string }>;
}

export interface EcosItemIndexStatus {
  available: boolean;
  /** 색인 파일 경로 (진단용) */
  path: string;
  builtAt?: string;
  indexedTables?: number;
  /** 사용 불가 사유 — 사람이 읽고 조치할 수 있는 문장 */
  reason?: string;
}

/** 실패 후 재시도까지 기다리는 시간(ms). 첫 실패로 영구히 꺼지지 않게 한다 */
const RETRY_AFTER_MS = 30_000;

/** 색인 없이 도는 상태를 알리는 문장 — 검색 응답·헬스체크·로그가 같은 문구를 쓴다 */
export const INDEX_MISSING_NOTE =
  "ECOS 항목명 색인을 읽지 못해 항목명 매칭이 꺼진 상태입니다 — 표 이름에만 의존하므로 " +
  '"국고채"처럼 항목 이름에만 있는 계열이 검색되지 않습니다. ' +
  "scripts/build-ecos-item-index.mjs로 색인을 생성하세요";

let cached: EcosItemIndex | null = null;
let lastFailureAt = 0;
let lastReason: string | undefined;

function indexPath(): string {
  // 경로를 바꿀 수 있게 둔다 — 색인 부재 상태를 재현·테스트하는 유일한 수단이다
  return (
    process.env.ECOS_ITEM_INDEX_PATH ?? path.join(process.cwd(), "data", "ecos-item-names.json")
  );
}

function fail(reason: string): null {
  lastReason = reason;
  lastFailureAt = Date.now();
  console.warn(`[search] ${INDEX_MISSING_NOTE} (${reason})`);
  return null;
}

export function ecosItemIndex(): EcosItemIndex | null {
  if (cached) return cached;
  // 실패는 캐시하지 않는다 — 다만 매 요청 재시도로 디스크를 때리지는 않는다
  if (lastFailureAt > 0 && Date.now() - lastFailureAt < RETRY_AFTER_MS) return null;

  const file = indexPath();
  try {
    if (!existsSync(file)) return fail(`색인 파일이 없습니다: ${file}`);
    const parsed = JSON.parse(readFileSync(file, "utf8")) as EcosItemIndex;
    if (!parsed?.tables || Object.keys(parsed.tables).length === 0) {
      return fail(`색인 파일에 tables가 비어 있습니다: ${file}`);
    }
    cached = parsed;
    lastReason = undefined;
    lastFailureAt = 0;
    return cached;
  } catch (err) {
    return fail(`색인 파일 읽기 실패: ${String(err)}`);
  }
}

/** 헬스체크·검색 응답이 쓰는 색인 상태 */
export function ecosItemIndexStatus(): EcosItemIndexStatus {
  const idx = ecosItemIndex();
  if (!idx) {
    return { available: false, path: indexPath(), reason: lastReason ?? INDEX_MISSING_NOTE };
  }
  return {
    available: true,
    path: indexPath(),
    builtAt: idx.builtAt,
    indexedTables: idx.indexedTables,
  };
}
