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
  - **부록이 본체를 인질로 잡지 않는다**: 국채 입찰 부록(TreasuryDirect)이 실패하거나 0건이어도
    FRED 본체는 그대로 실린다. 대신 부록 자리에 '수집 실패'·'해당 주 입찰 없음'을 문장으로 남긴다
    (빈 표·침묵 금지). 입찰은 단일 원천이라 교차검증이 불가능해 그 사실을 본문에 명시한다.
    단, **'데이터 이상' 페이지에는 부록도 싣지 않는다** — 그 페이지의 원칙은 '값을 싣지 않는다'다.

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
from notion_upload import image_block, upload_image  # noqa: E402

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

    def request_absolute(self, method, url, body, content_type, timeout=120):
        """절대 URL + 미리 만든 본문. 파일 업로드(multipart)용 — JSON 직렬화를 타지 않는다."""
        req = urllib.request.Request(url, data=body, method=method, headers={
            "Authorization": "Bearer " + self.token,
            "Notion-Version": self.version,
            "Content-Type": content_type,
        })
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")
            raise NotionError("Notion HTTP %s %s %s: %s" % (exc.code, method, url, detail[:1200]))

    def create_page(self, ds_id, properties, children=None):
        payload = {"parent": {"type": "data_source_id", "data_source_id": ds_id},
                   "properties": properties}
        if children:
            payload["children"] = children[:100]
        return self.request("POST", "/pages", payload)

    def append_blocks(self, page_id, children):
        """블록 append. 노션은 한 번에 100개까지만 받으므로 나눠 보낸다."""
        out = []
        for i in range(0, len(children), 100):
            out.append(self.request("PATCH", "/blocks/%s/children" % page_id,
                                    {"children": children[i:i + 100]}))
        return out

    def list_children(self, page_id):
        blocks, cursor = [], None
        while True:
            path = "/blocks/%s/children?page_size=100" % page_id
            if cursor:
                path += "&start_cursor=" + cursor
            res = self.request("GET", path)
            blocks += res.get("results", [])
            if not res.get("has_more") or not res.get("next_cursor"):
                return blocks
            cursor = res["next_cursor"]

    def has_heading(self, page_id, text):
        """같은 제목의 heading이 이미 있나 — 프로브 멱등성의 근거다."""
        for b in self.list_children(page_id):
            t = b.get("type", "")
            if not t.startswith("heading_"):
                continue
            got = "".join(seg.get("plain_text", "") for seg in b[t].get("rich_text", []))
            if got.strip() == text.strip():
                return True
        return False


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
    """잔액 표 행. 비교값에는 반드시 비교 기준일을 병기한다(기준일 없는 숫자 금지).

    지표명 칸에는 괄호 해설(gloss)을 붙인다 — 이 페이지는 사외까지 나갈 수 있고,
    'WRESBAL'만 적혀 있으면 읽는 사람이 무엇인지 알 수 없다. 해설 문구는 전부 config에 있다.
    """
    b = cfg["body"]
    rows = []
    for sid in result.get("table_order") or result["order"]:
        r = result["series"][sid]
        d = r["display"]
        name = (b["gloss_format"].format(label=r["label"], gloss=r["gloss"])
                if r.get("gloss") else r["label"])
        name = b["series_label_format"].format(label=name, id=sid)
        if r.get("latest") is None:
            rows.append([name, d["unit"], "미수집", "-"] + ["미수집"] * len(cfg["lookbacks"]))
            continue
        cells = [name, d["unit"], fmt(r["latest"], d), r["latest_date"]]
        for lb in cfg["lookbacks"]:
            x = r.get(lb["key"])
            cells.append("미수집" if not x else
                         "%s (%s = %s)" % (fmt(x["delta"], d, True), x["date"], fmt(x["value"], d)))
        rows.append(cells)
    return rows


# ------------------------------------------------- 구획① 헤드라인 기계 판정

