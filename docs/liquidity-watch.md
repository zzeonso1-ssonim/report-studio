# 유동성 워치 — 운영 문서

미국 유동성 지표를 FRED에서 주 1회 받아 노션 **매크로 브리핑룸**에 브리핑 페이지를 만든다.
Phase 0 검증(`team-soyoung/docs/liquidity-watch-phase0.md`)의 결론을 그대로 이식한 Phase 1에서 출발했고,
2026-08-02에 **미 국채 입찰 결과 부록**과 **v2 5구획 개편**을 붙였다(아래 별도 절).

- 이 파이프라인은 **웹앱(app/·lib/)과 무관하다.** Vercel 배포 대상이 아니고, 배포에 영향을 주지 않는다.
- `as_of: 2026-08-02` — 아래 실측값은 이 시점 기준선이다.

## 무엇을 · 언제 · 어디로

| 항목 | 내용 |
|---|---|
| 대상 | FRED 20계열 (표시 12 + 요인 분해 전용 8) + 파생 스프레드 2 — 목록은 `config.series`·`config.derived` |
| 부록 | 미 국채 입찰 결과 (입찰일 기준 지난 7일) |
| 출처 | FRED `fredgraph.csv` — **API 키 불필요** / 부록은 TreasuryDirect `TA_WS/securities/auctioned` — **키 불필요** |
| 실행 | GitHub Actions [`liquidity-watch.yml`](../.github/workflows/liquidity-watch.yml) — 목 22:00 UTC(=금 07:00 KST) 주 1회 + 수동 실행 |
| 왜 그 시각인가 | 연준 H.4.1이 목 16:30 ET(=금 05:30 KST)에 나온다. 90분 여유를 두고 받아 금요일 출근 전에 노션에 올려둔다 |
| 적재처 | 노션 매크로 브리핑룸 (data source `ff6676d0-8869-40a3-b03b-0a48942df0f1`) |
| 페이지 제목 | `{yymmdd}_미국 유동성 워치` — **yymmdd는 수집일이 아니라 `WRESBAL` 최신 관측일**(H.4.1 주간 기준)이다. 이것이 멱등 키다 |
| 속성 | 검토 상태=검토대기 / 작성방식=AI 초안 / 문서유형=체크포인트 / 카테고리=매크로 / 지역=미국 / 작성일=실행일(KST) |
| 의존성 | 수집·적재는 표준 라이브러리 + `curl`. **차트만** `matplotlib`(워크플로에서 버전 고정 설치, 실패해도 표는 나간다) |

### 파일

| 경로 | 역할 |
|---|---|
| [`scripts/liquidity/config.json`](../scripts/liquidity/config.json) | **단일 설정 소스.** 시리즈·표시명·단위·비교기준·판정 규칙·해설 문구·차트·노션 좌표·본문 문안이 전부 여기 있다 |
| [`scripts/liquidity/fetch_liquidity.py`](../scripts/liquidity/fetch_liquidity.py) | FRED 수집·교차검증·집계·**요인 분해·헤드라인 판정** → JSON. 부록 수집을 호출하되 **실패를 격리**한다 |
| [`scripts/liquidity/fetch_auctions.py`](../scripts/liquidity/fetch_auctions.py) | 부록: TreasuryDirect 입찰 결과 수집·스키마 검증 → `result["auctions"]` / 차트용 장기 이력 → `result["auction_history"]` |
| [`scripts/liquidity/charts.py`](../scripts/liquidity/charts.py) | 차트 4장 PNG 생성. **matplotlib import는 여기에만 있다** |
| [`scripts/liquidity/notion_upload.py`](../scripts/liquidity/notion_upload.py) | 노션 파일 업로드 3단계 → 이미지 블록 |
| [`scripts/liquidity/post_briefing.py`](../scripts/liquidity/post_briefing.py) | JSON → 노션 페이지 (멱등·dry-run·프로브 지원) |

**지표를 늘리거나 문안을 바꾸려면 `config.json`만 고친다.** 코드에 시리즈 ID·한글 문안·단위 상수를 두지 않았다.

