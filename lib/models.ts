/**
 * 내가 만든 경제지표 모델·앱 바로가기 레지스트리 — 단일 소스.
 * 페이지는 이 목록에서 파생만 하고(그룹·개수·라벨 포함) 별도 하드코딩을 두지 않는다.
 * URL은 실응답 검증된 값이므로 변경 시 반드시 재검증할 것.
 */

/** web = 배포된 웹앱(바로 사용), repo = 저장소만(로컬 실행 모델) */
export type ModelKind = "web" | "repo";

/**
 * 카드에 함께 보일 수치 — health JSON의 점경로와 라벨.
 * 경로가 없거나 값이 수치/문자열이 아니면 그 항목만 조용히 빠진다(전체는 살린다).
 */
export interface ModelHealthMetric {
  /** health JSON 내 점경로 (예: "nodes.done") */
  path: string;
  label: string;
}

/**
 * 모델이 공개한 가벼운 상태 엔드포인트 규약.
 *
 * 필수는 `generated_at`(기준일) 하나다 — 이 팀은 기준일 없는 수치를 화면에 내지 않는다.
 * 무거운 전체 데이터 엔드포인트를 여기에 넣지 말 것(모바일에서 본다).
 */
export interface ModelHealth {
  /** ModelLink.url 기준 상대 경로 — 호스트를 두 번 적지 않는다 */
  path: string;
  /** 응답 기준일(ISO8601)이 담긴 점경로 */
  generatedAtPath: string;
  /** 카드에 함께 보일 지표 (없으면 기준일만 표시) */
  metrics?: ModelHealthMetric[];
  /**
   * 사람 확정 게이트 플래그의 점경로. true=확정, false=미확정 초안.
   * 있으면 확정 여부 뱃지를 낸다 — AI 결론을 확정처럼 보이게 두지 않기 위한 필수 표기.
   */
  confirmedPath?: string;
  /** 미확정(초안) 상태일 때 붙는 문구 */
  draftLabel?: string;
  /** 확정 상태일 때 붙는 문구 */
  confirmedLabel?: string;
}

export interface ModelLink {
  id: string;
  name: string;
  description: string;
  url: string;
  kind: ModelKind;
  /** 접근 조건 등 부가 표기 (있을 때만 뱃지로 노출) */
  note?: string;
  /** 선언한 모델만 카드에 실시간 상태 줄이 붙는다 (없으면 기존과 동일한 링크 카드) */
  health?: ModelHealth;
}

export const models: ModelLink[] = [
  {
    id: "cpi-nowcast",
    name: "CPI 나우캐스트",
    description: "소비자물가 단기전망·추정 엔진",
    url: "https://cpi-web-five.vercel.app",
    kind: "web",
  },
  {
    id: "gdp-nowcast",
    name: "GDP 나우캐스트",
    description: "분기 실질 GDP 나우캐스팅",
    url: "https://gdp-nowcast-web.vercel.app",
    kind: "web",
  },
  {
    id: "bok-stance-lab",
    name: "BOK 스탠스 랩",
    description: "한국은행 커뮤니케이션 스탠스 분석",
    url: "https://bok-stance-lab.vercel.app",
    kind: "web",
  },
  {
    id: "fomc-dissent-lab",
    name: "FOMC 소수의견 대시보드",
    description: "소수의견·문서 톤·문구 diff·유사 사례 (2000~현재)",
    url: "https://fomc-dissent-lab.vercel.app",
    kind: "web",
  },
  {
    id: "bond-monitor",
    name: "채권 모니터",
    description: "채권 시장 모니터링",
    url: "https://bond-monitor-kappa.vercel.app",
    kind: "web",
  },
  {
    id: "daai",
    name: "DAAI (채권 AI 운용 OS)",
    description: "MP 스코어링·운용",
    url: "https://daishin-ai-research.vercel.app",
    kind: "web",
    note: "팀 공유 · 로그인 필요",
  },
  {
    id: "bond-desk",
    name: "채권 판단 데스크 (bond-desk)",
    description:
      "펀더멘털·통화정책·수급·밸류에이션·이벤트 근거를 모아 AI가 잠정 결론 초안 — 확정은 사람이",
    url: "https://bond-desk.vercel.app",
    kind: "web",
    note: "매일 07:40 KST 갱신",
    health: {
      path: "/api/health",
      generatedAtPath: "generated_at",
      metrics: [
        { path: "nodes.done", label: "노드" },
        { path: "cards", label: "카드" },
      ],
      confirmedPath: "confirmed",
      draftLabel: "AI 초안 · 미확정",
      confirmedLabel: "사람 확정됨",
    },
  },
];

/**
 * 그룹 표기 — 페이지의 섹션 제목·설명·뱃지가 모두 여기서 파생된다.
 * repo 그룹은 현재 항목이 0개다(비공개 저장소 링크 제거, 2026-08-03).
 * 항목이 없는 그룹은 modelsByKind()가 걸러내므로 빈 섹션은 렌더되지 않는다.
 */
export const modelKindMeta: Record<
  ModelKind,
  { label: string; badge: string; hint: string }
> = {
  web: {
    label: "웹앱",
    badge: "웹",
    hint: "배포된 앱 — 클릭하면 바로 열려요",
  },
  repo: {
    label: "저장소만 (로컬 실행 모델)",
    badge: "저장소",
    hint: "GitHub 저장소 — 내려받아 로컬에서 실행해요",
  },
};

/** 레지스트리 정의 순서를 유지한 채 kind별로 묶는다 */
export function modelsByKind(): { kind: ModelKind; items: ModelLink[] }[] {
  return (Object.keys(modelKindMeta) as ModelKind[])
    .map((kind) => ({ kind, items: models.filter((m) => m.kind === kind) }))
    .filter((g) => g.items.length > 0);
}
