#!/usr/bin/env python3
"""한글 질의 회귀 배터리 — 챗 플래너가 한국어 표현을 올바른 지표로 해석하는지 실측.

사용법:
  1) 로컬 dev 서버 기동 (포트 3500)
     ※ 저장소 경로에 한글이 있으면 Turbopack이 죽는다(Next 16.2.11, ident.rs
       char boundary). 영문 경로 심볼릭 링크에서 띄울 것:
         ln -sfn "<저장소>" /tmp/econ-cockpit && cd /tmp/econ-cockpit && npm run dev -- -p 3500
  2) 인증 — 둘 중 하나
     (a) 저장소에서 `set -a; . ./.env.local; set +a` 로 APP_PASSWORD를 넣으면
         이 스크립트가 알아서 로그인한다 (토큰을 파일로 남기지 않는다)
     (b) COCKPIT_SESSION=<토큰> 직접 지정
  3) python3 scripts/korean-query-battery.py

주의: OpenAI 조직 TPM 한도(gpt-4o 30k/분, 2026-08-01 기준) 때문에 문항당
25초 페이싱을 둔다. 연속 호출로 429가 나면 라우트가 최대 2회 재시도한다.

기대값 갱신 규칙: 지표 레지스트리(lib/indicators.ts)에 별칭을 추가하면
여기에 그 별칭을 쓰는 문항을 1개 이상 추가한다.
"""
import json
import os
import sys
import time
import urllib.request

BASE = os.environ.get("COCKPIT_BASE", "http://localhost:3500")