## 함정 3개 — 지우지 말 것

**① 52주 전 비교는 365일이 아니라 364일(=52주)이다.**
주간계열(H.4.1)이 같은 요일에 착지해야 연준 릴리스의 'Change from year ago'와 직접 대조된다.
365일로 잡으면 지준 연간 변동이 -362,844 대신 **-377,707**로 어긋난다(2026-07-31 실측).
`config.lookbacks[52w].days`에 근거와 함께 박혀 있다. **13주도 같은 이유로 90일이 아니라 91일**이다.

**② `WRESBAL`·`WTREGEN`은 주 평균이지 잔액이 아니다.**
Wednesday-ending **week average**다. 같은 H.4.1의 수요일 잔액과 지준 $40.0bn / TGA $59.7bn 차이가 났다(2026-07-31 실측).
**일간 계열(ON RRP)과 직접 더하거나 빼면 안 된다.** 파이프라인은 이 가감을 하지 않고,
노션 본문 '데이터 주의'에 매번 문장으로 명시한다(`config.body.cautions`).

**③ FRED는 브라우저 UA 위장 요청을 끊는다.**
브라우저 User-Agent를 붙이면 HTTP/2 INTERNAL_ERROR·403이 난다(실측). `/series/` 페이지도 막혀 있다.
`fetch_liquidity._get()`은 **curl 기본 UA**로만 요청한다 — 여기에 `User-Agent` 헤더를 추가하지 말 것.
단위·주기 메타는 `/series/` 대신 **xls의 sharedStrings**에서 읽는다.

## 부록 — 미 국채 입찰 결과 (2026-08-02 추가)

본문 하단에 `국채 입찰 (지난 7일)` 절이 붙는다. 원천은 TreasuryDirect
`https://www.treasurydirect.gov/TA_WS/securities/auctioned?format=json&days=10` — **API 키 불필요**,
실측 HTTP 200 · 1.1~1.2초 · 최근 10일 15건(2026-08-02). `days=10`으로 받아 코드가 **입찰일 기준 7일**로 좁힌다
(경계일 입찰이 갱신 시차로 빠지는 것을 막는 여유분).

### ① 낙찰 필드는 종목 유형마다 다르다 — 실호출로 확정한 표 (추측 금지)

`highYield` 하나로 통일돼 있지 않다. **Bill과 FRN은 `highYield`가 빈 문자열이다.**

| 유형 | 판별 | 낙찰 필드 | 표시 라벨 | 실측 근거 (2026-08-02) |
|---|---|---|---|---|
| 변동금리채(FRN) | `floatingRate=Yes` | `highDiscountMargin` | 최고 할인마진 | 07-29 2Y FRN: `highYield`·`highDiscountRate` 둘 다 빈 문자열, `highDiscountMargin=0.050` |
| 재정증권(Bill) | `securityType=Bill` | `highDiscountRate` (+`highInvestmentRate` 병기) | 최고 할인율 | 07-30 4-Week: `highYield=""`, `highDiscountRate=3.630`, `highInvestmentRate=3.691` |
| 물가연동채(TIPS) | `tips=Yes` | `highYield` = **실질수익률** | 최고 실질수익률 | 07-23 10Y TIPS: `highYield=2.4380` (같은 날 명목 10Y와 비교 금지) |
| 고정금리 Note·Bond | 나머지 | `highYield` | 최고 낙찰수익률 | 07-27 5Y Note `4.4080`, 07-22 20Y Bond 재발행 `5.1630` |

- 이 매핑은 코드가 아니라 **`config.treasurydirect.yield_rules`** 에 있다. 종목 유형이 늘면 config만 고친다.
- **규칙은 위에서부터 첫 일치로 평가되고 마지막 항목이 `when={}`(전부 일치)여야 한다.** FRN·TIPS도
  `securityType=Note`라서, 명목 규칙이 앞에 오면 둘 다 명목으로 잘못 잡힌다.
  `validate_auction_config()`가 순서를 강제한다(중간에 `when={}`가 있으면 예외).
