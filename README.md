# 경제데이터 통합조회 (econ-cockpit)

한국·미국 공공 경제데이터 API를 한곳에 모아 **자연어로 조회**하는 개인용 웹앱.
메인 입력창에 "한국이랑 미국 CPI 전년동기대비 5년치 비교해줘"라고 치면 챗봇(OpenAI function calling)이 지표를 찾아 차트로 보여준다.

상세 스펙: [docs/PRD.md](docs/PRD.md) · 구조: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## 기능

- **자연어 조회** — gpt-4o-mini 플래너가 등록 지표·전체 카탈로그를 도구 호출로 검색해 조회 계획 수립 (숫자 창작 금지, API 결과만 차트화)
- **전체 통계 검색** — ECOS 834개 통계표·KOSIS 통합검색·FRED를 실시간 검색, 미등록 지표도 바로 차트에
- **비교 차트** — 최대 4개 지표, 꺾은선·막대·영역 전환, 변환(전년동기대비·전기대비·재기준화), 단위 표기, PNG 다운로드
- **발표 캘린더** (`/calendar`) — 미국 FRED 자동 + 한국(금통위·CPI·GDP)·FOMC 공식 일정 시드
- **공시 검색** (`/disclosures`) — DART 회사명 검색(corp_code 캐시), 기간·유형 필터

## 데이터 소스 (어댑터)

| 소스 | 기관 | 비고 |
|---|---|---|
| ECOS | 한국은행 | 기준금리·환율·GDP 등 |
| KOSIS | 통계청 | CPI 등 (키 base64 `=` 패딩 자동 보정) |
| KRX | 한국거래소 | 국고채 수익률·지수. 일별 확정치 영구 캐시(`.data/krx`), 3y/10y 캐시 공유, 400영업일 단위 백필 |
| R-ONE | 한국부동산원 | 카탈로그 기반 범용 (통계표 738개) |
| DART | 금감원 | 공시검색 |
| FISIS | 금감원 | 월 분할 호출·일 28/30회 안전한도·증분 적재(`.data/fisis`) |
| FRED / BLS | 미 연준·노동통계국 | 미국 지표 + 발표 캘린더 |
| BEA | 미 경제분석국 | 자리표시자 (당분간 FRED 대체) |

## 설계 원칙

- **원천기관 우선** — 중복 수록 지표는 작성기관 API, 재수록본은 fallback
- **지표 레지스트리 단일 소스** (`lib/indicators.ts`) — 하드코딩 금지, 지표·코드는 여기서만
- **어댑터 계층** (`lib/sources/*`) — 인증·포맷·날짜표기 차이 흡수, 공통 `SeriesPoint[]` 반환
- **키는 서버 전용** — `.env.local` 환경변수만, 클라이언트 미노출 ([.env.example](.env.example) 참고 — 공공데이터포털 키는 Decoding 사용)
- **개정치 정책** — 소급 수정되는 지표는 매번 원천에서 새로 조회(10분 캐시), 확정치(KRX)·저한도(FISIS)만 영구 적재

## 실행

```bash
npm install
cp .env.example .env.local   # 키 입력
npm run dev
```

UI는 AI OS 민트 팔레트, 차트 시리즈 색은 색약 검증(validate_palette) 통과 팔레트(그린·블루·오렌지·슬레이트) 사용.