def login() -> str:
    """세션 토큰 확보 — 환경변수 우선, 없으면 APP_PASSWORD로 직접 로그인.

    토큰은 프로세스 메모리에만 둔다(파일로 쓰지 않는다).
    """
    token = os.environ.get("COCKPIT_SESSION")
    if token:
        return token
    pw = os.environ.get("APP_PASSWORD")
    if not pw:
        sys.exit("COCKPIT_SESSION 또는 APP_PASSWORD 환경변수가 필요합니다")
    req = urllib.request.Request(
        f"{BASE}/api/login",
        data=json.dumps({"password": pw}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        for k, v in r.getheaders():
            if k.lower() == "set-cookie" and v.startswith("econ_cockpit_session="):
                return v.split(";")[0].split("=", 1)[1]
    sys.exit("로그인 응답에 세션 쿠키가 없습니다")


TOKEN = login()

# (질의, 기대 계열 id 목록, exact) — exact=True면 목록이 정확히 일치해야 함.
# 기대가 빈 목록이면 "전부 adhoc(카탈로그 검색) 경로"를 기대한다는 뜻.
# 등록 지표는 indicatorId, 검색 계열은 series_id()가 만드는 adhoc:… 표기를 쓴다.
TESTS = [
    ("원달러 환율 3년", ["kr_usdkrw"], True),
    ("CD금리 1년", ["kr_cd_91d_yield"], True),  # "1년"은 기간 — 국고 1년 추가되면 오답
    ("국고 10년 1년치", ["kr_ktb_10y_yield"], True),
    ("국고 5년이랑 30년 금리 3년치", ["kr_ktb_5y_yield", "kr_ktb_30y_yield"], True),
    ("논팜이랑 미국 실업률 2년치", ["us_nonfarm_payrolls", "us_unemployment"], True),
    ("한국이랑 미국 기준금리 5년 비교", ["kr_base_rate", "us_fedfunds"], True),
    ("슈퍼코어랑 근원 PCE 전년비 3년", ["us_cpi_services_less_shelter", "us_core_pce"], True),
    ("회사채 AA-랑 국고 3년 스프레드 5년치", ["kr_corp_3y_aa_yield", "kr_ktb_3y_yield"], True),
    ("한국 CPI랑 미국 CPI 전년비로 겹쳐줘", ["kr_cpi", "us_cpi"], True),
    ("미국 케이스실러 주택가격 5년", [], False),
    ("수출금액지수랑 수출물량지수 3년", ["kr_export_value_idx", "kr_export_volume_idx"], True),
    ("광공업생산이랑 경기선행지수 5년치", ["kr_ip_index", "kr_leading_index"], True),
    ("미국 근원 CPI랑 미국 PCE 전년비 3년", ["us_core_cpi", "us_pce"], True),
    ("서울 아파트 매매가격지수랑 국고 3년 금리 전년대비 4년", ["kr_apt_sale_idx_seoul", "kr_ktb_3y_yield"], True),
    # 2026-08-04 추가 — 검색 결손(표당 항목 절단) 수정 회귀.
    # 121Y006 예금은행 대출금리(신규취급액)의 Group1은 19개인데 종전에는 앞 6개만
    # 노출돼 기업/가계/주택담보대출에 도달할 경로가 아예 없었다.
    (
        "ecos 1.3.3.2.1 예금은행 대출금리 중 기업대출, 가계대출, 주택담보대출의 전년대비 증감률",
        ["adhoc:121Y006:BECBLA02", "adhoc:121Y006:BECBLA03", "adhoc:121Y006:BECBLA0302"],
        True,
    ),
    # 소스를 넘나드는 조합 — 한 소스가 후보 칸을 독식하면 반대쪽이 0건이 된다
    ("한국 국고채 10년이랑 미국채 10년 금리 3년치", ["kr_ktb_10y_yield", "us_10y"], True),
    # 주기가 다른 계열 조합(월 + 분기) — 성긴 주기로 환산해 정렬되는지
    ("한국 소비자물가랑 실질 GDP 5년치", ["kr_cpi", "kr_gdp"], True),
]


def series_id(s: dict) -> str:
    """계획의 series 항목 → 비교용 id.

    등록 지표는 indicatorId, 검색 계열은 소스별 식별 파라미터로 만든다.
    (FRED는 seriesId, ECOS는 statCode+itemCode1, KOSIS는 tblId+itmId)
    """
    if s.get("indicatorId"):
        return s["indicatorId"]
    p = s.get("params", {})
    if p.get("seriesId"):
        return f"adhoc:{p['seriesId']}"
    if p.get("statCode"):
        return f"adhoc:{p['statCode']}:{p.get('itemCode1', '')}"
    if p.get("tblId"):
        return f"adhoc:{p['tblId']}:{p.get('itmId', '')}"
    return "adhoc:?"


def run() -> int:
    npass = 0
    for i, (q, expect, exact) in enumerate(TESTS):
        if i:
            time.sleep(25)  # TPM 페이싱
        t0 = time.time()
        req = urllib.request.Request(
            f"{BASE}/api/chat",
            data=json.dumps({"query": q}).encode(),
            headers={
                "Content-Type": "application/json",
                "Cookie": f"econ_cockpit_session={TOKEN}",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                d = json.load(r)
        except Exception as e:  # noqa: BLE001 — 실패 사유를 그대로 보고
            print(f"FAIL {q} -> {e}")
            continue
        dt = time.time() - t0
        plan = d.get("plan")
        if not plan:
            print(f"FAIL {dt:4.1f}s {q} -> {d.get('message') or d.get('error')}")
            continue
        ids = [series_id(s) for s in plan["series"]]
        if exact and expect:
            ok = sorted(ids) == sorted(expect)
        elif expect:
            ok = all(e in ids for e in expect)
        else:
            ok = len(ids) >= 1 and all(x.startswith("adhoc:") for x in ids)
        npass += ok
        print(
            f"{'PASS' if ok else 'FAIL'} {dt:4.1f}s {q} -> {ids} "
            f"tf={plan['transform']} drv={bool(plan.get('derived'))}"
        )
    print(f"\n{npass}/{len(TESTS)} PASS")
    return 0 if npass == len(TESTS) else 1


if __name__ == "__main__":
    sys.exit(run())
