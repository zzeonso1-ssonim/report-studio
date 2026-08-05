#!/usr/bin/env python3
"""한글 질의 회귀 배터리 — 챗 플래너가 한국어 표현을 올바른 지표로 해석하는지 실측.

**정답률만 보던 스크립트가 아니다.** 2026-08-05부터 실행마다 눈금 4개를 함께 낸다
(scripts/battery_metrics.py).

  ① 정답률          기대 지표 코드를 실제로 집었는가 (아래 채점 규칙, 사람 판단 없음)
  ② 라운드 평균·최대 도구 호출 라운드 수 = 검색 결손의 대리지표이자 비용의 원인
  ③ 질의당 비용     모델별 토큰 × verify-config.json 요금표
  ④ 응답시간        평균·최대

왜: 2026-08-01에 플래너를 gpt-4o-mini→gpt-4o로 올려 단가를 크게 높였는데
"나아졌다"는 증거가 어디에도 없었다. 값을 했는지 재려면 눈금이 먼저 있어야 한다.

**채점 규칙(기계적, 사람 판단 없음)**
  - exact=True  : 계획의 series id 집합이 기대 목록과 **정확히 일치**해야 PASS.
                  → 기대 지표 누락뿐 아니라 **중복 시리즈**도 자동으로 FAIL이 된다.
  - exact=False : 기대 목록이 비었으면 "series가 1개 이상이고 전부 카탈로그 검색
                  결과(adhoc:…)"면 PASS.
  - id 규칙     : 등록 지표는 indicatorId, 검색 계열은 소스별 식별 파라미터
                  (FRED seriesId · ECOS statCode+itemCode1 · KOSIS tblId+itmId).
  - 계획이 안 나오면(되묻기·오류) 무조건 FAIL.
  ※ 애매한 지점: "정답"은 지표 레지스트리(lib/indicators.ts) 기준이다. 같은 개념의
    다른 계열을 골라도 FAIL로 채점된다 — 의도된 엄격함이지 품질 판정이 아니다.

**기본 실행은 무과금이다** — 픽스처 재생(scripts/verify_common.py). 실제 측정은
`--live`에서만 하고, 그 실행이 통과해야 픽스처를 갱신한다.

사용법:
  python3 scripts/korean-query-battery.py                      # 무과금 재생
  npx next dev --webpack -p 3500                               # 실측용 서버
  python3 scripts/korean-query-battery.py --live --label after --out /tmp/after.json
  OPENAI_MODEL=gpt-5 npx next dev --webpack -p 3500            # 모델 A/B는 서버 환경변수로

기대값 갱신 규칙: 지표 레지스트리(lib/indicators.ts)에 별칭을 추가하면
여기에 그 별칭을 쓰는 문항을 1개 이상 추가한다.
"""
import argparse
import json
import sys
import time

from battery_metrics import Battery
from verify_common import Session, add_common_args

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
    # ── 2026-08-05 추가 — 2026-08-01 mini 실패 3종을 각각 겨냥한다 ──────────
    # 모델 A/B(mini vs gpt-4o vs gpt-5)가 그때의 상향 결정을 검증하려면
    # 실패했던 유형이 배터리에 남아 있어야 한다.
    #
    # ① 기간 표현을 만기로 오인("1년치"를 국고 1년으로 읽는 오답).
    #   위 "CD금리 1년"·"국고 10년 1년치"와 함께 이 유형을 겨냥한다.
    ("국고 3년 1년치", ["kr_ktb_3y_yield"], True),
    # ② 중복 시리즈 생성 — 같은 지표를 두 번 넣으면 exact 채점에서 자동 FAIL이다.
    #   단일 지표 + 기간 표현이 중복이 가장 잘 나던 형태다.
    ("원달러 환율 1년치 보여줘", ["kr_usdkrw"], True),
    # ③ 지표 별칭 무시 — "슈퍼코어"는 등록 지표를 반드시 써야 한다(라우트의
    #   aliasViolation이 지키는 규칙). 근사 계열로 대체하면 FAIL.
    ("슈퍼코어 3년치", ["us_cpi_services_less_shelter"], True),
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


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    add_common_args(ap)
    ap.add_argument("--label", default="", help="before/after·모델 A/B 표에 쓸 이름")
    ap.add_argument("--out", help="행·요약을 JSON으로 저장할 경로 (표 조립용)")
    args = ap.parse_args()

    S = Session("korean-query-battery", args.live, args.base)
    B = Battery(args.label or ("live" if args.live else "replay"))

    for i, (q, expect, exact) in enumerate(TESTS):
        if i:
            S.sleep("batteryBetweenQueriesS")  # TPM 페이싱 (재생 모드에서는 대기 없음)
        t0 = time.time()
        try:
            _, d = S.post("/api/chat", {"query": q}, timeout=90)
        except Exception as e:  # noqa: BLE001 — 실패 사유를 그대로 보고
            print(f"FAIL {q} -> {e}")
            B.add(q, False, time.time() - t0, None, detail=str(e))
            continue
        dt = time.time() - t0
        usage = d.get("usage")
        plan = d.get("plan")
        if not plan:
            why = d.get("message") or d.get("error")
            print(f"FAIL {dt:4.1f}s {q} -> {why}")
            B.add(q, False, dt, usage, detail=str(why))
            continue
        ids = [series_id(s) for s in plan["series"]]
        if exact and expect:
            ok = sorted(ids) == sorted(expect)
        elif expect:
            ok = all(e in ids for e in expect)
        else:
            ok = len(ids) >= 1 and all(x.startswith("adhoc:") for x in ids)
        r = B.add(q, ok, dt, usage, detail=",".join(ids))
        print(
            f"{'PASS' if ok else 'FAIL'} {dt:4.1f}s r={r.rounds} {q} -> {ids} "
            f"tf={plan['transform']} drv={bool(plan.get('derived'))}"
        )

    s = B.summary()
    print(f"\n{s['pass']}/{s['n']} PASS")
    B.print_summary()
    if not args.live:
        # 재생 모드의 시간은 실측이 아니다 — 픽스처를 읽은 시간일 뿐이라 0에 가깝다.
        # 라운드·토큰·비용은 기록 당시의 실측값 그대로다.
        print("  ※ 재생 모드 — ④ 응답시간은 측정값이 아니다(픽스처 읽기 시간). ①②③은 기록 당시 실측")
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(
                {"summary": s, "rows": [r.__dict__ for r in B.rows]}, f, ensure_ascii=False, indent=2
            )
        print(f"  → {args.out}")

    ok = s["pass"] == s["n"]
    S.finish(ok)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
