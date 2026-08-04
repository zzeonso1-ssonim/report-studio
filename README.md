# 경제데이터 통합조회 (econ-cockpit)

한국·미국 공공 경제데이터 API를 한곳에 모아 **자연어로 조회**하는 개인용 웹앱.
메인 입력창에 "한국이랑 미국 CPI 전년동기대비 5년치 비교해줘"라고 치면 챗봇(OpenAI function calling)이 지표를 찾아 차트로 보여준다.

**배포: <https://econ-cockpit.vercel.app>** (비밀번호 로그인 필요 — 아래 [접근 보호](#접근-보호))

상세 스펙: [docs/PRD.md](docs/PRD.md) · 구조: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## 기능

- **자연어 조회** — gpt-4o 플래너(`OPENAI_MODEL`로 전환)가 등록 지표·전체 카탈로그를 도구 호출로 검색해 조회 계획 수립 (숫자 창작 금지, API 결과만 차트화). 도구는 `list_indicators` · `search_catalog` · `list_table_items`(통계표 안의 세부 항목 열기) · `finalize_plan`
- **전체 통계 검색** — ECOS 834개 통계표·KOSIS 통합검색·FRED를 실시간 검색, 미등록 지표도 바로 차트에.
  질의 원문 검색은 항상 그대로 돌고, 여기에 **LLM이 소스별 검색어를 추가**한다(예: "한국 대출금리랑 미국 모기지금리" → ecos:"예금은행 대출금리" / fred:"mortgage rate"). 후보는 질의 관련도 순으로 재정렬한다.
  **LLM은 넓히는 데만 쓰고 후보를 지우지 못한다** — ON 결과는 언제나 OFF의 상위집합이며, `scripts/search-ab-check.py`가 이 불변조건을 측정한다 ([docs/query-semantics.md](docs/query-semantics.md))
- **비교 차트** — 최대 8개 지표(+파생 2), 꺾은선·막대·영역 전환, 변환(전년동기대비·전기대비·재기준화), 단위별 좌·우축 자동 분리, PNG 다운로드
- **발표 캘린더** (`/calendar`) — 미국 FRED 자동 + 한국(금통위·CPI·GDP)·FOMC 공식 일정 시드 (시드는 연 1회 수동 갱신)
- **공시 검색** (`/disclosures`) — DART 회사명 검색(corp_code 캐시), 기간·유형 필터
- **내 모델 바로가기** (`/models`) — 직접 만든 경제모델·앱 링크 레지스트리(`lib/models.ts`, 현재 웹앱 5 · 저장소 2)
- **미 유동성 프리셋** (`/liquidity`) — 지준·ON RRP·TGA 수준(기본 3년), 지준 주간 증감(기본 1년), SOFR−IORB 스프레드(기본 1년). 계열·문안은 노션 유동성 워치와 같은 `scripts/liquidity/config.json`에서 파생 ([docs/liquidity-watch.md](docs/liquidity-watch.md) '웹앱 연결')

등록 지표는 `lib/indicators.ts`에 46개(한국 23 · 미국 23 — 이 중 미 유동성 12계열은 config 파생),
전부 포털 실응답으로 코드 검증됨(2026-08-02 기준). 목록은 [docs/PRD.md 6절](docs/PRD.md) 참조.

## 데이터 소스 (어댑터)

| 소스 | 기관 | 비고 |
|---|---|---|
| ECOS | 한국은행 | 기준금리·환율·GDP 등 |
| KOSIS | 통계청 | CPI 등 (키 base64 `=` 패딩 자동 보정) |
| KRX | 한국거래소 | 국고채 수익률·지수. 일별 확정치 영구 캐시(`<DATA_DIR>/krx`), 3y/10y 캐시 공유, 400영업일 단위 백필 |
| R-ONE | 한국부동산원 | 카탈로그 기반 범용 (통계표 738개) |
| DART | 금감원 | 공시검색 |
| FISIS | 금감원 | ⚠️ **미가동** — 어댑터는 구현(월 분할 호출·일 28/30회 안전한도·증분 적재 `<DATA_DIR>/fisis`)했으나 발급 키가 서버에서 `010 미등록 인증키`로 거부됨(2026-07-25 재확인). 등록 지표 없음, 정상 응답 파싱 경로 미검증 |
| FRED / BLS | 미 연준·노동통계국 | 미국 지표 + 발표 캘린더 |
| BEA | 미 경제분석국 | 자리표시자 (당분간 FRED 대체) |

KRX는 채권지수 서비스(`idx/bon_dd_trd`)가 미승인 상태지만 불필요 판단으로 추가 신청하지 않았다.

## 설계 원칙