def build_headline_blocks(result, cfg):
    """판정 문장 + **판정 규칙 1줄을 바로 아래 병기한다.**

    규칙을 붙이는 이유: '흡수'라는 한 단어만 남으면 읽는 사람이 시장 판단으로 받아들인다.
    무엇을 어떤 임계로 분류했는지가 같은 화면에 있어야 한다.
    """
    h = result.get("headline") or {}
    hc = cfg["headline"]
    blocks = [heading(hc["heading"]),
              heading(h.get("text") or hc["unavailable"], 3),
              paragraph(h.get("rule") or "")]
    if h.get("detail"):
        blocks.append(paragraph(h["detail"]))
    return blocks


# ------------------------------------------------- 구획② 신호 보드

def signal_board_rows(result, cfg):
    """[현재값·관측일 | 판독 규칙 | 이상 신호 조건]. **임계값 칸은 자동화가 채우지 않는다.**"""
    sb = cfg["signal_board"]
    rows = []
    for spec in sb["rows"]:
        r = result["series"].get(spec["id"]) or {}
        d = r.get("display") or {}
        label = r.get("label", spec["id"])
        value = "미수집" if r.get("latest") is None else "%s %s" % (
            fmt(r["latest"], d), d.get("unit", ""))
        rows.append(["%s (%s)" % (label, spec["id"]), value,
                     r.get("latest_date") or "미수집", spec["read_rule"], sb["pending"]])
    return rows


def signal_board_claim(result, cfg):
    sb = cfg["signal_board"]
    parts = []
    for spec in sb["rows"]:
        r = result["series"].get(spec["id"]) or {}
        d = r.get("display") or {}
        parts.append(sb["claim_line_format"].format(
            label=r.get("label", spec["id"]),
            value="미수집" if r.get("latest") is None else "%s%s" % (
                fmt(r["latest"], d), (" " + d["unit"]) if d.get("unit") else ""),
            date=r.get("latest_date") or "미수집"))
    return sb["claim_format"].format(lines=", ".join(parts))


def build_signal_board_blocks(result, cfg):
    sb = cfg["signal_board"]
    return ([heading(sb["heading"]),
             heading(sb["claim_heading"], 3),
             paragraph(signal_board_claim(result, cfg)),
             table(sb["headers"], signal_board_rows(result, cfg))]
            + [bullet(x) for x in sb["cautions"]])


# ------------------------------------------------- 구획④ 요인 분해

def factor_rows(f, cfg):
    """요인별 행 + 항등식 검산 3행(요인 합 / 실제 증감 / 잔차). 잔차를 표에서 숨기지 않는다."""
    fc = cfg["factors"]
    nd = f["decimals"]
    kinds = fc["sign_kinds"]

    def num(v):
        return "{:+,.{d}f}".format(v, d=nd)

    rows = []
    for it in f["items"]:
        comps = ", ".join(fc["component_format"].format(
            id=c["id"], sign="+" if c["sign"] > 0 else "−") for c in it["components"])
        rows.append(["%s — %s" % (it["label"], it["gloss"]), num(it["delta"]), comps,
                     kinds[it["sign_kind"]]])
    rows.append([fc["sum_label"], num(f["sum"]), "위 다섯 요인의 합", kinds["identity"]])
    rows.append([fc["target_label"], num(f["target_delta"]), f["target"], kinds["identity"]])
    rows.append([fc["residual_label"], num(f["residual"]),
                 "%s − (요인 합)" % f["target"],
                 "임계 ±%s%s — %s" % (f["residual_threshold"], fc["residual_threshold_unit"],
                                     "이내" if f["residual_ok"] else "**초과: 검증 실패**")])
    return rows


def factor_claim(f, cfg):
    fc = cfg["factors"]
    nd = f["decimals"]
    breakdown = ", ".join(fc["claim_item_format"].format(
        label=it["label"], delta="{:+,.{d}f}".format(it["delta"], d=nd)) for it in f["items"])
    verdict_fmt = fc["residual_ok_format"] if f["residual_ok"] else fc["residual_warn_format"]
    return fc["claim_format"].format(
        basis_date=f["basis_date"],
        target_delta="{:+,.{d}f}".format(f["target_delta"], d=nd),
        breakdown=breakdown,
        sum="{:+,.{d}f}".format(f["sum"], d=nd),
        residual="{:+,.{d}f}".format(f["residual"], d=nd),
        residual_verdict=verdict_fmt.format(threshold=f["residual_threshold"],
                                            unit=fc["residual_threshold_unit"]))


