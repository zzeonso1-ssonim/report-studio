/**
 * 미 유동성 계열 — 웹앱이 쓰는 정의를 `scripts/liquidity/config.json`에서 파생한다.
 *
 * **FRED 시리즈 ID·한글 표시명·단위·환산계수를 이 파일에 다시 적지 않는다.**
 * 그 값들은 노션 유동성 워치 파이프라인(scripts/liquidity/*.py)의 단일 설정
 * 소스이고, 웹앱은 같은 파일을 읽어 지표 카탈로그와 /liquidity 프리셋을 만든다.
 * 두 곳이 같은 계열을 다르게 부르는 사고를 구조로 막는 것이 목적이다.
 *
 * 파이프라인과 다른 점 하나 — 파이썬은 원자료(백만 달러)를 담아 두고 표시할 때
 * `display.divide_by`를 적용하지만, 웹앱은 `/api/series/[id]`가 조회 직후
 * 나눠서 내려준다(IndicatorDef.divideBy). 차트가 같은 축에 놓이려면 단위가
 * 먼저 맞아야 하기 때문이다. 나눗셈 계수의 출처는 양쪽 모두 config다.
 */
import rawConfig from "@/scripts/liquidity/config.json";

// ── config 최소 스키마 ────────────────────────────────────────
// JSON을 통째로 추론시키면 배열 원소가 유니온이 돼 선택적 필드 접근이 막힌다.
// 웹앱이 실제로 읽는 부분만 선언하고 경계에서 한 번 단언한다.
interface RawDisplay {
  unit: string;
  divide_by: number;
  decimals: number;
}

interface RawSeries {
  id: string;
  label: string;
  gloss: string;
  expected_units: string;
  expected_frequency: string;
  display: RawDisplay;
  note: string;
  /** false면 잔액 표에서 빠지는 요인 분해 전용 계열 — 웹앱 카탈로그에도 넣지 않는다 */
  in_table?: boolean;
}

interface RawDerived {
  id: string;
  label: string;
  gloss: string;
  minuend: string;
  subtrahend: string;
  multiplier: number;
  round_to?: number;
  display: RawDisplay;
  note: string;
}

interface RawChartItem {
  key: string;
  kind: string;
  years?: number;
  weeks?: number;
  series?: { id: string; label_en: string }[];
  id?: string;
  zero_line?: boolean;
  claim: string;
  note: string;
}

interface RawConfig {
  as_of: string;
  series: RawSeries[];
  derived: RawDerived[];
  charts: { source_label: string; items: RawChartItem[] };
  factors: { target: string; unit: string; lookback: string };
  lookbacks: { key: string; label: string; basis: string }[];
}

const config = rawConfig as unknown as RawConfig;

/** config 기준일 — 화면에 "설정 기준일"로 병기한다 */
export const LIQUIDITY_CONFIG_AS_OF = config.as_of;

/** 출처 라벨 — 노션 브리핑 차트 캡션과 같은 문자열을 쓴다 */
export const LIQUIDITY_SOURCE_LABEL = config.charts.source_label;

// ── 계열 메타 ─────────────────────────────────────────────────

export interface LiquiditySeriesMeta {
  /** FRED 시리즈 ID (config에서 옴 — 여기서 만들지 않는다) */
  fredId: string;
  /** 웹앱 지표 레지스트리 id */
  indicatorId: string;
  /** 한글 표시명 (config.series[].label) */
  label: string;
  /** 한 줄 해설 (config.series[].gloss) */
  gloss: string;
  /** 함정 노트 (config.series[].note) — 주평균/잔액 구분 등 */
  note: string;
  /** 축·범례에 쓰는 단위 ("십억 USD" · "%") */
  unit: string;
  /** 시점 정의 ("주평균" · "일간" · "수요일 잔액") */
  qualifier: string;
  /** 원자료 → 표시단위 환산 제수 (백만 → 십억이면 1000) */
  divideBy: number;
  decimals: number;
  /** FRED 공표 주기 문자열 ("Weekly" · "Daily") */
  frequency: string;
}

/** 지표 레지스트리 id 규칙 — FRED ID에서 파생 (us_liq_wresbal 등) */
export function liquidityIndicatorId(fredId: string): string {
  return `us_liq_${fredId.toLowerCase()}`;
}

/**
 * `display.unit`은 "십억 USD, 주평균"처럼 단위와 시점 정의가 한 문자열에 있다.
 * 웹앱은 축 단위와 시점 정의를 나눠 써야 한다 — 단위 문자열이 다르면 자동
 * 이축 분리가 걸려 같은 십억 달러 계열이 좌·우로 찢어지기 때문이다.
 */
