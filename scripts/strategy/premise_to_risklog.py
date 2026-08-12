#!/usr/bin/env python3
"""주간채권전략 전제 → Risk Log 등재 훅.

무엇을 하나
  ① 주간채권전략 DB에서 **최신 회차**를 찾는다(제목 앞 YYMMDD가 회차 식별자다).
  ② 그 회차 본문의 §6 `리스크 / 확인 조건 / 전략 수정` 표를 파싱한다.
     표는 노션 **table 블록**이다(마크다운 아님). 헤더행을 검증해 다른 표를 잘못 읽는 것을 막는다.
  ③ 각 행을 Risk Log에 **신규 생성**하고(제목 `{yymmdd}_{리스크}`), 그 회차의
     `관련 리스크` relation에 잇는다.

왜 이게 필요했나
  주간채권전략 DB에 `관련 리스크` relation이 **이미 있는데 채우는 코드가 없었다**.
  260803·260727만 사람이 손으로 채웠고 최신 260810은 0건이었다(2026-08-12 실측).
  "주간 전략의 핵심 전제를 관찰지표로 등록해 매일 점검한다"는 경로가 실제로는 끊겨 있었다.

원칙 넷 — 어기면 조용히 틀린다
  - **창작 금지.** 확인 조건이 비었거나 헤더가 안 맞으면 만들어내지 않고 건너뛰고 로그에 남긴다.
    영역·중요도·시장 영향은 본문에서 기계적으로 확정할 수 없으므로 **비워 둔다**(디렉터가 채운다).
  - **멱등.** 같은 회차를 두 번 돌려도 행이 늘지 않는다. 제목 완전일치로 기존 행을 재사용하고,
    relation은 합집합으로 계산해 **바뀔 때만** PATCH한다.
  - **디렉터 영역 보호.** `_never_write`가 payload에 섞이면 예외를 던진다.
    특히 `최근 판정`·`최근 확인일`은 유동성 워치·기사 대조 경로의 것이라 등재 경로가 손대지 않는다.
  - **상수는 코드에 없다.** 좌표·속성명·문안·표 위치는 전부 premise_config.json에서 읽는다.

`상태`='후보' 함정 (2026-08-12 실측)
  Risk Log `상태`는 select가 아니라 **status 타입**이고 옵션은 관찰/주의/종료뿐이다.
  노션 API는 status 옵션을 **자동 생성하지 않는다**. 그래서 이 스크립트는 쓰기 전에
  preflight로 옵션 존재를 확인하고, 없으면 **아무것도 쓰지 않고 멈춘다**.
  옵션 추가는 노션 스키마 변경이라 디렉터 몫이다.

사용
  python3 premise_to_risklog.py --selftest        # 네트워크 없이 파싱·멱등·안전장치 검증
  python3 premise_to_risklog.py --preflight       # 노션 스키마만 확인, 쓰지 않음
  python3 premise_to_risklog.py --dry-run         # 실데이터 파싱까지, 쓰지 않음
  python3 premise_to_risklog.py                   # 실행(생성·연결)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))
# 노션 저수준 클라이언트는 유동성 워치 것을 그대로 쓴다. 새로 짜지 않는다.
sys.path.insert(0, os.path.join(os.path.dirname(_HERE), "liquidity"))

from post_briefing import Notion, NotionError, token_from_env  # noqa: E402

CONFIG_PATH = os.path.join(_HERE, "premise_config.json")


class PremiseError(RuntimeError):
    pass


def load_config(path=CONFIG_PATH):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


# ---------------------------------------------------------------- 설정 검증

def validate_config(cfg, path="<config>"):
    """오타를 러너까지 끌고 가지 않는다."""
    for key in ("notion", "source", "target", "extract", "text"):
        if key not in cfg:
            raise PremiseError("%s: %s가 없다" % (path, key))

    src, tgt = cfg["source"], cfg["target"]
    for k in ("data_source_id", "title_property", "relation_property",
              "round_pattern", "write_properties", "_never_write"):
        if k not in src:
            raise PremiseError("%s: source.%s가 없다" % (path, k))
    for k in ("data_source_id", "title_property", "title_format", "status_property",
              "status_type", "status_value", "criteria_property", "source_property",
              "memo_property", "create_properties", "_never_write"):
        if k not in tgt:
            raise PremiseError("%s: target.%s가 없다" % (path, k))

    # 쓰기 대상이 금지 목록과 겹치면 안 된다 — 여기서 막지 못하면 실쓰기에서 막을 곳이 없다.
    for label, block, writes in (("source", src, src["write_properties"]),
                                 ("target", tgt, tgt["create_properties"])):
        banned = set(block.get("_never_write") or [])
        overlap = [p for p in writes if p in banned]
        if overlap:
            raise PremiseError("%s: %s의 쓰기 목록이 _never_write와 겹친다: %s"
                               % (path, label, ", ".join(overlap)))

    if src["relation_property"] not in src["write_properties"]:
        raise PremiseError("%s: source.write_properties가 %r를 포함해야 한다"
                           % (path, src["relation_property"]))
    for need in (tgt["title_property"], tgt["status_property"],
                 tgt["criteria_property"], tgt["source_property"], tgt["memo_property"]):
        if need not in tgt["create_properties"]:
            raise PremiseError("%s: target.create_properties가 %r를 포함해야 한다" % (path, need))

    ex = cfg["extract"]
    for k in ("heading_types", "section_number_pattern", "sections", "max_cell_chars"):
        if k not in ex:
            raise PremiseError("%s: extract.%s가 없다" % (path, k))
    if not any(s.get("enabled") for s in ex["sections"]):
        raise PremiseError("%s: extract.sections에 enabled인 구역이 하나도 없다" % path)
    seen = set()
    for i, s in enumerate(ex["sections"]):
        where = "%s: extract.sections[%d]" % (path, i)
        for k in ("id", "enabled", "section_number", "table_index",
                  "expected_headers", "columns"):
            if k not in s:
                raise PremiseError("%s: %s가 없다" % (where, k))
        if s["id"] in seen:
            raise PremiseError("%s: id가 중복이다: %r" % (where, s["id"]))
        seen.add(s["id"])
        if not s["enabled"]:
            continue
        for role in ("risk", "criteria"):
            if role not in s["columns"]:
                raise PremiseError("%s: columns.%s가 없다" % (where, role))
        ncol = len(s["expected_headers"])
        for role, idx in s["columns"].items():
            if not isinstance(idx, int) or idx < 0 or idx >= ncol:
                raise PremiseError("%s: columns.%s=%r가 헤더 %d열 범위를 벗어난다"
                                   % (where, role, idx, ncol))


# ---------------------------------------------------------------- 노션 읽기 헬퍼

def rich_text(segs):
    return "".join(s.get("plain_text", "") for s in (segs or []))


def prop_title(props, name):
    p = (props or {}).get(name) or {}
    return rich_text(p.get("title"))


def prop_relation_ids(props, name):
    p = (props or {}).get(name) or {}
    return [r.get("id") for r in (p.get("relation") or []) if r.get("id")]


def prop_date_start(props, name):
    p = (props or {}).get(name) or {}
    d = p.get("date") or {}
    return d.get("start") or ""


def page_url(cfg, page_id):
    return cfg["notion"]["page_url_format"].format(
        page_id_compact=(page_id or "").replace("-", ""))


def fetch_children(notion, block_id):
    """블록 자식 전체(페이지네이션 소진)."""
    out, cursor = [], None
    while True:
        path = "/blocks/%s/children?page_size=100" % block_id
        if cursor:
            path += "&start_cursor=" + cursor
        res = notion.request("GET", path)
        out += res.get("results") or []
        if not res.get("has_more") or not res.get("next_cursor"):
            return out
        cursor = res["next_cursor"]


# ---------------------------------------------------------------- 회차 선택

def find_latest_round(notion, cfg, want_yymmdd=None):
    """최신 회차 페이지. want_yymmdd가 있으면 그 회차를 고른다."""
    src = cfg["source"]
    payload = {"page_size": 100}
    week = src.get("week_property")
    if week:
        payload["sorts"] = [{"property": week, "direction": "descending"}]
    pages, cursor = [], None
    while True:
        if cursor:
            payload["start_cursor"] = cursor
        res = notion.request("POST", "/data_sources/%s/query" % src["data_source_id"], payload)
        pages += [p for p in (res.get("results") or [])
                  if not (p.get("archived") or p.get("in_trash"))]
        if not res.get("has_more") or not res.get("next_cursor"):
            break
        cursor = res["next_cursor"]

    pat = re.compile(src["round_pattern"])
    rounds = []
    for p in pages:
        title = prop_title(p.get("properties"), src["title_property"])
        m = pat.search(title)
        if not m:
            continue
        rounds.append({
            "page_id": p.get("id"),
            "title": title,
            "yymmdd": m.group("yymmdd"),
            "week_start": prop_date_start(p.get("properties"), week) if week else "",
            "relation_ids": prop_relation_ids(p.get("properties"), src["relation_property"]),
        })
    if not rounds:
        raise PremiseError("주간채권전략 DB에서 회차(제목 앞 YYMMDD)를 하나도 찾지 못했다")

    if want_yymmdd:
        hit = [r for r in rounds if r["yymmdd"] == want_yymmdd]
        if not hit:
            raise PremiseError("회차 %s를 찾지 못했다 (있는 회차: %s)"
                               % (want_yymmdd, ", ".join(r["yymmdd"] for r in rounds)))
        return hit[0]
    # 정렬은 노션 sorts를 신뢰하되, week가 비어 있는 회차가 섞여도 흔들리지 않게 재정렬한다.
    rounds.sort(key=lambda r: (r["week_start"] or "", r["yymmdd"]), reverse=True)
    return rounds[0]


# ---------------------------------------------------------------- 본문 파싱

def collect_section_tables(blocks, cfg, fetch):
    """{섹션번호: [table 블록, ...]} — 등장 순서 보존.

    헤딩이 토글이라 표가 헤딩의 자식으로 들어가 있어도 잡히도록 재귀한다.
    """
    ex = cfg["extract"]
    heading_types = set(ex["heading_types"])
    pat = re.compile(ex["section_number_pattern"])
    found = {}
    state = {"section": None}

    def walk(items):
        for b in items:
            btype = b.get("type")
            if btype in heading_types:
                text = rich_text((b.get(btype) or {}).get("rich_text"))
                m = pat.search(text)
                state["section"] = int(m.group("num")) if m else None
            elif btype == "table":
                if state["section"] is not None:
                    found.setdefault(state["section"], []).append(b)
                continue  # 표의 자식(table_row)은 여기서 훑지 않는다
            if b.get("has_children"):
                walk(fetch(b.get("id")))

    walk(blocks)
    return found


def parse_table(notion, table_block, spec, cfg, fetch=None):
    """(items, skips). 헤더가 기대와 다르면 통째로 건너뛴다."""
    fetch = fetch or (lambda bid: fetch_children(notion, bid))
    txt = cfg["text"]
    limit = cfg["extract"]["max_cell_chars"]

    rows = [r for r in fetch(table_block.get("id")) if r.get("type") == "table_row"]
    cells = [[rich_text(c)[:limit].strip() for c in (r.get("table_row") or {}).get("cells") or []]
             for r in rows]
    if not cells:
        return [], [{"row": None, "reason": txt["skip_no_table"].format(
            section_number=spec["section_number"])}]

    header, body = cells[0], cells[1:]
    expected = spec["expected_headers"]
    # 헤더 셀은 볼드 등 서식이 붙을 수 있으므로 공백만 정규화해 비교한다.
    norm = lambda s: re.sub(r"\s+", "", s)
    if [norm(h) for h in header] != [norm(h) for h in expected]:
        return [], [{"row": None, "reason": txt["skip_header_mismatch"].format(
            expected=" | ".join(expected), got=" | ".join(header))}]

    cols = spec["columns"]
    items, skips = [], []
    for i, row in enumerate(body):
        get = lambda role: (row[cols[role]] if role in cols and cols[role] < len(row) else "")
        risk, criteria = get("risk"), get("criteria")
        if not risk:
            skips.append({"row": i + 1, "reason": txt["skip_no_risk"]})
            continue
        if not criteria:
            skips.append({"row": i + 1, "reason": "%s (리스크=%s)" % (txt["skip_no_criteria"], risk)})
            continue
        items.append({"section_id": spec["id"], "section_number": spec["section_number"],
                      "header_line": " / ".join(expected), "risk": risk,
                      "criteria": criteria, "action": get("action")})
    return items, skips


def extract_premises(notion, cfg, round_page_id, blocks=None, fetch=None):
    """(items, skips) — enabled 구역만."""
    fetch = fetch or (lambda bid: fetch_children(notion, bid))
    blocks = blocks if blocks is not None else fetch(round_page_id)
    txt = cfg["text"]
    tables = collect_section_tables(blocks, cfg, fetch)

    items, skips = [], []
    for spec in cfg["extract"]["sections"]:
        if not spec.get("enabled"):
            skips.append({"section": spec["section_number"], "row": None,
                          "reason": "구역 비활성(%s): %s" % (spec["id"],
                                                        spec.get("skip_reason", "사유 미기재"))})
            continue
        got = tables.get(spec["section_number"]) or []
        if not got:
            skips.append({"section": spec["section_number"], "row": None,
                          "reason": txt["skip_no_section"].format(
                              section_number=spec["section_number"])})
            continue
        try:
            table = got[spec["table_index"]]
        except IndexError:
            skips.append({"section": spec["section_number"], "row": None,
                          "reason": txt["skip_no_table"].format(
                              section_number=spec["section_number"])})
            continue
        got_items, got_skips = parse_table(notion, table, spec, cfg, fetch=fetch)
        items += got_items
        for s in got_skips:
            s["section"] = spec["section_number"]
        skips += got_skips
    return items, skips


# ---------------------------------------------------------------- 안전장치

def assert_write_safe(props, allowed, banned, where):
    """디렉터 영역 보호. **dry-run에서도 돈다** — 여기서 막지 못하면 막을 곳이 없다."""
    extra = [k for k in props if k not in set(allowed)]
    if extra:
        raise PremiseError("%s: 자동화가 쓸 수 없는 속성이 payload에 있다: %s"
                           % (where, ", ".join(extra)))
    hit = [k for k in props if k in set(banned or [])]
    if hit:
        raise PremiseError("%s: 디렉터 영역 속성이 payload에 있다: %s" % (where, ", ".join(hit)))
    return props


# ---------------------------------------------------------------- preflight

def preflight_status(notion, cfg):
    """(ok, detail). Risk Log `상태` status 옵션에 '후보'가 있는지. 없으면 쓰지 않는다."""
    tgt = cfg["target"]
    ds = notion.request("GET", "/data_sources/%s" % tgt["data_source_id"])
    prop = (ds.get("properties") or {}).get(tgt["status_property"])
    if prop is None:
        return False, "Risk Log에 %r 속성이 없다" % tgt["status_property"]
    ptype = prop.get("type")
    options = [o.get("name") for o in ((prop.get(ptype) or {}).get("options") or [])]
    if ptype != tgt["status_type"]:
        return False, ("%r 타입이 config(%s)와 다르다: 실제 %s"
                       % (tgt["status_property"], tgt["status_type"], ptype))
    if tgt["status_value"] not in options:
        return False, cfg["text"]["status_missing"].format(
            status_property=tgt["status_property"], status_type=ptype,
            status_value=tgt["status_value"], options=", ".join(options) or "(없음)")
    return True, "옵션 확인: %s" % ", ".join(options)


# ---------------------------------------------------------------- 기입

def build_title(cfg, yymmdd, risk):
    return cfg["target"]["title_format"].format(yymmdd=yymmdd, risk=risk)


def build_create_props(cfg, item, round_info, run_date_iso):
    tgt, txt = cfg["target"], cfg["text"]
    src_url = page_url(cfg, round_info["page_id"])
    props = {
        tgt["title_property"]: {"title": [{"type": "text", "text": {
            "content": build_title(cfg, round_info["yymmdd"], item["risk"])}}]},
        tgt["status_property"]: {tgt["status_type"]: {"name": tgt["status_value"]}},
        tgt["criteria_property"]: {"rich_text": [{"type": "text", "text": {
            "content": item["criteria"]}}]},
        tgt["source_property"]: {"rich_text": [{"type": "text", "text": {
            "content": txt["source_format"].format(
                round_title=round_info["title"], source_url=src_url)}}]},
        tgt["memo_property"]: {"rich_text": [{"type": "text", "text": {
            "content": txt["memo_format"].format(
                round_title=round_info["title"], section_number=item["section_number"],
                header_line=item["header_line"], run_date=run_date_iso,
                action=item["action"] or "(비어 있음)", source_url=src_url)}}]},
    }
    return assert_write_safe(props, tgt["create_properties"], tgt["_never_write"],
                             "Risk Log 생성")


def build_relation_props(cfg, ids):
    src = cfg["source"]
    props = {src["relation_property"]: {"relation": [{"id": i} for i in ids]}}
    return assert_write_safe(props, src["write_properties"], src["_never_write"],
                             "주간채권전략 relation")


def upsert_rows(notion, cfg, items, round_info, run_date_iso, dry_run):
    """제목 완전일치로 기존 행을 재사용한다. 기존 행의 속성은 **건드리지 않는다**."""
    tgt = cfg["target"]
    results = []
    for item in items:
        title = build_title(cfg, round_info["yymmdd"], item["risk"])
        props = build_create_props(cfg, item, round_info, run_date_iso)  # dry-run에서도 안전장치를 태운다
        existing = [] if dry_run and notion is None else notion.find_pages_by_title(
            tgt["data_source_id"], tgt["title_property"], title)
        if existing:
            results.append({"title": title, "action": "existing",
                            "page_id": existing[0].get("id"), "risk": item["risk"]})
            continue
        if dry_run:
            results.append({"title": title, "action": "would_create",
                            "page_id": None, "risk": item["risk"]})
            continue
        created = notion.create_page(tgt["data_source_id"], props)
        results.append({"title": title, "action": "created",
                        "page_id": created.get("id"), "risk": item["risk"]})
    return results


def merge_relation(existing_ids, new_ids):
    """합집합, 순서 보존(기존 먼저). (merged, changed)"""
    merged, seen = [], set()
    for i in list(existing_ids) + list(new_ids):
        if i and i not in seen:
            seen.add(i)
            merged.append(i)
    return merged, merged != list(existing_ids)


# ---------------------------------------------------------------- 통지

def notify(cfg, payload, dry_run):
    """등재 결과를 mp-scoring-app 푸시 라우트로 넘긴다. 실패해도 등재를 되돌리지 않는다."""
    nc = cfg.get("notify") or {}
    if not nc.get("enabled"):
        return {"status": "disabled"}
    url = (os.environ.get(nc["url_env"]) or "").strip()
    secret = (os.environ.get(nc["secret_env"]) or "").strip()
    if not url or not secret:
        return {"status": "skipped",
                "reason": "%s/%s 미설정 — 통지 건너뜀(등재는 정상)" % (nc["url_env"], nc["secret_env"])}
    if dry_run:
        return {"status": "skipped", "reason": "dry-run"}
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "Content-Type": "application/json", "Authorization": "Bearer " + secret})
    try:
        with urllib.request.urlopen(req, timeout=nc.get("timeout_seconds", 20)) as resp:
            return {"status": "sent", "http": resp.status}
    except urllib.error.HTTPError as exc:
        return {"status": "error", "http": exc.code,
                "reason": exc.read().decode("utf-8", "replace")[:400]}
    except Exception as exc:  # noqa: BLE001 — 통지 실패가 등재를 깨지 않는다
        return {"status": "error", "reason": str(exc)[:400]}


def run_date_kst(cfg):
    off = timedelta(hours=cfg["notion"].get("timezone_offset_hours", 9))
    return (datetime.now(timezone.utc) + off).date().isoformat()


# ---------------------------------------------------------------- 본체

def main(argv=None):
    ap = argparse.ArgumentParser(description="주간채권전략 전제 → Risk Log 등재")
    ap.add_argument("--config", default=CONFIG_PATH)
    ap.add_argument("--round", dest="round_yymmdd", default=None,
                    help="회차 YYMMDD 지정(기본: 최신)")
    ap.add_argument("--dry-run", action="store_true", help="파싱까지만. 아무것도 쓰지 않는다")
    ap.add_argument("--preflight", action="store_true", help="노션 스키마만 확인하고 끝낸다")
    ap.add_argument("--selftest", action="store_true", help="네트워크 없이 로직 검증")
    ap.add_argument("--out", default=None, help="결과 JSON 경로")
    args = ap.parse_args(argv)

    cfg = load_config(args.config)
    validate_config(cfg, args.config)

    if args.selftest:
        return selftest(cfg)

    if not cfg.get("enabled"):
        print("[premise] config.enabled=false — 아무것도 하지 않는다")
        return 0

    notion = Notion(token_from_env(), cfg["notion"]["api_version"])

    ok, detail = preflight_status(notion, cfg)
    print("[premise] preflight 상태 옵션: %s — %s" % ("OK" if ok else "차단", detail))
    if args.preflight:
        return 0 if ok else 2

    run_date = run_date_kst(cfg)
    rnd = find_latest_round(notion, cfg, args.round_yymmdd)
    print("[premise] 회차 %s (%s) · 기존 관련 리스크 %d건"
          % (rnd["yymmdd"], rnd["title"], len(rnd["relation_ids"])))

    items, skips = extract_premises(notion, cfg, rnd["page_id"])
    print("[premise] 추출 %d건 / 건너뜀 %d건" % (len(items), len(skips)))
    for s in skips:
        print("  - 건너뜀 §%s row=%s: %s" % (s.get("section"), s.get("row"), s["reason"]))
    for it in items:
        print("  - 추출 §%s %s | 확인 조건: %s" % (it["section_number"], it["risk"], it["criteria"]))

    # 옵션이 없으면 **파싱 결과만 보여주고 쓰지 않는다.** 여기서 쓰면 400으로 반쯤 쓰다 만다.
    write_blocked = not ok
    dry = args.dry_run or write_blocked
    if write_blocked:
        print("[premise] 쓰기 차단 — '%s' 옵션이 없어 dry-run으로 강등한다" % cfg["target"]["status_value"])

    rows = upsert_rows(notion, cfg, items, rnd, run_date, dry)
    created = [r for r in rows if r["action"] == "created"]
    existing = [r for r in rows if r["action"] == "existing"]
    for r in rows:
        print("  - %s: %s" % (r["action"], r["title"]))

    linked_ids = [r["page_id"] for r in rows if r["page_id"]]
    merged, changed = merge_relation(rnd["relation_ids"], linked_ids)
    if changed and not dry:
        notion.request("PATCH", "/pages/%s" % rnd["page_id"],
                       {"properties": build_relation_props(cfg, merged)})
    else:
        build_relation_props(cfg, merged)  # 안전장치는 dry-run에서도 태운다
    print("[premise] relation %d → %d건 (%s)"
          % (len(rnd["relation_ids"]), len(merged),
             "갱신" if (changed and not dry) else "변경 없음/미기입"))

    result = {"run_date": run_date, "round": rnd["yymmdd"], "round_title": rnd["title"],
              "round_url": page_url(cfg, rnd["page_id"]), "dry_run": dry,
              "write_blocked": write_blocked, "preflight": detail,
              "items": items, "skips": skips, "rows": rows,
              "created": len(created), "existing": len(existing),
              "relation_before": len(rnd["relation_ids"]), "relation_after": len(merged)}

    result["notify"] = notify(cfg, {
        "kind": "premise-registered", "round": rnd["yymmdd"], "roundTitle": rnd["title"],
        "url": result["round_url"], "created": len(created), "existing": len(existing),
        "items": [{"risk": r["risk"], "title": r["title"]} for r in rows],
        "skipped": len(skips), "dryRun": dry,
    }, dry)
    print("[premise] 통지: %s" % json.dumps(result["notify"], ensure_ascii=False))

    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(result, fh, ensure_ascii=False, indent=2)
    return 2 if write_blocked else 0


# ---------------------------------------------------------------- 셀프테스트

def _blk(btype, **kw):
    b = {"id": kw.pop("id", btype + "-id"), "type": btype, "has_children": kw.pop("children", None) is not None}
    b[btype] = kw
    return b


def _heading(text, bid):
    return {"id": bid, "type": "heading_2", "has_children": False,
            "heading_2": {"rich_text": [{"plain_text": text}]}}


def _table(bid):
    return {"id": bid, "type": "table", "has_children": True, "table": {"table_width": 3}}


def _row(cells):
    return {"id": "row", "type": "table_row",
            "table_row": {"cells": [[{"plain_text": c}] for c in cells]}}


def selftest(cfg):
    fails = []

    def check(name, got, want):
        if got != want:
            fails.append("%s: got=%r want=%r" % (name, got, want))

    # ① 섹션·표 수집 — §6에 표가 둘일 때 마지막을 잡아야 한다
    blocks = [
        _heading("🇰🇷 5. 국내 연결 — 채권시장 영향", "h5"),
        _table("t5"),
        _heading("🎯 6. 전략 제시 (양괄식 마무리)", "h6"),
        _table("t6a"),
        _table("t6b"),
    ]
    children = {
        "t5": [_row(["시나리오", "전제", "국고 3년", "전략"]),
               _row(["약세", "Core CPI 0.3% 이상", "3.80~3.88%", "매수 속도 조절"])],
        "t6a": [_row(["구간(국고 3년)", "판단", "실행"]),
                _row(["3.70%", "중립", "관망"])],
        # 아래 5행은 260810 회차 §6 표의 **실제 원문**이다(2026-08-12 노션 실측).
        # 파서가 진짜 데이터에서 5건을 뽑는지를 여기서 고정한다.
        "t6b": [_row(["리스크", "확인 조건", "전략 수정"]),
                _row(["미국 CPI 상방", "Core CPI MoM 0.3% 이상 또는 Shelter 0.3%대 반등",
                      "분할 매수 속도 조절, 3년 3.82% 상단 이탈 대비"]),
                _row(["유가 재상승", "WTI 85달러 접근·90달러 이상 지속", "듀레이션 축소, 레인지 상향"]),
                _row(["외국인 수급 소진", "3일 누적 순매도 전환 또는 미결제약정 감소 지속",
                      "3.80%대 되돌림 인정, 신규 매수 대기"]),
                _row(["미국 입찰 부진", "10년·30년 입찰 부진과 CPI 상방 동반", "10년 이상 구간 중립~축소"]),
                _row(["크레딧 수급 둔화", "투신 기타금융채 순매수 감소·RP금리 상승",
                      "하이닉스 관련 자금 집행 일단락 가능성 반영"]),
                # 아래 2행은 방어 검증용(실제 표에는 없다) — 빈 칸은 창작하지 않고 건너뛰어야 한다.
                _row(["", "조건만 있고 리스크 없음", "무시돼야"]),
                _row(["조건 없는 리스크", "", "무시돼야"])],
    }
    fetch = lambda bid: children.get(bid, [])

    tables = collect_section_tables(blocks, cfg, fetch)
    check("섹션5 표 수", len(tables.get(5) or []), 1)
    check("섹션6 표 수", len(tables.get(6) or []), 2)

    items, skips = extract_premises(None, cfg, "page", blocks=blocks, fetch=fetch)
    check("추출 건수", len(items), 5)
    check("첫 항목 리스크", items[0]["risk"], "미국 CPI 상방")
    check("첫 항목 확인 조건", items[0]["criteria"], "Core CPI MoM 0.3% 이상 또는 Shelter 0.3%대 반등")
    check("마지막 항목 리스크", items[-1]["risk"], "크레딧 수급 둔화")
    check("전략 수정 원문 보존", items[1]["action"], "듀레이션 축소, 레인지 상향")
    check("빈 칸 2건 건너뜀", len([s for s in skips if s.get("row")]), 2)
    check("§5 비활성 스킵 기록", any(s.get("section") == 5 for s in skips), True)

    # ② table_index=-1이 아니라 0이면 헤더 검증에 걸려 통째로 건너뛴다(엉뚱한 표 방어)
    bad = json.loads(json.dumps(cfg))
    for s in bad["extract"]["sections"]:
        if s["id"] == "risk_table":
            s["table_index"] = 0
    bad_items, bad_skips = extract_premises(None, bad, "page", blocks=blocks, fetch=fetch)
    check("잘못된 표 → 0건", len(bad_items), 0)
    check("헤더 불일치 사유 기록",
          any("헤더" in s["reason"] for s in bad_skips), True)

    # ③ 제목·멱등
    check("제목 형식", build_title(cfg, "260810", "미국 CPI 상방"), "260810_미국 CPI 상방")
    merged, changed = merge_relation(["a", "b"], ["b", "c"])
    check("relation 합집합", merged, ["a", "b", "c"])
    check("relation 변경 감지", changed, True)
    merged2, changed2 = merge_relation(["a", "b"], ["a"])
    check("relation 재실행 무변화", (merged2, changed2), (["a", "b"], False))

    # ④ 안전장치 — 디렉터 영역이 payload에 섞이면 예외
    tgt = cfg["target"]
    try:
        assert_write_safe({tgt["title_property"]: {}, "최근 판정": {}},
                          tgt["create_properties"], tgt["_never_write"], "t")
        fails.append("안전장치: '최근 판정'을 막지 못했다")
    except PremiseError:
        pass
    try:
        assert_write_safe({"대응 방향": {}}, tgt["create_properties"], tgt["_never_write"], "t")
        fails.append("안전장치: '대응 방향'을 막지 못했다")
    except PremiseError:
        pass
    # 위 둘은 allowed 검사만으로도 걸린다. **banned 층을 따로 태운다** —
    # allowed에 들어 있어도 _never_write면 막아야 한다(config가 어긋났을 때의 마지막 방어선).
    for banned_key in ("최근 판정", "대응 방향", "결말", "관련 판단"):
        try:
            assert_write_safe({banned_key: {}}, [banned_key], tgt["_never_write"], "t")
            fails.append("안전장치(banned층): allowed에 있는 %r를 막지 못했다" % banned_key)
        except PremiseError:
            pass
    try:
        build_relation_props(cfg, ["x"])
    except PremiseError as exc:
        fails.append("안전장치: 정상 relation payload를 막았다: %s" % exc)

    # ⑤ 생성 payload가 create_properties를 정확히 채우는지
    props = build_create_props(cfg, items[0],
                               {"page_id": "p1", "title": "260810 주간채권전략", "yymmdd": "260810"},
                               "2026-08-12")
    check("생성 속성 집합", sorted(props), sorted(tgt["create_properties"]))
    check("상태 값", props[tgt["status_property"]][tgt["status_type"]]["name"], tgt["status_value"])
    check("판정 기준 = 확인 조건 원문",
          props[tgt["criteria_property"]]["rich_text"][0]["text"]["content"],
          "Core CPI MoM 0.3% 이상 또는 Shelter 0.3%대 반등")

    # ⑥ config 검증기가 겹침을 잡는지
    bad2 = json.loads(json.dumps(cfg))
    bad2["target"]["create_properties"] = bad2["target"]["create_properties"] + ["최근 판정"]
    try:
        validate_config(bad2)
        fails.append("config 검증: _never_write 겹침을 놓쳤다")
    except PremiseError:
        pass

    if fails:
        print("SELFTEST 실패 %d건" % len(fails))
        for f in fails:
            print("  - " + f)
        return 1
    print("SELFTEST OK")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (PremiseError, NotionError) as exc:
        print("[premise] 실패: %s" % exc, file=sys.stderr)
        sys.exit(1)