def build_factor_blocks(result, cfg):
    """요인 분해 블록. **잔차가 임계를 넘으면 값을 숨기지 않고 경고를 함께 싣는다.**"""
    fc = cfg["factors"]
    f = result.get("factors") or {}
    blocks = [heading(fc["heading"])]
    if f.get("status") != "ok":
        return blocks + [paragraph(fc["unavailable_format"].format(
            reason=f.get("reason") or "요인 분해 결과가 스냅샷에 없다"))]
    blocks.append(heading(fc["claim_heading"], 3))
    blocks.append(paragraph(factor_claim(f, cfg)))
    blocks.append(table(fc["headers"], factor_rows(f, cfg)))
    if not f["residual_ok"]:
        blocks.append(heading(fc["residual_warning_heading"], 3))
        blocks.append(paragraph(fc["residual_warning_format"].format(
            residual="{:+,.{d}f}".format(f["residual"], d=f["decimals"]),
            threshold=f["residual_threshold"])))
    blocks.append(paragraph("분해 기간: %s → %s (%s). %s"
                            % (f["prev_date"], f["basis_date"], f["unit"],
                               f.get("identity_note", ""))))
    return blocks


# ------------------------------------------------- 부록: 국채 입찰 (단일 원천)

def dec(value, places):
    """자릿수 고정 표시. None은 '미수집' — 추정으로 채우지 않는다."""
    return "미수집" if value is None else "{:,.{d}f}".format(value, d=places)


def auction_metric_text(row):
    """낙찰 지표 값. Bill은 투자환산수익률을 괄호에 병기한다(할인율과 다른 값이다)."""
    txt = dec(row["metric_value"], row["metric_decimals"]) + row["metric_suffix"]
    if row.get("extra_value") is not None:
        txt += " (%s %s%s)" % (row["extra_label"],
                               dec(row["extra_value"], row["extra_decimals"]),
                               row["metric_suffix"])
    return txt


def auction_rows(a, cfg):
    """입찰 표 행. 모든 수치가 같은 행의 입찰일에 묶인다(기준일 없는 숫자 금지)."""
    t = cfg["treasurydirect"]
    out = []
    for r in a["rows"]:
        acc = (None if r.get("accepted") is None
               else r["accepted"] / t["accepted_divide_by"])
        out.append([r["item"], r["auction_date"], r["metric_label"], auction_metric_text(r),
                    dec(r["btc"], t["btc_decimals"]),
                    dec(acc, t["accepted_decimals"])])
    return out


def auction_claim_values(a, cfg):
    """claim 자리표시자. 전부 수집된 행에서만 파생한다 — 추정·보간 없음."""
    b, t = cfg["body"], cfg["treasurydirect"]
    rows = a["rows"]
    lo = min(rows, key=lambda r: r["btc"])
    hi = max(rows, key=lambda r: r["btc"])
    have = [r for r in rows if r.get("accepted") is not None]
    total = sum(r["accepted"] for r in have) / t["accepted_divide_by"] if have else None
    n_missing = len(rows) - len(have)
    return {
        "start": a["window"]["start"], "end": a["window"]["end"], "count": a["count"],
        "breakdown": ", ".join(b["auction_breakdown_item_format"].format(**x)
                               for x in a["breakdown"]),
        "btc_min": dec(lo["btc"], t["btc_decimals"]),
        "btc_min_item": lo["item"], "btc_min_date": lo["auction_date"],
        "btc_max": dec(hi["btc"], t["btc_decimals"]),
        "btc_max_item": hi["item"], "btc_max_date": hi["auction_date"],
        "accepted_total": dec(total, t["accepted_decimals"]),
        "accepted_partial": ("" if not n_missing
                             else b["auction_accepted_partial_format"].format(n=n_missing)),
        "metric_kinds": a.get("metric_kinds", ""),
    }


def auction_caution_lines(a, cfg):
    """입찰 표에만 붙는 주의. 단일 원천·유형별 정의 차이·발표 시차를 매번 명시한다."""
    ctx = {"metric_kinds": a.get("metric_kinds", ""),
           "window_days": (a.get("window") or {}).get("days",
                          cfg["treasurydirect"]["window_days"])}
    return [x.format(**ctx) for x in cfg["body"]["auction_cautions"]]


