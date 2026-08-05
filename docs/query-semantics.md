# 한글 질의 → 차트 파이프라인 구조 (2026-08-04 갱신)

"문제 생길 때마다 하나씩 고치는" 방식을 끝내기 위한 구조 문서.
질의가 차트가 되기까지의 단계와, 어긋났을 때 **어디 한 줄을 고치는지**를 적는다.

## 파이프라인

```
한국어 질의
  │ ①매칭        gpt-4o + list_indicators(name·aliases) / search_catalog / list_table_items
  ▼
카탈로그 검색     lib/search.ts searchAll — 3단
  │ ①-a 넓히기   원문 검색은 항상 실행 + LLM이 소스별 검색어를 **추가** (planSourceQueries)
  │              "한국 대출금리랑 미국 모기지금리" → ecos:"예금은행 대출금리" / fred:"mortgage rate"
  │              LLM은 소스를 지우지 못한다 → ON은 언제나 OFF의 상위집합
  │ ①-b 확장     표 선정 = 표 이름 + 목차번호 + **항목명 색인**(data/ecos-item-names.json)
  │              세부항목은 질의 관련도 순 정렬 후 **표당** 상한, 표·소스 단위 라운드로빈
  │              잘린 표는 truncated로 드러냄
  │ ①-c 선별     LLM이 질의에 맞는 후보를 앞으로 재정렬 (rankByRelevance, 후보를 버리지 않음)
  ▼
조회 계획(plan)   series[indicatorId|source+params] + derived + transform + 기간
  │ ②강제        aliasViolation: 질의에 별칭이 있는데 그 지표를 안 쓰면 계획 반려
  │              dedupe: 중복 시리즈 제거 (전부 app/api/chat/route.ts)
  ▼
시리즈 조회       app/api/series/[id] · adhoc
  │ ③시맨틱      resolveTransform(lib/transforms.ts) — 등록 지표는 kind=rate,
  │              검색 계열은 단위 문자열("연리%"·"％"·"Percent")로 판정해
  │              yoy/pop을 %p 차(yoy_diff)로 대체하고 그 사실을 note로 알림
  │              이미 변화율 단위("% Chg.") → 원계열 강등 (이중 변환 금지)
  │              yoy류는 1년 선행 조회 후 구간 잘라내기 (왼쪽 공백 방지)
  │              날짜 정규화: D=YYYY-MM-DD·M=YYYY-MM·Q=YYYY-Qn·A=YYYY (lib/dates.ts)
  ▼
클라이언트 병합    app/page.tsx
  │ ④정렬        주기가 섞이면 성긴 주기로 평균 환산 (일간→월평균, 월+분기→분기평균)
  │ ⑤축          표시 단위가 2종 이상이면 최다 단위를 좌축, 나머지를 우축으로 분리
  │              (3종 이상이면 우축을 공유하고 재기준화를 권하는 안내를 함께 표시)
  │              파생(스프레드=a−b·비율)은 코드가 계산, 단위도 코드가 결정(%p)
  │              역축 토글(좌축·우축 반전) 버튼
  ▼
차트 (ComposedChart, 최대 8계열 + 파생 2, 5번째부터 파선 병용)
```

## LLM 보조 (2026-08-04 신설)

문자열 부분문자열 대조만으로는 다국가·문장형 질의가 구조적으로 안 잡혀서
검색 앞뒤에 LLM 단계를 붙였다. **판단만 맡기고 숫자는 만들지 않는다.**