- 할인율(`highDiscountRate`)과 투자환산수익률(`highInvestmentRate`)은 **서로 다른 값**이다.
  채권 등가 비교용으로 괄호에 병기하되 같은 숫자로 취급하지 않는다.
- 재발행분은 `securityTerm`이 잔존만기, `originalSecurityTerm`이 원발행만기다
  (4-Week 입찰의 실체는 17-Week 재발행). 시장 호칭인 잔존만기를 표제로 쓰고 원발행만기를 괄호에 병기한다.

### ② 교차검증을 못 한다 — 그 자리를 무엇으로 메웠나

**TreasuryDirect는 단일 원천이라 FRED처럼 두 경로(csv↔xls) 대조가 불가능하다.** 대신:

- **스키마 엄격 검증** — `securityType`·`securityTerm`·`auctionDate`·`bidToCoverRatio` + 유형별 낙찰 필드가
  하나라도 비면 **그 행을 표에 싣지 않고** `표에서 제외한 행`에 결측 필드명과 함께 남긴다. 추정·보간하지 않는다.
- **본문에 명시** — '단일 원천이라 교차검증을 하지 못했다'가 데이터 주의 첫 줄에 매번 들어간다.
  부록 실패가 아니라 **정상 동작일 때도** 들어간다.

### ③ 부록은 본체를 인질로 잡지 않는다

| 상황 | 동작 |
|---|---|
| 입찰 API 실패(네트워크·5xx·JSON 깨짐) | **FRED 본체는 정상 적재.** 부록 자리에 '수집 실패 — {원인}' 문장. `mismatches`를 오염시키지 않는다 |
| 해당 주 입찰 0건 | 빈 표를 만들지 않고 **'해당 주 입찰 없음'을 명시**. 데이터 주의는 그대로 붙는다 |
| 일부 행 필드 결측 | 그 행만 빠지고 사유가 남는다. 나머지 행은 정상 |
| FRED 교차검증 불일치(데이터 이상 페이지) | **부록도 싣지 않는다.** 그 페이지의 원칙은 '값을 싣지 않는다'이므로 예외를 두지 않았다 |

격리 지점은 `fetch_liquidity.collect()`의 `try/except`다. 입찰 결측은 `mismatches`에 절대 넣지 않는다 —
`mismatches`는 'FRED 값을 싣지 말라'는 신호라, 입찰 한 건 결측이 전체 브리핑을 '데이터 이상'으로 만들면 안 된다.

## v2 개편 — 5구획 (2026-08-02)

본문이 5구획으로 바뀌었다. 순서와 문안은 전부 `config.json`에서 나온다.

| 구획 | 무엇 | 근거 설정 |
|---|---|---|
| ① 헤드라인 기계 판정 | `이번 주 유동성: 흡수/공급/중립 (주도: {요인} {±값})` + **판정 규칙 1줄 병기** | `config.headline` |
| ② 신호 보드 | SOFR−IORB · EFFR−IORB · SRF 사용액 — `[현재값·관측일 / 판독 규칙 / 이상 신호 조건]` | `config.signal_board` |
| ③ 잔액 표 | 12계열, 대비 열 **1주·4주·13주·52주**, 지표명에 괄호 해설 | `config.series`·`config.lookbacks` |
| ④ 요인 분해 | Δ지준을 5요인으로 분해 + **항등식 잔차를 교차검증으로 사용** | `config.factors` |
| ⑤ 입찰 부록 | 기존 그대로 | `config.treasurydirect` |

마지막에 인터랙티브 드릴다운 링크(`https://econ-cockpit.vercel.app`) 한 줄이 붙는다.

### 판정 규칙 — 기계적 분류일 뿐이다