function splitDisplayUnit(u: string): { unit: string; qualifier: string } {
  const i = u.indexOf(",");
  if (i < 0) return { unit: u.trim(), qualifier: "" };
  return { unit: u.slice(0, i).trim(), qualifier: u.slice(i + 1).trim() };
}

/**
 * 카탈로그 등록 대상 — `in_table !== false`인 계열.
 * config가 "잔액 표에 싣는 계열"로 이미 구분해 둔 것을 그대로 쓴다(현재 12종).
 * 요인 분해 전용 8종은 노션 표에도 없고 웹앱에도 올리지 않는다.
 */
export const liquiditySeries: LiquiditySeriesMeta[] = config.series
  .filter((s) => s.in_table !== false)
  .map((s) => {
    const { unit, qualifier } = splitDisplayUnit(s.display.unit);
    return {
      fredId: s.id,
      indicatorId: liquidityIndicatorId(s.id),
      label: s.label,
      gloss: s.gloss,
      note: s.note,
      unit,
      qualifier,
      divideBy: s.display.divide_by,
      decimals: s.display.decimals,
      frequency: s.expected_frequency,
    };
  });

const seriesByFredId = new Map(liquiditySeries.map((s) => [s.fredId, s]));

function requireSeries(fredId: string): LiquiditySeriesMeta {
  const s = seriesByFredId.get(fredId);
  if (!s) {
    throw new Error(
      `유동성 계열 ${fredId}를 config.series에서 찾지 못했습니다 (in_table=false이거나 삭제됨)`
    );
  }
  return s;
}

/**
 * 챗 질의용 한국어 별칭 — 웹앱 전용이라 config가 아니라 여기 둔다.
 * (노션 브리핑 파이프라인은 별칭을 쓰지 않는다. 파이프라인 설정에 웹 UI 문자열을
 *  섞으면 금요일 정기 실행의 검증 대상이 늘어난다.)
 *
 * 주의 — 별칭은 `app/api/chat`의 aliasViolation이 **질의 문자열 부분일치**로
 * 강제한다. 다른 지표의 별칭을 부분문자열로 포함하면 두 지표가 같이 끌려온다.
 * 예: IORB에 "지준부리금리"를 넣으면 "지준"(WRESBAL)까지 강제된다 → 쓰지 않는다.
 */
const LIQUIDITY_ALIASES: Record<string, string[]> = {
  WRESBAL: ["지준", "지급준비금", "미국 지준", "연준 지준"],
  RRPONTSYD: ["ON RRP", "역레포", "역RP"],
  WTREGEN: ["TGA", "재무부 일반계정", "미 재무부 계정"],
  WALCL: ["연준 전체 자산", "연준 총자산", "연준 대차대조표"],
  TREAST: ["SOMA 국채", "SOMA 미 국채", "연준 국채 보유"],
  WSHOMCB: ["SOMA MBS", "연준 MBS", "MBS 보유"],
  WLCFLL: ["연준 대출", "재할인창구", "할인창구"],
  WCURCIR: ["유통통화"],
  RPONTSYD: ["SRF", "상비 레포", "스탠딩 레포"],
  SOFR: ["SOFR"],
  EFFR: ["EFFR"],
  IORB: ["IORB", "준비금 이자율", "준비금 부리금리"],
};

// 별칭 키가 config에서 사라지면 조용히 죽는 대신 빌드에서 터뜨린다.
for (const fredId of Object.keys(LIQUIDITY_ALIASES)) {
  requireSeries(fredId);
}

export function liquidityAliases(fredId: string): string[] {
  return LIQUIDITY_ALIASES[fredId] ?? [];
}

// ── /liquidity 프리셋 ─────────────────────────────────────────

export interface LiquidityGroupSeries {
  indicatorId: string;
  /** 범례·표에 쓰는 이름 — "지급준비금 (주평균)" */
  name: string;
  label: string;
  qualifier: string;
  note: string;
  unit: string;
}

export interface LiquidityGroup {
  key: string;
  /** levels=수준 추이 · delta=주간 증감 막대 · spread=파생 스프레드 */
  kind: "levels" | "delta" | "spread";
  title: string;
  /** 축 단위 — "십억 USD" · "십억 USD, 주간 변동" · "bp" */
  unit: string;
  defaultYears: number;
  /** 이 차트의 주장 한 문장 (config의 charts.items[].claim) */
  claim: string;
  /** 주의 한 줄 (config의 charts.items[].note) */
  note: string;
  /** 조회할 시리즈 — 스프레드도 원계열 둘을 그대로 받는다 */
  series: LiquidityGroupSeries[];
  zeroLine?: boolean;
  /** kind=spread일 때의 계산 사양 — 값은 코드가 계산한다(모델 아님) */
  spread?: {
    minuendId: string;
    subtrahendId: string;
    multiplier: number;
    roundTo: number;
    name: string;
  };
  /** kind=delta일 때 막대 이름 — "지급준비금 1주 대비" */
  deltaName?: string;
}