- **원천기관 우선** — 중복 수록 지표는 작성기관 API, 재수록본은 fallback
- **지표 레지스트리 단일 소스** (`lib/indicators.ts`) — 하드코딩 금지, 지표·코드는 여기서만
- **검색 상한 단일 소스** (`lib/search-config.ts`) — 표당 항목·조합·모델 전달 건수의 상한을 전부 여기에 모은다. 상수마다 "무엇을 자르는지"를 주석으로 적는다.
  ECOS 검색가능 **608표 전수** 실측(2026-08-05): 착수 전에는 표의 **88.7%**에서 세부 항목이 잘렸고 전체 조합 1,056,975개 중 노출은 5,008개(**0.47%**)였다. 상한을 올린 뒤 69.1% / 11,234개(**1.06%**)다.
  **상한을 올리는 것으로는 해결되지 않는다** — 표당 상한 × 표 수가 산술 천장이다. 실질 해법은 아래 둘이다
- **항목명 색인** (`data/ecos-item-names.json`, `scripts/build-ecos-item-index.mjs`) — 표 이름에 없고 **항목 이름에만** 있는 계열에 닿는 경로. ECOS에서 국고채가 든 표의 이름은 "시장금리(일별)"이라, 색인이 없으면 "국고채 커브"는 ECOS 0건이 된다(실측). 런타임 생성은 ECOS 3분 300회 한도를 넘기므로 빌드 산출물로 커밋한다(608표, 약 780KB).
  갱신은 `.github/workflows/ecos-item-index.yml`(월 1회, 첫 주 일요일 19:00 UTC)이 맡는다 — **`ECOS_API_KEY` 시크릿을 저장소에 등록해야 동작한다.** 미등록이면 워크플로만 실패하고 앱은 마지막 커밋본으로 계속 돈다
- **탈출구** (`list_table_items` · `list_kosis_table_items`) — 검색은 언제나 일부만 보여주므로, 통계표를 직접 열어 모든 항목에 도달하는 경로를 둔다. 잘린 표는 검색 응답의 `truncated`로 드러내 모델이 "더 있다"는 사실을 알게 한다
- **조회 능력과 검색 상한은 한 상수에서 파생** — KOSIS 분류 차수는 `KOSIS_OBJ_LEVELS` 하나가 정하고 어댑터·검색이 함께 쓴다. 두 곳에 따로 적었다가 검색만 8단으로 열려 **조회하면 100% 실패하는 결과가 상위에 노출**됐다(2026-08-05)
- **조용한 품질 저하를 드러낸다** — 항목명 색인이 빠지면 검색이 수정 전으로 회귀하는데 겉으로는 "결과가 좀 적네"로만 보인다. `/api/health`가 `available`과 색인 **기준일(`builtAt`)**을 돌려주고, `/api/search` 응답의 `errors`·`indexStatus`에도 같은 신호가 실린다
- **차트 조합 단일 소스** (`lib/chart-config.ts`) — 계열 수 상한·색 토큰·파선을 서버(계획 검증)와 클라이언트(선택 UI)가 공유. 종전에는 `MAX_SERIES`가 두 파일에 따로 박혀 한쪽만 올리면 다른 쪽이 막았다
- **어댑터 계층** (`lib/sources/*`) — 인증·포맷·날짜표기 차이 흡수, 공통 `SeriesPoint[]` 반환
- **키는 서버 전용** — `.env.local` 환경변수만, 클라이언트 미노출 ([.env.example](.env.example) 참고 — 공공데이터포털 키는 Decoding 사용)
- **개정치 정책** — 소급 수정되는 지표는 매번 원천에서 새로 조회(10분 캐시), 확정치(KRX)·저한도(FISIS)만 영구 적재
- **저장 루트 단일 소스** (`lib/data-dir.ts`) — 파일 캐시 위치는 `DATA_DIR` → (서버리스 감지 시) `/tmp/econ-cockpit-data` → `.data` 순으로 결정. 캐시 읽기/쓰기 실패는 요청을 깨뜨리지 않고 경고 후 진행(캐시 없이 동작)

### 배포 시 주의 (Vercel 등 서버리스)

프로젝트 디렉터리가 읽기전용이라 파일 캐시는 자동으로 `/tmp`로 폴백한다. `/tmp`는 인스턴스별·콜드스타트마다 초기화되므로:

- **KRX** — 재수집해도 값은 동일(정확성 영향 없음). 느려지고 속도제한(403) 위험만 증가
- **FISIS** — 일 30회 한도 카운터가 인스턴스 간 공유되지 않아 한도 추적이 느슨해짐(초과 가능). 쓰기 자체가 실패하면 프로세스 메모리 카운터로 폴백
- **DART corp_code** — 8MB대 카탈로그를 콜드스타트마다 재다운로드(첫 검색 지연). 다운로드 실패 시 만료 캐시로라도 응답

정확한 한도 관리·성능이 필요하면 `DATA_DIR`을 영속 볼륨으로 지정하거나 저장소를 외부 DB로 교체할 것.

## 접근 보호

