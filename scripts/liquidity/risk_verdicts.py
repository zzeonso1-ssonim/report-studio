#!/usr/bin/env python3
"""유동성 워치 2단 — 노션 Risk Log 판정 자동 기입.

무엇을 하나
  ① **드리프트 검사**: 노션 Risk Log 페이지의 `판정 기준` 현재 원문을 읽어 config 사본과 대조한다.
     다르면 그 리스크는 **평가하지 않고** '확인 불가'로 남긴다. 디렉터가 임계를 고쳤는데
     자동화가 낡은 임계로 조용히 '정상'을 찍는 것을 막는 핵심 장치다.
  ② **평가**: 최신 관측일에서 역산한 window_days일 창 안에서 발동/근접 조건을 기계적으로 대조한다.
     '2영업일 연속'은 일간 이력으로 소급 평가하므로 주 1회 실행이어도 창 안의 연속 이틀을 잡아낸다.
  ③ **기입**: `최근 판정`(select)과 `최근 확인일`(date) **두 개만** PATCH한다.
     `상태`·`결말`·`판정 기준`·본문은 디렉터 영역이라 payload에 섞이면 예외를 던진다.

원칙 셋 — 어기면 조용히 틀린다
  - **침묵 금지.** 수집 실패·관측 노후·드리프트·노션 조회 실패는 전부 '확인 불가'로 **기입**한다.
    칸을 비워 두면 '아직 안 돌았다'와 '돌았는데 못 봤다'가 구분되지 않는다.
  - **임계는 코드에 없다.** 페이지 ID·연산자·임계·한글 문안은 전부 `config.risk_rules`에서 읽는다.
  - **격리.** 이 모듈의 실패가 브리핑 적재를 막지 않는다(워크플로에서 단계가 분리돼 있다).

노션 액세스 함정
  Risk Log는 최상위 DASHBOARD 하위에 있다. 인테그레이션 액세스 범위 밖이면 404가 난다.
  **우회하지 않는다** — `access_hint`를 로그에 찍고 '확인 불가'로 남긴 뒤 디렉터에게 넘긴다.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fetch_liquidity import load_config  # noqa: E402

# 연산자만 코드에 있다. **어떤 연산자를 쓸지·임계가 얼마인지는 config가 정한다.**
OPS = {
    ">=": lambda a, b: a >= b,
    ">": lambda a, b: a > b,
    "<=": lambda a, b: a <= b,
    "<": lambda a, b: a < b,
}


class RiskConfigError(RuntimeError):
    pass


# ---------------------------------------------------------------- 설정 검증

def validate_risk_rules(cfg, all_ids, path="<config>"):
    """config.risk_rules 자체 검증. 오타를 러너까지 끌고 가지 않는다."""
    rr = cfg.get("risk_rules")
    if rr is None:
        return
    need = ("database_id", "properties", "verdicts", "window_days", "rules",
            "write_properties", "page_url_format")
    for k in need:
        if k not in rr:
            raise RiskConfigError("%s: risk_rules.%s가 없다" % (path, k))
    for k in ("fire", "near", "normal", "unknown"):
        if k not in rr["verdicts"]:
            raise RiskConfigError("%s: risk_rules.verdicts.%s가 없다" % (path, k))
    for k in ("criteria", "verdict", "checked"):
        if k not in rr["properties"]:
            raise RiskConfigError("%s: risk_rules.properties.%s가 없다" % (path, k))

    # 쓰기 대상이 금지 목록과 겹치면 안 된다 — 여기서 막지 못하면 실쓰기에서 막을 곳이 없다.
    banned = set(rr.get("_never_write") or [])
    overlap = [p for p in rr["write_properties"] if p in banned]
    if overlap:
        raise RiskConfigError("%s: write_properties가 _never_write와 겹친다: %s"
                              % (path, ", ".join(overlap)))
    props = rr["properties"]
    if props["verdict"] not in rr["write_properties"] or props["checked"] not in rr["write_properties"]:
        raise RiskConfigError("%s: write_properties는 %r·%r를 포함해야 한다"
                              % (path, props["verdict"], props["checked"]))
    if props["criteria"] in rr["write_properties"]:
        raise RiskConfigError("%s: '판정 기준'(%r)은 디렉터 영역이라 쓸 수 없다"
                              % (path, props["criteria"]))

    seen = set()
    for i, r in enumerate(rr["rules"]):
        where = "%s: risk_rules.rules[%d]" % (path, i)
        for k in ("key", "page_id", "label", "series", "mode", "scale", "unit", "decimals",
                  "stale_days", "max_gap_days", "trigger", "near", "criteria_text",
                  "board_threshold"):
            if k not in r:
                raise RiskConfigError("%s: %s가 없다" % (where, k))
        if r["key"] in seen:
            raise RiskConfigError("%s: key가 중복이다: %r" % (where, r["key"]))
        seen.add(r["key"])
        if r["mode"] not in ("level", "change"):
            raise RiskConfigError("%s: mode를 모른다: %r" % (where, r["mode"]))
        if all_ids is not None and r["series"] not in all_ids:
            raise RiskConfigError("%s: series %r가 config.series/derived에 없다"
                                  % (where, r["series"]))
        for name in ("trigger", "near"):
            spec = r[name]
            if spec["op"] not in OPS:
                raise RiskConfigError("%s.%s: op를 모른다: %r (가능: %s)"
                                      % (where, name, spec["op"], ", ".join(OPS)))
            if not isinstance(spec.get("threshold"), (int, float)):
                raise RiskConfigError("%s.%s: threshold가 숫자가 아니다" % (where, name))
            if int(spec.get("consecutive", 1)) < 1:
                raise RiskConfigError("%s.%s: consecutive는 1 이상이다" % (where, name))

    # 신호 보드가 참조하는 risk_key가 실제로 있어야 한다.
    for row in (cfg.get("signal_board") or {}).get("rows", []):
        rk = row.get("risk_key")
        if rk and rk not in seen:
            raise RiskConfigError("%s: signal_board.rows[%s].risk_key %r가 risk_rules에 없다"
                                  % (path, row.get("id"), rk))


# ---------------------------------------------------------------- 평가

def _points(result, rule):
    """[(date, 임계 단위로 환산한 값)] — 관측일 오름차순. 없으면 None."""
    obs = (result.get("observations") or {}).get(rule["series"])
    if not obs:
        return None
    pts = [(date.fromisoformat(d), float(v) * rule["scale"]) for d, v in obs]
    pts.sort(key=lambda x: x[0])
    return pts


def _series_for_eval(pts, rule):
    """mode에 따라 평가 대상 계열을 만든다.

    level  — 관측값 그대로.
    change — **직전 관측 대비 변화.** 관측 간격이 max_gap_days를 넘으면 그 점은 버린다
             (결측 구간을 건너뛴 차분을 '주간 변화'로 부르면 값이 조용히 틀린다).
    """
    if rule["mode"] == "level":
        return list(pts)
    out = []
    for i in range(1, len(pts)):
        gap = (pts[i][0] - pts[i - 1][0]).days
        if gap > rule["max_gap_days"]:
            continue
        out.append((pts[i][0], pts[i][1] - pts[i - 1][1]))
    return out


def _hit_index(pts, i, spec, rule):
    """i번 관측이 spec을 '성립'시키나. consecutive=n이면 i를 끝으로 하는 n개 연속을 본다."""
    op = OPS[spec["op"]]
    n = int(spec.get("consecutive", 1))
    if i - (n - 1) < 0:
        return False
    for k in range(n):
        j = i - k
        if not op(pts[j][1], spec["threshold"]):
            return False
        # 연속성은 달력일이 아니라 인접 관측으로 센다(주말·공휴일은 관측이 없다).
        # 다만 간격이 max_gap_days를 넘으면 '연속'으로 보지 않는다.
        if k > 0 and (pts[j + 1][0] - pts[j][0]).days > rule["max_gap_days"]:
            return False
    return True


def _fmt(value, rule):
    return "{:,.{d}f}".format(value, d=rule["decimals"])


def evaluate_rule(rule, result, rrcfg, run_date):
    """한 리스크의 판정. 반환은 verdict_key + 근거 문장 + 실측값."""
    v = rrcfg["verdicts"]
    base = {
        "key": rule["key"], "page_id": rule["page_id"], "label": rule["label"],
        "series": rule["series"], "unit": rule["unit"], "mode": rule["mode"],
        "board_threshold": rule["board_threshold"],
        "page_url": rrcfg["page_url_format"].format(
            page_id_compact=rule["page_id"].replace("-", "")),
        "window_days": rrcfg["window_days"],
    }

    raw = _points(result, rule)
    if raw is None:
        return dict(base, verdict_key="unknown", verdict=v["unknown"],
                    reason=rrcfg["missing_series_format"].format(series=rule["series"]),
                    basis=rrcfg["missing_series_format"].format(series=rule["series"]))

    latest_date, latest_value = raw[-1]
    age = (run_date - latest_date).days
    base.update({"latest_date": latest_date.isoformat(),
                 "latest_value": round(latest_value, 6),
                 "latest_text": "%s%s" % (_fmt(latest_value, rule), rule["unit"]),
                 "age_days": age})
    if age > rule["stale_days"]:
        reason = rrcfg["stale_format"].format(series=rule["series"],
                                              latest_date=latest_date.isoformat(),
                                              age=age, stale_days=rule["stale_days"])
        return dict(base, verdict_key="unknown", verdict=v["unknown"],
                    reason=reason, basis=reason)

    pts = _series_for_eval(raw, rule)
    if not pts:
        reason = rrcfg["no_data_format"].format(series=rule["series"])
        return dict(base, verdict_key="unknown", verdict=v["unknown"],
                    reason=reason, basis=reason)

    anchor = pts[-1][0]
    win_from = anchor - timedelta(days=rrcfg["window_days"] - 1)
    idxs = [i for i, (d, _) in enumerate(pts) if d >= win_from]
    base.update({"window_from": win_from.isoformat(), "window_to": anchor.isoformat(),
                 "window_n": len(idxs),
                 "eval_latest": round(pts[-1][1], 6),
                 "eval_latest_text": "%s%s" % (_fmt(pts[-1][1], rule), rule["unit"]),
                 "eval_latest_date": anchor.isoformat()})

    # **발동을 먼저 본다.** 창 안에서 가장 늦게 성립한 날을 근거로 삼는다.
    for name, key in (("trigger", "fire"), ("near", "near")):
        spec = rule[name]
        hits = [i for i in idxs if _hit_index(pts, i, spec, rule)]
        if hits:
            i = hits[-1]
            n = int(spec.get("consecutive", 1))
            run = [(pts[j][0].isoformat(), round(pts[j][1], 6)) for j in range(i - n + 1, i + 1)]
            evidence = ", ".join("%s %s%s" % (d, _fmt(x, rule), rule["unit"]) for d, x in run)
            return dict(base, verdict_key=key, verdict=v[key],
                        hit_dates=[d for d, _ in run],
                        basis="%s %s %s%s%s 성립 (%s) — 창 %s~%s"
                              % (rule["label"], spec["op"], _fmt(spec["threshold"], rule),
                                 rule["unit"],
                                 " %d회 연속" % n if n > 1 else "",
                                 evidence, win_from.isoformat(), anchor.isoformat()))

    t, nr = rule["trigger"], rule["near"]
    return dict(base, verdict_key="normal", verdict=v["normal"], hit_dates=[],
                basis="창 %s~%s(관측 %d개)에서 발동(%s %s%s)·근접(%s %s%s) 어느 조건도 성립하지 않았다. "
                      "최신 %s %s%s"
                      % (win_from.isoformat(), anchor.isoformat(), len(idxs),
                         t["op"], _fmt(t["threshold"], rule), rule["unit"],
                         nr["op"], _fmt(nr["threshold"], rule), rule["unit"],
                         anchor.isoformat(), _fmt(pts[-1][1], rule), rule["unit"]))


# ---------------------------------------------------------------- 드리프트 검사

def read_criteria(notion, page_id, prop_name):
    """노션 페이지의 `판정 기준` 현재 원문. 실패는 예외로 던진다(호출부가 격리한다)."""
    page = notion.request("GET", "/pages/%s" % page_id)
    prop = (page.get("properties") or {}).get(prop_name)
    if prop is None:
        raise RuntimeError("페이지에 %r 속성이 없다" % prop_name)
    segs = prop.get("rich_text") or prop.get("title") or []
    return "".join(s.get("plain_text", "") for s in segs), page


def check_drift(notion, rule, rrcfg):
    """(status, notion_text, detail).

    status: "ok"(일치) / "drift"(불일치) / "error"(조회 실패)
    """
    prop = rrcfg["properties"]["criteria"]
    try:
        got, _page = read_criteria(notion, rule["page_id"], prop)
    except Exception as exc:  # noqa: BLE001 — 어떤 실패도 다른 리스크를 죽이지 않는다
        return "error", None, str(exc)[:600]
    want = rule["criteria_text"]
    if got == want:
        return "ok", got, None
    return "drift", got, "config=%r / notion=%r" % (want, got)


# ---------------------------------------------------------------- 기입

def assert_risk_safe(props, rrcfg):
    """디렉터 영역 보호. **dry-run에서도 돈다** — 여기서 막지 못하면 막을 곳이 없다."""
    allowed = set(rrcfg["write_properties"])
    extra = [k for k in props if k not in allowed]
    if extra:
        raise RuntimeError("자동화가 쓸 수 없는 속성이 payload에 있다: %s" % ", ".join(extra))
    banned = [k for k in props if k in set(rrcfg.get("_never_write") or [])]
    if banned:
        raise RuntimeError("디렉터 영역 속성이 payload에 있다: %s" % ", ".join(banned))
    return props


def build_write_payload(item, rrcfg, run_date_iso):
    p = rrcfg["properties"]
    props = {p["verdict"]: {"select": {"name": item["verdict"]}},
             p["checked"]: {"date": {"start": run_date_iso}}}
    return assert_risk_safe(props, rrcfg)


def write_verdict(notion, item, rrcfg, run_date_iso):
    props = build_write_payload(item, rrcfg, run_date_iso)
    notion.request("PATCH", "/pages/%s" % item["page_id"], {"properties": props})


# ---------------------------------------------------------------- 배타 소유 고지

def exclusion_block(cfg):
    """이 4건이 FRED 경로 전용임을 알리는 문안. **page_id는 rules에서 파생한다.**

    왜 코드가 문안을 만드나:
      덮어쓰는 주체가 클라우드 루틴이라 코드로는 막을 수 없다. 사람이 루틴 프롬프트·에이전트
      정의에 규칙을 붙여야 하는데, page_id를 손으로 옮겨 적으면 rules가 바뀔 때 조용히 어긋난다.
      그래서 **여기서 뽑아 붙인다** — 대상이 늘거나 줄면 이 출력도 따라 바뀐다.
    """
    rr = cfg["risk_rules"]
    eo = rr.get("exclusive_owner") or {}
    p = rr["properties"]
    lines = [
        "### %s 배타 소유 — 기사 대조 경로는 쓰지 마라" % rr.get("database_label", "Risk Log"),
        "",
        "**소유 경로**: %s" % eo.get("owner_label", "(미기재)"),
        "**충돌 경로**: %s" % eo.get("conflicting_path", "(미기재)"),
        "**사유**: %s" % eo.get("reason", "(미기재)"),
        "",
        eo.get("rule_text", ""),
        "",
        "| 리스크 | page_id |",
        "|---|---|",
    ]
    for r in rr["rules"]:
        lines.append("| %s | `%s` |" % (r["label"], r["page_id"]))
    lines += [
        "",
        "대상 필드: `%s` · `%s` (이 두 개만. 다른 필드는 평소대로)" % (p["verdict"], p["checked"]),
        "",
        "_이 표는 econ-cockpit `scripts/liquidity/config.json`의 `risk_rules.rules`에서 파생한다._",
        "_갱신: `python3 scripts/liquidity/risk_verdicts.py --exclusion-block`_",
    ]
    return "\n".join(lines)


def exclusion_page_ids(cfg):
    return [r["page_id"] for r in cfg["risk_rules"]["rules"]]


# ---------------------------------------------------------------- 본체

def evaluate_all(result, cfg, notion, run_date):
    """드리프트 검사 → 평가. notion이 None이면 드리프트를 확인할 수 없으므로 전부 '확인 불가'다."""
    rrcfg = cfg["risk_rules"]
    v = rrcfg["verdicts"]
    items = []
    for rule in rrcfg["rules"]:
        if notion is None:
            item = {
                "key": rule["key"], "page_id": rule["page_id"], "label": rule["label"],
                "series": rule["series"], "unit": rule["unit"],
                "board_threshold": rule["board_threshold"],
                "page_url": rrcfg["page_url_format"].format(
                    page_id_compact=rule["page_id"].replace("-", "")),
                "verdict_key": "unknown", "verdict": v["unknown"],
                "drift": "skipped",
                "reason": "노션 조회 없이 실행했다(드리프트 검사 불가) — 판정하지 않았다",
            }
            item["basis"] = item["reason"]
            items.append(item)
            continue

        status, notion_text, detail = check_drift(notion, rule, rrcfg)
        if status == "drift":
            reason = rrcfg["drift_reason_format"].format(
                property=rrcfg["properties"]["criteria"],
                drift_message=rrcfg["drift_message"])
            item = dict(
                key=rule["key"], page_id=rule["page_id"], label=rule["label"],
                series=rule["series"], unit=rule["unit"],
                board_threshold=rule["board_threshold"],
                page_url=rrcfg["page_url_format"].format(
                    page_id_compact=rule["page_id"].replace("-", "")),
                verdict_key="unknown", verdict=v["unknown"], drift="drift",
                drift_detail=detail, notion_criteria=notion_text,
                reason=reason, basis=reason)
            items.append(item)
            continue
        if status == "error":
            reason = rrcfg["fetch_failed_format"].format(error=detail)
            item = dict(
                key=rule["key"], page_id=rule["page_id"], label=rule["label"],
                series=rule["series"], unit=rule["unit"],
                board_threshold=rule["board_threshold"],
                page_url=rrcfg["page_url_format"].format(
                    page_id_compact=rule["page_id"].replace("-", "")),
                verdict_key="unknown", verdict=v["unknown"], drift="error",
                drift_detail=detail, fetch_error=detail,
                reason=reason, basis=reason)
            items.append(item)
            continue

        item = evaluate_rule(rule, result, rrcfg, run_date)
        item["drift"] = "ok"
        items.append(item)
    return items


def run_date_kst(cfg):
    tz = timezone(timedelta(hours=cfg["notion"]["timezone_offset_hours"]))
    return datetime.now(tz).date()


def print_report(items, rrcfg):
    print("=== Risk Log 판정 (%d건) ===" % len(items))
    for it in items:
        print("  [%s] %-28s %s" % (it["verdict"], it["label"], it.get("basis", "")))
        if it.get("drift") == "drift":
            print("      !! %s" % rrcfg["drift_message"])
            print("      %s" % it.get("drift_detail"))
        if it.get("fetch_error"):
            print("      !! 조회 실패: %s" % it["fetch_error"])


def main():
    ap = argparse.ArgumentParser(description="Risk Log 판정 평가·기입")
    ap.add_argument("--input", help="fetch_liquidity.py 결과 JSON. 없거나 못 읽으면 전부 '확인 불가'")
    ap.add_argument("--config", default=None)
    ap.add_argument("--out", help="판정 결과 JSON 저장 경로(브리핑 본문이 읽는다)")
    ap.add_argument("--dry-run", action="store_true", help="노션에 쓰지 않는다(드리프트 검사는 한다)")
    ap.add_argument("--no-notion", action="store_true",
                    help="노션을 아예 타지 않는다(오프라인 검수용 — 전부 '확인 불가')")
    ap.add_argument("--dump-criteria", action="store_true",
                    help="노션의 `판정 기준` 현재 원문을 repr로 출력하고 끝낸다(config 사본 갱신용)")
    ap.add_argument("--selftest", action="store_true", help="평가·드리프트 로직 자체 검증(네트워크 불필요)")
    ap.add_argument("--exclusion-block", action="store_true",
                    help="이 4건이 FRED 경로 전용임을 알리는 문안을 출력한다(에이전트 정의·루틴 프롬프트에 붙일 것). 아무것도 쓰지 않는다")
    args = ap.parse_args()

    cfg = load_config(args.config)
    if args.selftest:
        return selftest(cfg)
    if args.exclusion_block:
        print(exclusion_block(cfg))
        return 0

    rrcfg = cfg.get("risk_rules") or {}
    if not rrcfg.get("enabled", False):
        print("risk_rules.enabled=false — 판정을 건너뛴다")
        return 0
    validate_risk_rules(cfg, None)

    notion = None
    if not args.no_notion:
        from post_briefing import Notion, token_from_env  # 지연 로드(순환 import 방지)
        notion = Notion(token_from_env(), cfg["notion"]["api_version"])

    if args.dump_criteria:
        if notion is None:
            print("--dump-criteria는 노션이 필요하다", file=sys.stderr)
            return 2
        prop = rrcfg["properties"]["criteria"]
        rc = 0
        for rule in rrcfg["rules"]:
            try:
                got, _ = read_criteria(notion, rule["page_id"], prop)
                same = "일치" if got == rule["criteria_text"] else "!! 불일치"
                print("%-10s %s\n    notion=%r\n    config=%r"
                      % (rule["key"], same, got, rule["criteria_text"]))
            except Exception as exc:  # noqa: BLE001
                rc = 1
                print("%-10s !! 조회 실패: %s" % (rule["key"], str(exc)[:600]))
                print("    %s" % rrcfg["access_hint"])
        return rc

    # 수집 결과가 없어도 멈추지 않는다 — 그 자체가 '확인 불가'다(침묵 금지).
    result, load_error = {}, None
    if args.input:
        try:
            with open(args.input, "r", encoding="utf-8") as fh:
                result = json.load(fh)
        except Exception as exc:  # noqa: BLE001
            load_error = str(exc)[:300]
            print("수집 결과를 읽지 못했다(전부 '확인 불가'로 간다): %s" % load_error,
                  file=sys.stderr)

    run_date = run_date_kst(cfg)
    items = evaluate_all(result, cfg, notion, run_date)
    if load_error:
        for it in items:
            if it["verdict_key"] != "unknown":
                continue
            it.setdefault("input_error", load_error)

    run_iso = run_date.isoformat()
    write_failures, drift_hits, fetch_errors = [], [], []
    for it in items:
        if it.get("drift") == "drift":
            drift_hits.append(it["key"])
        if it.get("drift") == "error":
            fetch_errors.append(it["key"])
        if notion is None or args.dry_run:
            it["write"] = {"status": "skipped",
                           "reason": "no-notion" if notion is None else "dry-run"}
            continue
        try:
            write_verdict(notion, it, rrcfg, run_iso)
            it["write"] = {"status": "ok", "checked": run_iso}
        except Exception as exc:  # noqa: BLE001 — 한 건 실패가 나머지를 죽이지 않는다
            it["write"] = {"status": "failed", "error": str(exc)[:600]}
            write_failures.append(it["key"])
            print("기입 실패(계속): %s — %s" % (it["key"], str(exc)[:600]), file=sys.stderr)

    payload = {"run_date": run_iso, "window_days": rrcfg["window_days"],
               "basis_date": result.get("basis_date"),
               "generated_at_kst": result.get("generated_at_kst"),
               "input_error": load_error,
               "items": items}
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
        print("판정 결과 저장: %s" % args.out)

    print_report(items, rrcfg)
    if drift_hits:
        print("::error title=%s::%s — %s"
              % (rrcfg["drift_message"], rrcfg["drift_message"], ", ".join(drift_hits)))
    if fetch_errors:
        print("::error title=Risk Log 조회 실패::%s (%s)"
              % (rrcfg["access_hint"], ", ".join(fetch_errors)))
    if write_failures:
        print("::error title=Risk Log 기입 실패::%s" % ", ".join(write_failures))
    return 1 if (drift_hits or fetch_errors or write_failures) else 0


# ---------------------------------------------------------------- 셀프테스트

def _synthetic(series_id, pairs):
    return {"observations": {series_id: [[d, v] for d, v in pairs]}}


def selftest(cfg):
    """네트워크 없이 평가·보호 로직을 검증한다. **실패하면 0이 아닌 코드로 죽는다.**"""
    rrcfg = cfg["risk_rules"]
    by_key = {r["key"]: r for r in rrcfg["rules"]}
    fails = []

    def check(name, got, want):
        if got != want:
            fails.append("%s: 기대=%r 실제=%r" % (name, want, got))
        print("  %-52s %s (%s)" % (name, "OK" if got == want else "FAIL", got))

    run = date(2026, 8, 2)
    sofr = by_key["SOFR_IORB"]
    # ① 창 안에서 +5bp가 하루뿐 → 발동 아님, 근접
    r = evaluate_rule(sofr, _synthetic("SOFR_IORB_SPREAD", [
        ["2026-07-28", 0], ["2026-07-29", 0], ["2026-07-30", 6], ["2026-07-31", 1]]),
        rrcfg, run)
    check("SOFR 1일만 +6bp → 근접", r["verdict"], rrcfg["verdicts"]["near"])
    # ② 2영업일 연속 → 발동
    r = evaluate_rule(sofr, _synthetic("SOFR_IORB_SPREAD", [
        ["2026-07-28", 0], ["2026-07-29", 5], ["2026-07-30", 6], ["2026-07-31", 0]]),
        rrcfg, run)
    check("SOFR 07-29·30 연속 +5bp 이상 → 발동", r["verdict"], rrcfg["verdicts"]["fire"])
    check("  발동일 근거", r["hit_dates"], ["2026-07-29", "2026-07-30"])
    # ③ 연속 이틀이 **창 밖**이면 발동 아님 (창은 최신 관측일에서 7일)
    r = evaluate_rule(sofr, _synthetic("SOFR_IORB_SPREAD", [
        ["2026-07-20", 6], ["2026-07-21", 6], ["2026-07-29", 0], ["2026-07-30", 0]]),
        rrcfg, run)
    check("SOFR 연속 발동이 창(07-24~30) 밖 → 정상", r["verdict"], rrcfg["verdicts"]["normal"])
    # ④ 주말 낀 금·월 연속도 잡는다(달력일이 아니라 인접 관측으로 센다)
    r = evaluate_rule(sofr, _synthetic("SOFR_IORB_SPREAD", [
        ["2026-07-24", 5], ["2026-07-27", 7], ["2026-07-28", 0]]), rrcfg, run)
    check("SOFR 금(07-24)·월(07-27) 연속 → 발동", r["verdict"], rrcfg["verdicts"]["fire"])
    # ⑤ 관측이 낡으면 '확인 불가' (침묵 금지)
    r = evaluate_rule(sofr, _synthetic("SOFR_IORB_SPREAD", [["2026-06-01", 0]]), rrcfg, run)
    check("SOFR 관측 62일 낡음 → 확인 불가", r["verdict"], rrcfg["verdicts"]["unknown"])
    # ⑥ 수집 자체가 없으면 '확인 불가'
    r = evaluate_rule(sofr, {"observations": {}}, rrcfg, run)
    check("SOFR 수집 실패 → 확인 불가", r["verdict"], rrcfg["verdicts"]["unknown"])

    srf = by_key["SRF"]
    r = evaluate_rule(srf, _synthetic("RPONTSYD", [
        ["2026-07-30", 0.003], ["2026-07-31", 0.0]]), rrcfg, run)
    check("SRF 0.003십억$ → 정상", r["verdict"], rrcfg["verdicts"]["normal"])
    r = evaluate_rule(srf, _synthetic("RPONTSYD", [
        ["2026-07-30", 1.2], ["2026-07-31", 0.0]]), rrcfg, run)
    check("SRF 1.2십억$ 1일 → 근접", r["verdict"], rrcfg["verdicts"]["near"])
    r = evaluate_rule(srf, _synthetic("RPONTSYD", [
        ["2026-07-30", 0.0], ["2026-07-31", 8.0]]), rrcfg, run)
    check("SRF 8십억$ → 발동", r["verdict"], rrcfg["verdicts"]["fire"])

    # 지준: FRED 원단위(백만$)를 scale로 환산하는지까지 본다
    res = by_key["WRESBAL"]
    r = evaluate_rule(res, _synthetic("WRESBAL", [
        ["2026-07-22", 3062149], ["2026-07-29", 2984570]]), rrcfg, run)
    check("지준 2,984.6십억$ → 정상", r["verdict"], rrcfg["verdicts"]["normal"])
    check("  환산 확인(백만$→십억$)", r["latest_text"], "2,984.6십억$")
    r = evaluate_rule(res, _synthetic("WRESBAL", [
        ["2026-07-22", 3000000], ["2026-07-29", 2940000]]), rrcfg, run)
    check("지준 2,940십억$ → 근접", r["verdict"], rrcfg["verdicts"]["near"])
    r = evaluate_rule(res, _synthetic("WRESBAL", [
        ["2026-07-22", 3000000], ["2026-07-29", 2880000]]), rrcfg, run)
    check("지준 2,880십억$ → 발동", r["verdict"], rrcfg["verdicts"]["fire"])

    tga = by_key["TGA"]
    r = evaluate_rule(tga, _synthetic("WTREGEN", [
        ["2026-07-22", 829623], ["2026-07-29", 910776]]), rrcfg, run)
    check("TGA 주간 +81.2십억$ → 정상", r["verdict"], rrcfg["verdicts"]["normal"])
    check("  변화량 확인", r["eval_latest_text"], "+81.2십억$".replace("+", ""))
    r = evaluate_rule(tga, _synthetic("WTREGEN", [
        ["2026-07-22", 800000], ["2026-07-29", 920000]]), rrcfg, run)
    check("TGA 주간 +120십억$ → 근접", r["verdict"], rrcfg["verdicts"]["near"])
    r = evaluate_rule(tga, _synthetic("WTREGEN", [
        ["2026-07-22", 800000], ["2026-07-29", 980000]]), rrcfg, run)
    check("TGA 주간 +180십억$ → 발동", r["verdict"], rrcfg["verdicts"]["fire"])
    # 수준이 아무리 높아도 변화가 작으면 발동하지 않는다(mode=change 확인)
    r = evaluate_rule(tga, _synthetic("WTREGEN", [
        ["2026-07-22", 1900000], ["2026-07-29", 1910000]]), rrcfg, run)
    check("TGA 수준 1,910십억$·변화 +10 → 정상", r["verdict"], rrcfg["verdicts"]["normal"])

    # ---- 드리프트 검사: 노션 원문이 한 글자만 달라도 잡아야 한다 ----
    class FakeNotion:
        def __init__(self, texts):
            self.texts = texts

        def request(self, method, path, payload=None, timeout=60):
            pid = path.split("/")[-1]
            if pid not in self.texts:
                raise RuntimeError("Notion HTTP 404 GET %s: object_not_found" % path)
            return {"properties": {rrcfg["properties"]["criteria"]: {
                "rich_text": [{"plain_text": self.texts[pid]}]}}}

    same = {r["page_id"]: r["criteria_text"] for r in rrcfg["rules"]}
    obs = {"observations": {
        "SOFR_IORB_SPREAD": [["2026-07-29", 0], ["2026-07-30", 0]],
        "RPONTSYD": [["2026-07-30", 0.003], ["2026-07-31", 0.0]],
        "WRESBAL": [["2026-07-22", 3062149], ["2026-07-29", 2984570]],
        "WTREGEN": [["2026-07-22", 829623], ["2026-07-29", 910776]]}}
    items = evaluate_all(obs, cfg, FakeNotion(same), run)
    check("드리프트 없음 → 4건 모두 판정됨",
          sorted({i["drift"] for i in items}), ["ok"])
    check("드리프트 없음 → 4건 모두 정상",
          sorted({i["verdict"] for i in items}), [rrcfg["verdicts"]["normal"]])

    changed = dict(same)
    tga_id = by_key["TGA"]["page_id"]
    # 디렉터가 노션에서 임계를 고친 상황. **config 내용에 의존하는 치환을 쓰지 않는다** —
    # 사본이 마침 그 문자열을 담고 있지 않으면 치환이 무동작이 돼 테스트가 조용히 통과한다
    # (2026-08-02 실측: '+150'→'+120' 치환본을 config에 넣고 돌리자 이 검사가 무력해졌다).
    changed[tga_id] = changed[tga_id] + " [셀프테스트 변조]"
    items = evaluate_all(obs, cfg, FakeNotion(changed), run)
    drifted = [i for i in items if i["drift"] == "drift"]
    check("임계 변경 → 드리프트 1건 검출", [i["key"] for i in drifted], ["TGA"])
    check("드리프트 리스크 → 확인 불가",
          drifted[0]["verdict"], rrcfg["verdicts"]["unknown"])
    check("드리프트 아닌 3건 → 그대로 판정",
          sorted(i["verdict"] for i in items if i["drift"] == "ok"),
          [rrcfg["verdicts"]["normal"]] * 3)

    missing = {k: v for k, v in same.items() if k != tga_id}  # 404 상황
    items = evaluate_all(obs, cfg, FakeNotion(missing), run)
    err = [i for i in items if i["drift"] == "error"]
    check("노션 404 → 조회 실패 1건", [i["key"] for i in err], ["TGA"])
    check("조회 실패 리스크 → 확인 불가", err[0]["verdict"], rrcfg["verdicts"]["unknown"])

    # ---- 쓰기 보호: 디렉터 영역이 payload에 섞이면 예외 ----
    ok_payload = build_write_payload(items[0], rrcfg, "2026-08-02")
    check("기입 payload는 두 속성뿐", sorted(ok_payload), sorted(rrcfg["write_properties"]))
    try:
        assert_risk_safe(dict(ok_payload, **{"상태": {"status": {"name": "주의"}}}), rrcfg)
        check("'상태'를 섞으면 예외", "예외 없음", "예외")
    except RuntimeError as exc:
        check("'상태'를 섞으면 예외", "상태" in str(exc), True)
    try:
        assert_risk_safe(dict(ok_payload, **{"판정 기준": {"rich_text": []}}), rrcfg)
        check("'판정 기준'을 섞으면 예외", "예외 없음", "예외")
    except RuntimeError as exc:
        check("'판정 기준'을 섞으면 예외", "판정 기준" in str(exc), True)

    # ---- 설정 검증 ----
    try:
        validate_risk_rules(cfg, None)
        check("config.risk_rules 검증 통과", True, True)
    except RiskConfigError as exc:
        check("config.risk_rules 검증 통과", str(exc), True)

    print("")
    if fails:
        print("셀프테스트 실패 %d건:" % len(fails))
        for f in fails:
            print("  - %s" % f)
        return 1
    print("셀프테스트 전부 통과")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # 실패는 조용히 넘기지 않는다
        print("판정 단계 실패: %s" % exc, file=sys.stderr)
        sys.exit(1)
