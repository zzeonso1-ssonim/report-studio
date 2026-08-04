import { Cycle } from "./indicators";
import { SourceId } from "./sources/types";
import {
  ECOS_COMBOS_PER_TABLE,
  ECOS_GROUP_ITEM_CAPS,
  ECOS_TABLE_FANOUT,
  FRED_SKIP_NOTE,
  KOSIS_COMBOS_PER_TABLE,
  KOSIS_ITEM_CAP,
  KOSIS_OBJ_CAPS,
  KOSIS_TABLE_FANOUT,
  KOSIS_TABLE_SEARCH_COUNT,
  PER_SOURCE_CAP,
  SOURCE_TIMEOUT_MS,
  TABLE_ITEMS_PER_GROUP,
  fredSearchQuery,
  fredTranslatedNote,
  queryTokens,
  timeoutNote,
} from "./search-config";
import { planSourceQueries, rankByRelevance } from "./search-llm";
import { SearchOutcome, SearchResult } from "./search-types";

/**
 * 전체 통계 카탈로그 검색 — ECOS·KOSIS·FRED.
 * 결과의 params는 각 소스 어댑터(fetchSeries)에 그대로 넘길 수 있는 형태다.
 * 서버 전용 (API 키 사용) — 클라이언트에서 import 금지.
 *
 * 3단 구성:
 *  ① 분해  — 질의를 소스별 검색어로 나눈다 (LLM, 실패 시 원문 그대로)
 *  ② 확장  — 소스별로 표를 찾아 세부 항목까지 펼친다 (질의 관련도 순 정렬 + 표당 균등 배분)
 *  ③ 선별  — 후보를 질의 관련도 순으로 재정렬한다 (LLM, 실패 시 ②의 순서 유지)
 */
export type { SearchOutcome, SearchResult } from "./search-types";

/** 제한시간을 넘긴 소스를 식별하는 표식 (거부 사유로 던진다) */
const TIMED_OUT = Symbol("search-source-timeout");

/**
 * 소스 하나에 제한시간을 건다.
 *
 * fetch에 AbortSignal을 넘기지 않고 결과만 버리는 이유: Next의 데이터 캐시
 * (`next: { revalidate }`)는 abort된 요청을 적재하지 않아, 한 번 느렸던 소스가
 * 영영 캐시되지 않는 상태에 갇힌다. 함수는 응답을 보낸 뒤 종료되므로 남은
 * 요청은 캐시만 채우고 끝난다 (웜 캐시 0.45초 경로가 유지된다).
 */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(TIMED_OUT), ms);
      // 정상 완료 시 타이머가 이벤트 루프를 붙잡지 않게 한다
      void work.then(
        () => clearTimeout(timer),
        () => clearTimeout(timer)
      );
    }),
  ]);
}

/** 소스별 검색어 — 값이 없는 소스는 이번 질의에서 조회하지 않는다 */
interface SourceQueries {
  ecos?: string;
  kosis?: string;
  fred?: string;
}

export async function searchAll(q: string): Promise<SearchOutcome> {
  const notes: string[] = [];
  const errors: string[] = [];

  // ① 분해 — LLM이 소스별 검색어를 나눈다. 실패하면 종전대로 원문을 쓴다.
  const plan = await planSourceQueries(q);
  const fallbackQueries: SourceQueries = {
    ecos: q,
    kosis: q,
    fred: fredSearchQuery(q) ?? undefined,
  };
  const queries: SourceQueries = plan
    ? { ecos: plan.ecos, kosis: plan.kosis, fred: plan.fred }
    : fallbackQueries;

  // 항목 관련도 정렬에 쓸 토큰 — 질의 원문 + LLM이 집어낸 세부 항목명
  const tokens = queryTokens([q, ...(plan?.items ?? [])].join(" "));

  if (!queries.fred) notes.push(FRED_SKIP_NOTE);
  else if (queries.fred !== q) notes.push(fredTranslatedNote(queries.fred));

  let results = await runSources(queries, tokens, errors);

  // 안전망: 분해가 소스를 건너뛰었는데 결과가 0건이면, 건너뛴 한국 소스를
  // 원문으로 한 번 더 조회한다. LLM 오판으로 검색을 통째로 잃지 않게 한다.
  if (results.length === 0 && plan) {
    const retry: SourceQueries = {
      ecos: queries.ecos ? undefined : fallbackQueries.ecos,
      kosis: queries.kosis ? undefined : fallbackQueries.kosis,
    };
    if (retry.ecos || retry.kosis) {
      results = await runSources(retry, queryTokens(q), errors);
      if (results.length > 0) notes.push("검색어 분해로는 결과가 없어 질의 원문으로 다시 찾았습니다");
    }
    return { results, errors, notes };
  }

  // ③ 선별 — 질의에 맞는 후보를 앞으로. 실패하면 ②의 순서를 그대로 쓴다.
  results = await rankByRelevance(q, results);
  return { results, errors, notes };
}