function groupSeries(fredId: string): LiquidityGroupSeries {
  const s = requireSeries(fredId);
  return {
    indicatorId: s.indicatorId,
    name: `${s.label}${s.qualifier ? ` (${s.qualifier})` : ""}`,
    label: s.label,
    qualifier: s.qualifier,
    note: s.note,
    unit: s.unit,
  };
}

function chartItem(key: string): RawChartItem {
  const it = config.charts.items.find((c) => c.key === key);
  if (!it) throw new Error(`config.charts.items에 ${key}가 없습니다`);
  return it;
}

function derivedSpec(id: string): RawDerived {
  const d = config.derived.find((x) => x.id === id);
  if (!d) throw new Error(`config.derived에 ${id}가 없습니다`);
  return d;
}

function lookbackLabel(key: string): string {
  const lb = config.lookbacks.find((l) => l.key === key);
  if (!lb) throw new Error(`config.lookbacks에 ${key}가 없습니다`);
  return lb.label;
}

/** 주간 증감 막대의 기본 기간 — 노션 브리핑의 12주 차트보다 길게 본다(웹 전용 결정) */
const RESERVE_DELTA_DEFAULT_YEARS = 1;

/**
 * 주간 증감 차트의 주장 — config.charts에는 이 차트가 없어(노션은 12주 요인
 * 분해를 쓴다) 웹 전용 문안을 여기 둔다. 서술만 하고 시장 함의는 담지 않는다.
 */
const RESERVE_DELTA_CLAIM =
  "지급준비금의 주간 증감 부호와 크기만 보여준다 — 관측된 잔고 변동의 기술이며 금리 방향·시장 함의는 담지 않는다.";

const RESERVE_DELTA_NOTE =
  "직전 관측치와의 차(H.4.1 주평균 기준)를 코드가 계산한 값이다. 관측이 빠진 주가 있으면 그 구간은 두 주치 변동이 한 막대에 합쳐진다.";

/** 화면 상단 기간 버튼 — 대문(app/page.tsx)과 같은 프리셋 */
export const LIQUIDITY_YEAR_PRESETS = [1, 3, 5, 10] as const;

export function liquidityGroups(): LiquidityGroup[] {
  const levels = chartItem("levels");
  const levelSeries = (levels.series ?? []).map((s) => groupSeries(s.id));
  const levelUnits = [...new Set(levelSeries.map((s) => s.unit))];

  const target = requireSeries(config.factors.target);

  const spreadChart = chartItem("sofr_iorb");
  const spread = derivedSpec(spreadChart.id ?? "");
  const spreadUnit = splitDisplayUnit(spread.display.unit);

  return [
    {
      key: levels.key,
      kind: "levels",
      title: `${levelSeries.map((s) => s.label).join(" · ")} 수준 추이`,
      unit: levelUnits.join(" · "),
      defaultYears: levels.years ?? 3,
      claim: levels.claim,
      note: levels.note,
      series: levelSeries,
    },
    {
      key: "reserve_delta",
      kind: "delta",
      title: `${target.label} 주간 증감`,
      unit: config.factors.unit,
      defaultYears: RESERVE_DELTA_DEFAULT_YEARS,
      claim: RESERVE_DELTA_CLAIM,
      note: RESERVE_DELTA_NOTE,
      series: [groupSeries(target.fredId)],
      deltaName: `${target.label} ${lookbackLabel(config.factors.lookback)}`,
      zeroLine: true,
    },
    {
      key: spreadChart.key,
      kind: "spread",
      title: spread.label,
      unit: spreadUnit.unit,
      defaultYears: spreadChart.years ?? 1,
      claim: spreadChart.claim,
      note: spread.note,
      series: [groupSeries(spread.minuend), groupSeries(spread.subtrahend)],
      zeroLine: spreadChart.zero_line ?? false,
      spread: {
        minuendId: liquidityIndicatorId(spread.minuend),
        subtrahendId: liquidityIndicatorId(spread.subtrahend),
        multiplier: spread.multiplier,
        roundTo: spread.round_to ?? 2,
        name: spread.label,
      },
    },
  ];
}
