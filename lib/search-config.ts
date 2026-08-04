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
 * 나머지는 그대로 응답한다.
 *
 * 6초였을 때 FRED가 간헐적으로 걸려 회귀 배터리가 비결정적으로 떨어졌다
 * (2026-08-05: "미국 케이스실러 주택가격 5년"이 재실행에서 계획 없이 종료).
 * 검색어 변형이 늘어 소스당 호출도 늘었으므로 8초로 올린다.
 */
export const SOURCE_TIMEOUT_MS = positiveInt(
  process.env.NEXT_PUBLIC_SEARCH_SOURCE_TIMEOUT_MS,
  8000
);

/**
 * LLM 보조(lib/search-llm.ts) 1단계에 허용하는 시간(ms).
 * 넘기면 그 단계만 버리고 문자열 경로로 진행한다.
 * 서버 상한 계산에 쓰이므로 SERVER_BUDGET_MS보다 먼저 선언한다.
 */
export const SEARCH_LLM_TIMEOUT_MS = positiveInt(
  process.env.NEXT_PUBLIC_SEARCH_LLM_TIMEOUT_MS,
  4000
);

/** 응답 조립·직렬화 등 소스 호출 밖에서 쓰는 여유(ms) */
export const SERVER_OVERHEAD_MS = 2000;

/**
 * 서버가 스스로 지키기로 한 상한(ms).
 * 소스 조회(병렬) + LLM 보조 2단계(분해·선별, 각각 순차)를 더한 최악값이다.
 */
export const SERVER_BUDGET_MS =
  SOURCE_TIMEOUT_MS + 2 * SEARCH_LLM_TIMEOUT_MS + SERVER_OVERHEAD_MS;

/** 클라이언트 abort 상한(ms) — 서버 상한 + 왕복 네트워크 여유 */
export const CLIENT_TIMEOUT_MS = SERVER_BUDGET_MS + 5000;

/**
 * 서버리스 함수 상한(초). vercel.json의 maxDuration과 같은 값이어야 한다.
 * SERVER_BUDGET_MS(현재 16초)보다 커야 서버가 스스로 정한 상한이 의미를 갖는다.
 * Next는 route의 `export const maxDuration`을 빌드타임 정적 리터럴로만 받으므로
 * route.ts에는 리터럴을 쓰고, 어긋나면 개발 중에 드러나도록 여기서 대조한다.
 */
export const FUNCTION_MAX_DURATION_S = 25;

/**
 * 검색 상한 — "무엇을 자르는가"를 상수마다 명시한다.
 *
 * ── 실측 (2026-08-05, ECOS 검색가능 608표 **전수**) ─────────────
 *   착수 전(Group1 6·Group2 2·Group3 1, 조합 12): 잘린 표 88.7%,
 *   전체 조합 1,056,975개 중 노출 5,008개 → **0.47%**
 *   현재(Group1 20·Group2 6·Group3 3, 표당 24): 잘린 표 69.1%, 11,234개 → **1.06%**
 *   질의 1회 노출 상한: 5표×12=60조합 → 최대 16표×24=**384조합**
 *
 * **상한을 올리는 것으로는 해결되지 않는다.** 표당 상한 × 표 수가 산술 천장이라
 * 어떤 값을 넣어도 전체의 몇 %에 머문다. 그래서 실질 해법은 상한이 아니라 둘이다.
 *   ① **항목명 색인**(data/ecos-item-names.json) — 표 이름에 없고 항목 이름에만
 *      있는 계열(국고채가 대표)이 표 후보에 오르게 한다. 없으면 도달률 0이다.
 *   ② **탈출구**(list_table_items · list_kosis_table_items) — 표를 직접 열어
 *      모든 항목에 도달한다. 잘린 표는 검색 응답의 truncated로 드러내, 모델이
 *      "더 있다"는 사실을 알고 표를 열도록 만든다.
 * 아래 상한들은 "한 화면에 몇 개를 먼저 보여줄까"를 정할 뿐이다.
 */

/**
 * 자르는 대상: 세부항목을 펼칠 통계표 수(검색어 변형 1개당).
 * 검색어 변형(원문 + LLM 제안)마다 이만큼씩 뽑아 **이어붙인다** — 변형이 늘면
 * 후보 표도 늘어난다. 원문 몫을 LLM 변형이 밀어내지 않게 하기 위한 구조다.
 */
export const ECOS_TABLE_FANOUT = 5;
export const KOSIS_TABLE_FANOUT = 5;