- 모델: `SEARCH_LLM_MODEL`(`gpt-4o-mini`, 플래너의 `OPENAI_MODEL`과 별개). **개발·검증 경로에서는 환경변수 재정의를 받지 않고 고정**이며, `OPENAI_SEARCH_MODEL`은 `NODE_ENV=production`에서만 먹는다 (2026-08-05, 개발 루프가 청구서가 되는 것을 막기 위해)
- 호출: 질의 1건당 최대 2회(검색어 제안 1 + 정렬 1). 같은 입력은 캐시로 0회(TTL 30분, 실패는 캐시 안 함)
- 실패·미설정·시간초과(`SEARCH_LLM_TIMEOUT_MS`, 기본 4초)면 **전부 문자열 경로로 폴백**
- 끄기: 환경변수 `SEARCH_LLM=off`, 요청 단위로는 `/api/search?q=…&llm=off`
- **불변조건: ON은 OFF의 상위집합.** LLM에 소스 제거 권한을 줬더니 결과가 좁아지는 역전이 났다
  (2026-08-05: 생산자물가 세부품목 ON 36건 / OFF 96건). `scripts/search-ab-check.py`로 상시 측정한다.
  건수만 보면 부족하다 — 건수가 같아도 **다른 항목으로 바뀌는** 누수가 실제로 있었다
  (통안증권·국민주택채권·CD·KORIBOR). 원인은 정렬이 아니라 **선택**이었다: LLM 힌트가
  원문 점수 0인 동점 항목의 순서를 갈라, Group 상한(20)에 걸리는 27항목 표에서 살아남는
  항목이 달라졌다. 그래서 표 확장을 **원문 토큰만으로 한 번 + 힌트를 더해 한 번** 돌려
  합집합을 낸다(`expandEcosTable`·`expandKosisTable`의 `pass()`). 스크립트도 집합 포함을 검사한다

## 조용한 실패를 드러내는 자리

| 무엇이 조용히 죽는가 | 어디서 드러나는가 |
|---|---|
| ECOS 항목명 색인 부재 → 항목명 매칭 전면 중단 | `/api/health`(503 + reason), `/api/search`의 `errors`·`indexStatus` |
| 색인 기준일이 오래됨 | `/api/health`·`/api/search`의 `indexStatus.builtAt` |
| ECOS 항목조회 실패(3분 300회 한도 등) | `/api/search`의 `errors`에 표 이름과 함께 |
| KOSIS 원격 검색 0건 → 축약 재검색 | `/api/search`의 `notes`에 "…로 좁혀 찾았습니다" |
| 표 항목이 잘림 | `/api/search`의 `truncated`·`notes`, 챗 도구의 `truncatedTables` |

## 원칙

- **모델은 숫자·단위를 만들지 않는다.** 계산(변환·파생·평균·축)은 전부 코드.
- **모델은 설득이 아니라 강제로 다룬다.** 프롬프트 지시는 참고용이고,
  정합성은 검증기(반려·dedupe·kind 대체)가 보장한다. gpt-4o-mini에서
  프롬프트만으로 안 고쳐지는 것을 실측으로 확인했다(2026-08-01).
- **지표의 진실은 lib/indicators.ts 한 곳.** 소스코드·별칭·성격(kind)·
  노출 여부(featured)가 전부 여기서 파생된다.

## 증상별 수리 지점 (대부분 1줄)

| 증상 | 고치는 곳 |
|---|---|
| 한국어 표현을 엉뚱한 지표로 해석 | `lib/indicators.ts` 해당 지표 `aliases`에 표현 추가 + 배터리 문항 추가 |
| 순수 한글 검색이 미국 통계를 못 찾음 | LLM 분해가 1차 해법. 폴백 경로는 `lib/search-config.ts` `FRED_KO_EN`에 [한글, 영문] 추가 |
| 표 안의 세부 항목을 못 찾음(검색에 안 나옴) | 상한 문제. `lib/search-config.ts`의 `ECOS_GROUP_ITEM_CAPS`·`ECOS_COMBOS_PER_TABLE`. 챗은 `list_table_items`로 표를 직접 연다 |
| 한 소스만 나오고 다른 나라가 0건 | 소스 편향. `capWithSourceFloor`(챗)·`interleave`(검색) 확인 |
| 문장형 질의가 0건 | 토큰화 문제. `lib/search-config.ts`의 `QUERY_STOPWORDS`·`PARTICLES` |
| 새 지표를 주요지표에 넣고 싶다 | `lib/indicators.ts`에 엔트리 추가 (반드시 실호출 검증 후 `verified: true`) |
| 주요지표 화면이 복잡하다 | 해당 지표 `featured: false` (챗 조회는 유지됨) |
| 전년대비가 이상한 값(비율 폭등) | 해당 지표 `kind`가 맞는지 확인 — rate면 %p 차로 자동 대체됨 |
| 두 시리즈가 겹치지 않음(값 하나만) | 주기 확인 — ④가 자동 처리. 새 주기면 `CYCLE_RANK`/`bucketDate` |
| 축이 이상하게 붙음 | 단위(unit) 표기 확인 — ⑤는 표시 단위 문자열로 그룹핑한다 |
| 조회 안 한 지표가 차트에 낌 | 이전 챗 질의의 선택이 남은 것 — 수동 패널의 "질의 선택" 칩(비노출 지표 포함, 2026-08-02 신설)에서 ×로 제거. 챗 질의는 항상 선택을 통째로 교체한다 |

