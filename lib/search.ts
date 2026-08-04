import { Cycle } from "./indicators";
import { ecosItemIndex } from "./ecos-item-index";
import { SourceId } from "./sources/types";
import {
  ECOS_COMBOS_PER_TABLE,
  ECOS_GROUP_ITEM_CAPS,
  ECOS_ITEM_TABLE_FANOUT,
  ECOS_TABLE_FANOUT,
  FRED_RESULTS_PER_QUERY,
  FRED_SKIP_NOTE,
  KOSIS_COMBOS_PER_TABLE,
  KOSIS_ITEM_CAP,
  KOSIS_OBJ_CAPS,
  KOSIS_TABLE_FANOUT,
  KOSIS_TABLE_SEARCH_COUNT,
  SOURCE_RESULT_CEILING,
  SOURCE_TIMEOUT_MS,
  TABLE_ITEMS_PER_GROUP,
  TRUNCATION_NOTES_SHOWN,
  fredSearchQuery,
  fredTranslatedNote,
  queryTokens,
  timeoutNote,
} from "./search-config";
import { planSourceQueries, rankByRelevance } from "./search-llm";
import { SearchOutcome, SearchResult, TableTruncation } from "./search-types";

/**
 * 전체 통계 카탈로그 검색 — ECOS·KOSIS·FRED.
 * 결과의 params는 각 소스 어댑터(fetchSeries)에 그대로 넘길 수 있는 형태다.
 * 서버 전용 (API 키 사용) — 클라이언트에서 import 금지.
 *
 * 3단 구성:
 *  ① 넓히기 — 질의 원문으로 항상 검색하고, LLM이 만든 소스별 검색어를 **추가**한다.
 *  ② 확장  — 표 → 세부 항목. 표 선정에 **표 이름 + 목차번호 + 항목명 색인**을 모두 쓴다.
 *  ③ 선별  — LLM이 질의 관련도 순으로 재정렬한다(후보를 버리지 않는다).
 *
 * ── 넓히기 원칙 (이 파일의 불변조건) ────────────────────────────
 * **LLM ON의 결과는 언제나 OFF의 상위집합이어야 한다.**
 * 2026-08-05 실측에서 LLM에 "필요 없는 소스는 null" 권한을 줬더니 ON이 OFF보다
 * 결과가 좁아지는 역전이 났다(예: 생산자물가 세부품목 ON 36건 / OFF 96건,
 * ECOS 국제 주요국 PPI 비교표가 통째로 소실). 그래서 지금은
 *  - 원문 검색어가 어떤 경우에도 빠지지 않는다(폴백이 아니라 상시 경로).
 *  - LLM은 검색어를 **더하고** 순서를 조정할 뿐, 소스를 지우지 못한다.
 *  - 상한이 "소스당"이 아니라 "표당"이다. 표가 늘면 결과도 같이 늘어난다 —
 *    소스당 상한이면 LLM이 표를 더 찾아올수록 표당 몫이 줄어 기존 결과가 밀려난다.
 *  - 항목 정렬은 원문 토큰 점수가 1순위, LLM 힌트는 동점을 가르는 2순위다.
 */
export type { SearchOutcome, SearchResult, TableTruncation } from "./search-types";

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

/** 한 소스에 보낼 검색어들 — 원문 + LLM 제안. 중복·빈 값 제거 */
function variantsOf(...candidates: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const c of candidates) {
    const s = c?.trim();
    if (s && s.length >= 2 && !out.includes(s)) out.push(s);
  }
  return out;
}

interface SourceOutput {
  results: SearchResult[];
  truncated: TableTruncation[];
}

/**
 * @param opts.llm false면 LLM 보조를 끄고 문자열 경로만 쓴다.
 *   ON/OFF 결과를 같은 서버에서 대조하기 위한 진단 스위치다 —
 *   "LLM이 결과를 좁히지 않는다"는 불변조건은 측정으로만 지킬 수 있다.
 */