/**
 * 자르는 대상: **항목명 색인**으로 추가로 끌어오는 통계표 수.
 * 표 이름에는 없고 항목 이름에만 있는 계열(국고채가 대표)에 닿는 유일한 경로다.
 * 위 FANOUT과 별도로 더해지므로 이름 매칭 결과를 밀어내지 않는다.
 */
export const ECOS_ITEM_TABLE_FANOUT = 6;

/** 자르는 대상: KOSIS 원격 통합검색이 돌려주는 통계표 수 (페이지네이션 없음) */
export const KOSIS_TABLE_SEARCH_COUNT = 20;

/**
 * 자르는 대상: ECOS 표 하나에서 그룹(차원)별로 조합에 넣는 세부항목 수.
 * 조합 생성량의 상한은 곱(=Group1×Group2×Group3)이므로 무한정 올리지 않는다.
 * 항목은 질의 관련도 순으로 정렬한 뒤 자르므로, 찾는 항목은 앞쪽에 남는다.
 */
export const ECOS_GROUP_ITEM_CAPS: Record<string, number> = {
  Group1: 20,
  Group2: 6,
  Group3: 3,
};

/**
 * 자르는 대상: ECOS 표 하나가 결과에 올리는 항목 조합(=결과 행) 수.
 * 관련도 순으로 정렬한 뒤 자른다.
 *
 * **소스당이 아니라 표당인 것이 핵심이다.** 소스당 상한이면 검색이 표를 더
 * 찾아올수록 표당 몫이 줄어, 검색어를 넓힌 결과가 오히려 기존 결과를 밀어낸다
 * (LLM ON이 OFF보다 좁아지던 역전의 직접 원인). 표당 상한이면 표가 늘면
 * 결과도 함께 늘어난다.
 *
 * 이 값을 올리는 것으로는 결손이 해결되지 않는다 — 표당 상한 × 표 수가 산술
 * 천장이다(2026-08-05 재측정: 전 표 기준 노출률 0.47%→1.06%). 잘린 항목의
 * 실질 해법은 항목명 색인(표 선정)과 list_table_items(탈출구)다.
 */
export const ECOS_COMBOS_PER_TABLE = 24;

/** 자르는 대상: KOSIS 표 하나의 ITEM(지표) 수 */
export const KOSIS_ITEM_CAP = 6;

/**
 * KOSIS 분류 차수(objL1…objLN) 지원 한계 — **검색과 조회의 단일 소스**.
 *
 * 검색이 이보다 깊은 표를 결과에 올리면 조회에서 100% 실패하고,
 * 반대로 이보다 얕게 잡으면 그만큼 통계표가 통째로 검색에서 사라진다.
 * 두 곳에 따로 적었다가 사고가 났다 — 2026-08-05, 검색 상한만 8로 올리고
 * 어댑터(lib/sources/kosis.ts)는 3단에 머물러 `err 20 필수요청변수값 누락`이
 * 났다("취업자수 산업별" KOSIS 42건 중 36건 조회 불가, 그중 1건이 순위 2위).
 * KOSIS OpenAPI가 받는 최대치는 objL8이다.
 */
export const KOSIS_OBJ_LEVELS = 8;

/**
 * 자르는 대상: KOSIS 분류차수별 항목 수 (objL1, objL2, … 순).
 * 배열 길이는 위 KOSIS_OBJ_LEVELS에서 파생한다 — 손으로 적으면 어긋난다.
 * 앞 차수일수록 조합에 미치는 영향이 크므로 앞만 넉넉히 준다.
 */
export const KOSIS_OBJ_CAPS = Array.from({ length: KOSIS_OBJ_LEVELS }, (_, i) =>
  i === 0 ? 6 : i === 1 ? 2 : 1
);

/** 자르는 대상: KOSIS 표 하나가 만들어내는 항목 조합 수 */
export const KOSIS_COMBOS_PER_TABLE = 24;

/** 자르는 대상: FRED 검색어 1개가 가져오는 시리즈 수 (FRED는 표→항목 구조가 없다) */
export const FRED_RESULTS_PER_QUERY = 48;

/**
 * 자르는 대상: 폭주 방지용 소스별 절대 상한.
 *
 * **정상 경로에서는 절대 걸리면 안 된다.** 이게 걸리는 순간 표가 늘수록 표당
 * 몫이 줄어, 검색어를 넓힌 결과가 기존 결과를 밀어내는 역전이 되살아난다.
 * 최악값 계산: 표 후보 (ECOS_TABLE_FANOUT × 검색어 변형 2 + ECOS_ITEM_TABLE_FANOUT)
 * = 16개 × 표당 24건 = 384 < 600.
 */
