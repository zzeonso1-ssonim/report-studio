#!/usr/bin/env python3
"""유동성 워치 — fetch_liquidity.py 결과를 노션 '매크로 브리핑룸'에 브리핑 페이지로 적재한다.

입력: fetch_liquidity.py --json 산출물(파일 또는 stdin)
출력: 노션 페이지 1건 (주 1회)

무엇을 지키나
  - **멱등성**: 제목({yymmdd}_미국 유동성 워치)이 같은 페이지가 이미 있으면 만들지 않는다.
    yymmdd는 수집일이 아니라 **WRESBAL 최신 관측일**(H.4.1 주간 기준)이다 —
    같은 주에 두 번 돌아도 페이지는 하나다.
  - **불일치는 침묵하지 않는다**: 교차검증 mismatches가 있으면 값을 싣지 않고
    '데이터 이상' 페이지(불일치 내역만)를 만든다. 틀린 숫자가 나가는 것이 가장 나쁘다.
  - **디렉터 데이터 보존**: config.notion._never_write의 속성(중요도·내 메모·키워드·
    입력완료·relation 등)은 payload에 넣지 않는다. 검사로 강제한다.
  - **'승인'을 쓰지 않는다**: 검토 상태의 '승인'은 디렉터 전용이다(config._forbidden_values).
  - **없는 select 옵션을 만들지 않는다**: 값은 config에만 있고, 스키마는 2026-08-01 실측 확인.
  - **모든 수치에 관측일 병기**: 표의 비교값에는 비교 기준일이 함께 들어간다.

환경변수
  NOTION_TOKEN  (필수. --dry-run에서는 불필요 — 네트워크를 아예 타지 않는다)

사용
  python3 scripts/liquidity/post_briefing.py --input snapshot.json
  python3 scripts/liquidity/post_briefing.py --input snapshot.json --dry-run \
      --payload-out payload.json --markdown-out body.md

종료 코드: 0=생성 성공 또는 이미 존재(멱등 스킵) / 1=실패
의존: 표준 라이브러리만.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fetch_liquidity import fmt, load_config  # noqa: E402

NOTION_API = "https://api.notion.com/v1"
RICH_TEXT_CHUNK = 1900
TODAY_KST = "@today_kst"


class NotionError(RuntimeError):
    pass


# ---------------------------------------------------------------- 노션 저수준

def token_from_env(env_var="NOTION_TOKEN"):
    token = (os.environ.get(env_var) or "").strip()
    if not token:
        raise NotionError(
            "%s가 없다. Actions는 저장소 Secrets에 등록해야 한다: "
            "gh secret set %s -R zzeonso1-ssonim/econ-cockpit "
            "(등록은 디렉터 몫 — 자동화가 키를 대신 입력하지 않는다)" % (env_var, env_var))
    return token


class Notion:
    def __init__(self, token, version):
        self.token, self.version = token, version

    def request(self, method, path, payload=None, timeout=60):
        data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(NOTION_API + path, data=data, method=method, headers={
            "Authorization": "Bearer " + self.token,
            "Notion-Version": self.version,
            "Content-Type": "application/json",
        })
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", "replace")
            raise NotionError("Notion HTTP %s %s %s: %s" % (exc.code, method, path, body[:1200]))

    def find_pages_by_title(self, ds_id, title_property, title):
        """같은 제목의 살아있는 페이지. 중복 생성 방지의 핵심."""
        payload = {"page_size": 100,
                   "filter": {"property": title_property, "title": {"equals": title}}}
        out = []
        while True:
            res = self.request("POST", "/data_sources/%s/query" % ds_id, payload)
            out += [p for p in res.get("results", [])
                    if not (p.get("archived") or p.get("in_trash"))]
            if not res.get("has_more") or not res.get("next_cursor"):
                return out
            payload["start_cursor"] = res["next_cursor"]

    def create_page(self, ds_id, properties, children=None):
        payload = {"parent": {"type": "data_source_id", "data_source_id": ds_id},
                   "properties": properties}
        if children:
            payload["children"] = children[:100]
        return self.request("POST", "/pages", payload)


# ---------------------------------------------------------------- 블록 헬퍼

def rich_text(text):
    text = "" if text is None else str(text)
    return [{"type": "text", "text": {"content": text[:RICH_TEXT_CHUNK]}}] if text else []


def paragraph(text):
    return {"object": "block", "type": "paragraph", "paragraph": {"rich_text": rich_text(text)}}


def heading(text, level=2):
    key = "heading_%d" % level
    return {"object": "block", "type": key, key: {"rich_text": rich_text(text)}}


def bullet(text):
    return {"object": "block", "type": "bulleted_list_item",
            "bulleted_list_item": {"rich_text": rich_text(text)}}


def table(headers, rows):
    """노션 table 블록. 첫 행이 헤더다."""
    def row(cells):
        return {"object": "block", "type": "table_row",
                "table_row": {"cells": [rich_text(c) for c in cells]}}
    return {"object": "block", "type": "table", "table": {
        "table_width": len(headers), "has_column_header": True, "has_row_header": False,
        "children": [row(headers)] + [row(r) for r in rows]}}


def bookmark(url):
    return {"object": "block", "type": "bookmark", "bookmark": {"url": url}}


# ---------------------------------------------------------------- 본문 조립

def today_kst(cfg):
    tz = timezone(timedelta(hours=cfg["notion"]["timezone_offset_hours"]))
    return datetime.now(tz).strftime("%Y-%m-%d")


def yymmdd(iso_date):
    """'2026-07-29' → '260729'. 제목 멱등 키."""
    return (iso_date or "").replace("-", "")[2:]


def claim_values(result, cfg):
    """claim_format의 자리표시자를 채울 값 사전. 시리즈별 분기 없이 기계적으로 만든다."""
    out = {"basis_date": result.get("basis_date") or "미확정"}
    for sid, r in result["series"].items():
        d = r["display"]
        out["%s_latest" % sid] = fmt(r.get("latest"), d)
        out["%s_latest_date" % sid] = r.get("latest_date") or "미수집"
        for lb in cfg["lookbacks"]:
            x = r.get(lb["key"])
            out["%s_%s_value" % (sid, lb["key"])] = fmt(x["value"], d) if x else "미수집"
            out["%s_%s_delta" % (sid, lb["key"])] = fmt(x["delta"], d, True) if x else "미수집"
            out["%s_%s_date" % (sid, lb["key"])] = x["date"] if x else "미수집"
    pair = cfg["body"]["claim_pair"]
    da = (result["series"].get(pair["a"], {}).get("prev") or {}).get("delta")
    db = (result["series"].get(pair["b"], {}).get("prev") or {}).get("delta")
    if da is None or db is None or da == 0 or db == 0:
        out["pair_direction"] = pair["flat"]
    else:
        out["pair_direction"] = pair["opposite"] if (da > 0) != (db > 0) else pair["same"]
    return out


def snapshot_rows(result, cfg):
    """스냅샷 표 행. 비교값에는 반드시 비교 기준일을 병기한다(기준일 없는 숫자 금지)."""
    rows = []
    for sid in result["order"]:
        r = result["series"][sid]
        d = r["display"]
        if r.get("latest") is None:
            rows.append(["%s (%s)" % (r["label"], sid), d["unit"], "미수집", "-"]
                        + ["미수집"] * len(cfg["lookbacks"]))
            continue
        cells = ["%s (%s)" % (r["label"], sid), d["unit"],
                 fmt(r["latest"], d), r["latest_date"]]
        for lb in cfg["lookbacks"]:
            x = r.get(lb["key"])
            cells.append("미수집" if not x else
                         "%s (%s = %s)" % (fmt(x["delta"], d, True), x["date"], fmt(x["value"], d)))
        rows.append(cells)
    return rows


def crosscheck_lines(result, cfg):
    cc = result["cross_check"]
    lines = [
        "방법: %s" % cc["method"],
        "대조 규모: 시리즈 %d종 × 최근 %d개 관측 = %d건 대조, 불일치 %d건"
        % (cc["series_checked"], cc["observations_compared"] // max(cc["series_checked"], 1),
           cc["observations_compared"], cc["mismatch_count"]),
    ]
    return lines + list(cfg["body"].get("crosscheck_notes") or [])


def source_lines(result):
    updated = ["%s %s" % (sid, result["series"][sid]["meta"].get("data_updated") or "-")
               for sid in result["order"] if result["series"][sid]["meta"].get("data_updated")]
    return [
        "출처: %s" % result["source"],
        "수집 시각: %s" % result["generated_at_kst"],
        "FRED 최종갱신(시리즈별): %s" % ", ".join(updated),
        "이 페이지는 GitHub Actions(econ-cockpit / liquidity-watch.yml)가 주 1회 자동 생성한 AI 초안이다.",
    ]


def caution_lines(result, cfg):
    """고정 3줄 + 조건부 1줄.

    조건부: 관측일이 수집일(KST)보다 뒤인 시리즈. IORB는 FRED가 앞선 날짜까지 값을 준다
    (2026-08-01 수집 시 최신 관측일 2026-08-03 실측). 비교 기준일이 전부 그 관측일에서
    역산되므로 다른 시리즈와 시점이 어긋난다 — 조용히 넘기지 않고 본문에 남긴다.
    """
    lines = list(cfg["body"]["cautions"])
    today = result["generated_at_kst"][:10]
    ahead = ["%s %s" % (sid, result["series"][sid].get("latest_date"))
             for sid in result["order"]
             if (result["series"][sid].get("latest_date") or "") > today]
    if ahead and cfg["body"].get("caution_future_obs"):
        lines.append(cfg["body"]["caution_future_obs"].format(
            items=", ".join(ahead) + " / 수집일 " + today))
    return lines


def build_body(result, cfg):
    b = cfg["body"]
    blocks = [
        heading(b["claim_heading"]),
        paragraph(b["claim_format"].format(**claim_values(result, cfg))),
        heading(b["table_heading"]),
        table(b["table_headers"], snapshot_rows(result, cfg)),
    ]
    blocks.append(paragraph("비교 기준: " + " / ".join(
        "%s = %s" % (lb["label"], lb["basis"]) for lb in cfg["lookbacks"])))
    blocks.append(heading(b["crosscheck_heading"]))
    blocks += [bullet(x) for x in crosscheck_lines(result, cfg)]
    blocks.append(heading(b["caution_heading"]))
    blocks += [bullet(x) for x in caution_lines(result, cfg)]
    blocks.append(heading(b["source_heading"]))
    blocks += [bullet(x) for x in source_lines(result)]
    blocks.append(bookmark(result["source_url"]))
    return blocks


def build_anomaly_body(result, cfg):
    """불일치가 있을 때의 본문. **값을 싣지 않는다** — 불일치 내역과 출처뿐이다."""
    b = cfg["body"]
    blocks = [heading(b["claim_heading"]), paragraph(b["anomaly_lead"]),
              heading(b["anomaly_heading"])]
    blocks += [bullet(m) for m in result["mismatches"][:60]]
    if len(result["mismatches"]) > 60:
        blocks.append(paragraph("… 외 %d건" % (len(result["mismatches"]) - 60)))
    blocks.append(heading(b["crosscheck_heading"]))
    blocks += [bullet(x) for x in crosscheck_lines(result, cfg)]
    blocks.append(heading(b["source_heading"]))
    blocks += [bullet(x) for x in source_lines(result)]
    blocks.append(bookmark(result["source_url"]))
    return blocks


# ---------------------------------------------------------------- 속성

def build_properties(title, cfg):
    ncfg = cfg["notion"]
    props = {ncfg["title_property"]: {"title": rich_text(title)}}
    for name, spec in ncfg["properties"].items():
        kind, value = spec["type"], spec["value"]
        if kind == "select":
            props[name] = {"select": {"name": value}}
        elif kind == "multi_select":
            props[name] = {"multi_select": [{"name": v} for v in value]}
        elif kind == "date":
            props[name] = {"date": {"start": today_kst(cfg) if value == TODAY_KST else value}}
        elif kind == "rich_text":
            props[name] = {"rich_text": rich_text(value)}
        else:
            raise NotionError("config.notion.properties[%s].type을 모른다: %r" % (name, kind))
    assert_safe(props, cfg)
    return props


def assert_safe(props, cfg):
    """디렉터 데이터 보존 검사. DRY_RUN에서도 돈다 — 여기서 막지 못하면 실쓰기에서 막을 곳이 없다."""
    ncfg = cfg["notion"]
    banned = [p for p in (ncfg.get("_never_write") or []) if p in props]
    if banned:
        raise NotionError("쓰면 안 되는 속성이 payload에 있다: %s" % ", ".join(banned))
    for name, blocked in (ncfg.get("_forbidden_values") or {}).items():
        prop = props.get(name) or {}
        got = (prop.get("select") or {}).get("name")
        if got in blocked:
            raise NotionError("%s=%r는 자동화가 쓸 수 없는 값이다(디렉터 전용)" % (name, got))
    return props


# ---------------------------------------------------------------- 마크다운(검수용)

def blocks_to_markdown(title, props, blocks):
    """dry-run 검수용. 노션에 쓰는 것과 같은 블록에서 파생한다(별도 문안을 만들지 않는다)."""
    def txt(rt):
        return "".join(seg["text"]["content"] for seg in rt)

    out = ["# %s" % title, ""]
    out.append("속성: " + " / ".join(
        "%s=%s" % (k, json.dumps(v, ensure_ascii=False)) for k, v in props.items()
        if k != "이름"))
    out.append("")
    for blk in blocks:
        t = blk["type"]
        if t.startswith("heading_"):
            out += ["", "#" * int(t[-1]) + " " + txt(blk[t]["rich_text"]), ""]
        elif t == "paragraph":
            out += [txt(blk["paragraph"]["rich_text"]), ""]
        elif t == "bulleted_list_item":
            out.append("- " + txt(blk["bulleted_list_item"]["rich_text"]))
        elif t == "bookmark":
            out += ["", "출처 링크: " + blk["bookmark"]["url"]]
        elif t == "table":
            rows = blk["table"]["children"]
            for i, row in enumerate(rows):
                cells = [txt(c) for c in row["table_row"]["cells"]]
                out.append("| " + " | ".join(cells) + " |")
                if i == 0:
                    out.append("|" + "---|" * len(cells))
            out.append("")
    return "\n".join(out) + "\n"


# ---------------------------------------------------------------- 본체

def main():
    ap = argparse.ArgumentParser(description="유동성 워치 노션 적재")
    ap.add_argument("--input", help="fetch_liquidity.py --json 결과 파일. 없으면 stdin")
    ap.add_argument("--config", default=None)
    ap.add_argument("--dry-run", action="store_true",
                    help="노션에 쓰지 않고 payload만 출력한다(네트워크·토큰 불필요)")
    ap.add_argument("--payload-out", help="payload(properties+children) JSON 저장 경로")
    ap.add_argument("--markdown-out", help="본문 마크다운 저장 경로(검수용)")
    args = ap.parse_args()

    cfg = load_config(args.config)
    raw = open(args.input, "r", encoding="utf-8").read() if args.input else sys.stdin.read()
    result = json.loads(raw)

    basis = result.get("basis_date")
    if not basis:
        raise RuntimeError("basis_date가 없다 — %s 최신 관측일을 못 구했다. 제목(멱등 키)을 만들 수 없다."
                           % cfg["notion"]["title_basis_series"])

    anomaly = bool(result.get("mismatches"))
    ncfg = cfg["notion"]
    title_fmt = ncfg["anomaly_title_format"] if anomaly else ncfg["title_format"]
    title = title_fmt.format(yymmdd=yymmdd(basis))
    props = build_properties(title, cfg)
    blocks = build_anomaly_body(result, cfg) if anomaly else build_body(result, cfg)

    payload = {"parent": {"type": "data_source_id", "data_source_id": ncfg["data_source_id"]},
               "properties": props, "children": blocks}
    if args.payload_out:
        with open(args.payload_out, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
        print("payload 저장: %s" % args.payload_out)
    if args.markdown_out:
        with open(args.markdown_out, "w", encoding="utf-8") as fh:
            fh.write(blocks_to_markdown(title, props, blocks))
        print("본문 마크다운 저장: %s" % args.markdown_out)

    if anomaly:
        print("!! 교차검증 불일치 %d건 — 값을 싣지 않고 '데이터 이상' 페이지로 적재한다"
              % len(result["mismatches"]), file=sys.stderr)

    if args.dry_run:
        print("[DRY-RUN] 제목: %s" % title)
        print("[DRY-RUN] 블록 %d개, 속성 %d개. 노션에 쓰지 않았다." % (len(blocks), len(props)))
        if not args.payload_out:
            print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    notion = Notion(token_from_env(), ncfg["api_version"])
    existing = notion.find_pages_by_title(ncfg["data_source_id"], ncfg["title_property"], title)
    if existing:
        print("이미 있음 — 생성하지 않는다: %r (%d건, %s)"
              % (title, len(existing), existing[0].get("url", "")))
        return 0
    page = notion.create_page(ncfg["data_source_id"], props, blocks)
    print("생성: %r → %s" % (title, page.get("url", page.get("id", ""))))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print("적재 실패: %s" % exc, file=sys.stderr)
        sys.exit(1)
