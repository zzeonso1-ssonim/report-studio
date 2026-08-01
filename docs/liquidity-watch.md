# 유동성 워치 — 운영 문서

미국 유동성 5개 지표를 FRED에서 주 1회 받아 노션 **매크로 브리핑룸**에 브리핑 페이지를 만든다.
Phase 0 검증(`team-soyoung/docs/liquidity-watch-phase0.md`)의 결론을 그대로 이식한 Phase 1이다.

- 이 파이프라인은 **웹앱(app/·lib/)과 무관하다.** Vercel 배포 대상이 아니고, 배포에 영향을 주지 않는다.
- `as_of: 2026-08-01` — 아래 실측값은 이 시점 기준선이다.

## 무엇을 · 언제 · 어디로

| 항목 | 내용 |
|---|---|
| 대상 | `WRESBAL`(지준) · `RRPONTSYD`(ON RRP) · `WTREGEN`(TGA) · `SOFR` · `IORB` + 파생 `SOFR-IORB` |
| 출처 | FRED `fredgraph.csv` — **API 키 불필요** |
| 실행 | GitHub Actions [`liquidity-watch.yml`](../.github/workflows/liquidity-watch.yml) — 목 22:00 UTC(=금 07:00 KST) 주 1회 + 수동 실행 |
| 왜 그 시각인가 | 연준 H.4.1이 목 16:30 ET(=금 05:30 KST)에 나온다. 90분 여유를 두고 받아 금요일 출근 전에 노션에 올려둔다 |
| 적재처 | 노션 매크로 브리핑룸 (data source `ff6676d0-8869-40a3-b03b-0a48942df0f1`) |
| 페이지 제목 | `{yymmdd}_미국 유동성 워치` — **yymmdd는 수집일이 아니라 `WRESBAL` 최신 관측일**(H.4.1 주간 기준)이다. 이것이 멱등 키다 |
| 속성 | 검토 상태=검토대기 / 작성방식=AI 초안 / 문서유형=체크포인트 / 카테고리=매크로 / 지역=미국 / 작성일=실행일(KST) |
| 의존성 | 표준 라이브러리 + `curl`. `pip install` 없음 |

### 파일

| 경로 | 역할 |
|---|---|
| [`scripts/liquidity/config.json`](../scripts/liquidity/config.json) | **단일 설정 소스.** 시리즈·표시명·단위·비교기준·노션 좌표·본문 문안이 전부 여기 있다 |
| [`scripts/liquidity/fetch_liquidity.py`](../scripts/liquidity/fetch_liquidity.py) | FRED 수집·교차검증·집계 → JSON |
| [`scripts/liquidity/post_briefing.py`](../scripts/liquidity/post_briefing.py) | JSON → 노션 페이지 (멱등·dry-run 지원) |

**지표를 늘리거나 문안을 바꾸려면 `config.json`만 고친다.** 코드에 시리즈 ID·한글 문안·단위 상수를 두지 않았다.

## 함정 3개 — 지우지 말 것

**① 1년 전 비교는 365일이 아니라 364일(=52주)이다.**
주간계열(H.4.1)이 같은 요일에 착지해야 연준 릴리스의 'Change from year ago'와 직접 대조된다.
365일로 잡으면 지준 연간 변동이 -362,844 대신 **-377,707**로 어긋난다(2026-07-31 실측).
`config.lookbacks[1y].days`에 근거와 함께 박혀 있다.

**② `WRESBAL`·`WTREGEN`은 주 평균이지 잔액이 아니다.**
Wednesday-ending **week average**다. 같은 H.4.1의 수요일 잔액과 지준 $40.0bn / TGA $59.7bn 차이가 났다(2026-07-31 실측).
**일간 계열(ON RRP)과 직접 더하거나 빼면 안 된다.** 파이프라인은 이 가감을 하지 않고,
노션 본문 '데이터 주의'에 매번 문장으로 명시한다(`config.body.cautions`).

**③ FRED는 브라우저 UA 위장 요청을 끊는다.**
브라우저 User-Agent를 붙이면 HTTP/2 INTERNAL_ERROR·403이 난다(실측). `/series/` 페이지도 막혀 있다.
`fetch_liquidity._get()`은 **curl 기본 UA**로만 요청한다 — 여기에 `User-Agent` 헤더를 추가하지 말 것.
단위·주기 메타는 `/series/` 대신 **xls의 sharedStrings**에서 읽는다.

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
# 수집만 — 사람이 읽는 표
python3 scripts/liquidity/fetch_liquidity.py

# 수집 → JSON
python3 scripts/liquidity/fetch_liquidity.py --json --out /tmp/liquidity.json

# 노션에 쓰지 않고 payload·본문만 확인 (토큰 불필요, 네트워크도 안 탄다)
python3 scripts/liquidity/post_briefing.py --input /tmp/liquidity.json --dry-run \
  --payload-out /tmp/payload.json --markdown-out /tmp/body.md

# 실제 적재 (토큰이 셸 환경변수에 있을 때)
python3 scripts/liquidity/post_briefing.py --input /tmp/liquidity.json

# FRED 원문 보관(재현용). H.4.1 주간계열은 소급 수정된다
python3 scripts/liquidity/fetch_liquidity.py --json --cache-dir ./fred_cache --out /tmp/liquidity.json
```

Actions에서 수동 실행: 저장소 → Actions → "유동성 워치 (주간)" → Run workflow.

## 확인한 것 / 확인 못 한 것 (2026-08-01)

확인함
- `fetch_liquidity.py` 실제 네트워크 실행 — 5시리즈 + 파생 1개 수집, **교차검증 불일치 0건**, 기준일 `2026-07-29`(WRESBAL), 소요 약 1~6초.
- `post_briefing.py --dry-run` — 블록 20개·속성 7개·표 7열×7행 payload 생성.
- 불일치 경로 — mismatches를 주입해 '데이터 이상' 페이지 본문이 **값 없이** 나오는 것 확인.
- 가드 — `검토 상태=승인`, `내 메모` 쓰기 시도가 모두 예외로 차단되는 것 확인.
- 워크플로 YAML 파싱(`yaml.safe_load`) 통과. `actionlint`는 이 맥에 없어 미실행.

확인 못 함
- **노션 실제 적재.** 로컬에 `NOTION_TOKEN`이 없어 페이지 생성·멱등 스킵을 실행으로 확인하지 못했다. 첫 적재로 검증해야 한다.
- Actions 러너에서의 실행. 시크릿 등록 후 `workflow_dispatch` 1회로 확인한다.