공개 URL이므로 앱 전체에 비밀번호 게이트를 둔다. Vercel 플랫폼 보호(프로덕션 Vercel Authentication, Advanced
Deployment Protection의 비밀번호 보호)는 **현재 요금제에서 사용 불가**여서(설정 API가 428 응답) 앱 레벨로 구현했다.

- `proxy.ts` (Next 16에서 `middleware.ts`가 개명된 파일) — matcher 없이 **모든 요청**이 게이트를 통과하고, 예외 경로는 `lib/auth-config.ts`의 명명 상수로 판정한다
- 세션 쿠키 `econ_cockpit_session` = `v1.<만료ms>.<HMAC-SHA256>` — 평문 비밀번호는 쿠키에 넣지 않는다. 유효기간 30일, httpOnly·secure·SameSite=Lax, 비교는 `timingSafeEqual`
- 환경변수 `APP_PASSWORD`(필수) / `APP_SECRET`(선택 — 미설정 시 `APP_PASSWORD`에서 서명키 파생, 비밀번호를 바꾸면 기존 세션이 자동 무효화)
- **프로덕션에서 `APP_PASSWORD`가 없으면 전면 차단**(페이지는 안내 화면, API는 503). 로컬 개발에서만 미설정 시 무인증 통과
- 차단 시 페이지는 `/login?from=…`으로 리다이렉트(오픈 리다이렉트 방지 검증), API는 401 JSON

## 실행

```bash
npm install
cp .env.example .env.local   # APP_PASSWORD + 기관 키 입력
npm run dev
```

`.env.example`에는 두 가지 누락·구식 표기가 있으니 주의:

- **`OPENAI_API_KEY`(자연어 조회 필수)·`OPENAI_MODEL`(선택, 기본 `gpt-4o`)이 빠져 있다** — `.env.local`에 직접 추가할 것.
  검색 보조 LLM은 `OPENAI_SEARCH_MODEL`(선택, 기본 `gpt-4o-mini`)·`SEARCH_LLM=off`(끄기)·`NEXT_PUBLIC_SEARCH_LLM_TIMEOUT_MS`(선택, 기본 4000)·`SEARCH_LLM_CACHE_TTL_MS`(선택, 기본 30분)로 조절한다. 같은 `OPENAI_API_KEY`를 쓰며, 질의 1건당 최대 2회 호출(캐시 적중 시 0회). `/api/search?q=…&llm=off`로 한 요청만 끌 수도 있다(A/B 대조용)
- KRX·R-ONE·FISIS에 붙은 "미구현" 주석은 어댑터 구현 이전 시점 표기다. 현재 상태는 위 소스 표 기준

## 배포

Vercel 프로젝트 `econ-cockpit` — **Git 자동배포가 아니라 수동 배포**다.

```bash
vercel deploy --prod
```

`APP_PASSWORD`·`OPENAI_API_KEY`·기관 키는 Vercel 환경변수(Production)에 등록되어 있어야 한다.

UI는 AI OS 민트 팔레트, 차트 시리즈 색은 색약 검증(validate_palette) 통과 팔레트(그린·블루·오렌지·슬레이트) 사용.
계열이 5개를 넘으면 색만으로는 구분이 어려워 5번째부터 파선(`SERIES_DASH`)을 함께 입힌다 — 색 확장분(`--series-5~10`)은 색약 검증을 다시 돌리지 않았으므로, 색 단독 구분에 의존하지 말 것.
색·파선 배열 길이는 `MAX_SERIES + MAX_DERIVED`(=10) 이상이어야 하며, `lib/chart-config.ts`가 모듈 로드 시 이를 대조해 어긋나면 throw한다(주석으로만 지키던 불변조건을 코드로 옮겼다).

### 로컬 dev 주의 — 한글 경로에서 Turbopack이 죽는다

이 저장소는 경로에 한글이 있다(`01_금융_리서치`). Next 16.2.11의 Turbopack이 청크 이름을
바이트 단위로 자르다가 한글 중간에서 패닉한다(`start byte index N is not a char boundary`).
`npm run dev`는 페이지는 뜨지만 **API 라우트 컴파일에서 500**이 난다.
**코드 문제가 아니라 경로 문제다** — ASCII 경로에서는 Turbopack dev·build 모두 정상이다.

우회 두 가지 (2026-08-05 확인):

```bash
# (a) ASCII 경로 복제본 — 권장. dev·build 모두 Turbopack 그대로 쓴다
rsync -a --exclude .git --exclude .next --exclude .vercel "$PWD/" /tmp/econ-verify/
cd /tmp/econ-verify && npm run dev -- -p 3500

# (b) webpack 폴백 — 저장소에서 바로 띄울 때
npx next dev --webpack -p 3500
```

검증 스크립트(`scripts/korean-query-battery.py`·`e2e-query-check.py`·`search-ab-check.py`)는
이렇게 띄운 서버에 붙인다. 로컬에서 `APP_PASSWORD`를 빈 값으로 띄우면 게이트가 열린다
(`APP_PASSWORD= npm run dev -- -p 3500`).
