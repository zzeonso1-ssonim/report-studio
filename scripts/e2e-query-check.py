#!/usr/bin/env python3
"""질의 → 계획 → 실제 데이터까지 관통 확인.

회귀 배터리(korean-query-battery.py)는 "플래너가 어느 지표를 골랐나"까지만 본다.
이 스크립트는 그 계획을 실제 조회 라우트(/api/series/[id], /api/series/adhoc)에
그대로 넣어 **값이 나오는지**를 확인한다. 화면이 열리는 것과 값이 나오는 것은
다르기 때문에, 완료 판정은 항상 이쪽으로 한다.

각 계열에 대해 마지막 관측치(시점·값)와 관측 수, 서버 안내문(note)을 찍는다.

**기본 실행은 무과금이다** — 저장된 픽스처(scripts/fixtures/)를 재생한다.
실제 서버·OpenAI를 부르는 것은 `--live`를 명시했을 때뿐이고, 그 실행이 통과하면
같은 응답으로 픽스처를 갱신한다(scripts/verify_common.py).

사용법:
  # 기본 — 네트워크 0회, 서버 없이 돈다
  python3 scripts/e2e-query-check.py

  # 실호출(과금) — 서버를 띄운 뒤 픽스처를 갱신할 때만
  npx next dev --webpack -p 3500        # 또는 ASCII 경로 복제본에서 npm run dev
  python3 scripts/e2e-query-check.py --live
  python3 scripts/e2e-query-check.py --live "질의1" "질의2"   # 임의 질의
"""
import argparse
import sys
import time

from verify_common import Session, add_common_args

DEFAULT_QUERIES = [
    "ecos 1.3.3.2.1 예금은행 대출금리 중 기업대출, 가계대출, 주택담보대출의 전년대비 증감률",
    "한국 국고채 10년이랑 미국채 10년 금리 3년치",
    "한국 CPI랑 미국 CPI 전년비로 겹쳐줘",
    "한국 소비자물가랑 실질 GDP 5년치",
]


def last_obs(points: list) -> str:
    """마지막 유효 관측치 — 값이 없으면 그렇게 적는다(추정·보간 금지)"""
    valid = [p for p in points if p.get("value") is not None]
    if not valid:
        return "값 없음"
    p = valid[-1]
    return f"{p['date']} = {p['value']}"


def check(S: Session, query: str) -> bool:
    print(f"\n{'=' * 78}\n질의: {query}")
    t0 = time.time()
    try:
        _, d = S.post("/api/chat", {"query": query})
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
                _, r = S.get(
                    f"/api/series/{s['indicatorId']}?start={plan['startDate']}"
                    f"&end={plan['endDate']}&transform={plan['transform']}"
                )
            else:
                label = f"{s.get('source')} {s.get('params', {})}"
                _, r = S.post(
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
    ap = argparse.ArgumentParser(description=__doc__)
    add_common_args(ap)
    ap.add_argument("queries", nargs="*", help="임의 질의 (--live에서만 의미가 있다)")
    args = ap.parse_args()

    queries = args.queries or DEFAULT_QUERIES
    if args.queries and not args.live:
        sys.exit("임의 질의는 픽스처에 없습니다 — `--live`와 함께 쓰세요")

    S = Session("e2e-query-check", args.live, args.base)
    results = []
    for i, q in enumerate(queries):
        if i:
            S.sleep("e2eBetweenQueriesS")  # OpenAI TPM 페이싱 (재생 모드에서는 대기 없음)
        results.append(check(S, q))
    npass = sum(results)
    print(f"\n{'=' * 78}\n{npass}/{len(results)} 질의에서 모든 계열이 값을 반환")
    ok = npass == len(results)
    S.finish(ok)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