def build_auction_blocks(result, cfg):
    """부록 블록. **본체를 인질로 잡지 않는다** — 실패·0건도 문장으로 남기고 넘어간다."""
    b, t = cfg["body"], cfg["treasurydirect"]
    blocks = [heading(b["auction_heading"].format(window_days=t["window_days"]))]
    a = result.get("auctions")

    if not a:  # 구버전 fetch 산출물
        return blocks + [paragraph(b["auction_failed_format"].format(
            error="스냅샷에 auctions 항목이 없다(입찰 부록 이전 버전의 fetch 산출물이다)"))]
    if a.get("status") == "failed":
        return blocks + [paragraph(b["auction_failed_format"].format(
            error=a.get("error") or "원인 미상"))]
    if not a.get("rows"):  # 빈 표를 만들지 않고, 침묵하지도 않는다
        blocks.append(paragraph(b["auction_empty_format"].format(
            start=a["window"]["start"], end=a["window"]["end"],
            raw_count=a.get("raw_count", 0))))
        blocks.append(heading(b["caution_heading"], 3))
        return blocks + [bullet(x) for x in auction_caution_lines(a, cfg)]

    blocks.append(heading(b["auction_claim_heading"], 3))
    blocks.append(paragraph(b["auction_claim_format"].format(**auction_claim_values(a, cfg))))
    blocks.append(table(b["auction_table_headers"], auction_rows(a, cfg)))
    if a.get("dropped"):
        blocks.append(heading(b["auction_dropped_heading"], 3))
        blocks.append(paragraph(b["auction_dropped_lead"].format(n=len(a["dropped"]))))
        blocks += [bullet(d) for d in a["dropped"][:20]]
    blocks.append(heading(b["caution_heading"], 3))
    blocks += [bullet(x) for x in auction_caution_lines(a, cfg)]
    return blocks


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
    lines = [
        "출처: %s" % result["source"],
        "수집 시각: %s" % result["generated_at_kst"],
        "FRED 최종갱신(시리즈별): %s" % ", ".join(updated),
    ]
    a = result.get("auctions") or {}
    if a:
        w = a.get("window") or {}
        lines.append("부록 출처: %s%s" % (
            a.get("source", "-"),
            "" if a.get("status") == "failed" else
            " / 입찰일 %s~%s 수집, %s" % (w.get("start", "-"), w.get("end", "-"),
                                        a.get("fetched_at_kst", "-"))))
        lines.append("부록 검증: %s" % (a.get("cross_check") or {}).get("method", "-"))
    lines.append("이 페이지는 GitHub Actions(econ-cockpit / liquidity-watch.yml)가 "
                 "주 1회 자동 생성한 AI 초안이다.")
    return lines


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


def build_body(result, cfg, charts=None):
    """v2 본문 — 5구획.

      ① 헤드라인 기계 판정   ② 신호 보드   ③ 잔액 표   ④ 요인 분해   ⑤ 입찰 부록
    그 뒤로 교차검증·데이터 주의·출처, 마지막에 인터랙티브 드릴다운 링크가 붙는다.
    charts가 오면 각 구획 흐름 뒤 '차트' 섹션으로 이미지 블록을 붙인다 — **없어도 본문은 완성된다.**
    """
    b = cfg["body"]
    blocks = build_headline_blocks(result, cfg)                       # ①
    blocks += build_signal_board_blocks(result, cfg)                  # ②

    blocks.append(heading(b["table_heading"]))                        # ③
    blocks.append(heading(b["claim_heading"], 3))
    blocks.append(paragraph(b["claim_format"].format(**claim_values(result, cfg))))
    blocks.append(table(b["table_headers"], snapshot_rows(result, cfg)))
    blocks.append(paragraph("비교 기준: " + " / ".join(
        "%s = %s" % (lb["label"], lb["basis"]) for lb in cfg["lookbacks"])))

    blocks += build_factor_blocks(result, cfg)                        # ④
    blocks += build_auction_blocks(result, cfg)                       # ⑤
    blocks += build_chart_blocks(charts, cfg)                         # 차트(격리)

    blocks.append(heading(b["crosscheck_heading"]))
    blocks += [bullet(x) for x in crosscheck_lines(result, cfg)]
    blocks.append(heading(b["caution_heading"]))
    blocks += [bullet(x) for x in caution_lines(result, cfg)]
    blocks.append(heading(b["source_heading"]))
    blocks += [bullet(x) for x in source_lines(result)]
    blocks.append(bookmark(result["source_url"]))
    a = result.get("auctions") or {}
    if a.get("source_url"):
        blocks.append(bookmark(a["source_url"]))
    blocks.append(paragraph(b["cockpit_link_format"].format(url=b["cockpit_url"])))
    return blocks


