# 경제데이터 통합조회 (econ-cockpit)

한국·미국 공공 경제데이터 API를 한곳에 모아 **자연어로 조회**하는 개인용 웹앱.
메인 입력창에 "한국이랑 미국 CPI 전년동기대비 5년치 비교해줘"라고 치면 챗봇(OpenAI function calling)이 지표를 찾아 차트로 보여준다.

**배포: <https://econ-cockpit.vercel.app>** (비밀번호 로그인 필요 — 아래 [접근 보호](#접근-보호))

상세 스펙: [docs/PRD.md](docs/PRD.md) · 구조: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## 기능

- **자연어 조회** — gpt-4o-mini 플래너(`OPENAI_MODEL`로 전환)가 등록 지표·전체 카탈로그를 도구 호출로 검색해 조회 계획 수립 (숫자 창작 금지, API 결과만 차트화)
- **전체 통계 검색** — ECOS 834개 통계표·KOSIS 통합검색·FRED를 실시간 검색, 미등록 지표도 바로 차트에
- **비교 차트** — 최대 4개 지표, 꺾은선·막대·영역 전환, 변환(전년동기대비·전기대비·재기준화), 단위 표기, PNG 다운로드
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

- **`OPENAI_API_KEY`(자연어 조회 필수)·`OPENAI_MODEL`(선택, 기본 `gpt-4o-mini`)이 빠져 있다** — `.env.local`에 직접 추가할 것
- KRX·R-ONE·FISIS에 붙은 "미구현" 주석은 어댑터 구현 이전 시점 표기다. 현재 상태는 위 소스 표 기준

## 배포

Vercel 프로젝트 `econ-cockpit` — **Git 자동배포가 아니라 수동 배포**다.

```bash
vercel deploy --prod
```

`APP_PASSWORD`·`OPENAI_API_KEY`·기관 키는 Vercel 환경변수(Production)에 등록되어 있어야 한다.

UI는 AI OS 민트 팔레트, 차트 시리즈 색은 색약 검증(validate_palette) 통과 팔레트(그린·블루·오렌지·슬레이트) 사용.
