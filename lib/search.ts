import { Cycle } from "./indicators";
import { SourceId } from "./sources/types";
import {
  ECOS_TABLE_FANOUT,
  FRED_SKIP_NOTE,
  KOSIS_TABLE_FANOUT,
  PER_SOURCE_CAP,
  SOURCE_TIMEOUT_MS,
  fredSearchQuery,
  fredTranslatedNote,
  timeoutNote,
} from "./search-config";

/**
 * 전체 통계 카탈로그 검색 — ECOS·KOSIS·FRED.
 * 결과의 params는 각 소스 어댑터(fetchSeries)에 그대로 넘길 수 있는 형태다.
 * 서버 전용 (API 키 사용) — 클라이언트에서 import 금지.
 */
export interface SearchResult {
  source: SourceId;
  name: string;
  params: Record<string, string>;
  cycle: Cycle;
  unit?: string;
  origin: string;
}

export interface SearchOutcome {
  results: SearchResult[];
  /** 소스별 부분 실패 메시지 (키 미설정, HTTP 오류, 제한시간 초과 등) */
  errors: string[];
  /** 실패가 아닌 안내 — 조회 대상이 아니라 건너뛴 소스 등 */
  notes: string[];
}

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

export async function searchAll(q: string): Promise<SearchOutcome> {
  const notes: string[] = [];

  // 소스별로 독립 실행 — 한 곳이 느리거나 실패해도 나머지를 막지 않는다
  const tasks: { source: SourceId; run: () => Promise<SearchResult[]> }[] = [
    { source: "ecos", run: () => searchEcos(q) },
    { source: "kosis", run: () => searchKosis(q) },
  ];
  const fredQ = fredSearchQuery(q);
  if (fredQ) {
    tasks.push({ source: "fred", run: () => searchFred(fredQ) });
    if (fredQ !== q) notes.push(fredTranslatedNote(fredQ));
  } else {
    notes.push(FRED_SKIP_NOTE);
  }

  const settled = await Promise.allSettled(
    tasks.map((t) => withDeadline(t.run(), SOURCE_TIMEOUT_MS))
  );

  const results: SearchResult[] = [];
  const errors: string[] = [];
  settled.forEach((s, i) => {
    const { source } = tasks[i];
    if (s.status === "fulfilled") {
      results.push(...s.value);
    } else if (s.reason === TIMED_OUT) {
      errors.push(timeoutNote(source));
    } else {
      errors.push(
        `[${source}] ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`
      );
    }
  });
  return { results, errors, notes };
}

function getKey(envName: string): string {
  const key = process.env[envName];
  if (!key) throw new Error(`${envName} 환경변수가 설정되지 않았습니다`);
  return key;
}

