/**
 * 내가 만든 경제지표 모델·앱 바로가기 레지스트리 — 단일 소스.
 * 페이지는 이 목록에서 파생만 하고(그룹·개수·라벨 포함) 별도 하드코딩을 두지 않는다.
 * URL은 실응답 검증된 값이므로 변경 시 반드시 재검증할 것.
 */

/** web = 배포된 웹앱(바로 사용), repo = 저장소만(로컬 실행 모델) */
export type ModelKind = "web" | "repo";

export interface ModelLink {
  id: string;
  name: string;
  description: string;
  url: string;
  kind: ModelKind;
  /** 접근 조건 등 부가 표기 (있을 때만 뱃지로 노출) */
  note?: string;
}

export const models: ModelLink[] = [
  {
    id: "bond-desk",
    name: "채권 데스크",
    description: "펀더멘털·통화정책·수급·밸류에이션·이벤트를 모아 낸 AI 결론 초안 — 확정은 사람이",
    url: "https://bond-desk.vercel.app",
    kind: "web",
  },
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