지준(`WRESBAL`) 주간 증감이 **+5.0십억 달러 초과면 '공급', -5.0십억 달러 미만이면 '흡수', 그 사이면 '중립'.**
주도 요인은 요인 분해에서 |주간 변동|이 최대인 항목이다. 임계는 `config.headline.neutral_threshold`.
**규칙 문장이 판정 바로 아래 항상 병기된다** — '흡수'라는 한 단어만 남으면 읽는 사람이 시장 판단으로 받아들이기 때문이다.
시장 함의·금리 방향은 이 파이프라인이 만들지 않는다(디렉터 몫).

**② 신호 보드의 '이상 신호 조건' 칸은 전부 `디렉터 확정 대기`로 비어 있다.** 자동화가 임계값을 채우지 않는다.

### 신규 FRED 계열 — 실호출로 확정한 ID (추측 금지)

`fredgraph.xls` 메타의 description 원문을 읽어 정체를 확정했다. 원문은 각 series의 `_fred_desc`에 그대로 있다.

| 용도 | FRED ID | FRED가 부르는 이름 | 주기·단위 |
|---|---|---|---|
| 전체 자산 | `WALCL` | Assets: Total Assets (Less Eliminations from Consolidation): **Wednesday Level** | Weekly, Millions |
| SOMA 미 국채 | `TREAST` | Securities Held Outright: U.S. Treasury Securities: All: **Wednesday Level** | Weekly, Millions |
| SOMA MBS | `WSHOMCB` | Securities Held Outright: Mortgage-Backed Securities: **Wednesday Level** | Weekly, Millions |
| 대출 합계 | `WLCFLL` | Liquidity and Credit Facilities: Loans: **Wednesday Level** | Weekly, Millions |
| 유통통화 | `WCURCIR` | Currency in Circulation: **Week Average** | Weekly, Millions |
| SRF 사용액 | `RPONTSYD` | Overnight Repurchase Agreements: Treasury Securities **Purchased** by the Fed in TOMO | Daily, Billions |
| EFFR | `EFFR` | Effective Federal Funds Rate | Daily, Percent |

**`RPONTSYD`를 고른 근거 — 이름으로 고르지 않았다.**
FRED에 'SRF 사용액'이라는 계열은 없다. 이름이 `Standing Repo`인 **`SRFTSYD`는 금리이고 2026-06-12 이후 갱신이 멈췄다**(실측).
현 제도에서 연준의 오버나이트 국채담보 매입(TOMO Repo)이 SRF 운영분이라 `RPONTSYD`를 쓴다.
자릿수 대조도 했다 — 같은 것을 H.4.1 주평균으로 보는 `WREPO`가 2026-07-29 주 6백만 달러이고,
`RPONTSYD` 일간값은 0.001~0.010십억 달러(=1~10백만)로 맞는다.

**`RRPONTSYD`(ON RRP, 잔액 표)와 `WLRRAA`(역RP 총액, 요인 분해)는 다른 계열이다.**
후자는 외국 공적기관분까지 포함한 주평균 총액이다. 본문 '데이터 주의'에 매번 명시된다.

### 요인 분해 — 잔차가 3차 교차검증이다

```
Δ지준 ≈ Δ연준 신용자산(WRESCRT) − ΔTGA(WTREGEN) − Δ역RP(WLRRAA) − Δ유통통화(WCURCIR) − Δ기타
잔차   = 실제 Δ지준 − 위 다섯 요인의 합
```

- **전부 H.4.1 주간평균 계열로만 구성했다.** `WALCL`·`TREAST` 같은 수요일 잔액 계열을 섞으면 항등식이 닫히지 않는다.
- **'기타'는 잔차 흡수 항목이 아니다.** 실제 6개 계열의 부호 합이다 —
  `WOFSRBGSA`(+) `WTCOA`(+) `WDFOA`(−) `WOTHLB`(−) `WOFDRBTHA`(−) `WOTHLIAB`(−).
  설정 검증(`validate_factors`)이 구성 계열이 `config.series`에 실재하는지, 부호가 ±1인지 강제한다.
- **잔차는 표의 별도 행으로 값 그대로 실린다.** 임계(`5.0`십억 달러) 초과 시 값을 숨기지 않고 경고 문단을 함께 붙인다.

