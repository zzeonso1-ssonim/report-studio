# PRD — econ-cockpit (경제데이터 콕핏)

작성일: 2026-07-24 · 최종 갱신: 2026-07-25 · 작성자: 전소영
상태: **v1·v2 구현 완료 · 배포됨** (<https://econ-cockpit.vercel.app>)

## 1. 한 줄 정의

한국·미국 공공 경제데이터 API를 한곳에 모아 조회하고, 챗봇에게 자연어로 검색시키는 **개인용** 웹앱.

## 2. 배경 / 문제

- GDP·CPI 나우캐스팅, 채권 스프레드 등 앱이 목적별로 흩어져 있어, "그때그때 보고 싶은 정보"를 확인하려면 여러 앱·포털을 오가야 함.
- CPI·GDP 앱에 각각 챗봇을 심었더니 프롬프트·모델·비용 관리가 분산됨.
- 기관 포털(ECOS, KOSIS, KRX, R-ONE, DART, FISIS)마다 인증·포맷·검색 UI가 제각각.

## 3. 사용자

본인 1인 (개인 API 키 사용). **팀 공유 아님** — DAAI·AI OS와 분리.
공개 URL이므로 앱 레벨 비밀번호 게이트로 보호한다 (8절).

## 4. 범위

### v1 — 완료

- 지표 레지스트리 기반 시계열 조회 (지표 선택 → 기간 → 테이블·차트)
- **변환 계층**: 원계열(`raw`) → 전년동기대비(`yoy`)·전기대비(`pop`)·재기준화(`rebase`, 구간 시작=100). 레지스트리의 주기 정보로 자동 계산 — 추가 API 호출 없음
- **비교 차트**: 최대 4개 지표 겹쳐 그리기. 단위가 다른 지표는 YoY% 또는 재기준화로 비교, 주기가 다르면 날짜 정렬 처리
- 데이터 소스 어댑터 (6절)
- 통합 API: `GET /api/series/{indicatorId}?transform=raw|yoy|pop|rebase&start=&end=` — 소스·변환 차이를 서버가 흡수

### v2 — 완료

- **자연어 메인 입력** (`POST /api/chat`): OpenAI Chat Completions function calling 플래너.
  도구 `list_indicators` → `search_catalog` → `finalize_plan`(최대 6라운드)으로 **조회 계획(JSON)만** 만들고,
  실제 데이터는 기존 `/api/series/[id]`·`/api/series/adhoc` 경로가 조회한다 — 모델은 숫자를 만들지 않는다.
  기본 모델 `gpt-4o-mini`, `OPENAI_MODEL` 환경변수로 전환. 계획이 불가능하면 한국어로 되묻는다.
- **전체 카탈로그 검색** (`GET /api/search`, `POST /api/series/adhoc`): ECOS 통계표 목록·KOSIS 통합검색·FRED series/search를
  병렬 조회해 미등록 지표도 즉시 차트에 올린다 (`lib/search.ts`).
- **발표 캘린더** (`/calendar`, `GET /api/calendar?days=`): 미국은 FRED `releases/dates` 자동
  (`include_release_dates_with_no_data=true`, 일간 갱신 릴리스는 major에서 제외),
  한국은 공표일정 API가 없어 시드파일(`lib/calendar-kr.ts` — 금통위·CPI·GDP)로 적재.
  FOMC 결정일도 FRED 노이즈에 묻혀 별도 시드(`lib/calendar-us.ts`). **두 시드는 연 1회 수동 갱신 필요.**
- **DART 공시검색** (`/disclosures`, `GET /api/disclosures`): 회사명→corp_code 카탈로그 캐시, 기간·유형 필터.
  **페이지 진입 시 자동 조회하지 않는다** — 검색을 눌렀을 때만 호출(2026-07-25 변경). DART 호출과 8MB대
  corp_code 카탈로그 다운로드가 무거워 필요할 때만 부담하도록 한 것.
- **차트 UX**: 유형 토글(꺾은선·막대·영역), 단위 표기, PNG 다운로드(2배 해상도).
- **내 모델 바로가기** (`/models`): 별도 레지스트리(`lib/models.ts`) 기반 링크 모음 — 7절.

### 제외

- DAAI/AI OS 연동 (팀 자산 — 이 앱은 개인용)
- 계산·추정 로직 일체 (나우캐스팅 등은 기존 엔진이 담당, 이 앱은 **순수 소비자**)
- CPI·GDP 결과 재계산 — 필요 시 기존 엔진의 결과 API만 호출

## 5. 설계 원칙

1. **원천기관 우선**: 중복 지표는 작성기관 API 사용 (CPI→KOSIS, 기준금리·GDP→ECOS, 미 CPI→BLS). 재수록본은 `fallback`으로 지정 가능 — 이중화 수단.
2. **지표 레지스트리 단일 소스**: 지표→소스·코드 매핑은 `lib/indicators.ts` 한 파일에만 존재. 하드코딩 금지 원칙의 적용. (모델 바로가기는 `lib/models.ts`, 게이트 상수는 `lib/auth-config.ts`가 각자의 단일 소스.)
3. **어댑터 계층**: 소스별 인증·포맷·날짜표기 차이는 `lib/sources/*` 어댑터가 흡수. 공통 반환형 `SeriesPoint[]`.
4. **키는 서버 사이드 환경변수만**. 클라이언트 노출 금지 (`NEXT_PUBLIC_` 금지).
5. **캐싱 한 겹** (fetch revalidate 10분) — 기관별 일일 호출 한도 보호. 확정치(KRX)·저한도(FISIS)·대용량 카탈로그(DART corp_code)만 파일 캐시로 별도 적재.

## 6. 데이터 소스 현황 (2026-07-25)

| 소스 | 기관 | 키 | 상태 |
|---|---|---|---|
| ECOS | 한국은행 | 필요 | **구현·실검증** — 지표 조회 + 통계표 카탈로그 검색 |
| KOSIS | 통계청 | 필요 | **구현·실검증** — 지표 조회 + 통합검색 (키 base64 `=` 패딩 자동 보정) |
| FRED | 세인트루이스 연은 | 필요 (무료 즉시발급) | **구현·실검증** — 지표 조회 + series/search + 발표 캘린더 |
| BLS | 미 노동통계국 | 선택 (키 없으면 저한도) | **구현·실검증** — 미 CPI 원천 |
| DART | 금감원 | 필요 | **구현·실검증** — 공시검색, corp_code 카탈로그 캐시 |
| KRX | 한국거래소 | 승인형 | **구현·실검증** — 국고채 3y/10y·10년국채선물지수. 기준일 순회 + 일별 확정치 영구 캐시. 채권지수 서비스(`idx/bon_dd_trd`)는 미승인이나 **불필요 판단(추가 신청 안 함)** |
| R-ONE | 한국부동산원 | 필요 | **구현·실검증** — 카탈로그 기반 범용 어댑터(통계표 738개), 아파트 매매·전세가격지수 등록 |
| FISIS | 금감원 | 필요 (관리자 승인 후 이메일 발급) | **어댑터 구현 완료 · 미가동** — 발급받은 키가 서버에서 `010 미등록 인증키`로 거부됨(2026-07-24 최초 확인, 2026-07-25 재확인). 그래서 **등록 지표 없음**이고 정상 응답 파싱 경로는 미검증. 호출당 1개월·일 30회 제한 대응(월 분할 호출, 28회 안전한도, 증분 적재)은 코드에 반영됨 |
| BEA | 미 경제분석국 | 필요 | **자리표시자** (`lib/sources/stubs.ts`) — 미 GDP는 당분간 FRED 재수록본(`GDPC1`) 사용 |

### 등록 지표 (`lib/indicators.ts`) — 13개, 전부 `verified: true`

**한국 9개**

| id | 지표 | 소스 | 주기 |
|---|---|---|---|
| `kr_base_rate` | 한국 기준금리 | ECOS `722Y001` | 일 |
| `kr_usdkrw` | 원/달러 환율 (매매기준율) | ECOS `731Y001` | 일 |
| `kr_cpi` | 한국 소비자물가지수 (2020=100) | KOSIS `DT_1J22003` | 월 |
| `kr_gdp` | 한국 실질 GDP (계절조정, 분기) | ECOS `200Y104` | 분기 |
| `kr_ktb_3y_yield` | 국고채 3년 지표물 수익률 | KRX `bon/kts_bydd_trd` | 일 |
| `kr_ktb_10y_yield` | 국고채 10년 지표물 수익률 | KRX `bon/kts_bydd_trd` | 일 |
| `kr_ktb_fut10y_index` | 10년국채선물지수 | KRX `idx/drvprod_dd_trd` | 일 |
| `kr_apt_sale_idx` | 전국 아파트 매매가격지수 | R-ONE `A_2024_00045` | 월 |
| `kr_apt_jeonse_idx` | 전국 아파트 전세가격지수 | R-ONE `A_2024_00050` | 월 |

**미국 4개**

| id | 지표 | 소스 | 주기 |
|---|---|---|---|
| `us_cpi` | 미국 CPI-U (SA) | BLS `CUSR0000SA0` (fallback FRED `CPIAUCSL`) | 월 |
| `us_fedfunds` | 미국 연방기금금리 (실효, 월평균) | FRED `FEDFUNDS` | 월 |
| `us_gdp` | 미국 실질 GDP (연율, 2017$) | FRED `GDPC1` | 분기 |
| `us_10y` | 미 국채 10년 금리 | FRED `DGS10` | 일 |

미등록 지표는 전체 카탈로그 검색(ECOS·KOSIS·FRED)으로 조회한다 — 레지스트리 등재는 "자주 보는 지표"에 한정.

## 7. 챗봇 · 모델 바로가기

### 챗봇 (구현 완료)

- 도구 호출로만 동작: `list_indicators` → (필요 시) `search_catalog` → `finalize_plan`. 챗봇이 숫자를 추정·창작하지 않고 **계획만 세우고 조회는 서버가 수행**.
- 시리즈 최대 4개, 도구 호출 최대 6라운드, `temperature: 0`. 토큰 사용량을 응답에 함께 반환.
- 모델·프롬프트·비용 관리는 이 앱 한곳으로 통일.
- CPI·GDP 앱에 심어뒀던 기존 챗봇은 **코드째 삭제 완료**(2026-07-24, 양쪽 저장소 푸시됨) — 챗봇은 이 앱 하나로 통일.
- DART 공시검색은 챗봇 도구가 아니라 별도 페이지(`/disclosures`)로 제공한다.

### 모델 바로가기 `/models` (구현 완료)

`lib/models.ts` 레지스트리에서 파생 (현재 7개). 페이지는 그룹·개수·라벨까지 전부 이 파일에서 파생하고 하드코딩을 두지 않는다.

- **웹앱(5)**: CPI 나우캐스트, GDP 나우캐스트, BOK 스탠스 랩, 채권 모니터, DAAI(팀 공유·로그인 필요)
- **저장소만(2)**: 내수 체감경기 검증 모델, CSI 문항 선행성 테스트

## 8. 비기능 요구사항

- 스택: Next.js 16 (App Router, TS) — 기존 앱들과 통일. Next 16에서 `middleware.ts`가 **`proxy.ts`로 개명**됨.
- **UI: AI OS 민트 팔레트로 통일** (primary `#147b6d`, 배경 `#f8fbf9`, 텍스트 `#173b35` — bondAI_OS 테마 기준). 차트 시리즈 색은 색약 검증 팔레트를 별도 사용. 아키텍처 다이어그램: `docs/ARCHITECTURE.md`
- **배포: 완료** — <https://econ-cockpit.vercel.app> (Vercel 프로젝트 `econ-cockpit`). 계정 402 이슈는 해소됨.
  Git 자동배포가 아니라 **`vercel deploy --prod` 수동 배포**다.
- 저장소: GitHub private (`econ-cockpit`)

### 접근 보호 (앱 레벨 비밀번호 게이트)

Vercel 플랫폼 기능(프로덕션 Vercel Authentication, Advanced Deployment Protection의 비밀번호 보호)은
**현재 요금제에서 사용 불가**로 확인됐다 (설정 API가 428 응답). 그래서 앱 레벨로 구현한다.

- `proxy.ts` — matcher 없이 **모든 요청**이 게이트를 통과. 예외 경로는 정규식이 아니라 `lib/auth-config.ts`의 명명 상수로 판정.
- 세션 쿠키 `econ_cockpit_session` = `v1.<만료ms>.<HMAC-SHA256>`. **평문 비밀번호는 쿠키에 넣지 않는다.** 유효기간 30일, httpOnly·secure·SameSite=Lax. 비교는 전부 `timingSafeEqual`.
- 서명키: `APP_SECRET`(있으면) → 없으면 `APP_PASSWORD`에서 HMAC 파생(비밀번호를 바꾸면 기존 세션 자동 무효화).
- 게이트 상태 3종: `APP_PASSWORD` 설정 → `enforced` / 미설정+로컬 → `open`(개발 편의) / **미설정+프로덕션 → `unconfigured`(전면 차단 + 설정 안내)**.
- 차단 응답: 페이지는 `/login?from=…`으로 리다이렉트(오픈 리다이렉트 방지 검증), API는 401 JSON(미설정 시 503).
- 실측(2026-07-25): `/` → 307 `/login?from=%2F`, `/login` → 200, `/api/indicators` → 401 JSON.
- 비밀번호 값은 Vercel 환경변수에만 두고 저장소·문서에 기록하지 않는다.

### 데이터 저장 (서버리스 제약)

파일 캐시 루트는 `lib/data-dir.ts` 단일 소스: `DATA_DIR` → (서버리스 감지 시) `/tmp/econ-cockpit-data` → `.data`.
Vercel에서는 `/tmp`라 인스턴스별·콜드스타트마다 초기화된다 — KRX는 재수집만 늘고(정확성 영향 없음),
FISIS 일 30회 카운터는 느슨해지며, DART corp_code는 콜드스타트마다 재다운로드된다. 상세는 README 참조.

## 9. 미결 사항

- [x] 챗봇 모델·프로바이더 — OpenAI `gpt-4o-mini` 확정 (2026-07-24 e2e 3케이스 검증, 질의당 ~$0.0005). `OPENAI_MODEL` 환경변수로 상위 모델 전환 가능
- [x] KRX 키 — 발급·검증 완료. 채권지수 서비스(`idx/bon_dd_trd`)는 미승인이나 불필요 판단으로 종결
- [x] FISIS API 제공 형태 확인 — 금감원 FISIS로 확정 (금투협 FreeSIS는 법인 전용이라 제외)
- [x] 국내 지표 테이블 코드 검증 — 등록 지표 13개 모두 포털 실응답으로 코드 확인 완료 (`verified: true`)
- [x] Vercel 배포 — <https://econ-cockpit.vercel.app> 프로덕션 가동 (402 해소)
- [x] 접근 보호 — Vercel 플랫폼 보호가 요금제상 불가(428)라 앱 레벨 비밀번호 게이트로 대체
- [ ] **FISIS 키 활성화** — 발급 키가 `010 미등록 인증키`로 거부됨(2026-07-25 재확인). 금감원에 키 상태 문의 필요
- [ ] FISIS 지표 등록 — 키 활성화 후. 그때 정상 응답 파싱 경로(정상코드 `000`, 데이터 배열 위치 `list`, 행 필드 `base_month`, 값 필드 `a`)를 실응답으로 확인하고 어댑터의 다중 키 폴백을 정리할 것
- [ ] 발표 캘린더 시드 갱신 — `lib/calendar-kr.ts`·`lib/calendar-us.ts`는 2026년 잔여 일정만 적재(2026-07-24 기준). **2027년 일정 공표 후 교체 필요**
- [x] CPI·GDP 앱의 기존 챗봇 코드 삭제 — 2026-07-24 완료. GDP는 `web/src/app/{chat,api/chat}`·`ChatPanel`·`lib/ecos.ts` 제거 + openai 의존성 제거, CPI는 `engine/qa_agent.py`·`api/routers/qa.py`·`web/app/qa` 제거. 양쪽 빌드 통과·푸시 완료 (git 히스토리로 복구 가능)

## 10. 경제전망 보고서 출력 — 구현 예정

경제전망 워크벤치의 화면과 데이터 연결은 보고서 자체가 아니다. 보고서 생성·미리보기·내보내기는
[경제전망 보고서 출력 계약](outlook-report-contract.md)을 따라 별도 구현한다.

### GitHub 양식 단일 기준

- 내용 순서·데이터 상태 표현: 이 저장소의 `scripts/liquidity/config.json` 및 `scripts/liquidity/post_briefing.py`
- 시나리오·리스크 표: 이 저장소의 `scripts/strategy/premise_config.json`
- 시각·문체·인쇄·편집 규격: GitHub `zzeonso1-ssonim/bond-strategy-reports`
- 정본: 편집 가능한 `index.html`; 구조화 상태 `report.json`; PDF·Word는 정본에서 파생
- DAAI 연동·노출 없음

### 완료 조건

- [ ] Cockpit에서 보고서 미리보기 아티팩트를 먼저 제공
- [ ] 헤드라인 기계 판정 → 신호 보드 → 핵심 주장 → 섹터별 근거 차트 → 시나리오 → 리스크 → 교차검증 → 데이터 주의 → 출처 순서 구현
- [ ] 잠재성장률 `1.5 / 1.7 / 2.0` 시나리오를 사용자 수정 가능 입력으로 구현
- [ ] 모든 차트에 단위·빈도·계절조정 여부·기준일·출처 표시
- [ ] 미연결·결측·교차검증 불일치를 수치 추정 없이 명시
- [ ] IBM × Coinbase 흰색 A4 인쇄형 스타일 및 연구노트형 명사 종결 적용
- [ ] HTML 블록 편집·이동·삭제·되돌리기, PDF·Word 출력 검증
- [ ] PDF 전 페이지 렌더링 QA 및 모바일/인쇄 오버플로 검증