/** 소스별 검색어로 실제 조회. 소스 하나가 느리거나 실패해도 나머지를 막지 않는다 */
async function runSources(
  queries: SourceQueries,
  tokens: string[],
  errors: string[]
): Promise<SearchResult[]> {
  const tasks: { source: SourceId; run: () => Promise<SearchResult[]> }[] = [];
  if (queries.ecos) tasks.push({ source: "ecos", run: () => searchEcos(queries.ecos!, tokens) });
  if (queries.kosis) tasks.push({ source: "kosis", run: () => searchKosis(queries.kosis!, tokens) });
  if (queries.fred) tasks.push({ source: "fred", run: () => searchFred(queries.fred!) });
  if (tasks.length === 0) return [];

  const settled = await Promise.allSettled(
    tasks.map((t) => withDeadline(t.run(), SOURCE_TIMEOUT_MS))
  );

  const perSource: SearchResult[][] = [];
  settled.forEach((s, i) => {
    const { source } = tasks[i];
    if (s.status === "fulfilled") {
      perSource.push(s.value);
    } else if (s.reason === TIMED_OUT) {
      errors.push(timeoutNote(source));
    } else {
      errors.push(
        `[${source}] ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`
      );
    }
  });
  // 소스 단위 라운드로빈 — 순서대로 이어붙이면 ECOS가 칸을 다 먹어 한·미 비교가 깨진다
  return interleave(perSource);
}

/**
 * 여러 묶음을 라운드로빈으로 합친다 (묶음 안의 순서는 유지).
 * 앞 묶음이 상한을 독식해 뒤 묶음이 통째로 사라지는 것을 막는 유일한 장치다.
 */
export function interleave<T>(groups: T[][], cap = Infinity): T[] {
  const out: T[] = [];
  const longest = groups.reduce((m, g) => Math.max(m, g.length), 0);
  for (let i = 0; i < longest && out.length < cap; i++) {
    for (const g of groups) {
      if (out.length >= cap) break;
      if (i < g.length) out.push(g[i]);
    }
  }
  return out;
}

/**
 * 상한을 적용하되 소스마다 최소 몫(floor)을 보장한다.
 * 관련도 정렬 결과를 존중하면서도 한 소스가 칸을 전부 먹어 다른 나라·기관이
 * 0건이 되는 일(한·미 비교의 치명상)을 막는다.
 */
export function capWithSourceFloor(
  results: SearchResult[],
  cap: number,
  floor: number
): SearchResult[] {
  if (results.length <= cap) return results;
  const seenPerSource = new Map<string, number>();
  const kept = new Set<number>();
  results.forEach((r, i) => {
    const n = seenPerSource.get(r.source) ?? 0;
    if (n < floor) {
      seenPerSource.set(r.source, n + 1);
      kept.add(i);
    }
  });
  for (let i = 0; i < results.length && kept.size < cap; i++) kept.add(i);
  return results.filter((_, i) => kept.has(i)).slice(0, cap);
}

function getKey(envName: string): string {
  const key = process.env[envName];
  if (!key) throw new Error(`${envName} 환경변수가 설정되지 않았습니다`);
  return key;
}