export async function searchAll(
  q: string,
  opts: { llm?: boolean } = {}
): Promise<SearchOutcome> {
  const notes: string[] = [];
  const errors: string[] = [];

  // ① 넓히기 — LLM은 검색어를 더할 뿐, 소스를 지우지 못한다
  const plan = opts.llm === false ? null : await planSourceQueries(q);
  const fredBase = fredSearchQuery(q);
  const queries = {
    ecos: variantsOf(q, plan?.ecos),
    kosis: variantsOf(q, plan?.kosis),
    fred: variantsOf(fredBase, plan?.fred),
  };

  // 정렬 토큰: 원문이 1순위, LLM이 집어낸 세부 항목명·검색어는 2순위(동점 판정용)
  const primaryTokens = queryTokens(q);
  const extraTokens = queryTokens(
    [...(plan?.items ?? []), plan?.ecos ?? "", plan?.kosis ?? ""].join(" ")
  ).filter((t) => !primaryTokens.includes(t));

  if (queries.fred.length === 0) notes.push(FRED_SKIP_NOTE);
  else if (!queries.fred.includes(q)) notes.push(fredTranslatedNote(queries.fred.join(" / ")));

  const tasks: { source: SourceId; run: () => Promise<SourceOutput> }[] = [];
  if (queries.ecos.length > 0) {
    tasks.push({ source: "ecos", run: () => searchEcos(queries.ecos, primaryTokens, extraTokens) });
  }
  if (queries.kosis.length > 0) {
    tasks.push({
      source: "kosis",
      run: () => searchKosis(queries.kosis, primaryTokens, extraTokens),
    });
  }
  if (queries.fred.length > 0) {
    tasks.push({ source: "fred", run: () => searchFred(queries.fred) });
  }

  const settled = await Promise.allSettled(
    tasks.map((t) => withDeadline(t.run(), SOURCE_TIMEOUT_MS))
  );

  const perSource: SearchResult[][] = [];
  const truncated: TableTruncation[] = [];
  settled.forEach((s, i) => {
    const { source } = tasks[i];
    if (s.status === "fulfilled") {
      perSource.push(s.value.results);
      truncated.push(...s.value.truncated);
    } else if (s.reason === TIMED_OUT) {
      errors.push(timeoutNote(source));
    } else {
      errors.push(
        `[${source}] ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`
      );
    }
  });

  // 소스 단위 라운드로빈 — 이어붙이면 ECOS가 앞을 다 채워 한·미 비교가 깨진다
  let results = interleave(perSource);

  // ③ 선별 — 질의에 맞는 후보를 앞으로. 실패하면 ②의 순서를 그대로 쓴다
  if (opts.llm !== false) results = await rankByRelevance(q, results);

  // 잘린 표를 드러낸다 — 모델도 사용자도 "더 있다"는 사실을 알아야 표를 열어본다.
  // 상한을 올려 해결되는 문제가 아니다(표당 상한 × 표 수가 산술 천장이다).
  for (const t of truncated.slice(0, TRUNCATION_NOTES_SHOWN)) {
    notes.push(
      `${t.statName}(${t.statCode})은 항목 ${t.totalItems}개 중 ${t.shownItems}개만 표시했습니다 — 나머지는 통계표를 열어 확인하세요`
    );
  }
  if (truncated.length > TRUNCATION_NOTES_SHOWN) {
    notes.push(
      `… 그 밖에 ${truncated.length - TRUNCATION_NOTES_SHOWN}개 통계표도 항목이 일부만 표시됐습니다`
    );
  }

  return { results, errors, notes, truncated };
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

/** 결과 중복 제거 — 같은 소스·같은 params는 한 번만 (검색어 변형 간 겹침 제거) */
function dedupeResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of results) {
    const sig = `${r.source}:${Object.entries(r.params)
      .sort()
      .map(([k, v]) => `${k}=${v}`)
      .join("&")}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(r);
  }
  return out;
}

function getKey(envName: string): string {
  const key = process.env[envName];
  if (!key) throw new Error(`${envName} 환경변수가 설정되지 않았습니다`);
  return key;
}

// ── 관련도 채점 ────────────────────────────────────────────────
// 이름 비교는 대소문자·공백을 무시한다. 점수는 "걸린 토큰 수"가 1순위,
// "걸린 글자 수"(=토큰의 구체성)가 2순위다. 동점은 호출부에서 원래 순서로
// 안정 정렬되므로, 토큰이 하나도 안 걸리던 종전 동작과 순서가 어긋나지 않는다.

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

/**
 * 원문 토큰이 1순위, LLM 힌트가 2순위인 합성 점수.
 * 원문 점수를 압도적 자리수로 올려, LLM이 켜져도 원문 기준 순서가 뒤집히지 않게 한다
 * (LLM ON이 OFF의 상위집합이어야 한다는 불변조건).
 */
function rankScore(name: string, primary: string[], extra: string[]): number {
  return tokenScore(name, primary) * 1_000_000 + tokenScore(name, extra);
}

/** 점수 내림차순 정렬 (동점은 원래 순서 유지) */
function rankByTokens<T>(
  rows: T[],
  nameOf: (r: T) => string,
  primary: string[],
  extra: string[] = []
): T[] {
  return rows
    .map((row, i) => ({ row, i, score: rankScore(nameOf(row), primary, extra) }))
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

/**
 * 표 후보 선정 — 두 갈래를 **더한다**(둘 중 하나를 고르지 않는다).
 *  ㉠ 표 이름(목차번호 포함) 매칭 상위 ECOS_TABLE_FANOUT — 검색어 변형마다
 *  ㉡ 항목명 색인 매칭 상위 ECOS_ITEM_TABLE_FANOUT
 *
 * ㉡이 없으면 국고채처럼 **표 이름에 없고 항목 이름에만 있는 계열**은 도달률이
 * 0이다(ECOS에서 국고채가 든 표의 이름은 "시장금리(일별)"이다). ㉡을 따로 뽑아
 * 이어붙이는 이유는 ㉠을 밀어내지 않기 위해서다 — 넓히기만 하고 좁히지 않는다.
 */
function ecosTableCandidates(
  tables: EcosTableRow[],
  queries: string[],
  primary: string[],
  extra: string[]
): EcosTableRow[] {
  const picked: EcosTableRow[] = [];
  const seen = new Set<string>();
  const add = (rows: EcosTableRow[]) => {
    for (const t of rows) {
      if (seen.has(t.STAT_CODE)) continue;
      seen.add(t.STAT_CODE);
      picked.push(t);
    }
  };

  for (const q of queries) {
    const nq = normalize(q);
    add(
      tables
        .map((t, i) => {
          // 질의 원문이 표 이름에 통째로 들어가면 최우선(종전 부분문자열 동작 보존)
          const bonus = normalize(t.STAT_NAME).includes(nq) ? 1e15 : 0;
          return { t, i, score: rankScore(t.STAT_NAME, primary, extra) + bonus };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || a.i - b.i)
        .slice(0, ECOS_TABLE_FANOUT)
        .map((x) => x.t)
    );
  }

  const index = ecosItemIndex();
  if (index) {
    add(
      tables
        .map((t, i) => {
          const blob = index.tables[t.STAT_CODE]?.s;
          return { t, i, score: blob ? rankScore(blob, primary, extra) : 0 };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || a.i - b.i)
        .slice(0, ECOS_ITEM_TABLE_FANOUT)
        .map((x) => x.t)
    );
  }
  return picked;
}

async function searchEcos(
  queries: string[],
  primary: string[],
  extra: string[]
): Promise<SourceOutput> {
  const key = getKey("ECOS_API_KEY");
  const tables = (await fetchEcosTables(key)).filter((t) => t.SRCH_YN === "Y");
  const matched = ecosTableCandidates(tables, queries, primary, extra);

  const expanded = await Promise.all(
    matched.map((t) =>
      expandEcosTable(key, t, primary, extra).catch(() => ({ results: [], truncated: [] }))
    )
  );
  return {
    results: dedupeResults(
      interleave(
        expanded.map((e) => e.results),
        SOURCE_RESULT_CEILING
      )
    ),
    truncated: expanded.flatMap((e) => e.truncated),
  };
}

/** 항목 행(항목×주기 중복 수록)에서 이번에 쓸 주기를 고른다 */
function pickEcosCycle(rows: EcosItemRow[], tableCycle: string | null): string | null {
  const cycles = new Set(rows.map((r) => r.CYCLE).filter((c) => c in ECOS_CYCLE));
  if (tableCycle && cycles.has(tableCycle)) return tableCycle;
  return ECOS_CYCLE_PREFERENCE.find((c) => cycles.has(c)) ?? null;
}

/** 그룹(차원)별 유일 항목 — 상한 적용본과 전체 항목 수를 함께 돌려준다(잘림 판정용) */
function ecosGroups(
  cycleRows: EcosItemRow[],
  primary: string[],
  extra: string[]
): { capped: EcosItemRow[][]; totalItems: number } {
  let totalItems = 0;
  const capped = ECOS_GROUPS.map((g) => {
    const seen = new Map<string, EcosItemRow>();
    for (const r of cycleRows) {
      if (r.GRP_CODE === g && !seen.has(r.ITEM_CODE)) seen.set(r.ITEM_CODE, r);
    }
    totalItems += seen.size;
    const ranked = rankByTokens([...seen.values()], (r) => r.ITEM_NAME, primary, extra);
    return ranked.slice(0, ECOS_GROUP_ITEM_CAPS[g] ?? 1);
  }).filter((items) => items.length > 0);
  return { capped, totalItems };
}

async function expandEcosTable(
  key: string,
  table: EcosTableRow,
  primary: string[],
  extra: string[]
): Promise<SourceOutput> {
  const rows = await fetchEcosItems(key, table.STAT_CODE);
  if (rows.length === 0) return { results: [], truncated: [] };

  const rawCycle = pickEcosCycle(rows, table.CYCLE);
  if (!rawCycle) return { results: [], truncated: [] };
  const { capped: groups, totalItems } = ecosGroups(
    rows.filter((r) => r.CYCLE === rawCycle),
    primary,
    extra
  );
  if (groups.length === 0) return { results: [], truncated: [] };

  // 앞자리 목차번호는 표시 이름에서만 뺀다 — 차트 범례를 짧게 유지하기 위함이고,
  // 검색 대조는 위에서 목차번호가 붙은 원문으로 이미 끝났다.
  const tableName = table.STAT_NAME.replace(/^[\d.]+\s*/, "");

  const combos: EcosItemRow[][] = groups.reduce<EcosItemRow[][]>(
    (acc, items) => acc.flatMap((combo) => items.map((it) => [...combo, it])),
    [[]]
  );
  // 조합도 관련도 순으로 정렬한 뒤 자른다. Group1이 바깥 루프라 정렬 없이 자르면
  // Group2가 짧은 표에서 Group1 상한을 올려도 결과가 바뀌지 않는다.
  const ranked = rankByTokens(
    combos,
    (c) => c.map((it) => it.ITEM_NAME).join(" "),
    primary,
    extra
  );
  const shownCombos = ranked.slice(0, ECOS_COMBOS_PER_TABLE);

  const shownItems = new Set(shownCombos.flat().map((it) => it.ITEM_CODE)).size;
  const truncated: TableTruncation[] =
    shownItems < totalItems
      ? [
          {
            source: "ecos",
            statCode: table.STAT_CODE,
            statName: tableName,
            shownItems,
            totalItems,
          },
        ]
      : [];

  return {
    results: shownCombos.map((combo) => {
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
    }),
    truncated,
  };
}

// ── 통계표 안 열어보기 (탈출구) ────────────────────────────────
// 검색 결과는 상한이 있는 한 언제나 일부만 노출한다. 표당 상한 × 표 수가
// 산술 천장이므로 상한을 올리는 것은 해결이 아니다. 잘린 항목에 도달할
// 경로가 없으면 그 계열은 앱에서 존재하지 않는 것과 같으므로, 표 하나를
// 지정해 항목 목록을 여는 경로를 ECOS·KOSIS 양쪽에 둔다.

export interface TableItemGroup {
  group: string;
  /** 그룹의 전체 항목 수 */
  total: number;
  /** 이번 응답에 담은 구간 시작 위치 */
  offset: number;
  items: { itemCode: string; itemName: string; unit?: string }[];
}

export interface TableItemsResult {
  source: SourceId;
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
  opts: { cycle?: string; filter?: string; offset?: number } = {}
): Promise<TableItemsResult> {
  const key = getKey("ECOS_API_KEY");
  const code = statCode.trim();
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const [tables, rows] = await Promise.all([fetchEcosTables(key), fetchEcosItems(key, code)]);
  const table = tables.find((t) => t.STAT_CODE === code);
  if (rows.length === 0) {
    throw new Error(`통계표 ${code}의 항목을 찾을 수 없습니다 (statCode를 확인하세요)`);
  }

  const availableCycles = [...new Set(rows.map((r) => r.CYCLE))].filter((c) => c in ECOS_CYCLE);
  const notes: string[] = [];
  const wanted = opts.cycle && availableCycles.includes(opts.cycle) ? opts.cycle : null;
  if (opts.cycle && !wanted) {
    notes.push(
      `주기 ${opts.cycle}는 이 표에 없습니다 (가능: ${availableCycles.join(", ") || "없음"})`
    );
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

    // 필터가 걸리면 맞는 항목만, 하나도 안 맞으면 전체를 관련도 순으로
    const hit = tokens.length > 0 ? all.filter((r) => tokenScore(r.ITEM_NAME, tokens) > 0) : [];
    const pool = hit.length > 0 ? hit : rankByTokens(all, (r) => r.ITEM_NAME, tokens);
    const shown = pool.slice(offset, offset + TABLE_ITEMS_PER_GROUP);
    const end = offset + shown.length;
    if (end < pool.length) {
      notes.push(
        `${g}: ${pool.length}개 중 ${offset + 1}~${end}번째를 표시했습니다 — 나머지는 offset=${end}로 다시 부르거나 filter로 좁히세요`
      );
    } else if (tokens.length > 0 && hit.length > 0 && hit.length < all.length) {
      notes.push(`${g}: 전체 ${all.length}개 중 필터에 맞는 ${hit.length}개를 표시했습니다`);
    }
    groups.push({
      group: g,
      total: all.length,
      offset,
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
    source: "ecos",
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
// 항목·분류·주기를 펼쳐 어댑터 params(itmId/objL1..8/prdSe)를 완성한다.
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

async function kosisSearchTables(key: string, q: string): Promise<KosisSearchRow[]> {
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
  return json;
}

function kosisMeta(key: string, orgId: string, tblId: string, type: string) {
  const qs = new URLSearchParams({
    method: "getMeta",
    type,
    apiKey: key,
    orgId,
    tblId,
    format: "json",
    jsonVD: "Y",
  });
  return fetch(`https://kosis.kr/openapi/statisticsData.do?${qs}`, {
    next: { revalidate: 86400 },
  }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))));
}