# ------------------------------------------------- 차트 (격리)

def build_chart_blocks(charts, cfg, heading_text=None, lead=None):
    """차트 섹션. **차트 실패가 본문을 막지 않는다** — 실패하면 사유 한 줄만 남는다.

    charts는 charts.build_charts() 결과에 각 항목의 upload_id가 채워진 형태다.
    upload_id가 없는 항목(생성 실패·업로드 실패)은 이미지 대신 사유 문장으로 들어간다:
    조용히 사라지면 '차트가 원래 없는 것'과 구분되지 않는다.
    """
    ch = cfg["charts"]
    if not charts:
        return []
    blocks = [heading(heading_text or ch["heading"])]
    if lead:
        blocks.append(paragraph(lead))
    if charts.get("status") in ("skipped", "disabled"):
        return blocks + [paragraph(charts.get("reason") or ch["skipped_format"].format(
            reason="사유 미상"))]
    for item in charts.get("items", []):
        if item.get("upload_id"):
            blocks.append(image_block(item["upload_id"], rich_text(item["caption"])))
        elif item.get("upload_error"):
            blocks.append(paragraph(ch["upload_failure_format"].format(
                error="%s — %s" % (item["key"], item["upload_error"]))))
        elif item.get("status") == "ok":
            # dry-run: 그림은 만들었지만 업로드를 타지 않았다. 실패로 오인하지 않게 구분해 둔다.
            blocks.append(paragraph(ch["not_uploaded_format"].format(
                key=item["key"], path=item.get("path") or "-", caption=item["caption"])))
        else:
            blocks.append(paragraph(item.get("error") or ch["failure_format"].format(
                error="%s: 사유 미상" % item["key"])))
    return blocks


def make_charts(result, cfg, outdir):
    """차트 생성. **어떤 실패도 예외로 올리지 않는다** — 표 적재를 막으면 안 되기 때문이다."""
    if not cfg["charts"].get("enabled"):
        return None
    try:
        from charts import build_charts  # matplotlib은 이 안에서만 import된다
        return build_charts(result, cfg, outdir)
    except Exception as exc:  # noqa: BLE001
        print("차트 생성 단계 실패(본문은 계속): %s" % exc, file=sys.stderr)
        return {"status": "skipped", "items": [],
                "reason": cfg["charts"]["skipped_format"].format(error=str(exc)[:300],
                                                                 reason=str(exc)[:300])}


