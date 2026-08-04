/**
 * 차트 조합 파라미터 — 단일 소스.
 *
 * 서버(app/api/chat/route.ts의 계획 검증)와 클라이언트(app/page.tsx의 선택 UI)가
 * 같은 값을 써야 한다. 종전에는 두 파일에 각각 `const MAX_SERIES = 4`가 박혀 있어
 * 한쪽만 올리면 다른 쪽이 막았다. node 전용 모듈을 import하지 않는다.
 */

/**
 * 한 그림에 담을 수 있는 조회 계열 수.
 * 용도가 "한국·미국·기관 간 지표를 넘나들며 겹쳐 보기"라 4개로는 부족하다
 * (한·미 CPI + 한·미 정책금리만 해도 4개, 여기에 스프레드를 얹으면 초과).
 */
export const MAX_SERIES = 8;

/** 시리즈 간 파생 계산(스프레드·비율) 수. 계열과 별도로 차트에 얹힌다 */
export const MAX_DERIVED = 2;

/**
 * 계열 색 토큰 (app/globals.css의 --series-*).
 * 배열 길이가 MAX_SERIES + MAX_DERIVED 이상이어야 색이 순환하지 않는다.
 */
export const SERIES_VARS = [
  "--series-1",
  "--series-2",
  "--series-3",
  "--series-4",
  "--series-5",
  "--series-6",
  "--series-7",
  "--series-8",
];

/**
 * 선 파선 패턴 — 색만으로 8~10개를 구분하기는 어렵고 색약 사용자에게는 특히
 * 그렇다. 5번째부터 파선을 입혀 색과 무관한 두 번째 단서를 준다.
 * undefined = 실선.
 */
export const SERIES_DASH: (string | undefined)[] = [
  undefined,
  undefined,
  undefined,
  undefined,
  "6 3",
  "2 3",
  "10 3 2 3",
  "1 3",
];

/** i번째 계열의 색 토큰·파선 (배열을 넘기면 순환) */
export function seriesStyle(i: number): { colorVar: string; dash?: string } {
  return {
    colorVar: SERIES_VARS[i % SERIES_VARS.length],
    dash: SERIES_DASH[i % SERIES_DASH.length],
  };
}