**임계 5.0의 근거 (2026-08-02 실측)**: 최근 60주 잔차 범위 **-0.30 ~ +0.90십억 달러**,
|잔차| > 1.0인 주 **0건**. 임계는 실측 최대치의 5배 이상 여유다.
잔차의 정체는 SDR 증서계정 등 `items`에 없는 소액 항목으로 본다.
2026-07-29 주 실측 잔차는 **-0.10십억 달러**(실제 -77.6 vs 요인 합 -77.5).

`WOTHLIAB`는 **수준이 음수다**(2026-07-29 -179,225백만 달러). 이연자산 때문이며 오타가 아니다.

### 차트 4장 — 실패해도 표는 나간다

| 차트 | 내용 |
|---|---|
| ① `levels` | 지준·ON RRP·TGA 수준 3년 |
| ② `factors` | 주간 Δ지준 요인 분해 스택 막대 12주 + 실제 증감 점 |
| ③ `sofr_iorb` | SOFR−IORB 1년 |
| ④ `btc` | 입찰 응찰배수 10주, 유형별 |

- **그림 안 텍스트는 전부 영문이다.** 러너에 한글 폰트가 없어 한글은 두부(□)로 나온다.
  제목·축·범례는 `*_en` 필드에서만 읽고, 한글 설명은 노션 캡션(`caption_format`, '이 그림의 주장' + as-of)으로 단다.
- **격리**: `matplotlib` import는 `charts.py` 안에만 있다. 라이브러리가 없거나 그리기·업로드가 실패해도
  표는 그대로 적재되고 차트 자리에 사유 한 줄만 남는다. 한 장의 실패가 나머지 세 장을 죽이지도 않는다.
  워크플로의 설치 스텝은 `continue-on-error: true`다.
- **함정 (2026-08-02 실측으로 잡음)**: `observations`는 FRED **원자료**라 계열마다 단위가 다르다
  (WRESBAL 백만 / RRPONTSYD 십억). `_obs()`에서 `display.divide_by`로 환산하지 않으면
  축 라벨이 'USD bn'인데 값은 백만으로 찍히고 십억 단위 계열은 0선에 눌려 보이지 않는다. 실제로 그렇게 나왔었다.
- 차트④는 부록(7일 창)과 **별개 호출**이다(`chart_request_days=90`). 부록 값을 바꾸지 않는다.

### 차트 업로드 프로브 (`probe_charts=1`)

로컬에 `NOTION_TOKEN`이 없어(그리고 키를 로컬로 꺼내오지 않는다) **업로드 경로는 러너에서만 검증한다.**

```bash
gh workflow run liquidity-watch.yml -R zzeonso1-ssonim/econ-cockpit -f probe_charts=1
```

- 새 페이지를 만들지 않는다. 이번 기준일의 **기존 페이지 하단**에 `차트(v2 프로브)` 섹션을 append한다.
- **멱등**: 같은 제목의 heading이 이미 있으면 아무것도 하지 않는다(`Notion.has_heading`).
- 본문·속성은 건드리지 않는다. append만 한다.

노션 파일 업로드 3단계 (좌표는 `config.notion.file_upload`):

1. `POST /v1/file_uploads` `{filename, content_type}` → `{id, upload_url}`
2. `POST {upload_url}` — `multipart/form-data`, 파일 필드명 `file`
3. 블록 append 시 `{"type":"image","image":{"type":"file_upload","file_upload":{"id":…}}}`

## 안전장치

- **교차검증**: 매 실행마다 `fredgraph.csv`(값) ↔ `fredgraph.xls`(별도 엔드포인트) 최근 10개 관측치를 대조하고,
  FRED 메타의 단위·주기 문자열을 `config.series.expected_*`와 대조한다(원자료 단위가 백만↔십억으로 바뀌면 1,000배 오차가 조용히 난다).
