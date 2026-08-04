#!/usr/bin/env python3
"""질의 → 계획 → 실제 데이터까지 관통 확인.

회귀 배터리(korean-query-battery.py)는 "플래너가 어느 지표를 골랐나"까지만 본다.
이 스크립트는 그 계획을 실제 조회 라우트(/api/series/[id], /api/series/adhoc)에
그대로 넣어 **값이 나오는지**를 확인한다. 화면이 열리는 것과 값이 나오는 것은
다르기 때문에, 완료 판정은 항상 이쪽으로 한다.

각 계열에 대해 마지막 관측치(시점·값)와 관측 수, 서버 안내문(note)을 찍는다.

사용법 (배터리와 동일):
  ln -sfn "<저장소>" /tmp/econ-cockpit && cd /tmp/econ-cockpit && npm run dev -- -p 3500
  cd <저장소> && set -a; . ./.env.local; set +a
  python3 scripts/e2e-query-check.py                 # 기본 질의 묶음
  python3 scripts/e2e-query-check.py "질의1" "질의2"  # 임의 질의
"""
import json
import os
import sys
import time
import urllib.request

BASE = os.environ.get("COCKPIT_BASE", "http://localhost:3500")

DEFAULT_QUERIES = [
    "ecos 1.3.3.2.1 예금은행 대출금리 중 기업대출, 가계대출, 주택담보대출의 전년대비 증감률",
    "한국 국고채 10년이랑 미국채 10년 금리 3년치",
    "한국 CPI랑 미국 CPI 전년비로 겹쳐줘",
    "한국 소비자물가랑 실질 GDP 5년치",
]


def login() -> str:
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
HEAD = {"Content-Type": "application/json", "Cookie": f"econ_cockpit_session={TOKEN}"}


def post(path: str, body: dict, timeout: int = 120) -> dict:
    req = urllib.request.Request(f"{BASE}{path}", data=json.dumps(body).encode(), headers=HEAD)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def get(path: str, timeout: int = 120) -> dict:
    req = urllib.request.Request(f"{BASE}{path}", headers=HEAD)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def last_obs(points: list) -> str:
    """마지막 유효 관측치 — 값이 없으면 그렇게 적는다(추정·보간 금지)"""
    valid = [p for p in points if p.get("value") is not None]
    if not valid:
        return "값 없음"
    p = valid[-1]
    return f"{p['date']} = {p['value']}"


def check(query: str) -> bool:
    print(f"\n{'=' * 78}\n질의: {query}")
    t0 = time.time()
    try:
        d = post("/api/chat", {"query": query})
    except Exception as e:  # noqa: BLE001
        print(f"  실패: /api/chat {e}")
        return False
    plan = d.get("plan")
    if not plan:
        print(f"  실패: 계획 없음 — {d.get('message') or d.get('error')}")
        return False
    print(
        f"  계획 {time.time() - t0:.1f}s · transform={plan['transform']} "
        f"{plan['startDate']}~{plan['endDate']} · note={d.get('note')}"
    )

    ok = True
    for s in plan["series"]:
        try:
            if s.get("indicatorId"):
                label = s["indicatorId"]
                r = get(
                    f"/api/series/{s['indicatorId']}?start={plan['startDate']}"
                    f"&end={plan['endDate']}&transform={plan['transform']}"
                )
            else:
                label = f"{s.get('source')} {json.dumps(s.get('params', {}), ensure_ascii=False)}"
                r = post(
                    "/api/series/adhoc",
                    {
                        "source": s.get("source"),
                        "params": s.get("params", {}),
                        "cycle": s.get("cycle", "M"),
                        "name": s.get("name", ""),
                        "unit": s.get("unit", ""),
                        "start": plan["startDate"],
                        "end": plan["endDate"],
                        "transform": plan["transform"],
                    },
                )
        except Exception as e:  # noqa: BLE001
            print(f"  ✗ {label}: 조회 실패 {e}")
            ok = False
            continue
        if r.get("error"):
            print(f"  ✗ {label}: {r['error']}")
            ok = False
            continue
        pts = r.get("points", [])
        good = any(p.get("value") is not None for p in pts)
        ok = ok and good
        print(
            f"  {'✓' if good else '✗'} {r['indicator']['name']} "
            f"[{r.get('transform')}] n={len(pts)} 최종 {last_obs(pts)}"
            + (f" · note={r['note']}" if r.get("note") else "")
        )
    return ok


def main() -> int:
    queries = sys.argv[1:] or DEFAULT_QUERIES
    results = []
    for i, q in enumerate(queries):
        if i:
            time.sleep(20)  # OpenAI TPM 페이싱
        results.append(check(q))
    npass = sum(results)
    print(f"\n{'=' * 78}\n{npass}/{len(results)} 질의에서 모든 계열이 값을 반환")
    return 0 if npass == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