export const SOURCE_RESULT_CEILING = 600;

/** 자르는 대상: 항목이 잘린 통계표를 안내문으로 몇 개까지 알릴지 */
export const TRUNCATION_NOTES_SHOWN = 5;

/**
 * 자르는 대상: 챗 플래너(모델)에게 넘기는 검색 결과 수.
 * 소스별 최소 몫을 먼저 확보한 뒤 자른다 — 소스 순서대로 이어붙여 자르면
 * ECOS가 칸을 다 먹어 KOSIS·FRED 후보가 모델 눈에 들어오지 않는다.
 *
 * 30에서 18로 낮췄다(2026-08-05). 도구 결과는 **이후 모든 라운드의 프롬프트에
 * 누적**돼서, 탈출구까지 가는 연쇄 질의에서 프롬프트가 25k~27k 토큰이 됐다
 * (조직 gpt-4o 30k TPM의 85~90% → 429 → 백오프 → 응답 27~29초 → HTTP 502).
 * 화면 검색(/api/search)은 이 상한과 무관하게 전량 그대로 받는다.
 */
export const CHAT_RESULT_CAP = 18;

/** 자르는 대상: list_table_items가 그룹당 나열하는 항목 수 (표 안을 열어볼 때) */
export const TABLE_ITEMS_PER_GROUP = 40;

// ── LLM 검색 보조 (lib/search-llm.ts) ──────────────────────────
/**
 * 문자열 대조만으로는 "한국 대출금리랑 미국 모기지금리 비교" 같은 다국가·문장형
 * 질의가 구조적으로 안 잡힌다(한글이 FRED로 새고, 후보 정렬 기준이 없다).
 * 그래서 ① 소스별 검색어를 **추가로** 제안하고 ② 후보 순서를 조정하는 두 가지를
 * LLM에 맡긴다.
 *
 * **LLM은 넓히는 데만 쓴다.** 2026-08-05 실측에서 "필요 없는 소스는 빼라"고
 * 시켰더니 ON이 OFF보다 결과가 좁아지는 역전이 났다(생산자물가 세부품목
 * ON 36건 / OFF 96건 등). 지금은 원문 검색이 항상 별도로 돌고 LLM 결과는
 * 거기에 더해지므로, ON은 언제나 OFF의 상위집합이다
 * (scripts/search-ab-check.py가 이 불변조건을 측정한다).
 */

/** 보조 호출용 모델 — 플래너(OPENAI_MODEL)와 별개. 값싸고 빠른 쪽을 쓴다 (서버 전용) */
export const SEARCH_LLM_MODEL = process.env.OPENAI_SEARCH_MODEL || "gpt-4o-mini";

/** 자르는 대상: 선별 단계에서 LLM에게 보여주는 후보 수 (토큰 비용 상한) */
export const SEARCH_LLM_CANDIDATES = 60;

/** 질의당 LLM 보조 호출 결과 캐시 건수 (프로세스 메모리, 같은 질의 반복 시 0회 호출) */
export const SEARCH_LLM_CACHE_SIZE = 200;

/**
 * LLM 보조 캐시 수명(ms). 없으면 한 번 나온 오답이 인스턴스 수명 내내 고착된다.
 * 프롬프트·모델을 바꿔도 옛 답이 남는 것도 막는다. 기본 30분.
 */
export const SEARCH_LLM_CACHE_TTL_MS = positiveInt(
  process.env.SEARCH_LLM_CACHE_TTL_MS,
  30 * 60 * 1000
);

// ── 질의 토큰화 ────────────────────────────────────────────────
// 문장형 질의("… 중 기업대출, 가계대출의 전년대비 증감률")를 통째로 부분문자열
// 대조하면 어떤 통계표에도 걸리지 않는다. 조사·군더더기를 걷어낸 토큰 단위로
// 대조해야 "예금은행"·"대출금리"·"1.3.3.2.1"이 각각 표 이름에 걸린다.

/**
 * 검색어에서 걷어내는 말 — 어느 통계표에나 걸리거나(변별력 0) 지표가 아닌 표현.
 * 지표·기관을 가리키는 말은 절대 넣지 않는다(넣으면 그 지표를 못 찾게 된다).
 */