- **불일치 시 침묵하지 않는다**: 불일치가 1건이라도 있으면 **값을 싣지 않고** `{yymmdd}_미국 유동성 워치 (데이터 이상)` 페이지를 만들어 불일치 내역만 적는다.
- **멱등**: 같은 제목 페이지가 이미 있으면 생성하지 않고 그 사실을 로그로 남긴 뒤 정상 종료한다.
- **'승인'을 쓰지 않는다**: `검토 상태=승인`은 디렉터 전용이라 코드가 거부한다(`config.notion._forbidden_values`).
- **디렉터 입력 보존**: 중요도·내 메모·키워드·입력완료·relation 계열은 payload에 넣지 않는다(`_never_write` 검사로 강제).
- **관측일 병기**: 표의 모든 비교값에 비교 기준일과 그때의 값이 함께 들어간다. 기준일 없는 숫자를 만들지 않는다.
- **조건부 경고**: 관측일이 수집일보다 뒤인 시리즈가 있으면 본문에 한 줄이 자동으로 붙는다
  (IORB는 FRED가 앞선 날짜까지 값을 준다 — 2026-08-01 수집 시 최신 관측일 2026-08-03 실측).
- **설정 검증이 먼저 터진다**(v2): 표 헤더 열 수와 `lookbacks` 개수 불일치, 요인 구성 계열이 `series`에 없음,
  부호가 ±1이 아님, 차트 범례 키 누락, 신호 보드가 없는 지표를 가리킴 — 전부 수집 시작 전에 예외를 던진다.
  깨진 설정으로 숫자를 만들어 내보내는 것이 가장 나쁘다.
- **블록 100개 초과를 조용히 자르지 않는다**(v2): 노션 `create_page`는 children을 100개까지만 받는다.
  v2 본문은 그보다 길 수 있어 나머지를 `append_blocks`로 이어 붙인다(예전 코드는 `[:100]`으로 잘랐다 — 표 뒤가 통째로 사라질 수 있었다).

## 남은 조건 — 크론이 돌려면 이것이 필요하다

**`NOTION_TOKEN` 저장소 시크릿 등록. 디렉터 몫이다.**

```bash
gh secret set NOTION_TOKEN -R zzeonso1-ssonim/econ-cockpit
```

- 값은 팀 노션 인테그레이션 토큰(다른 저장소에 등록된 것과 같은 값)이다.
- 그 인테그레이션이 **매크로 브리핑룸 DB에 연결(Connections)** 돼 있어야 한다. 안 돼 있으면 404가 난다.
- 등록 전까지 워크플로는 **첫 스텝에서 명확한 메시지로 실패**한다(조용한 스킵 없음).
  성공으로 찍힌 채 노션이 비는 상태를 만들지 않기 위해서다.

## 수동 실행

```bash
# 수집만 — 사람이 읽는 표 (부록 입찰 포함)
python3 scripts/liquidity/fetch_liquidity.py

# 입찰 부록만 따로 (FRED를 타지 않아 빠르다)
python3 scripts/liquidity/fetch_auctions.py

# 수집 → JSON
python3 scripts/liquidity/fetch_liquidity.py --json --out /tmp/liquidity.json

# 노션에 쓰지 않고 payload·본문만 확인 (토큰 불필요, 네트워크도 안 탄다)
python3 scripts/liquidity/post_briefing.py --input /tmp/liquidity.json --dry-run \
  --payload-out /tmp/payload.json --markdown-out /tmp/body.md

# 실제 적재 (토큰이 셸 환경변수에 있을 때)
python3 scripts/liquidity/post_briefing.py --input /tmp/liquidity.json

# FRED 원문 보관(재현용). H.4.1 주간계열은 소급 수정된다
python3 scripts/liquidity/fetch_liquidity.py --json --cache-dir ./fred_cache --out /tmp/liquidity.json

# 차트만 따로 그려 눈으로 확인 (matplotlib 필요. 노션을 타지 않는다)
python3 scripts/liquidity/charts.py --input /tmp/liquidity.json --outdir /tmp/charts

# 차트까지 포함한 dry-run (그림은 만들되 업로드는 타지 않는다)
python3 scripts/liquidity/post_briefing.py --input /tmp/liquidity.json --dry-run \
  --charts-dir /tmp/charts --markdown-out /tmp/body.md
```

