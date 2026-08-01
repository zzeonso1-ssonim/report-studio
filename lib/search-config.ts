/**
 * 통합검색 성능 파라미터 — 단일 소스.
 *
 * 서버(lib/search.ts, app/api/search/route.ts)와 클라이언트(app/page.tsx)가
 * 같은 값을 쓴다. 그래서 node 전용 모듈을 import하지 않으며, 환경변수는
 * 브라우저 인라인이 되도록 NEXT_PUBLIC_ 접두사를 리터럴로 참조한다.
 *
 * 배경 (2026-07-28 실측, 서울에서 로컬 dev 기준):
 *   ECOS  표목록 0.55s + 항목확장 2.3s
 *   KOSIS 검색 0.35s + 메타확장 0.35s
 *   FRED  한글 검색어에서 15~17s 소요 후 결과 0건  ← 응답 지연의 전부
 * 세 소스는 이미 병렬이라 전체 응답시간은 가장 느린 소스가 결정한다.
 */

/** 환경변수 → 양의 정수. 미설정·비정상 값이면 기본값. */
function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * 소스 1곳에 허용하는 시간(ms). 초과하면 그 소스만 결과에서 빼고
 * 나머지는 그대로 응답한다. ECOS 실측 최대 2.3s의 약 2.5배 여유.
 */
export const SOURCE_TIMEOUT_MS = positiveInt(
  process.env.NEXT_PUBLIC_SEARCH_SOURCE_TIMEOUT_MS,
  6000
);

/** 응답 조립·직렬화 등 소스 호출 밖에서 쓰는 여유(ms) */
export const SERVER_OVERHEAD_MS = 2000;

/** 서버가 스스로 지키기로 한 상한(ms) */
export const SERVER_BUDGET_MS = SOURCE_TIMEOUT_MS + SERVER_OVERHEAD_MS;

/** 클라이언트 abort 상한(ms) — 서버 상한 + 왕복 네트워크 여유 */
export const CLIENT_TIMEOUT_MS = SERVER_BUDGET_MS + 5000;

/**
 * 서버리스 함수 상한(초). vercel.json의 maxDuration과 같은 값이어야 한다.
 * Next는 route의 `export const maxDuration`을 빌드타임 정적 리터럴로만 받으므로
 * route.ts에는 리터럴을 쓰고, 어긋나면 개발 중에 드러나도록 여기서 대조한다.
 */
export const FUNCTION_MAX_DURATION_S = 20;

/** 소스별 확장(세부항목 조회) 대상 통계표 수 — 결과 건수를 결정하므로 함부로 줄이지 않는다 */
export const ECOS_TABLE_FANOUT = 5;
export const KOSIS_TABLE_FANOUT = 4;

/** 소스 1곳이 반환하는 결과 상한 */
export const PER_SOURCE_CAP = 20;

/**
 * FRED에 질의를 보낼지 판정한다.
 *
 * FRED 카탈로그는 영문 전용이라 한글만으로 된 검색어는 항상 0건이다.
 * 그런데 무매칭 질의에서 응답이 15~17초까지 늘어져(2026-07-28 실측) 전체
 * 검색을 지연시키므로, 매칭 가능성이 없는 질의는 애초에 보내지 않는다.
 * ASCII 영숫자가 하나라도 있으면(예: "CPI 소비자물가") 그대로 조회한다.
 */
export function isFredSearchable(q: string): boolean {
  return /[a-z0-9]/i.test(q);
}

/**
 * 한글 거시 용어 → FRED 영문 검색어. 한글만으로 된 질의도 미국 데이터를
 * 탐색할 수 있게 하는 최소 용어집 — 지표 정의가 아니라 검색어 변환 사전이므로
 * 여기(검색 설정 단일 소스)에 둔다. 매칭 우선순위: 먼저 등장하는 긴 표현부터.
 */
const FRED_KO_EN: [string, string][] = [
  ["근원 소비자물가", "core consumer price index"],
  ["슈퍼코어", "services less rent of shelter"],
  ["절사평균", "trimmed mean"],
  ["소비자물가", "consumer price index"],
  ["생산자물가", "producer price index"],
  ["개인소비지출", "personal consumption expenditures"],
  ["실업률", "unemployment rate"],
  ["비농업", "nonfarm payrolls"],
  ["고용", "employment"],
  ["소매판매", "retail sales"],
  ["산업생산", "industrial production"],
  ["기준금리", "federal funds rate"],
  ["국채", "treasury yield"],
  ["장단기", "yield spread"],
  ["환율", "exchange rate"],
  ["주택착공", "housing starts"],
  ["주택", "housing"],
  ["무역수지", "trade balance"],
  ["경기침체", "recession"],
];

/**
 * 질의에서 FRED에 실제로 보낼 검색어를 도출한다.
 * 영숫자가 있으면 원문 그대로, 한글뿐이면 용어집 매칭으로 영문 변환,
 * 변환 불가면 null(FRED 건너뜀).
 */
export function fredSearchQuery(q: string): string | null {
  if (isFredSearchable(q)) return q;
  const terms: string[] = [];
  for (const [ko, en] of FRED_KO_EN) {
    if (q.includes(ko) && !terms.includes(en)) terms.push(en);
  }
  return terms.length > 0 ? terms.join(" ") : null;
}

/** 한글 질의를 영문으로 변환해 FRED를 조회했음을 알리는 안내문 */
export function fredTranslatedNote(en: string): string {
  return `FRED는 영문 카탈로그라 "${en}"(으)로 검색했습니다`;
}

/** FRED를 건너뛴 이유 안내문 */
export const FRED_SKIP_NOTE =
  "FRED는 영문 카탈로그라 한글 검색어는 건너뜁니다 — 영문으로 검색하세요 (예: consumer price)";

/** ms → 사람이 읽는 초 표기 (1초 미만도 0초로 뭉개지 않는다) */
export function seconds(ms: number): string {
  return ms >= 1000 ? String(Math.round(ms / 1000)) : (ms / 1000).toFixed(1);
}

/** 소스가 제한시간을 넘겼을 때의 안내문 */
export function timeoutNote(source: string): string {
  return `[${source}] ${seconds(SOURCE_TIMEOUT_MS)}초 안에 응답하지 않아 이번 결과에서 제외했습니다`;
}