async function searchKosis(
  queries: string[],
  primary: string[],
  extra: string[]
): Promise<SourceOutput> {
  const key = kosisKey();
  const perQuery = await Promise.all(
    queries.map((q) => kosisSearchTables(key, q).catch(() => []))
  );

  // 검색어 변형별로 상위 N개씩 뽑아 이어붙인다 (LLM 변형이 원문 결과를 밀어내지 않게)
  const picked: KosisSearchRow[] = [];
  const seen = new Set<string>();
  for (const rows of perQuery) {
    const ordered = rankByTokens(rows, (r) => `${r.TBL_NM} ${r.STAT_NM ?? ""}`, primary, extra);
    for (const t of ordered.slice(0, KOSIS_TABLE_FANOUT)) {
      const sig = `${t.ORG_ID}/${t.TBL_ID}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      picked.push(t);
    }
  }

  const expanded = await Promise.all(
    picked.map((t) =>
      expandKosisTable(key, t, primary, extra).catch(() => ({ results: [], truncated: [] }))
    )
  );
  return {
    results: dedupeResults(
      interleave(
        expanded.map((e) => e.results),
        SOURCE_RESULT_CEILING
      )
    ),
    truncated: expanded.flatMap((e) => e.truncated),
  };
}

async function expandKosisTable(
  key: string,
  table: KosisSearchRow,
  primary: string[],
  extra: string[]
): Promise<SourceOutput> {
  const [itmJson, prdJson] = await Promise.all([
    kosisMeta(key, table.ORG_ID, table.TBL_ID, "ITM"),
    kosisMeta(key, table.ORG_ID, table.TBL_ID, "PRD"),
  ]);
  if (!Array.isArray(itmJson) || !Array.isArray(prdJson)) return { results: [], truncated: [] };

  // 주기: M > Q > D > A 우선
  const available = new Set((prdJson as { PRD_SE: string }[]).map((p) => p.PRD_SE));
  const label = ["월", "분기", "일", "년"].find((l) => available.has(l));
  if (!label) return { results: [], truncated: [] };
  const { cycle, prdSe } = KOSIS_PRD[label];

  const itmRows = itmJson as KosisItmRow[];
  const rank = (rows: KosisItmRow[]) =>
    rankByTokens(dedupe(rows), (r) => r.ITM_NM, primary, extra);
  const itemRows = itmRows.filter((r) => r.OBJ_ID === "ITEM");
  const items = rank(itemRows).slice(0, KOSIS_ITEM_CAP);
  if (items.length === 0) return { results: [], truncated: [] };
  let totalItems = dedupe(itemRows).length;

  const objSns = [...new Set(itmRows.filter((r) => r.OBJ_ID_SN).map((r) => r.OBJ_ID_SN!))].sort();
  // 어댑터가 지원하는 분류 차수까지만 — 그 이상은 조회 params를 만들 수 없다.
  // (KOSIS_OBJ_CAPS 길이 = 지원 차수. 넘치면 표가 통째로 검색에서 사라진다)
  if (objSns.length > KOSIS_OBJ_CAPS.length) return { results: [], truncated: [] };
  const objLevels = objSns.map((sn, i) => {
    const level = itmRows.filter((r) => r.OBJ_ID_SN === sn);
    totalItems += dedupe(level).length;
    return rank(level).slice(0, KOSIS_OBJ_CAPS[i]);
  });

  const combos: KosisItmRow[][] = [items, ...objLevels].reduce<KosisItmRow[][]>(
    (acc, level) => acc.flatMap((combo) => level.map((it) => [...combo, it])),
    [[]]
  );
  const ranked = rankByTokens(combos, (c) => c.map((it) => it.ITM_NM).join(" "), primary, extra);
  const shownCombos = ranked.slice(0, KOSIS_COMBOS_PER_TABLE);

  const shownItems = new Set(shownCombos.flat().map((it) => it.ITM_ID)).size;
  const truncated: TableTruncation[] =
    shownItems < totalItems
      ? [
          {
            source: "kosis",
            statCode: `${table.ORG_ID}/${table.TBL_ID}`,
            statName: table.TBL_NM,
            shownItems,
            totalItems,
          },
        ]
      : [];

  return {
    results: shownCombos.map((combo) => {
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
    }),
    truncated,
  };
}

/** KOSIS 탈출구 — ECOS의 listEcosTableItems와 같은 역할 */
export async function listKosisTableItems(
  orgId: string,
  tblId: string,
  opts: { filter?: string; offset?: number } = {}
): Promise<TableItemsResult> {
  const key = kosisKey();
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const [itmJson, prdJson] = await Promise.all([
    kosisMeta(key, orgId, tblId, "ITM"),
    kosisMeta(key, orgId, tblId, "PRD"),
  ]);
  if (!Array.isArray(itmJson)) {
    throw new Error(`KOSIS 통계표 ${orgId}/${tblId}의 항목 메타를 읽지 못했습니다`);
  }
  const itmRows = itmJson as KosisItmRow[];
  if (itmRows.length === 0) {
    throw new Error(`KOSIS 통계표 ${orgId}/${tblId}의 항목이 비어 있습니다`);
  }

  const available = new Set(
    Array.isArray(prdJson) ? (prdJson as { PRD_SE: string }[]).map((p) => p.PRD_SE) : []
  );
  const label = ["월", "분기", "일", "년"].find((l) => available.has(l));
  const { cycle, prdSe } = label ? KOSIS_PRD[label] : { cycle: "M" as Cycle, prdSe: "M" };

  const tokens = opts.filter ? queryTokens(opts.filter) : [];
  const notes: string[] = [];
  const groups: TableItemGroup[] = [];
  const paramsHint: Record<string, string> = { orgId, tblId, prdSe, itmId: "<ITEM ITM_ID>" };

  const objSns = [...new Set(itmRows.filter((r) => r.OBJ_ID_SN).map((r) => r.OBJ_ID_SN!))].sort();
  if (objSns.length > KOSIS_OBJ_CAPS.length) {
    notes.push(
      `분류 차수가 ${objSns.length}단이라 조회 어댑터(objL1~objL${KOSIS_OBJ_CAPS.length})가 지원하지 않습니다 — 이 표는 조회할 수 없습니다`
    );
  }
  const levels: { group: string; rows: KosisItmRow[] }[] = [
    { group: "ITEM", rows: dedupe(itmRows.filter((r) => r.OBJ_ID === "ITEM")) },
    ...objSns.map((sn, i) => ({
      group: `objL${i + 1}`,
      rows: dedupe(itmRows.filter((r) => r.OBJ_ID_SN === sn)),
    })),
  ];

  for (const { group, rows } of levels) {
    if (rows.length === 0) continue;
    const hit = tokens.length > 0 ? rows.filter((r) => tokenScore(r.ITM_NM, tokens) > 0) : [];
    const pool = hit.length > 0 ? hit : rankByTokens(rows, (r) => r.ITM_NM, tokens);
    const shown = pool.slice(offset, offset + TABLE_ITEMS_PER_GROUP);
    const end = offset + shown.length;
    if (end < pool.length) {
      notes.push(
        `${group}: ${pool.length}개 중 ${offset + 1}~${end}번째를 표시했습니다 — 나머지는 offset=${end}로 다시 부르거나 filter로 좁히세요`
      );
    }
    groups.push({
      group,
      total: rows.length,
      offset,
      items: shown.map((r) => ({
        itemCode: r.ITM_ID,
        itemName: r.ITM_NM,
        unit: r.UNIT_NM || undefined,
      })),
    });
    if (group !== "ITEM") paramsHint[group] = `<${group} ITM_ID>`;
  }

  return {
    source: "kosis",
    statCode: `${orgId}/${tblId}`,
    statName: `${orgId}/${tblId}`,
    cycle,
    availableCycles: [...available],
    groups,
    paramsHint,
    notes,
  };
}

function dedupe(rows: KosisItmRow[]): KosisItmRow[] {
  const seen = new Map<string, KosisItmRow>();
  for (const r of rows) if (!seen.has(r.ITM_ID)) seen.set(r.ITM_ID, r);
  return [...seen.values()];
}

// ── FRED ──────────────────────────────────────────────────────
// 시리즈가 1차원이라 표→항목 펼침이 없다. 이름 매칭도 FRED 서버가 한다.
// 결손은 "검색어가 영문이어야 한다"는 것뿐이라 넓히기 단계에서 해결한다.

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

async function searchFred(queries: string[]): Promise<SourceOutput> {
  const key = getKey("FRED_API_KEY");
  const perQuery = await Promise.all(
    queries.map(async (q) => {
      const qs = new URLSearchParams({
        search_text: q,
        api_key: key,
        file_type: "json",
        limit: String(FRED_RESULTS_PER_QUERY),
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
        name:
          r.seasonal_adjustment_short && r.seasonal_adjustment_short !== "NSA"
            ? `${r.title} (${r.seasonal_adjustment_short})`
            : r.title,
        params: { seriesId: r.id },
        cycle: FRED_FREQ[r.frequency_short] ?? "M",
        unit: r.units_short,
        origin: "FRED (세인트루이스 연은)",
      }));
    })
  );
  return {
    results: dedupeResults(interleave(perQuery, SOURCE_RESULT_CEILING)),
    truncated: [],
  };
}
