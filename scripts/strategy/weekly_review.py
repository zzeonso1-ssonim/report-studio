#!/usr/bin/env python3
"""주간 복기 초안 자동 생성 → 주간채권전략 `복기 메모` 기입.

왜 필요했나 (2026-08-12 실측)
  복기 기입률이 5회차 중 2회차(40%)이고, 마지막 실제 복기가 260727이다. 이후 2회 연속 공백.
  제안서는 "주간 복기에서 직전 판단을 평가한다"고 단정하는데 실적이 이를 못 받친다.

기계가 대조하는 4축 — **이것만** 자동으로 판정한다
  ① 방향   회차가 제시한 금리 방향 vs 실제 주간 변화
  ② 레인지 제시 레인지 안에 실제 금리가 있었는가(이탈했다면 며칠·얼마나)
  ③ 트리거 등록한 조건부 트리거가 실제로 발동했는가
  ④ 실행구간 제시한 레벨 구간에 실제로 도달했는가

사람 몫으로 남기는 것
  **"왜 틀렸나"(원인 귀속).** 초안 말미에 원인 칸을 비워 두고 디렉터가 한 줄만 채우게 한다.
  전제와 결과 / 대응 시점은 판단이 섞이므로 **대조 가능한 사실만 제시하고 판정하지 않는다.**

원칙 — 어기면 이 작업 전체가 무의미해진다
  - **대조 불가한 축은 '확인 불가'다.** 추정·보간 금지. 계열이 없으면 없다고 쓴다.
    트리거는 config.mappings에 **선언된 것만** 판정한다(미국 CPI·NFP·투신 수급은 수집분에 없다).
  - **모든 수치에 출처와 기준일을 병기한다.**
  - **초안임을 본문에 명시한다.** 확정된 복기처럼 보이면 안 된다.
  - **멱등.** 마커 사이만 교체한다. 사람이 쓴 복기 메모는 덮지 않는다.
  - 데이터는 이미 있는 수집분을 **읽기만** 한다. 새 수집기를 만들지 않는다.

사용
  python3 weekly_review.py --selftest
  python3 weekly_review.py --round 260803 --dry-run          # 노션 읽기, 쓰지 않음
  python3 weekly_review.py --round-json fixture.json --dry-run  # 노션 없이 초안 생성
  python3 weekly_review.py --round 260803                     # 기입
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(_HERE), "liquidity"))
sys.path.insert(0, _HERE)

from post_briefing import Notion, NotionError, token_from_env  # noqa: E402
from premise_to_risklog import (  # noqa: E402  — 파싱 헬퍼는 등재 훅 것을 그대로 쓴다
    collect_section_tables, fetch_children, page_url, prop_date_start, prop_title, rich_text,
)

CONFIG_PATH = os.path.join(_HERE, "review_config.json")
OPS = {">=": lambda a, b: a >= b, ">": lambda a, b: a > b,
       "<=": lambda a, b: a <= b, "<": lambda a, b: a < b}


class ReviewError(RuntimeError):
    pass


def load_config(path=CONFIG_PATH):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def validate_config(cfg, path="<config>"):
    for key in ("notion", "source", "market", "axes", "verdicts", "text", "extract"):
        if key not in cfg:
            raise ReviewError("%s: %s가 없다" % (path, key))
    src = cfg["source"]
    banned = set(src.get("_never_write") or [])
    overlap = [p for p in src["write_properties"] if p in banned]
    if overlap:
        raise ReviewError("%s: write_properties가 _never_write와 겹친다: %s"
                          % (path, ", ".join(overlap)))
    if src["review_property"] not in src["write_properties"]:
        raise ReviewError("%s: write_properties가 %r를 포함해야 한다"
                          % (path, src["review_property"]))
    if src["review_property"] != src["write_properties"][0] or len(src["write_properties"]) != 1:
        raise ReviewError("%s: 이 스크립트는 `복기 메모` 하나만 쓴다" % path)
    for m in cfg["axes"]["triggers"]["mappings"]:
        for k in ("id", "series", "mode", "op"):
            if k not in m:
                raise ReviewError("%s: mappings.%s가 없다" % (path, k))
        if m["op"] not in OPS:
            raise ReviewError("%s: op를 모른다: %r" % (path, m["op"]))
        if m["mode"] not in ("level_max", "cumulative_sign"):
            raise ReviewError("%s: mode를 모른다: %r" % (path, m["mode"]))


# ---------------------------------------------------------------- 시장 데이터 (읽기 전용)

class MarketReader:
    """PostgREST 읽기. **키를 파일에 쓰지 않는다** — 환경변수, 없으면 공개 설정 파일을 런타임 파싱."""

    _URL_RE = re.compile(r"""SUPABASE_URL\s*=\s*["']([^"']+)["']""")
    _KEY_RE = re.compile(r"""SUPABASE_KEY\s*=\s*["']([^"']+)["']""")

    def __init__(self, cfg):
        c = cfg["market"]["credentials"]
        url = (os.environ.get(c["url_env"]) or "").strip()
        key = (os.environ.get(c["key_env"]) or "").strip()
        self.source = "env(%s/%s)" % (c["url_env"], c["key_env"])
        if not url or not key:
            path = os.path.expanduser(c["config_js_fallback"])
            if not os.path.exists(path):
                raise ReviewError("%s/%s가 없고 폴백 %s도 없다"
                                  % (c["url_env"], c["key_env"], path))
            text = open(path, "r", encoding="utf-8").read()
            mu, mk = self._URL_RE.search(text), self._KEY_RE.search(text)
            if not mu or not mk:
                raise ReviewError("%s에서 SUPABASE_URL/SUPABASE_KEY를 파싱하지 못했다" % path)
            url, key = mu.group(1), mk.group(1)
            self.source = c["config_js_fallback"]
        self.base = url.rstrip("/")
        self.__key = key  # 이름 맹글링 — 밖에서 우연히 직렬화되지 않게

    def select(self, table, columns, filters, order, page=1000):
        out, offset = [], 0
        qs = ["select=" + urllib.parse.quote(columns, safe=",")]
        for k, v in (filters or {}).items():
            qs.append("%s=%s" % (k, urllib.parse.quote(v, safe='.,()"*')))
        if order:
            qs.append("order=" + urllib.parse.quote(order, safe=".,"))
        base = "%s/rest/v1/%s?%s" % (self.base, table, "&".join(qs))
        while True:
            req = urllib.request.Request(base, headers={
                "apikey": self.__key, "Authorization": "Bearer " + self.__key,
                "Range-Unit": "items", "Range": "%d-%d" % (offset, offset + page - 1)})
            with urllib.request.urlopen(req, timeout=30) as resp:
                chunk = json.loads(resp.read().decode("utf-8") or "[]")
            out += chunk
            if len(chunk) < page:
                return out
            offset += page


def load_yields(reader, cfg, labels, start, end):
    """{label: {date: yield}}"""
    m = cfg["market"]
    if not labels:
        return {}
    inlist = 'in.(%s)' % ",".join('"%s"' % l for l in labels)
    rows = reader.select(m["yield_table"], m["yield_columns"],
                         {"label": inlist, "trade_date": "gte." + start},
                         "trade_date.asc,label.asc")
    out = {}
    for r in rows:
        if not (start <= r["trade_date"] <= end):
            continue
        if r.get("yield") is None:
            continue
        out.setdefault(r["label"], {})[r["trade_date"]] = float(r["yield"])
    return out


def load_series(reader, cfg, symbols, start, end):
    """{symbol: {date: value}}"""
    m = cfg["market"]
    if not symbols:
        return {}
    inlist = "in.(%s)" % ",".join('"%s"' % s for s in symbols)
    rows = reader.select(m["series_table"], m["series_columns"],
                         {"symbol": inlist, "trade_date": "gte." + start},
                         "trade_date.asc,symbol.asc")
    out = {}
    for r in rows:
        if not (start <= r["trade_date"] <= end):
            continue
        if r.get("value") is None:
            continue
        out.setdefault(r["symbol"], {})[r["trade_date"]] = float(r["value"])
    return out


# ---------------------------------------------------------------- 축 ①: 방향

def classify_call(text, ax):
    """(방향, 근거어). 양쪽 어휘가 섞이면 (None, ...) — 판정하지 않는다."""
    bull = [k for k in ax["bull_keywords"] if k in text]
    bear = [k for k in ax["bear_keywords"] if k in text]
    flat = [k for k in ax["flat_keywords"] if k in text]
    if bull and not bear:
        return "하락", bull
    if bear and not bull:
        return "상승", bear
    if flat and not bull and not bear:
        return "보합", flat
    return None, bull + bear + flat


def axis_direction(cfg, call_text, series, label):
    ax, V = cfg["axes"]["direction"], cfg["verdicts"]
    days = sorted(series.get(label) or {})
    if len(days) < 2:
        return {"verdict": V["unknown"], "detail": cfg["text"]["no_data"], "facts": []}
    first, last = days[0], days[-1]
    y0, y1 = series[label][first], series[label][last]
    bp = (y1 - y0) * 100.0
    actual = "보합" if abs(bp) < ax["min_move_bp"] else ("상승" if bp > 0 else "하락")
    facts = ["실제: %s %.3f%% (%s) → %.3f%% (%s), %+.1fbp → **%s**"
             % (label, y0, first, y1, last, bp, actual)]
    expected, kws = classify_call(call_text or "", ax)
    if expected is None:
        return {"verdict": V["unknown"], "facts": facts,
                "detail": "핵심 콜에서 방향을 단정할 수 없다(양방향 어휘 혼재 또는 무매칭: %s). "
                          "**사실만 제시하고 판정하지 않는다.**" % (", ".join(kws) or "없음")}
    verdict = V["match"] if expected == actual else V["miss"]
    return {"verdict": verdict, "facts": facts,
            "detail": "제시 방향 **%s** (근거어: %s) vs 실제 **%s**" % (expected, ", ".join(kws), actual)}


# ---------------------------------------------------------------- 축 ②: 레인지

def parse_ranges(text, cfg):
    """[(label, lo, hi)] — 만기 별칭 뒤에 오는 첫 레인지를 짝짓는다."""
    ax = cfg["axes"]["range"]
    pat = re.compile(ax["range_pattern"])
    out, seen = [], set()
    for mat in cfg["market"]["maturities"]:
        pos = -1
        for alias in mat["alias"]:
            i = (text or "").find(alias)
            if i >= 0 and (pos < 0 or i < pos):
                pos = i
        if pos < 0:
            continue
        m = pat.search(text, pos)
        if not m:
            continue
        if mat["label"] in seen:
            continue
        seen.add(mat["label"])
        out.append((mat["label"], float(m.group("lo")), float(m.group("hi"))))
    return out


def axis_range(cfg, range_text, series):
    V, out = cfg["verdicts"], []
    ranges = parse_ranges(range_text or "", cfg)
    if not ranges:
        return {"verdict": V["unknown"], "rows": [],
                "detail": "제시 레인지를 원문에서 찾지 못했다 — 만들어내지 않는다"}
    worst = V["match"]
    for label, lo, hi in ranges:
        pts = series.get(label) or {}
        if not pts:
            out.append({"label": label, "lo": lo, "hi": hi, "verdict": V["unknown"],
                        "detail": cfg["text"]["no_data"]})
            worst = V["unknown"] if worst == V["match"] else worst
            continue
        below = {d: v for d, v in pts.items() if v < lo}
        above = {d: v for d, v in pts.items() if v > hi}
        n = len(below) + len(above)
        if n == 0:
            out.append({"label": label, "lo": lo, "hi": hi, "verdict": V["match"],
                        "detail": "%d거래일 전부 %0.2f~%0.2f%% 안 (주간 %0.3f~%0.3f%%)"
                                  % (len(pts), lo, hi, min(pts.values()), max(pts.values()))})
            continue
        worst = V["miss"]
        parts = []
        if below:
            d, v = min(below.items(), key=lambda kv: kv[1])
            parts.append("하단 %0.2f%% 이탈 %d일 (최대 %.1fbp, %s %0.3f%%)"
                         % (lo, len(below), (lo - v) * 100, d, v))
        if above:
            d, v = max(above.items(), key=lambda kv: kv[1])
            parts.append("상단 %0.2f%% 이탈 %d일 (최대 %.1fbp, %s %0.3f%%)"
                         % (hi, len(above), (v - hi) * 100, d, v))
        out.append({"label": label, "lo": lo, "hi": hi, "verdict": V["miss"],
                    "detail": " · ".join(parts)})
    return {"verdict": worst, "rows": out, "detail": ""}


# ---------------------------------------------------------------- 축 ③: 트리거

def match_mapping(cfg, risk, criteria):
    combined = "%s %s" % (risk or "", criteria or "")
    for m in cfg["axes"]["triggers"]["mappings"]:
        if not all(k in combined for k in (m.get("match_all") or [])):
            continue
        any_kw = m.get("match_any") or []
        if any_kw and not any(k in (criteria or "") for k in any_kw):
            continue
        return m
    return None


def _thresholds(m, criteria):
    pat = m.get("threshold_pattern")
    if not pat:
        t = m.get("threshold")
        return [] if t is None else [float(t)]
    vals = [float(x.group("v").replace(",", "")) for x in re.finditer(pat, criteria or "")]
    if not vals:
        return []
    return vals if m.get("all_thresholds") else vals[:1]


def axis_triggers(cfg, rows, series):
    tc, V = cfg["axes"]["triggers"], cfg["verdicts"]
    out = []
    for r in rows:
        risk, criteria = r["risk"], r["criteria"]
        m = match_mapping(cfg, risk, criteria)
        if not m:
            out.append({"risk": risk, "criteria": criteria, "verdict": tc["unmapped_verdict"],
                        "detail": tc["unmapped_reason"]})
            continue
        pts = series.get(m["series"]) or {}
        if not pts:
            out.append({"risk": risk, "criteria": criteria, "verdict": V["unknown"],
                        "detail": "%s 계열이 그 주에 없다" % m["series"]})
            continue
        ths = _thresholds(m, criteria)
        if m["mode"] == "level_max" and ths:
            hi_d, hi_v = max(pts.items(), key=lambda kv: kv[1])
            hits = [t for t in ths if OPS[m["op"]](hi_v, t)]
            out.append({
                "risk": risk, "criteria": criteria,
                "verdict": "발동" if hits else "미발동",
                "detail": "%s 주간 고가 %.2f%s (%s) vs 임계 %s → %s. %s"
                          % (m["series"], hi_v, m.get("unit", ""), hi_d,
                             " / ".join("%g" % t for t in ths),
                             "도달 " + ", ".join("%g" % t for t in hits) if hits else "전부 미도달",
                             m.get("note", ""))})
        elif m["mode"] == "cumulative_sign":
            days = sorted(pts)[-int(m.get("window_days", 3)):]
            total = sum(pts[d] for d in days)
            fired = OPS[m["op"]](total, float(m.get("threshold", 0)))
            out.append({
                "risk": risk, "criteria": criteria,
                "verdict": "발동" if fired else "미발동",
                "detail": "%s 최근 %d거래일(%s~%s) 누적 %+.0f%s → %s. %s"
                          % (m["series"], len(days), days[0], days[-1], total,
                             m.get("unit", ""), "순매도" if total < 0 else "순매수",
                             m.get("note", ""))})
        else:
            out.append({"risk": risk, "criteria": criteria, "verdict": V["unknown"],
                        "detail": "확인 조건에서 임계값을 뽑지 못했다 — 추정하지 않는다"})
    return out


# ---------------------------------------------------------------- 축 ④: 실행구간

def axis_levels(cfg, table_rows, header, series):
    ax, V = cfg["axes"]["levels"], cfg["verdicts"]
    label = cfg["market"]["primary_maturity"]
    mm = re.search(ax["maturity_from_header_pattern"], header or "")
    if mm:
        want = mm.group("mat").strip()
        for mat in cfg["market"]["maturities"]:
            if any(a in want or want in a for a in mat["alias"]):
                label = mat["label"]
                break
    pts = series.get(label) or {}
    if not pts:
        return {"label": label, "rows": [], "verdict": V["unknown"], "detail": cfg["text"]["no_data"]}
    lo_w, hi_w = min(pts.values()), max(pts.values())
    rng = re.compile(ax["level_range_pattern"])
    pat = re.compile(ax["level_pattern"])
    out = []
    for cell in table_rows:
        # 범위 표기('3.80~3.90%')를 먼저 본다. 앞 숫자에 %가 안 붙어서
        # 단일 패턴만 쓰면 구간을 점으로 오독한다.
        band = rng.search(cell)
        if band:
            lo_b, hi_b = float(band.group("lo")), float(band.group("hi"))
        else:
            levels = [float(x.group("v")) for x in pat.finditer(cell)]
            if not levels:
                out.append({"band": cell, "verdict": V["unknown"],
                            "detail": "구간에서 레벨 숫자를 뽑지 못했다"})
                continue
            lo_b = hi_b = min(levels)
        # 구간이면 주간 범위와 겹쳤는지, 단일 레벨이면 그 레벨을 통과했는지.
        touched = not (hi_w < lo_b or lo_w > hi_b)
        out.append({"band": cell, "verdict": "도달" if touched else "미도달",
                    "detail": "주간 %0.3f~%0.3f%% / 구간 %0.2f~%0.2f%%" % (lo_w, hi_w, lo_b, hi_b)})
    return {"label": label, "rows": out, "verdict": "", "detail": ""}


# ---------------------------------------------------------------- 회차 읽기

def read_round(notion, cfg, want_yymmdd):
    """(info, tables). tables={섹션번호: [{header:[], rows:[[...]]}]}"""
    src = cfg["source"]
    payload = {"page_size": 100,
               "sorts": [{"property": src["week_property"], "direction": "descending"}]}
    res = notion.request("POST", "/data_sources/%s/query" % src["data_source_id"], payload)
    pat = re.compile(src["round_pattern"])
    cands = []
    for p in res.get("results") or []:
        if p.get("archived") or p.get("in_trash"):
            continue
        title = prop_title(p.get("properties"), src["title_property"])
        m = pat.search(title)
        if not m:
            continue
        cands.append((m.group("yymmdd"), title, p))
    if not cands:
        raise ReviewError("회차를 찾지 못했다")
    pick = None
    if want_yymmdd:
        pick = next((c for c in cands if c[0] == want_yymmdd), None)
        if not pick:
            raise ReviewError("회차 %s를 찾지 못했다 (있는 회차: %s)"
                              % (want_yymmdd, ", ".join(c[0] for c in cands)))
    else:
        pick = cands[0]
    yymmdd, title, page = pick
    props = page.get("properties") or {}
    week = (props.get(src["week_property"]) or {}).get("date") or {}

    def txt(name):
        return rich_text((props.get(name) or {}).get("rich_text"))

    info = {"yymmdd": yymmdd, "title": title, "page_id": page.get("id"),
            "week_start": week.get("start") or "", "week_end": week.get("end") or "",
            "call": txt(src["call_property"]), "range_text": txt(src["range_property"]),
            "review": txt(src["review_property"]),
            "url": page_url(cfg, page.get("id"))}

    fetch = lambda bid: fetch_children(notion, bid)
    blocks = fetch(info["page_id"])
    raw = collect_section_tables(blocks, cfg, fetch)
    tables = {}
    for sec, tbs in raw.items():
        got = []
        for tb in tbs:
            rows = [r for r in fetch(tb.get("id")) if r.get("type") == "table_row"]
            cells = [[rich_text(c).strip() for c in (r.get("table_row") or {}).get("cells") or []]
                     for r in rows]
            if cells:
                got.append({"header": cells[0], "rows": cells[1:]})
        tables[sec] = got
    return info, tables


# ---------------------------------------------------------------- 초안 렌더

def render_draft(cfg, info, axes, run_date, coverage):
    t, V = cfg["text"], cfg["verdicts"]
    L = [t["marker_open"].format(round=info["yymmdd"]),
         "## " + t["heading"].format(run_date=run_date),
         "", t["disclaimer"], "", coverage, ""]

    d = axes["direction"]
    L += ["### ① 방향 — %s" % d["verdict"], d["detail"]] + ["- " + f for f in d["facts"]] + [""]

    r = axes["range"]
    L += ["### ② 레인지 — %s" % r["verdict"]]
    if r["rows"]:
        L += ["- %s %0.2f~%0.2f%% → **%s** · %s" % (x["label"], x["lo"], x["hi"], x["verdict"], x["detail"])
              for x in r["rows"]]
    else:
        L += [r["detail"]]
    L += [""]

    L += ["### ③ 트리거"]
    for x in axes["triggers"]:
        L += ["- **%s** → **%s**" % (x["risk"], x["verdict"]),
              "  - 확인 조건: %s" % x["criteria"], "  - %s" % x["detail"]]
    if not axes["triggers"]:
        L += ["- " + t["no_data"]]
    L += [""]

    lv = axes["levels"]
    L += ["### ④ 실행구간 (%s)" % lv["label"]]
    if lv["rows"]:
        L += ["- %s → **%s** (%s)" % (x["band"], x["verdict"], x["detail"]) for x in lv["rows"]]
    else:
        L += ["- " + (lv["detail"] or t["no_data"])]
    L += ["", "### " + t["cause_heading"], t["cause_prompt"], "",
          t["marker_close"]]
    return "\n".join(L)


def chunk_rich_text(s, size):
    return [{"type": "text", "text": {"content": s[i:i + size]}} for i in range(0, len(s), size)] or \
           [{"type": "text", "text": {"content": ""}}]


def merge_review(existing, draft, cfg, round_id):
    """(new_text, action). 사람이 쓴 것은 덮지 않는다."""
    t = cfg["text"]
    op = t["marker_open"].format(round=round_id)
    cl = t["marker_close"]
    existing = existing or ""
    if op in existing and cl in existing:
        i, j = existing.index(op), existing.index(cl) + len(cl)
        return existing[:i] + draft + existing[j:], "replaced"
    if existing.strip():
        return existing, "skipped_human"
    return draft, "created"


def assert_review_safe(props, cfg):
    src = cfg["source"]
    extra = [k for k in props if k not in set(src["write_properties"])]
    if extra:
        raise ReviewError("자동화가 쓸 수 없는 속성이 payload에 있다: %s" % ", ".join(extra))
    hit = [k for k in props if k in set(src.get("_never_write") or [])]
    if hit:
        raise ReviewError("디렉터 영역 속성이 payload에 있다: %s" % ", ".join(hit))
    return props


def run_date_kst(cfg):
    off = timedelta(hours=cfg["notion"].get("timezone_offset_hours", 9))
    return (datetime.now(timezone.utc) + off).date().isoformat()


# ---------------------------------------------------------------- 본체

def build_review(cfg, info, tables, reader, run_date):
    src, mkt, t = cfg["source"], cfg["market"], cfg["text"]
    start, end = info["week_start"], info["week_end"]
    if not start or not end:
        raise ReviewError("회차 `%s` 속성에 주간 범위가 없다" % src["week_property"])

    # 트리거 표 / 구간 표
    tc, lc = cfg["axes"]["triggers"], cfg["axes"]["levels"]
    trig_rows, level_cells, level_header = [], [], ""
    secs = tables.get(tc["section_number"]) or []
    if secs:
        tb = secs[tc["table_index"]] if abs(tc["table_index"]) <= len(secs) else None
        if tb:
            cols = tc["columns"]
            norm = lambda s: re.sub(r"\s+", "", s)
            if [norm(h) for h in tb["header"]] == [norm(h) for h in tc["expected_headers"]]:
                for row in tb["rows"]:
                    g = lambda k: row[cols[k]] if cols[k] < len(row) else ""
                    if g("risk") and g("criteria"):
                        trig_rows.append({"risk": g("risk"), "criteria": g("criteria")})
    lsecs = tables.get(lc["section_number"]) or []
    if lsecs and abs(lc["table_index"]) <= len(lsecs):
        tb = lsecs[lc["table_index"]]
        if tb["header"] and tb["header"][0].startswith(lc["expected_header_prefix"]):
            level_header = tb["header"][0]
            level_cells = [r[0] for r in tb["rows"] if r]

    # 필요한 계열만 조회한다
    labels = {mkt["primary_maturity"]}
    labels |= {lab for lab, _, _ in parse_ranges(info["range_text"], cfg)}
    symbols = set()
    for r in trig_rows:
        m = match_mapping(cfg, r["risk"], r["criteria"])
        if m:
            symbols.add(m["series"])

    yields = load_yields(reader, cfg, sorted(labels), start, end)
    series = load_series(reader, cfg, sorted(symbols), start, end) if symbols else {}

    prim = yields.get(mkt["primary_maturity"]) or {}
    days = sorted(prim)
    coverage = t["coverage_note"].format(days=len(days), first=days[0] if days else "-",
                                         last=days[-1] if days else "-",
                                         source=mkt["source_label"], run_date=run_date)
    if days and date.fromisoformat(days[-1]) < date.fromisoformat(end):
        coverage += "\n\n" + t["partial_week_note"].format(days=len(days))

    axes = {
        "direction": axis_direction(cfg, info["call"], yields, mkt["primary_maturity"]),
        "range": axis_range(cfg, info["range_text"], yields),
        "triggers": axis_triggers(cfg, trig_rows, series) if tc["enabled"] else [],
        "levels": axis_levels(cfg, level_cells, level_header, yields) if lc["enabled"] else
                  {"label": mkt["primary_maturity"], "rows": [], "verdict": "", "detail": ""},
    }
    return axes, coverage


def main(argv=None):
    ap = argparse.ArgumentParser(description="주간 복기 초안 생성")
    ap.add_argument("--config", default=CONFIG_PATH)
    ap.add_argument("--round", dest="round_yymmdd", default=None)
    ap.add_argument("--round-json", default=None, help="노션 대신 회차 픽스처로 초안을 만든다(검증용)")
    ap.add_argument("--dry-run", action="store_true", help="노션에 쓰지 않는다")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--out", default=None)
    args = ap.parse_args(argv)

    cfg = load_config(args.config)
    validate_config(cfg, args.config)
    if args.selftest:
        return selftest(cfg)
    if not cfg.get("enabled"):
        print("[review] config.enabled=false — 아무것도 하지 않는다")
        return 0

    run_date = run_date_kst(cfg)
    reader = MarketReader(cfg)
    print("[review] 시장데이터 자격 출처: %s" % reader.source)

    notion = None
    if args.round_json:
        fx = json.load(open(args.round_json, encoding="utf-8"))
        info, tables = fx["info"], {int(k): v for k, v in fx["tables"].items()}
        print("[review] 픽스처 모드: %s" % args.round_json)
    else:
        notion = Notion(token_from_env(), cfg["notion"]["api_version"])
        info, tables = read_round(notion, cfg, args.round_yymmdd)

    print("[review] 회차 %s (%s) · 주간 %s~%s"
          % (info["yymmdd"], info["title"], info["week_start"], info["week_end"]))

    axes, coverage = build_review(cfg, info, tables, reader, run_date)
    draft = render_draft(cfg, info, axes, run_date, coverage)
    print("\n" + draft + "\n")

    new_text, action = merge_review(info.get("review"), draft, cfg, info["yymmdd"])
    if action == "skipped_human":
        print("[review] %s" % cfg["text"]["human_written_skip"])
    elif args.dry_run or notion is None:
        assert_review_safe({cfg["source"]["review_property"]: {}}, cfg)  # 안전장치는 항상 태운다
        print("[review] dry-run — 기입하지 않음 (예정 동작: %s)" % action)
    else:
        props = assert_review_safe({cfg["source"]["review_property"]: {
            "rich_text": chunk_rich_text(new_text, cfg["notion"]["rich_text_chunk"])}}, cfg)
        notion.request("PATCH", "/pages/%s" % info["page_id"], {"properties": props})
        print("[review] 기입 완료 (%s)" % action)

    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump({"round": info["yymmdd"], "action": action, "draft": draft,
                       "axes": axes, "run_date": run_date}, fh, ensure_ascii=False, indent=2)
    return 0


# ---------------------------------------------------------------- 셀프테스트

def selftest(cfg):
    fails = []

    def check(name, got, want):
        if got != want:
            fails.append("%s: got=%r want=%r" % (name, got, want))

    V = cfg["verdicts"]
    # 레인지 원문 파싱 — 260803 실제 원문
    rs = parse_ranges("국고 3년 3.70~3.90% / 국고 10년 4.20~4.45%", cfg)
    check("레인지 2건", rs, [("국고채 3년", 3.70, 3.90), ("국고채 10년", 4.20, 4.45)])

    # 방향 — 양방향 어휘 혼재면 판정하지 않는다
    check("혼재 → 판정 안 함", classify_call("강세 지속이나 약세 전환 경계", cfg["axes"]["direction"])[0], None)
    check("강세만 → 하락", classify_call("강세 연장 전망", cfg["axes"]["direction"])[0], "하락")
    check("약세만 → 상승", classify_call("약세 재개", cfg["axes"]["direction"])[0], "상승")

    ser = {"국고채 3년": {"2026-08-03": 3.742, "2026-08-07": 3.700}}
    d = axis_direction(cfg, "강세 연장 전망", ser, "국고채 3년")
    check("방향 부합", d["verdict"], V["match"])
    d2 = axis_direction(cfg, "약세 재개", ser, "국고채 3년")
    check("방향 이탈", d2["verdict"], V["miss"])
    d3 = axis_direction(cfg, "", ser, "국고채 3년")
    check("콜 없음 → 확인 불가", d3["verdict"], V["unknown"])
    check("확인 불가여도 사실은 제시", len(d3["facts"]), 1)

    # 레인지 이탈 계산
    r = axis_range(cfg, "국고 3년 3.75~3.90%", {"국고채 3년": {
        "2026-08-03": 3.742, "2026-08-04": 3.80, "2026-08-05": 3.95}}, )
    check("레인지 이탈 판정", r["verdict"], V["miss"])
    check("이탈 상하단 모두 기록", "하단" in r["rows"][0]["detail"] and "상단" in r["rows"][0]["detail"], True)

    # 트리거 — 매핑 없는 것은 반드시 확인 불가
    rows = [{"risk": "7월 CPI 상방 서프라이즈", "criteria": "전월비 플러스 또는 근원 전월비 +0.2% 초과"},
            {"risk": "유가 재상승", "criteria": "WTI 90달러 상회 3일 이상 지속"},
            {"risk": "WGBI 수급 소멸", "criteria": "월초 외국인 현·선물 순매수 둔화"},
            {"risk": "외국인 수급 소진", "criteria": "3일 누적 순매도 전환 또는 미결제약정 감소 지속"}]
    ser2 = {"WTI": {"2026-08-05": 88.0, "2026-08-06": 91.2},
            "KTB3F_FRG": {"2026-08-05": -1000.0, "2026-08-06": -500.0, "2026-08-07": 200.0}}
    tr = axis_triggers(cfg, rows, ser2)
    check("CPI는 확인 불가", tr[0]["verdict"], cfg["axes"]["triggers"]["unmapped_verdict"])
    check("WTI 90 도달 → 발동", tr[1]["verdict"], "발동")
    # 리스크명에 '수급'이 있어도 조건이 '순매수 둔화'면 순매도 평가로 넘어가면 안 된다
    check("순매수 둔화는 확인 불가", tr[2]["verdict"], cfg["axes"]["triggers"]["unmapped_verdict"])
    check("순매도 조건은 평가", tr[3]["verdict"], "발동")

    # 실행구간
    lv = axis_levels(cfg, ["3.90% 상회", "3.80~3.90%", "3.70~3.75%"], "구간 (국고 3년)",
                     {"국고채 3년": {"a": 3.74, "b": 3.82}})
    check("도달 구간", [x["verdict"] for x in lv["rows"]], ["미도달", "도달", "도달"])

    # 멱등 — 두 번 돌려도 누적되지 않는다
    # 마커 문자열 자체에 'A'가 들어 있어 한 글자 토큰으로 비교하면 항상 참이 된다(첫 판에 걸렸다).
    draft1 = cfg["text"]["marker_open"].format(round="260803") + "\n<<OLD_BODY>>\n" + cfg["text"]["marker_close"]
    draft2 = cfg["text"]["marker_open"].format(round="260803") + "\n<<NEW_BODY>>\n" + cfg["text"]["marker_close"]
    merged, act = merge_review("", draft1, cfg, "260803")
    check("최초 생성", act, "created")
    merged2, act2 = merge_review(merged, draft2, cfg, "260803")
    check("재실행은 교체", act2, "replaced")
    check("누적되지 않음", merged2.count(cfg["text"]["marker_close"]), 1)
    check("새 내용으로 교체", "<<NEW_BODY>>" in merged2 and "<<OLD_BODY>>" not in merged2, True)
    _, act3 = merge_review("디렉터가 손으로 쓴 복기", draft1, cfg, "260803")
    check("사람 글은 덮지 않음", act3, "skipped_human")

    # 안전장치
    try:
        assert_review_safe({"상태": {}}, cfg)
        fails.append("안전장치: '상태'를 막지 못했다")
    except ReviewError:
        pass
    try:
        assert_review_safe({"핵심 콜": {}}, cfg)
        fails.append("안전장치: '핵심 콜'을 막지 못했다")
    except ReviewError:
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
    except (ReviewError, NotionError) as exc:
        print("[review] 실패: %s" % exc, file=sys.stderr)
        sys.exit(1)