/** 검색어 매칭 — 대소문자 무시 + 공백 제거 비교 병행 */
function matches(name: string, q: string): boolean {
  const n = name.toLowerCase();
  const query = q.toLowerCase();
  return n.includes(query) || n.replace(/\s/g, "").includes(query.replace(/\s/g, ""));
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

/** ECOS 주기 표기 → 어댑터 관례. SM(반월)→D, S(반년)→Q는 근사 (변환 주기 계산에 오차 가능) */
const ECOS_CYCLE: Record<string, Cycle> = { D: "D", SM: "D", M: "M", Q: "Q", S: "Q", A: "A" };

async function searchEcos(q: string): Promise<SearchResult[]> {
  const key = getKey("ECOS_API_KEY");
  const res = await fetch(
    `https://ecos.bok.or.kr/api/StatisticTableList/${key}/json/kr/1/1000/`,
    { next: { revalidate: 86400 } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.RESULT) throw new Error(`${json.RESULT.CODE} ${json.RESULT.MESSAGE}`);
  const tables: EcosTableRow[] = json.StatisticTableList?.row ?? [];

  const matched = tables
    .filter((t) => t.SRCH_YN === "Y" && matches(t.STAT_NAME, q))
    .slice(0, ECOS_TABLE_FANOUT);

  const perTable = await Promise.all(
    matched.map((t) => expandEcosTable(key, t).catch(() => []))
  );
  return perTable.flat().slice(0, PER_SOURCE_CAP);
}

async function expandEcosTable(key: string, table: EcosTableRow): Promise<SearchResult[]> {
  const res = await fetch(
    `https://ecos.bok.or.kr/api/StatisticItemList/${key}/json/kr/1/1000/${table.STAT_CODE}`,
    { next: { revalidate: 86400 } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.RESULT) throw new Error(`${json.RESULT.CODE} ${json.RESULT.MESSAGE}`);
  const rows: EcosItemRow[] = json.StatisticItemList?.row ?? [];
  if (rows.length === 0) return [];

  // 항목 행은 항목×주기로 중복 수록 — 표 대표 주기를 우선, 없으면 M>Q>D>A 순으로 택일
  const cycles = new Set(rows.map((r) => r.CYCLE));
  const rawCycle =
    table.CYCLE && cycles.has(table.CYCLE)
      ? table.CYCLE
      : ["M", "Q", "D", "A", "SM", "S"].find((c) => cycles.has(c));
  if (!rawCycle) return [];
  const cycleRows = rows.filter((r) => r.CYCLE === rawCycle);

  // 그룹(차원)별 유일 항목 목록 — Group1 최대 6, Group2 최대 2, Group3은 첫 항목만
  const caps: Record<string, number> = { Group1: 6, Group2: 2, Group3: 1 };
  const groups = ["Group1", "Group2", "Group3"]
    .map((g) => {
      const seen = new Map<string, EcosItemRow>();
      for (const r of cycleRows) {
        if (r.GRP_CODE === g && !seen.has(r.ITEM_CODE)) seen.set(r.ITEM_CODE, r);
      }
      return [...seen.values()].slice(0, caps[g]);
    })
    .filter((items) => items.length > 0);
  if (groups.length === 0) return [];

  const tableName = table.STAT_NAME.replace(/^[\d.]+\s*/, ""); // 앞자리 목차번호 제거
  const combos: EcosItemRow[][] = groups.reduce<EcosItemRow[][]>(
    (acc, items) => acc.flatMap((combo) => items.map((it) => [...combo, it])),
    [[]]
  );

  return combos.slice(0, 12).map((combo) => {
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

// ── KOSIS ─────────────────────────────────────────────────────
// 통합검색(statisticsSearch.do)으로 통계표를 찾고, 표별 메타(getMeta ITM/PRD)로
// 항목·분류·주기를 펼쳐 어댑터 params(itmId/objL1/prdSe)를 완성한다.

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

async function searchKosis(q: string): Promise<SearchResult[]> {
  const key = kosisKey();
  const qs = new URLSearchParams({
    method: "getList",
    apiKey: key,
    searchNm: q,
    format: "json",
    jsonVD: "Y",
    startCount: "1",
    resultCount: "10",
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

  const perTable = await Promise.all(
    rows.slice(0, KOSIS_TABLE_FANOUT).map((t) => expandKosisTable(key, t).catch(() => []))
  );
  return perTable.flat().slice(0, PER_SOURCE_CAP);
}

async function expandKosisTable(key: string, table: KosisSearchRow): Promise<SearchResult[]> {
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
  const items = dedupe(itmRows.filter((r) => r.OBJ_ID === "ITEM")).slice(0, 3);
  const objSns = [...new Set(itmRows.filter((r) => r.OBJ_ID_SN).map((r) => r.OBJ_ID_SN!))].sort();
  // 현재 kosis 어댑터는 objL1/objL2까지만 지원 — 분류 3차 이상 표는 제외
  if (objSns.length > 2) return [];
  const objLevels = objSns.map((sn, i) =>
    dedupe(itmRows.filter((r) => r.OBJ_ID_SN === sn)).slice(0, i === 0 ? 4 : 1)
  );
  if (items.length === 0) return [];

  const combos: KosisItmRow[][] = [items, ...objLevels].reduce<KosisItmRow[][]>(
    (acc, level) => acc.flatMap((combo) => level.map((it) => [...combo, it])),
    [[]]
  );

  return combos.slice(0, 10).map((combo) => {
    const [itm, ...objs] = combo;
    const params: Record<string, string> = {
      orgId: table.ORG_ID,
      tblId: table.TBL_ID,
      itmId: itm.ITM_ID,
      objL1: objs[0]?.ITM_ID ?? "",
      prdSe,
    };
    if (objs[1]) params.objL2 = objs[1].ITM_ID;
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
