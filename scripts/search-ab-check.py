#!/usr/bin/env python3
"""LLM 보조 ON/OFF 결과 대조 — "LLM이 검색을 좁히지 않는다"를 측정으로 지킨다.

2026-08-05 사고: LLM에 "필요 없는 소스는 null" 권한을 줬더니 ON이 OFF보다
결과가 좁아졌다(생산자물가 세부품목 ON 36건 / OFF 96건, ECOS 국제 비교표 소실).
LLM은 넓히는 데만 써야 하며, 그 불변조건은 이 스크립트로 확인한다.

판정: **ON 건수가 OFF보다 적은 질의가 하나라도 있으면 실패.**
소스별 건수도 함께 대조한다(총량이 같아도 한 소스가 사라지면 실패다).

사용법:
  ln -sfn "<저장소>" /tmp/econ-cockpit  # 또는 ASCII 경로 복제본
  cd <저장소> && set -a; . ./.env.local; set +a
  python3 scripts/search-ab-check.py
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request

BASE = os.environ.get("COCKPIT_BASE", "http://localhost:3500")

# (질의, 상위 결과에 반드시 들어가야 하는 표현 or None)
#  - 앞 4개: LLM ON이 OFF보다 좁아졌던 질의 (2026-08-05 검증 지적)
#  - 국고채 3개: 표 이름에는 없고 항목 이름에만 있어 종전 0건이던 채권데스크 1순위 질의.
#    ECOS에서 국고채가 든 표의 이름은 "시장금리(일별)"이라 항목명 색인이 없으면 못 찾는다.
QUERIES = [
    ("생산자물가 세부품목", None),
    ("통화량 M2 평잔", None),
    ("취업자수 산업별", None),
    ("가구당 월평균 가계수지 교육비", None),
    ("국고채 커브", "국고채"),
    ("국고채 3년 5년 10년 커브", "국고채"),
    ("국고채 10년", "국고채"),
    ("한국이랑 미국 소비자물가 비교", None),
    # 아래 3개는 집합 포함 위반이 실제로 났던 표(817Y002·721Y001, Group1 27항목)를
    # 정면으로 겨냥한다. LLM 힌트가 원문 점수 0인 동점 항목의 선택을 갈라
    # ON에서 통안증권·국민주택채권·CD·KORIBOR가 사라졌던 자리다.
    ("통안증권 금리", "통안증권"),
    ("KORIBOR 금리", None),
    ("국민주택채권 금리", None),
]

#: 기대 표현을 찾을 상위 결과 개수
TOP_N = 5


def login() -> str:
    token = os.environ.get("COCKPIT_SESSION")
    if token:
        return token
    pw = os.environ.get("APP_PASSWORD")
    if not pw:
        return ""  # 로컬 dev에서 APP_PASSWORD 미설정이면 게이트가 열려 있다
    req = urllib.request.Request(
        f"{BASE}/api/login",
        data=json.dumps({"password": pw}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        for k, v in r.getheaders():
            if k.lower() == "set-cookie" and v.startswith("econ_cockpit_session="):
                return v.split(";")[0].split("=", 1)[1]
    return ""


TOKEN = login()
HEAD = {"Cookie": f"econ_cockpit_session={TOKEN}"} if TOKEN else {}


def search(q: str, llm: bool) -> dict:
    url = f"{BASE}/api/search?q={urllib.parse.quote(q)}" + ("" if llm else "&llm=off")
    req = urllib.request.Request(url, headers=HEAD)
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def by_source(d: dict) -> dict:
    out = {}
    for x in d.get("results", []):
        out[x["source"]] = out.get(x["source"], 0) + 1
    return out


def sigs(d: dict) -> set:
    """결과 하나의 신원 = 소스 + 조회 파라미터.

    건수만 비교하면 "ON에서 4건이 빠지고 다른 4건이 들어온" 경우를 못 잡는다.
    실제로 그렇게 새고 있었다(통안증권·국민주택채권·CD·KORIBOR).
    불변조건은 '집합 포함'이지 '건수 비교'가 아니다.
    """
    return {
        x["source"] + ":" + "&".join(f"{k}={v}" for k, v in sorted(x.get("params", {}).items()))
        for x in d.get("results", [])
    }


def name_of(d: dict, sig: str) -> str:
    for x in d.get("results", []):
        s = x["source"] + ":" + "&".join(f"{k}={v}" for k, v in sorted(x.get("params", {}).items()))
        if s == sig:
            return x.get("name", sig)
    return sig


def main() -> int:
    print(f"{'질의':<34} {'OFF':>18}  {'ON':>18}  판정")
    print("-" * 84)
    failures = []
    for i, (q, expect) in enumerate(QUERIES):
        if i:
            time.sleep(3)  # 기관 API 예의
        try:
            off = search(q, False)
            time.sleep(1)
            on = search(q, True)
        except Exception as e:  # noqa: BLE001
            print(f"{q:<34} 조회 실패: {e}")
            failures.append((q, "조회 실패"))
            continue
        n_off, n_on = len(off.get("results", [])), len(on.get("results", []))
        s_off, s_on = by_source(off), by_source(on)
        # 총량과 소스별 건수 둘 다 줄면 안 된다
        lost = [s for s, n in s_off.items() if s_on.get(s, 0) < n]
        ok = n_on >= n_off and not lost
        if not ok:
            failures.append((q, f"ON {n_on} < OFF {n_off} · 감소 소스 {lost}"))
        # 핵심 불변조건: OFF의 결과 집합이 ON에 전부 들어 있어야 한다
        missing = sigs(off) - sigs(on)
        if missing:
            ok = False
            sample = ", ".join(name_of(off, m) for m in list(missing)[:3])
            failures.append((q, f"ON에서 사라진 결과 {len(missing)}건: {sample}"))
        # 기대 표현은 ON·OFF 양쪽 상위 결과에 있어야 한다 (LLM 없이도 닿아야 한다)
        if expect:
            for label, d in (("OFF", off), ("ON", on)):
                names = [x["name"] for x in d.get("results", [])[:TOP_N]]
                if not any(expect in n for n in names):
                    ok = False
                    failures.append((q, f'{label} 상위 {TOP_N}건에 "{expect}" 없음'))
        print(
            f"{q:<34} {n_off:>4}건 {str(s_off):>12}  {n_on:>4}건 {str(s_on):>12}  "
            f"{'OK' if ok else 'FAIL'}"
        )
    print()
    if failures:
        print(f"실패 {len(failures)}건 — LLM이 결과를 좁혔거나 기대 계열에 못 닿았다")
        for q, why in failures:
            print(f"  - {q}: {why}")
        return 1
    print(f"{len(QUERIES)}/{len(QUERIES)} OK — ON이 OFF보다 좁아진 질의 없음 · 기대 계열 전부 도달")
    return 0


if __name__ == "__main__":
    sys.exit(main())
