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
 * 한 그림에 동시에 그려질 수 있는 최대 계열 수 = 조회 계열 + 파생 계산.
 * 색·파선 배열이 이 길이 미만이면 순환이 일어나 서로 다른 계열이 같은 모양이 된다.
 */
export const MAX_PLOTTED = MAX_SERIES + MAX_DERIVED;

/**
 * 계열 색 토큰 (app/globals.css의 --series-*).
 * 배열 길이가 MAX_PLOTTED 이상이어야 색이 순환하지 않는다 — 주석만으로는
 * 지켜지지 않아 실제로 어긋난 적이 있으므로(길이 8 vs 필요 10, 9·10번째가
 * 1·2번째와 완전히 동일해짐) 파일 하단에서 모듈 로드 시 대조한다.
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
  "--series-9",
  "--series-10",
];

/**
 * 선 파선 패턴 — 색만으로 8~10개를 구분하기는 어렵고 색약 사용자에게는 특히
 * 그렇다. 5번째부터 파선을 입혀 색과 무관한 두 번째 단서를 준다.
 * undefined = 실선.
 *
 * 1~4번 색만 색약 검증(validate_palette)을 통과했고 5~10번은 검증을 다시
 * 돌리지 않았다. 따라서 5번 이후는 색 단독 구분에 의존하면 안 되며,
 * 파선 병용이 필수다 — 이 배열의 5~10번 자리를 undefined로 비우지 말 것.
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
  "12 4",
  "4 2 1 2",
];

// 불변조건 자기검증 — 배열을 늘리지 않고 MAX_SERIES·MAX_DERIVED만 올리는
// 실수를 빌드 시점에 잡는다. 이 모듈은 서버 라우트(app/api/chat/route.ts)와
// 클라이언트(app/page.tsx) 양쪽이 import하므로 `next build`에서 즉시 터진다.
if (SERIES_VARS.length < MAX_PLOTTED || SERIES_DASH.length < MAX_PLOTTED) {
  throw new Error(
    `chart-config 불변조건 위반: 색·파선 배열은 MAX_SERIES(${MAX_SERIES}) + MAX_DERIVED(${MAX_DERIVED}) = ${MAX_PLOTTED}개 이상이어야 합니다 ` +
      `(현재 SERIES_VARS=${SERIES_VARS.length}, SERIES_DASH=${SERIES_DASH.length}). ` +
      `app/globals.css의 --series-* 토큰도 라이트·다크 두 블록 모두에 함께 추가해야 합니다.`
  );
}
// 5번 이후 파선 누락도 같이 잡는다 (색 단독 구분 금지 규칙)
for (let i = 4; i < MAX_PLOTTED; i++) {
  if (!SERIES_DASH[i]) {
    throw new Error(
      `chart-config 불변조건 위반: ${i + 1}번째 계열에 파선이 없습니다 — ` +
        `5번 이후 색(--series-5~)은 색약 검증을 거치지 않아 파선 병용이 필수입니다.`
    );
  }
}

/** i번째 계열의 색 토큰·파선 (배열을 넘기면 순환) */
export function seriesStyle(i: number): { colorVar: string; dash?: string } {
  return {
    colorVar: SERIES_VARS[i % SERIES_VARS.length],
    dash: SERIES_DASH[i % SERIES_DASH.length],
  };
}
