#!/usr/bin/env python3
"""한글 질의 회귀 배터리 — 챗 플래너가 한국어 표현을 올바른 지표로 해석하는지 실측.

사용법:
  1) 로컬 dev 서버 기동 (포트 3500)
  2) 세션 쿠키 토큰 발급:
     curl -s -D - -o /dev/null -X POST http://localhost:3500/api/login \
       -H 'Content-Type: application/json' -d '{"password":"<APP_PASSWORD>"}'
  3) COCKPIT_SESSION=<토큰> python3 scripts/korean-query-battery.py

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
TOKEN = os.environ.get("COCKPIT_SESSION")
if not TOKEN:
    sys.exit("COCKPIT_SESSION 환경변수(세션 쿠키 토큰)가 필요합니다")

# (질의, 기대 indicatorId 목록, exact) — exact=True면 목록이 정확히 일치해야 함.
# 기대가 빈 목록이면 "전부 adhoc(카탈로그 검색) 경로"를 기대한다는 뜻.
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
]


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
        ids = [
            s.get("indicatorId") or f"adhoc:{s.get('params', {}).get('seriesId', '?')}"
            for s in plan["series"]
        ]
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