// ── 관련도 채점 ────────────────────────────────────────────────
// 이름 비교는 대소문자·공백을 무시한다. 점수는 "걸린 토큰 수"가 1순위,
// "걸린 글자 수"(=토큰의 구체성)가 2순위다. 동점은 호출부에서 원래 순서로
// 안정 정렬되므로, 토큰이 하나도 없던 종전 동작과 순서가 어긋나지 않는다.

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s/g, "");
}

function tokenScore(name: string, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const n = normalize(name);
  let hits = 0;
  let chars = 0;
  for (const t of tokens) {
    if (!n.includes(t)) continue;
    hits++;
    chars += t.length;
  }
  return hits === 0 ? 0 : hits * 1000 + chars;
}

/** 표 매칭 점수 — 질의 원문이 통째로 이름에 들어가면 최우선(종전 부분문자열 동작 보존) */
function tableScore(name: string, q: string, tokens: string[]): number {
  const base = tokenScore(name, tokens);
  return normalize(name).includes(normalize(q)) ? base + 1_000_000 : base;
}

/** 점수를 매겨 내림차순 정렬 (동점은 원래 순서 유지). 점수 0은 버린다 */
function rankByTokens<T>(rows: T[], nameOf: (r: T) => string, tokens: string[]): T[] {
  return rows
    .map((row, i) => ({ row, i, score: tokenScore(nameOf(row), tokens) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.row);
}

// ── ECOS ──────────────────────────────────────────────────────
// StatisticTableList: 전체 통계표(834개) 전량 수신 → 하루 캐시 → 검색어 필터.
// 매칭된 표는 StatisticItemList로 세부 항목을 펼쳐 항목 단위 결과를 만든다.

interface EcosTableRow {
  STAT_CODE: string;
  STAT_NAME: string;
  CYCLE: string | null;
  SRCH_YN: string;
  ORG_NAME: string | null;
}

interface EcosItemRow {
  GRP_CODE: string; // "Group1" | "Group2" | "Group3"
  ITEM_CODE: string;
  ITEM_NAME: string;
  CYCLE: string;
  UNIT_NAME: string | null;
}

/**
 * ECOS 주기 표기 → 어댑터 관례.
 * SM(반월)·S(반기)는 어댑터(lib/sources/ecos.ts)의 기간 표기 변환이 지원하지
 * 않는다 — 조회 구간이 연도로 나가고 응답 시점 표기도 정규형이 아니라, 차트
 * x축이 조용히 망가진다. 그래서 검색 결과에 아예 올리지 않는다.
 */
const ECOS_CYCLE: Record<string, Cycle> = { D: "D", M: "M", Q: "Q", A: "A" };

/** 표 대표 주기가 없을 때 고르는 우선순위 — 지원 주기만 둔다 */
const ECOS_CYCLE_PREFERENCE = ["M", "Q", "D", "A"];

const ECOS_GROUPS = ["Group1", "Group2", "Group3"];

async function fetchEcosTables(key: string): Promise<EcosTableRow[]> {
  const res = await fetch(
    `https://ecos.bok.or.kr/api/StatisticTableList/${key}/json/kr/1/1000/`,
    { next: { revalidate: 86400 } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.RESULT) throw new Error(`${json.RESULT.CODE} ${json.RESULT.MESSAGE}`);
  return json.StatisticTableList?.row ?? [];
}

async function fetchEcosItems(key: string, statCode: string): Promise<EcosItemRow[]> {
  const res = await fetch(
    `https://ecos.bok.or.kr/api/StatisticItemList/${key}/json/kr/1/1000/${statCode}`,
    { next: { revalidate: 86400 } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.RESULT) throw new Error(`${json.RESULT.CODE} ${json.RESULT.MESSAGE}`);
  return json.StatisticItemList?.row ?? [];
}

async function searchEcos(q: string, tokens: string[]): Promise<SearchResult[]> {
  const key = getKey("ECOS_API_KEY");
  const tables = await fetchEcosTables(key);
  const searchable = tables.filter((t) => t.SRCH_YN === "Y");

  // 표 이름에는 목차번호가 붙어 있다("1.3.3.2.1. 예금은행 대출금리") — 지우지
  // 않고 그대로 대조해야 목차번호로 찾는 질의가 걸린다.
  const matched = searchable
    .map((t, i) => ({ t, i, score: tableScore(t.STAT_NAME, q, tokens) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, ECOS_TABLE_FANOUT)
    .map((x) => x.t);

  const perTable = await Promise.all(
    matched.map((t) => expandEcosTable(key, t, tokens).catch(() => []))
  );
  // 표 단위 라운드로빈 — 이어붙여 자르면 앞 표(신규취급액)가 뒤 표(잔액)를 밀어낸다
  return interleave(perTable, PER_SOURCE_CAP);
}

/** 항목 행(항목×주기 중복 수록)에서 이번에 쓸 주기와 그 주기의 항목만 추린다 */
function pickEcosCycle(rows: EcosItemRow[], tableCycle: string | null): string | null {
  const cycles = new Set(rows.map((r) => r.CYCLE).filter((c) => c in ECOS_CYCLE));
  if (tableCycle && cycles.has(tableCycle)) return tableCycle;
  return ECOS_CYCLE_PREFERENCE.find((c) => cycles.has(c)) ?? null;
}

/** 그룹(차원)별 유일 항목 — 질의 관련도 순으로 정렬한 뒤 상한을 적용한다 */
function ecosGroups(cycleRows: EcosItemRow[], tokens: string[]): EcosItemRow[][] {
  return ECOS_GROUPS.map((g) => {
    const seen = new Map<string, EcosItemRow>();
    for (const r of cycleRows) {
      if (r.GRP_CODE === g && !seen.has(r.ITEM_CODE)) seen.set(r.ITEM_CODE, r);
    }
    const ranked = rankByTokens([...seen.values()], (r) => r.ITEM_NAME, tokens);
    return ranked.slice(0, ECOS_GROUP_ITEM_CAPS[g] ?? 1);
  }).filter((items) => items.length > 0);
}

async function expandEcosTable(
  key: string,
  table: EcosTableRow,
  tokens: string[]
): Promise<SearchResult[]> {
  const rows = await fetchEcosItems(key, table.STAT_CODE);
  if (rows.length === 0) return [];

  const rawCycle = pickEcosCycle(rows, table.CYCLE);
  if (!rawCycle) return [];
  const groups = ecosGroups(
    rows.filter((r) => r.CYCLE === rawCycle),
    tokens
  );
  if (groups.length === 0) return [];

  // 앞자리 목차번호는 표시 이름에서만 뺀다 — 차트 범례를 짧게 유지하기 위함이고,
  // 검색 대조는 위에서 목차번호가 붙은 원문으로 이미 끝났다.
  const tableName = table.STAT_NAME.replace(/^[\d.]+\s*/, "");

  const combos: EcosItemRow[][] = groups.reduce<EcosItemRow[][]>(
    (acc, items) => acc.flatMap((combo) => items.map((it) => [...combo, it])),
    [[]]
  );
  // 조합도 관련도 순으로 정렬한 뒤 자른다. Group1이 바깥 루프라 정렬 없이 자르면
  // Group2가 짧은 표에서 Group1 상한을 올려도 결과가 바뀌지 않는다.
  const ranked = rankByTokens(combos, (c) => c.map((it) => it.ITEM_NAME).join(" "), tokens);

  return ranked.slice(0, ECOS_COMBOS_PER_TABLE).map((combo) => {
    const params: Record<string, string> = { statCode: table.STAT_CODE, cycle: rawCycle };
    combo.forEach((it, i) => (params[`itemCode${i + 1}`] = it.ITEM_CODE));
    return {
      source: "ecos" as const,
      name: `${tableName} · ${combo.map((it) => it.ITEM_NAME).join(" / ")}`,
      params,
      cycle: ECOS_CYCLE[rawCycle] ?? "M",
      unit: combo[0].UNIT_NAME ?? undefined,
      origin: table.ORG_NAME ?? "한국은행 ECOS",
    };
  });
}

// ── ECOS 표 안 열어보기 ────────────────────────────────────────
// 검색 결과는 상한이 있는 한 언제나 일부만 노출한다. 잘린 항목에 도달할
// 경로가 없으면 그 계열은 앱에서 존재하지 않는 것과 같으므로, 표 하나를
// 지정해 항목 목록을 통째로 여는 경로를 둔다 (챗 도구 list_table_items).

export interface TableItemGroup {
  group: string;
  /** 그룹의 전체 항목 수 */
  total: number;
  items: { itemCode: string; itemName: string; unit?: string }[];
}

export interface TableItemsResult {
  statCode: string;
  statName: string;
  cycle: string;
  availableCycles: string[];
  groups: TableItemGroup[];
  /** 이 표를 조회할 때 쓸 params 형태 */
  paramsHint: Record<string, string>;
  notes: string[];
}

export async function listEcosTableItems(
  statCode: string,
  opts: { cycle?: string; filter?: string } = {}
): Promise<TableItemsResult> {
  const key = getKey("ECOS_API_KEY");
  const code = statCode.trim();
  const [tables, rows] = await Promise.all([fetchEcosTables(key), fetchEcosItems(key, code)]);
  const table = tables.find((t) => t.STAT_CODE === code);
  if (rows.length === 0) {
    throw new Error(`통계표 ${code}의 항목을 찾을 수 없습니다 (statCode를 확인하세요)`);
  }

  const availableCycles = [...new Set(rows.map((r) => r.CYCLE))].filter((c) => c in ECOS_CYCLE);
  const notes: string[] = [];
  const wanted = opts.cycle && availableCycles.includes(opts.cycle) ? opts.cycle : null;
  if (opts.cycle && !wanted) {
    notes.push(`주기 ${opts.cycle}는 이 표에 없습니다 (가능: ${availableCycles.join(", ") || "없음"})`);
  }
  const cycle = wanted ?? pickEcosCycle(rows, table?.CYCLE ?? null);
  if (!cycle) throw new Error(`통계표 ${code}에 지원 주기(D·M·Q·A)가 없습니다`);

  const tokens = opts.filter ? queryTokens(opts.filter) : [];
  const groups: TableItemGroup[] = [];
  const paramsHint: Record<string, string> = { statCode: code, cycle };

  for (const g of ECOS_GROUPS) {
    const seen = new Map<string, EcosItemRow>();
    for (const r of rows) {
      if (r.CYCLE === cycle && r.GRP_CODE === g && !seen.has(r.ITEM_CODE)) {
        seen.set(r.ITEM_CODE, r);
      }
    }
    const all = [...seen.values()];
    if (all.length === 0) continue;

    // 필터가 걸리면 맞는 항목만, 하나도 안 맞으면 전체를 관련도 순으로 보여준다
    const hit = tokens.length > 0 ? all.filter((r) => tokenScore(r.ITEM_NAME, tokens) > 0) : [];
    const pool = hit.length > 0 ? hit : rankByTokens(all, (r) => r.ITEM_NAME, tokens);
    const shown = pool.slice(0, TABLE_ITEMS_PER_GROUP);
    if (shown.length < all.length) {
      notes.push(
        `${g}: 전체 ${all.length}개 중 ${shown.length}개 표시${
          tokens.length > 0 ? " (항목명 필터 적용)" : " — filter로 좁히세요"
        }`
      );
    }
    groups.push({
      group: g,
      total: all.length,
      items: shown.map((r) => ({
        itemCode: r.ITEM_CODE,
        itemName: r.ITEM_NAME,
        unit: r.UNIT_NAME ?? undefined,
      })),
    });
    paramsHint[`itemCode${groups.length}`] = `<${g} ITEM_CODE>`;
  }
  if (groups.length === 0) throw new Error(`통계표 ${code}의 ${cycle} 주기 항목이 비어 있습니다`);

  return {
    statCode: code,
    statName: table?.STAT_NAME ?? code,
    cycle,
    availableCycles,
    groups,
    paramsHint,
    notes,
  };
}

// ── KOSIS ─────────────────────────────────────────────────────
// 통합검색(statisticsSearch.do)으로 통계표를 찾고, 표별 메타(getMeta ITM/PRD)로
// 항목·분류·주기를 펼쳐 어댑터 params(itmId/objL1..3/prdSe)를 완성한다.
// 표 이름 매칭은 KOSIS 서버가 하므로 로컬 부분문자열 대조는 없다.

interface KosisSearchRow {
  ORG_ID: string;
  ORG_NM?: string;
  TBL_ID: string;
  TBL_NM: string;
  STAT_NM?: string;
}

interface KosisItmRow {
  OBJ_ID: string; // "ITEM" 또는 분류 ID
  OBJ_ID_SN?: string; // 분류 차수 "1","2",...
  ITM_ID: string;
  ITM_NM: string;
  UNIT_NM?: string;
}

/** KOSIS 수록주기 한글 라벨 → (어댑터 관례 cycle, prdSe 코드) */
const KOSIS_PRD: Record<string, { cycle: Cycle; prdSe: string }> = {
  "일": { cycle: "D", prdSe: "D" },
  "월": { cycle: "M", prdSe: "M" },
  "분기": { cycle: "Q", prdSe: "Q" },
  "년": { cycle: "A", prdSe: "Y" },
};

function kosisKey(): string {
  // 어댑터와 동일한 base64 패딩 보정
  const raw = getKey("KOSIS_API_KEY");
  return raw + "=".repeat((4 - (raw.length % 4)) % 4);
}

async function searchKosis(q: string, tokens: string[]): Promise<SearchResult[]> {
  const key = kosisKey();
  const qs = new URLSearchParams({
    method: "getList",
    apiKey: key,
    searchNm: q,
    format: "json",
    jsonVD: "Y",
    startCount: "1",
    resultCount: String(KOSIS_TABLE_SEARCH_COUNT),
  });
  const res = await fetch(`https://kosis.kr/openapi/statisticsSearch.do?${qs}`, {
    next: { revalidate: 3600 },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json)) {
    // 결과 없음도 {err:...} 형태로 오므로 빈 결과로 처리
    if (json?.err === "30" || json?.errMsg?.includes("결과")) return [];
    throw new Error(json?.errMsg ?? json?.err ?? "예상치 못한 응답 형식");
  }
  const rows: KosisSearchRow[] = json;

  // 원격이 돌려준 순서를 존중하되, 질의 토큰이 표 이름에 걸리는 표를 앞으로 올린다
  const ordered = rankByTokens(rows, (r) => `${r.TBL_NM} ${r.STAT_NM ?? ""}`, tokens);
  const perTable = await Promise.all(
    ordered.slice(0, KOSIS_TABLE_FANOUT).map((t) => expandKosisTable(key, t, tokens).catch(() => []))
  );
  return interleave(perTable, PER_SOURCE_CAP);
}

async function expandKosisTable(
  key: string,
  table: KosisSearchRow,
  tokens: string[]
): Promise<SearchResult[]> {
  const meta = (type: string) => {
    const qs = new URLSearchParams({
      method: "getMeta",
      type,
      apiKey: key,
      orgId: table.ORG_ID,
      tblId: table.TBL_ID,
      format: "json",
      jsonVD: "Y",
    });
    return fetch(`https://kosis.kr/openapi/statisticsData.do?${qs}`, {
      next: { revalidate: 86400 },
    }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))));
  };
  const [itmJson, prdJson] = await Promise.all([meta("ITM"), meta("PRD")]);
  if (!Array.isArray(itmJson) || !Array.isArray(prdJson)) return [];

  // 주기: M > Q > D > A 우선
  const available = new Set(
    (prdJson as { PRD_SE: string }[]).map((p) => p.PRD_SE)
  );
  const label = ["월", "분기", "일", "년"].find((l) => available.has(l));
  if (!label) return [];
  const { cycle, prdSe } = KOSIS_PRD[label];

  const itmRows = itmJson as KosisItmRow[];
  const rank = (rows: KosisItmRow[]) => rankByTokens(dedupe(rows), (r) => r.ITM_NM, tokens);
  const items = rank(itmRows.filter((r) => r.OBJ_ID === "ITEM")).slice(0, KOSIS_ITEM_CAP);
  if (items.length === 0) return [];

  const objSns = [...new Set(itmRows.filter((r) => r.OBJ_ID_SN).map((r) => r.OBJ_ID_SN!))].sort();
  // 어댑터가 지원하는 분류 차수(objL1~objL3)까지만 — 그 이상은 조회 params를 만들 수 없다
  if (objSns.length > KOSIS_OBJ_CAPS.length) return [];
  const objLevels = objSns.map((sn, i) =>
    rank(itmRows.filter((r) => r.OBJ_ID_SN === sn)).slice(0, KOSIS_OBJ_CAPS[i])
  );

  const combos: KosisItmRow[][] = [items, ...objLevels].reduce<KosisItmRow[][]>(
    (acc, level) => acc.flatMap((combo) => level.map((it) => [...combo, it])),
    [[]]
  );
  const ranked = rankByTokens(combos, (c) => c.map((it) => it.ITM_NM).join(" "), tokens);

  return ranked.slice(0, KOSIS_COMBOS_PER_TABLE).map((combo) => {
    const [itm, ...objs] = combo;
    const params: Record<string, string> = {
      orgId: table.ORG_ID,
      tblId: table.TBL_ID,
      itmId: itm.ITM_ID,
      objL1: objs[0]?.ITM_ID ?? "",
      prdSe,
    };
    objs.slice(1).forEach((o, i) => (params[`objL${i + 2}`] = o.ITM_ID));
    const parts = combo.map((it) => it.ITM_NM).filter((n, i, a) => a.indexOf(n) === i);
    return {
      source: "kosis" as const,
      name: `${table.TBL_NM} · ${parts.join(" / ")}`,
      params,
      cycle,
      unit: itm.UNIT_NM || undefined,
      origin: table.ORG_NM ?? "KOSIS",
    };
  });
}

function dedupe(rows: KosisItmRow[]): KosisItmRow[] {
  const seen = new Map<string, KosisItmRow>();
  for (const r of rows) if (!seen.has(r.ITM_ID)) seen.set(r.ITM_ID, r);
  return [...seen.values()];
}

// ── FRED ──────────────────────────────────────────────────────
// 시리즈가 1차원이라 표→항목 펼침이 없다. 이름 매칭도 FRED 서버가 한다.
// 결손은 "검색어가 영문이어야 한다"는 것뿐이라 분해 단계에서 해결한다.

interface FredSeriesRow {
  id: string;
  title: string;
  frequency_short: string;
  units_short?: string;
  seasonal_adjustment_short?: string;
}

/** FRED frequency_short → 어댑터 관례. W/BW→D, SA(반년)→Q는 근사 */
const FRED_FREQ: Record<string, Cycle> = {
  D: "D", W: "D", BW: "D", M: "M", Q: "Q", SA: "Q", A: "A",
};

async function searchFred(q: string): Promise<SearchResult[]> {
  const key = getKey("FRED_API_KEY");
  const qs = new URLSearchParams({
    search_text: q,
    api_key: key,
    file_type: "json",
    limit: String(PER_SOURCE_CAP),
    order_by: "popularity",
    sort_order: "desc",
  });
  const res = await fetch(`https://api.stlouisfed.org/fred/series/search?${qs}`, {
    next: { revalidate: 3600 },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const rows: FredSeriesRow[] = json.seriess ?? [];

  return rows.map((r) => ({
    source: "fred" as const,
    name: r.seasonal_adjustment_short && r.seasonal_adjustment_short !== "NSA"
      ? `${r.title} (${r.seasonal_adjustment_short})`
      : r.title,
    params: { seriesId: r.id },
    cycle: FRED_FREQ[r.frequency_short] ?? "M",
    unit: r.units_short,
    origin: "FRED (세인트루이스 연은)",
  }));
}