Actions에서 수동 실행: 저장소 → Actions → "유동성 워치 (주간)" → Run workflow.
차트 업로드만 실증하려면 `probe_charts=1`로 실행한다(위 'v2 개편' 절 참조).

## 확인한 것 / 확인 못 한 것 — 입찰 부록 (2026-08-02)

확인함 (전부 실데이터·실행)

- **필드 매핑을 실호출로 확정.** 응답 필드 120종 전수 확인 후 유형별 낙찰 필드를 위 표대로 결정.
  추정한 것 없음. TIPS·Bond·FRN 경로는 창을 07-19~07-25로 옮겨 4개 규칙 전부 태워 확인.
- **`fetch_auctions.py` 실행** — 창 2026-07-27~2026-08-02, 원천 15건 중 기간내 10건, 표 10행, 제외 0건, 1.2초.
- **독립 재계산 대조** — 스크립트를 거치지 않고 API를 다시 받아 별도 코드로 계산한 값이 일치.
  총 낙찰액 합계 **818.7십억 달러**, 응찰배수 **2.28**(5Y Note, 07-27) ~ **3.37**(2Y FRN, 07-29),
  10행 전부 낙찰값·응찰배수·낙찰액 일치(불일치 0건).
- **`post_briefing --dry-run`** — 블록 33개, 표 2개(FRED 7열×7행 + 입찰 6열×11행) payload 생성.
- **격리 4경로** — ①입찰 실패 시 FRED 본체 존치(블록 25개, FRED 표 정상, `mismatches` 오염 0)
  ②입찰 0건 주 '해당 주 입찰 없음' 문장 ③필수 필드 결측 행 제외 + 사유 기록
  ④'데이터 이상' 페이지에는 부록 미포함(표 블록 0개).
- **규칙 순서 가드** — 기본규칙(`when={}`)을 앞으로 옮기면 `validate_auction_config`가 예외로 막는 것 확인.

확인 못 함

- **노션 실제 적재.** 이번 주 페이지(`260729_미국 유동성 워치`)는 이미 존재해 멱등 스킵이 정상 동작이라
  실쓰기를 하지 않았다. **입찰 부록이 노션에 렌더된 모습은 아직 본 적이 없다** —
  **다음 금요일(2026-08-07 07:00 KST) 정기 run이 첫 실전**이고, 그때 표가 실제로 붙는지 확인해야 한다.
- 입찰 0건인 주의 실제 발생. 미 재무부는 매주 Bill을 발행하므로 현실에서는 거의 없다.
  코드 경로는 날짜를 밀어 확인했지만 실제 그런 주가 온 적은 없다.
- 연휴·특별 입찰(CMB 등)에서의 필드 형태. `securityType=CMB` 라벨은 config에 넣어뒀으나 실물을 보지 못했다.

## 확인한 것 / 확인 못 한 것 — FRED 본체 (2026-08-01)

확인함
- `fetch_liquidity.py` 실제 네트워크 실행 — 5시리즈 + 파생 1개 수집, **교차검증 불일치 0건**, 기준일 `2026-07-29`(WRESBAL), 소요 약 1~6초.
- `post_briefing.py --dry-run` — 블록 20개·속성 7개·표 7열×7행 payload 생성.
- 불일치 경로 — mismatches를 주입해 '데이터 이상' 페이지 본문이 **값 없이** 나오는 것 확인.
- 가드 — `검토 상태=승인`, `내 메모` 쓰기 시도가 모두 예외로 차단되는 것 확인.
- 워크플로 YAML 파싱(`yaml.safe_load`) 통과. `actionlint`는 이 맥에 없어 미실행.

확인 못 함
- **노션 실제 적재.** 로컬에 `NOTION_TOKEN`이 없어 페이지 생성·멱등 스킵을 실행으로 확인하지 못했다. 첫 적재로 검증해야 한다.
- Actions 러너에서의 실행. 시크릿 등록 후 `workflow_dispatch` 1회로 확인한다.
