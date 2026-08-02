#!/usr/bin/env python3
"""유동성 워치 부록 — 미 국채 입찰 결과 수집 (TreasuryDirect).

FRED 본체(fetch_liquidity.py)와 같은 원칙을 따른다: 설정은 config.json의
`treasurydirect` 섹션 한 곳에서만 읽고, 코드에 URL·필드명·한글 문안·유형 라벨을 두지 않는다.

FRED와 다른 점 하나 — **교차검증이 불가능하다.**
  TreasuryDirect 입찰 결과는 단일 원천이라 fredgraph.csv ↔ fredgraph.xls 같은
  두 경로 대조를 할 수 없다. 그 자리를 **스키마 엄격 검증**으로 대체한다:
  필수 필드(config.required_fields + 유형별 낙찰 필드)가 하나라도 비면
  그 행을 표에 싣지 않고 `dropped`에 사유를 남긴다. 빈칸을 추정으로 채우지 않는다.
  본문에는 '단일 원천(교차검증 불가)'을 매번 명시한다(config.body.auction_cautions).

낙찰 필드는 종목 유형마다 다르다 (2026-08-02 실호출로 확정 — 추정 아님)
  ┌────────────────────┬──────────────────────┬───────────────────────────────────┐
  │ 유형               │ 낙찰 필드            │ 실측 근거                          │
  ├────────────────────┼──────────────────────┼───────────────────────────────────┤
  │ Bill               │ highDiscountRate     │ highYield가 빈 문자열. 할인 발행    │
  │                    │ (+highInvestmentRate)│ 이라 할인율이 낙찰 지표다          │
  │ Note·Bond 고정금리 │ highYield            │ stop-out yield                    │
  │ TIPS (tips=Yes)    │ highYield = **실질** │ 명목채와 같은 열에서 비교 금지     │
  │ FRN (floatingRate) │ highDiscountMargin   │ highYield·highDiscountRate 둘 다   │
  │                    │                      │ 빔 (2026-07-29 2Y FRN)            │
  └────────────────────┴──────────────────────┴───────────────────────────────────┘
  이 매핑은 코드가 아니라 config.treasurydirect.yield_rules에 있다.
  규칙은 위에서부터 순서대로 평가되고 마지막 항목이 when={}(전부 일치)여야 한다 —
  FRN Note가 'Note'라는 이유로 명목 규칙에 먼저 걸리면 안 되기 때문이다.

**이 모듈의 실패는 예외로 밖으로 나간다. 격리는 호출부(fetch_liquidity.collect)가 한다** —
입찰 부록이 FRED 본체를 인질로 잡으면 안 된다.

사용
    python3 scripts/liquidity/fetch_auctions.py            # 사람이 읽는 표
    python3 scripts/liquidity/fetch_auctions.py --json

의존: 표준 라이브러리 + curl (fetch_liquidity._get 재사용).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fetch_liquidity import _get, load_config  # noqa: E402

REQUIRED_TD = ["url", "source_label", "source_url", "timeout_seconds", "retries",
               "request_days", "window_days", "type_field", "term_field", "date_field",
               "btc_field", "accepted_field", "required_fields", "type_labels",
               "yield_rules", "btc_decimals", "accepted_divide_by", "accepted_decimals"]
REQUIRED_RULE = ["key", "when", "match_label", "field", "label", "decimals"]


# ---------------------------------------------------------------- 설정 검증

def validate_auction_config(cfg, path="<config>"):
    """깨진 설정으로 수집을 시작하지 않는다. 특히 규칙 순서를 강제한다."""
    if "treasurydirect" not in cfg:
        raise RuntimeError("config에 treasurydirect 섹션이 없다 (%s)" % path)
    t = cfg["treasurydirect"]
    missing = [k for k in REQUIRED_TD if k not in t]
    if missing:
        raise RuntimeError("config.treasurydirect 누락: %s (%s)" % (", ".join(missing), path))
    if not isinstance(t["window_days"], int) or t["window_days"] <= 0:
        raise RuntimeError("config.treasurydirect.window_days는 양의 정수여야 한다: %r"
                           % t["window_days"])
    if t["request_days"] < t["window_days"]:
        raise RuntimeError("request_days(%r) < window_days(%r) — 창보다 적게 받으면 누락된다"
                           % (t["request_days"], t["window_days"]))
    if not t["accepted_divide_by"]:
        raise RuntimeError("config.treasurydirect.accepted_divide_by는 0이 될 수 없다")
    rules = t["yield_rules"]
    if not rules:
        raise RuntimeError("config.treasurydirect.yield_rules가 비었다 — 낙찰 필드를 고를 수 없다")
    for r in rules:
        gone = [k for k in REQUIRED_RULE if k not in r]
        if gone:
            raise RuntimeError("yield_rules[%s]에 %s가 없다" % (r.get("key", "?"), ", ".join(gone)))
    for r in rules[:-1]:
        if not r["when"]:
            raise RuntimeError(
                "yield_rules[%s].when이 비었다 — 마지막이 아닌 규칙이 전부 일치하면 "
                "뒤 규칙이 죽는다(FRN·TIPS가 명목 규칙에 먼저 걸린다)" % r["key"])
    if rules[-1]["when"]:
        raise RuntimeError("yield_rules의 마지막 규칙은 when={}(기본값)이어야 한다: %r"
                           % rules[-1]["key"])
    for key in ("auction_heading", "auction_table_headers", "auction_claim_format",
                "auction_cautions", "auction_empty_format", "auction_failed_format",
                "auction_metric_kind_format"):
        if key not in cfg.get("body", {}):
            raise RuntimeError("config.body에 %r가 없다 (%s)" % (key, path))
    return cfg


# ---------------------------------------------------------------- 필드 헬퍼

def _s(rec, field):
    """문자열 필드. API는 결측을 빈 문자열로 준다(null이 아니다)."""
    v = rec.get(field)
    return "" if v is None else str(v).strip()


def _num(rec, field):
    """수치 필드. API가 전부 문자열로 주므로 float 변환한다. 결측·비수치는 None."""
    raw = _s(rec, field)
    if not raw:
        return None
    try:
        return float(raw)
    except ValueError:
        return None


def _date(rec, field):
    """'2026-07-22T00:00:00' → date. 파싱 실패는 None(추정하지 않는다)."""
    raw = _s(rec, field)[:10]
    if not raw:
        return None
    try:
        return datetime.strptime(raw, "%Y-%m-%d").date()
    except ValueError:
        return None


def pick_rule(rec, rules):
    """config 순서대로 첫 일치 규칙. 마지막은 when={}이라 항상 걸린다(검증으로 강제)."""
    for r in rules:
        if all(_s(rec, k) == v for k, v in (r["when"] or {}).items()):
            return r
    return None


def metric_kinds(tcfg, body):
    """'재정증권(Bill)=최고 할인율(highDiscountRate), …' — 규칙에서 파생한다.

    같은 문장을 config에 두 번 쓰면 규칙을 늘렸을 때 한쪽이 낡는다. 여기서 만든다.
    """
    f = body["auction_metric_kind_format"]
    return ", ".join(f.format(match_label=r["match_label"], label=r["label"], field=r["field"])
                     for r in tcfg["yield_rules"])


# ---------------------------------------------------------------- 행 조립

def describe(rec, tcfg):
    """표의 '종목' 셀. 유형 한글명 + 만기 + 플래그(재발행·TIPS·FRN)."""
    stype = _s(rec, tcfg["type_field"])
    label = tcfg["type_labels"].get(stype) or tcfg["type_label_fallback"].format(type=stype)
    term = _s(rec, tcfg["term_field"])
    flags = []
    for field, flag_label in (tcfg.get("flag_labels") or {}).items():
        if _s(rec, field) == "Yes":
            flags.append(flag_label)
    original = _s(rec, tcfg["original_term_field"])
    if _s(rec, tcfg["reopening_field"]) == "Yes" and original and original != term:
        flags.append(tcfg["reopening_origin_format"].format(original=original))
    text = "%s %s" % (label, term) if term else label
    return (text + " (%s)" % ", ".join(flags)) if flags else text, label, stype, term


def build_row(rec, tcfg):
    """(row, dropped_reason). 필수 필드가 하나라도 비면 row=None — 추정으로 채우지 않는다."""
    rule = pick_rule(rec, tcfg["yield_rules"])
    text, type_label, stype, term = describe(rec, tcfg)
    ident = "%s / %s / %s" % (text, _s(rec, tcfg["date_field"])[:10] or "입찰일 결측",
                              _s(rec, tcfg["cusip_field"]) or "CUSIP 결측")

    missing = [f for f in tcfg["required_fields"] if not _s(rec, f)]
    if rule is None:
        missing.append("<낙찰 필드 규칙 없음>")
    elif _num(rec, rule["field"]) is None:
        missing.append("%s(%s 규칙)" % (rule["field"], rule["key"]))
    adate = _date(rec, tcfg["date_field"])
    if adate is None and tcfg["date_field"] not in missing:
        missing.append("%s(날짜 파싱 실패)" % tcfg["date_field"])
    btc = _num(rec, tcfg["btc_field"])
    if btc is None and tcfg["btc_field"] not in missing:
        missing.append("%s(수치 아님)" % tcfg["btc_field"])
    if missing:
        return None, "%s — 결측 필드: %s" % (ident, ", ".join(missing))

    row = {
        "item": text, "type": stype, "type_label": type_label, "term": term,
        "auction_date": adate.isoformat(),
        "issue_date": (_date(rec, tcfg["issue_date_field"]) or "").isoformat()
                      if _date(rec, tcfg["issue_date_field"]) else "",
        "cusip": _s(rec, tcfg["cusip_field"]),
        "metric_key": rule["key"], "metric_label": rule["label"], "metric_field": rule["field"],
        "metric_value": _num(rec, rule["field"]),
        "metric_decimals": rule["decimals"], "metric_suffix": rule.get("suffix", ""),
        "extra_label": rule.get("extra_label", ""),
        "extra_field": rule.get("extra_field", ""),
        "extra_value": _num(rec, rule["extra_field"]) if rule.get("extra_field") else None,
        "extra_decimals": rule.get("extra_decimals", rule["decimals"]),
        "btc": btc,
        "accepted": _num(rec, tcfg["accepted_field"]),
    }
    return row, None


# ---------------------------------------------------------------- 본체

def collect_auctions(cfg, cache_dir=None, today=None):
    """지난 window_days일 입찰 결과. 실패는 예외로 던진다(격리는 호출부 몫)."""
    validate_auction_config(cfg)
    t = cfg["treasurydirect"]
    kst = timezone(timedelta(hours=cfg["notion"]["timezone_offset_hours"]))
    now = datetime.now(timezone.utc)
    end = today or now.astimezone(kst).date()
    start = end - timedelta(days=t["window_days"] - 1)

    url = t["url"].format(days=t["request_days"])
    raw = _get(url, t, cache_dir)
    try:
        records = json.loads(raw.decode("utf-8"))
    except ValueError as exc:
        raise RuntimeError("TreasuryDirect 응답이 JSON이 아니다: %s" % exc)
    if not isinstance(records, list):
        raise RuntimeError("TreasuryDirect 응답이 배열이 아니다: %s" % type(records).__name__)

    rows, dropped, in_window = [], [], 0
    for rec in records:
        if not isinstance(rec, dict):
            dropped.append("배열 원소가 객체가 아니다: %r" % (str(rec)[:80],))
            continue
        adate = _date(rec, t["date_field"])
        if adate is None:
            dropped.append("입찰일을 읽지 못해 기간 판정 불가 (%s=%r)"
                           % (t["date_field"], _s(rec, t["date_field"])[:40]))
            continue
        if not (start <= adate <= end):
            continue
        in_window += 1
        row, reason = build_row(rec, t)
        (rows.append(row) if row else dropped.append(reason))

    rows.sort(key=lambda r: (r["auction_date"], r["type"], r["term"]))
    counts = {}
    for r in rows:
        counts[r["type_label"]] = counts.get(r["type_label"], 0) + 1

    return {
        "status": "ok" if rows else "empty",
        "source": t["source_label"],
        "source_url": t["source_url"],
        "fetched_at_kst": now.astimezone(kst).strftime("%Y-%m-%d %H:%M KST"),
        "window": {"start": start.isoformat(), "end": end.isoformat(),
                   "days": t["window_days"], "requested_days": t["request_days"]},
        "raw_count": len(records),
        "in_window_count": in_window,
        "count": len(rows),
        "breakdown": [{"type_label": k, "n": v} for k, v in
                      sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))],
        "rows": rows,
        "dropped": dropped,
        "cross_check": {
            "available": False,
            "method": "단일 원천 — 이중 경로 대조 불가. 스키마 엄격 검증(필수 필드 결측 행 제외)으로 갈음",
            "required_fields": t["required_fields"],
            "dropped_count": len(dropped),
        },
        "metric_kinds": metric_kinds(t, cfg["body"]),
        "error": None,
    }


def collect_auction_history(cfg, cache_dir=None, today=None):
    """차트④ 전용 — 더 긴 창(chart_request_days)의 입찰 이력.

    **본문 부록과 별개의 호출이다.** 부록(window_days=7)의 값을 건드리지 않는다 —
    같은 표를 두 기준으로 만들면 어느 쪽이 맞는지 알 수 없게 된다.
    여기서는 차트에 필요한 최소 필드(입찰일·유형·응찰배수)만 검증한다:
    낙찰 지표는 그리지 않으므로 유형별 낙찰 필드 결측을 이유로 행을 버리지 않는다.
    """
    validate_auction_config(cfg)
    t = cfg["treasurydirect"]
    kst = timezone(timedelta(hours=cfg["notion"]["timezone_offset_hours"]))
    now = datetime.now(timezone.utc)
    end = today or now.astimezone(kst).date()
    start = end - timedelta(weeks=t["chart_weeks"])

    raw = _get(t["url"].format(days=t["chart_request_days"]), t, cache_dir)
    records = json.loads(raw.decode("utf-8"))
    if not isinstance(records, list):
        raise RuntimeError("TreasuryDirect 이력 응답이 배열이 아니다: %s" % type(records).__name__)

    rows, dropped = [], []
    for rec in records:
        if not isinstance(rec, dict):
            continue
        adate = _date(rec, t["date_field"])
        btc = _num(rec, t["btc_field"])
        stype = _s(rec, t["type_field"])
        if adate is None or btc is None or not stype:
            dropped.append("%s / %s — 차트 필수 필드(입찰일·유형·응찰배수) 결측"
                           % (_s(rec, t["cusip_field"]) or "CUSIP 결측",
                              _s(rec, t["date_field"])[:10] or "입찰일 결측"))
            continue
        if not (start <= adate <= end):
            continue
        rows.append({"auction_date": adate.isoformat(), "type": stype,
                     "term": _s(rec, t["term_field"]), "btc": btc})
    rows.sort(key=lambda r: (r["auction_date"], r["type"], r["term"]))
    return {
        "status": "ok" if rows else "empty",
        "window": {"start": start.isoformat(), "end": end.isoformat(),
                   "weeks": t["chart_weeks"], "requested_days": t["chart_request_days"]},
        "raw_count": len(records), "count": len(rows),
        "rows": rows, "dropped": dropped,
        "_note": "차트 전용. 본문 부록(입찰일 최근 %d일)과 별개 호출이며 부록 값을 바꾸지 않는다."
                 % t["window_days"],
        "error": None,
    }


def failed_auctions(cfg, error):
    """수집 실패 자리표시자. 조용히 비우지 않고 실패 사실을 데이터로 남긴다."""
    t = cfg.get("treasurydirect") or {}
    return {"status": "failed", "error": str(error)[:500],
            "source": t.get("source_label", "TreasuryDirect"),
            "source_url": t.get("source_url", ""),
            "count": 0, "rows": [], "dropped": [], "breakdown": [],
            "window": {"days": t.get("window_days")},
            "cross_check": {"available": False, "method": "수집 실패로 검증 미실시"}}


def print_auctions(res):
    if res["status"] == "failed":
        print("입찰 수집 실패: %s" % res["error"])
        return
    w = res["window"]
    print("입찰 창 %s~%s (%d일) — 원천 %d건 중 기간내 %d건, 표에 실은 것 %d건, 제외 %d건"
          % (w["start"], w["end"], w["days"], res["raw_count"],
             res["in_window_count"], res["count"], len(res["dropped"])))
    for r in res["rows"]:
        val = "%.*f%s" % (r["metric_decimals"], r["metric_value"], r["metric_suffix"])
        if r["extra_value"] is not None:
            val += " (%s %.*f%s)" % (r["extra_label"], r["extra_decimals"],
                                     r["extra_value"], r["metric_suffix"])
        print("  %s | %s | %s %s | btc %.2f" % (r["auction_date"], r["item"],
                                                r["metric_label"], val, r["btc"]))
    for d in res["dropped"]:
        print("  [제외] %s" % d)


def main():
    ap = argparse.ArgumentParser(description="미 국채 입찰 결과 수집(TreasuryDirect)")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--config", default=None)
    ap.add_argument("--cache-dir", default=None)
    args = ap.parse_args()
    cfg = load_config(args.config)
    res = collect_auctions(cfg, args.cache_dir)
    print(json.dumps(res, ensure_ascii=False, indent=2)) if args.json else print_auctions(res)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print("입찰 수집 실패: %s" % exc, file=sys.stderr)
        sys.exit(1)