def upload_charts(notion, cfg, charts):
    """각 PNG를 노션에 올려 upload_id를 채운다. **한 장의 실패가 나머지를 죽이지 않는다.**"""
    if not charts or charts.get("status") in ("skipped", "disabled"):
        return charts
    for item in charts.get("items", []):
        if item.get("status") != "ok" or not item.get("path"):
            continue
        try:
            item["upload_id"] = upload_image(notion, cfg, item["path"])
        except Exception as exc:  # noqa: BLE001
            item["upload_error"] = str(exc)[:400]
            print("차트 업로드 실패(계속): %s — %s" % (item["key"], exc), file=sys.stderr)
    return charts


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
        elif t == "image":
            img = blk["image"]
            out += ["", "[이미지 %s] %s" % (img.get("type"), txt(img.get("caption") or [])), ""]
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
    ap.add_argument("--charts-dir", default=os.environ.get("LIQUIDITY_CHARTS_DIR") or None,
                    help="차트 PNG 출력 디렉터리. 없으면 차트를 만들지 않는다")
    ap.add_argument("--probe-charts", action="store_true",
                    help="**프로브 모드**: 새 페이지를 만들지 않고, 이번 기준일의 기존 페이지 하단에 "
                         "차트 섹션만 append한다. 같은 제목의 섹션이 이미 있으면 아무것도 하지 않는다(멱등)")
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

    # ---- 프로브 모드: 기존 페이지에 차트 섹션만 붙인다(본문을 다시 쓰지 않는다) ----
    if args.probe_charts:
        return run_probe(result, cfg, title, args)

    # 차트는 '데이터 이상' 페이지에는 붙이지 않는다 — 그 페이지의 원칙은 '값을 싣지 않는다'다.
    charts = None
    if args.charts_dir and not anomaly:
        charts = make_charts(result, cfg, args.charts_dir)

    props = build_properties(title, cfg)
    blocks = (build_anomaly_body(result, cfg) if anomaly
              else build_body(result, cfg, charts))

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

    # 업로드는 페이지를 만들기 직전에 한다 — 실패해도 blocks를 다시 조립해 본문은 그대로 낸다.
    if charts:
        charts = upload_charts(notion, cfg, charts)
        blocks = build_body(result, cfg, charts)

    # 노션 create_page는 children을 100개까지만 받는다. v2 본문은 그보다 길 수 있어
    # **나머지를 append로 이어 붙인다** — 예전처럼 조용히 잘리면 표 뒤가 통째로 사라진다.
    page = notion.create_page(ncfg["data_source_id"], props, blocks[:100])
    page_id = page["id"]
    if len(blocks) > 100:
        notion.append_blocks(page_id, blocks[100:])
    print("생성: %r → %s (블록 %d개)"
          % (title, page.get("url", page_id), len(blocks)))
    return 0


def run_probe(result, cfg, title, args):
    """차트 업로드 경로 E2E 실증. 기존 주간 페이지 하단에 '차트(v2 프로브)' 섹션을 붙인다.

    **멱등하다** — 같은 제목의 heading이 이미 있으면 아무것도 하지 않는다.
    **본문을 건드리지 않는다** — append만 하고 기존 블록·속성은 수정하지 않는다.
    """
    ch, ncfg = cfg["charts"], cfg["notion"]
    notion = Notion(token_from_env(), ncfg["api_version"])
    pages = notion.find_pages_by_title(ncfg["data_source_id"], ncfg["title_property"], title)
    if not pages:
        print("프로브 대상 페이지가 없다: %r — 정기 실행이 먼저 만들어야 한다" % title,
              file=sys.stderr)
        return 1
    if len(pages) > 1:
        print("!! 같은 제목의 페이지가 %d건이다. 첫 번째에만 붙인다: %r"
              % (len(pages), title), file=sys.stderr)
    page = pages[0]
    page_id, page_url = page["id"], page.get("url", "")

    if notion.has_heading(page_id, ch["probe_heading"]):
        print("이미 있음 — 붙이지 않는다: %r 섹션 (%s)" % (ch["probe_heading"], page_url))
        return 0

    outdir = args.charts_dir or os.path.join(os.environ.get("RUNNER_TEMP", "."), "charts")
    charts = make_charts(result, cfg, outdir)
    if not charts:
        print("차트가 비활성화돼 있다(config.charts.enabled=false) — 붙일 것이 없다", file=sys.stderr)
        return 1
    charts = upload_charts(notion, cfg, charts)
    blocks = build_chart_blocks(charts, cfg, ch["probe_heading"], ch["probe_lead"])
    notion.append_blocks(page_id, blocks)

    ok = sum(1 for i in charts.get("items", []) if i.get("upload_id"))
    print("프로브 완료: %r 에 '%s' 섹션 append — 이미지 %d/%d장 (%s)"
          % (title, ch["probe_heading"], ok, len(charts.get("items", [])), page_url))
    for i in charts.get("items", []):
        print("  %-10s %s%s" % (i["key"], i.get("status"),
                                "" if i.get("upload_id") else
                                " / 업로드 실패: %s" % i.get("upload_error", i.get("error", "-"))))
    return 0 if ok else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print("적재 실패: %s" % exc, file=sys.stderr)
        sys.exit(1)