## 검증 스크립트

**기본 실행은 무과금이다** (2026-08-05). 아래 파이썬 스크립트는 플래그 없이 돌리면
`scripts/fixtures/`에 저장된 응답을 호출 순서대로 재생하고 네트워크를 한 번도 쓰지 않는다
(`scripts/verify_common.py`). 실제 서버·OpenAI를 부르는 것은 `--live`뿐이며, **그 실행이
통과해야 픽스처가 갱신된다.** 픽스처가 없거나 요청 순서가 어긋나면 통과가 아니라 실패다.
개발 루프가 그대로 청구서가 되던 것을 끊기 위한 구조다.

| 스크립트 | 무엇을 지키는가 | 통과 기준 |
|---|---|---|
| `scripts/korean-query-battery.py` | 한국어 표현 → 지표 해석 + **눈금 4개**(정답률·라운드·비용·시간) | **3회 연속** 전항목 PASS (모델 응답이 비결정적이라 1회는 표본이 아니다) |
| `scripts/e2e-query-check.py` | 계획이 아니라 **값**이 나오는가 | 전 계열이 값 반환 + 시점 표기 |
| `scripts/search-ab-check.py` | LLM이 검색을 좁히지 않는가 | **건수·소스별 건수·집합 포함** 3가지 모두 통과(ON이 OFF의 상위집합) |
| `scripts/build-ecos-item-index.mjs` | 항목명 색인 갱신 | ECOS 3분 300회 한도 준수(60초당 90회 페이싱) |
| `scripts/index-missing-check.py` | 색인이 빠졌을 때 **신호와 복구** | 503+사유, errors 신호, 재시작 없이 복구 |

별칭·용어집을 고치면 배터리 문항도 같이 추가한다. OpenAI TPM 한도 때문에 문항당 25초 페이싱
(`--live`에서만 기다린다).

### 눈금 4개 — "돈을 더 썼는데 나아졌나"에 답하기 위한 것

배터리는 실행마다 **정답률 / 라운드 평균·최대 / 질의당 비용(USD) / 응답시간**을 함께 낸다
(`scripts/battery_metrics.py`). 2026-08-01에 플래너를 `gpt-4o-mini`→`gpt-4o`로 올리며 단가를
크게 높였는데 나아졌다는 증거를 남기지 않았던 것이 계기다.

- **라운드 수가 핵심 대리지표다.** `/api/chat`은 지표를 못 찾으면 도구 호출 라운드를 더 태우고,
  도구 결과는 이후 모든 라운드 프롬프트에 누적된다 — 즉 **검색 결손이 곧 비용**이다.
- 숫자의 출처는 서버 계측(`lib/llm-usage.ts`)이 `/api/chat` 응답 `usage`에 실어 보내는
  `rounds`·`llmCalls`·`elapsedMs`·모델별 토큰(캐시 적중분 포함)이다.
- 요금표는 `scripts/verify-config.json`에 출처·확인일과 함께 둔다(코드에 박지 않는다).
- 모델 A/B는 서버를 `OPENAI_MODEL=<모델> npx next dev …`로 띄워 같은 배터리를 돌린다.
  ※ `gpt-5`는 `temperature=0`을 거부한다(2026-08-05 실측, HTTP 400 `unsupported_value`).
  라우트가 온도를 무조건 보내므로 **현 코드로는 gpt-5 배터리를 돌릴 수 없다.**

## 남은 구조적 한계 (알고 있는 것)

- 별칭 강제는 부정 표현("슈퍼코어 **빼고**")을 구분하지 못한다 — 드묾, 수동 제거 가능.
- 아파트 지수 지역은 전국·서울만 등록 — 다른 지역은 모델이 되묻도록 프롬프트 지시.
- KRX 어댑터는 10년국채선물지수만 사용(영업일 순회 느림) — 장기 시계열 요청 시 느릴 수 있음.
- FRED 검색은 인기순 상위라 정확한 시리즈가 뒤로 밀릴 수 있음 — 자주 쓰면 지표로 등록하는 게 정석.