const QUERY_STOPWORDS = new Set([
  // 소스 이름 — 어느 표 이름에도 안 들어 있고, FRED에 그대로 보내면 잡음이 된다
  "ecos", "kosis", "fred", "api",
  // 변환 지시어
  "전년대비", "전년동기대비", "전년동월대비", "전기대비", "전월대비", "전분기대비",
  "증감률", "증가율", "상승률", "변화율", "증감", "원계열", "재기준화", "yoy", "pop", "qoq", "mom",
  // 요청 동사·군더더기
  "보여줘", "알려줘", "찾아줘", "그려줘", "뽑아줘", "달라", "해줘", "주세요",
  "비교", "비교해줘", "겹쳐", "겹쳐줘", "추이", "현황", "그래프", "차트", "데이터",
  "자료", "최근", "각각", "모두", "전부", "관련", "정도",
  // 연결어·형식어
  "그리고", "그리구", "이랑", "하고", "또는", "중에", "중에서", "대비", "기준",
]);

/** 기간 표현 — "5년치"·"3개월간"처럼 조회 구간을 뜻할 뿐 지표가 아니다 */
const PERIOD_TOKEN = /^\d+(년치|년간|개월치|개월간|일치|주치)$/;

/** 목차번호 — "1.3.3.2.1" 형태. 점을 살려야 표 이름의 목차와 대조된다 */
const TREE_TOKEN = /^\d+(\.\d+)+$/;

/** 토큰 끝에서 떼는 조사 (긴 것부터). 어간이 2자 미만이 되면 떼지 않는다 */
const PARTICLES = [
  "에서는", "으로는", "이라는", "에서", "으로", "까지", "부터", "라는", "에게",
  "의", "을", "를", "은", "는", "과", "와", "랑", "에", "로", "도", "만", "등", "중",
].sort((a, b) => b.length - a.length);

function stripParticle(t: string): string {
  if (!/[가-힣]$/.test(t)) return t;
  for (const p of PARTICLES) {
    if (t.endsWith(p) && t.length - p.length >= 2) return t.slice(0, -p.length);
  }
  return t;
}

/**
 * 질의 → 매칭용 토큰. 소문자화 → 구두점 분리 → 조사 제거 → 불용어·1자 토큰 제거.
 * 순서는 원문 등장순을 유지하고 중복은 제거한다.
 */
export function queryTokens(q: string): string[] {
  const out: string[] = [];
  for (const raw of q.toLowerCase().replace(/[^0-9a-z가-힣.]+/g, " ").split(/\s+/)) {
    let t = raw.replace(/^\.+|\.+$/g, "");
    if (!t) continue;
    if (!TREE_TOKEN.test(t)) t = t.replace(/\./g, "");
    t = stripParticle(t);
    if (t.length < 2) continue;
    if (QUERY_STOPWORDS.has(t) || PERIOD_TOKEN.test(t)) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * FRED에 보낼 검색어를 도출한다.
 *
 * FRED 카탈로그는 영문 전용이다. 한글이 섞인 원문을 그대로 보내면 결과 0건에
 * 응답만 15~17초까지 늘어져(2026-07-28 실측) 전체 검색을 지연시킨다. 그래서
 * **한글은 절대 그대로 보내지 않고**, 영문 토큰 + 용어집 변환분만 조립한다.
 * 조립 결과가 비면 null(FRED 건너뜀).
 *
 * 예) "ecos 1.3.3.2.1 예금은행 대출금리…" → ecos는 불용어, 목차번호는 숫자
 *     → 영문 토큰 없음 → 용어집 매칭분만 남거나 null. 한글이 FRED로 새지 않는다.
 */
export function isFredSearchable(q: string): boolean {
  return fredSearchQuery(q) !== null;
}

/**
 * 한글 거시 용어 → FRED 영문 검색어. 한글만으로 된 질의도 미국 데이터를
 * 탐색할 수 있게 하는 용어집 — 지표 정의가 아니라 검색어 변환 사전이므로
 * 여기(검색 설정 단일 소스)에 둔다. 채권 데스크에서 실제로 부르는 표현 기준.
 *
 * 매칭 규칙(fredSearchQuery): 긴 표현부터 대조하고, 매칭된 구간은 질의에서
 * 지운 뒤 계속한다 — "근원 소비자물가"가 잡히면 그 안의 "소비자물가"가
 * 중복으로 또 잡히지 않는다. 배열 순서는 가독성용 분류일 뿐 우선순위가 아니다.
 */
const FRED_KO_EN: [string, string][] = [
  // ── 물가 ──
  ["근원 소비자물가", "core consumer price index"],
  ["소비자물가", "consumer price index"],
  ["생산자물가", "producer price index"],
  ["수입물가", "import price index"],
  ["개인소비지출", "personal consumption expenditures"],
  ["슈퍼코어", "services less rent of shelter"],
  ["절사평균", "trimmed mean"],
  ["중위 물가", "median consumer price index"],
  ["기대인플레이션", "inflation expectations"],
  ["기대인플레", "inflation expectations"],
  ["브레이크이븐", "breakeven inflation"],
  ["물가연동", "treasury inflation indexed"],
  // ── 고용 ──
  ["실업률", "unemployment rate"],
  ["비농업", "nonfarm payrolls"],
  ["신규 실업수당", "initial claims"],
  ["실업수당", "unemployment insurance claims"],
  ["구인", "job openings"],
  ["경제활동참가율", "labor force participation rate"],
  ["시간당 임금", "average hourly earnings"],
  ["임금", "average hourly earnings"],
  ["고용비용", "employment cost index"],
  ["고용", "employment"],
  // ── 성장·실물 ──
  ["산업생산", "industrial production"],
  ["설비가동률", "capacity utilization"],
  ["내구재 주문", "durable goods orders"],
  ["공장주문", "factory orders"],
  ["소매판매", "retail sales"],
  ["개인소득", "personal income"],
  ["경기선행지수", "leading index"],
  ["재고", "business inventories"],
  // ── 심리·서베이 ──
  ["소비자심리", "consumer sentiment"],
  ["소비자신뢰", "consumer confidence"],
  ["미시간", "michigan consumer sentiment"],
  ["중소기업 낙관", "small business optimism"],
  ["제조업지수", "manufacturing index"],
  ["필라델피아 연은", "philadelphia fed manufacturing"],
  ["엠파이어", "empire state manufacturing"],
  // ── 금리·크레딧 ──
  ["기준금리", "federal funds rate"],
  ["장단기", "yield spread"],
  ["국채", "treasury yield"],
  ["모기지금리", "mortgage rate"],
  ["하이일드", "high yield spread"],
  ["크레딧 스프레드", "credit spread"],
  ["회사채 스프레드", "corporate bond spread"],
  ["회사채", "corporate bond yield"],
  // ── 주택 ──
  ["주택착공", "housing starts"],
  ["주택허가", "building permits"],
  ["신규주택판매", "new home sales"],
  ["기존주택판매", "existing home sales"],
  ["케이스실러", "case shiller home price"],
  ["주택가격", "home price index"],
  ["주택", "housing"],
  // ── 대외·재정 ──
  ["무역수지", "trade balance"],
  ["경상수지", "current account"],
  ["수출", "exports"],
  ["수입", "imports"],
  ["재정적자", "federal budget deficit"],
  ["국가부채", "federal debt"],
  // ── 통화·유동성 ──
  ["통화량", "money stock M2"],
  ["연준 총자산", "fed total assets"],
  ["역레포", "reverse repurchase"],
  ["은행 대출", "bank credit"],
  // ── 달러·원자재 ──
  ["달러인덱스", "dollar index"],
  ["환율", "exchange rate"],
  ["국제유가", "crude oil price"],
  ["유가", "crude oil price"],
  ["금값", "gold price"],
  ["천연가스", "natural gas price"],
  ["구리", "copper price"],
  // ── 기타 ──
  ["경기침체", "recession"],
];

/** 긴 표현 우선 정렬본 — 모듈 로드 시 1회 계산 */
const FRED_KO_EN_BY_LENGTH = [...FRED_KO_EN].sort((a, b) => b[0].length - a[0].length);

/**
 * 질의 → FRED 검색어. 영문 토큰(불용어 제외)과 한글 용어집 변환분을 합친다.
 * 한글은 결과에 남기지 않는다 — 남기면 0건 + 장시간 지연이 된다.
 */
export function fredSearchQuery(q: string): string | null {
  const terms: string[] = queryTokens(q).filter((t) => /[a-z]/.test(t));
  let rest = q;
  for (const [ko, en] of FRED_KO_EN_BY_LENGTH) {
    if (!rest.includes(ko)) continue;
    if (!terms.includes(en)) terms.push(en);
    rest = rest.split(ko).join(" "); // 매칭 구간 소거 — 긴 표현 안의 짧은 표현 중복 방지
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
