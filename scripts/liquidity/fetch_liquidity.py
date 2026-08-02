#!/usr/bin/env python3
"""유동성 워치 — FRED 공개 CSV 수집·집계.

Phase 0 시드(team-soyoung/scripts/fetch_liquidity_seed.py)를 econ-cockpit으로 이식한 것.
시드와 달리 시리즈 정의·표시명·단위·비교기준을 코드가 아니라 scripts/liquidity/config.json
한 곳에서만 읽는다(하드코딩 분산 금지).

무엇을 하나
  1. config.series의 FRED 시리즈를 fredgraph.csv로 받는다. API 키 불필요
  2. 같은 시리즈를 fredgraph.xls(별도 엔드포인트)로 한 번 더 받아 최근 N개 관측치를 대조한다
  3. FRED 메타의 단위·주기 문자열을 config의 expected 값과 대조한다
     (원자료 단위가 백만↔십억으로 바뀌면 1,000배 오차가 조용히 난다 — 여기서 잡는다)
  4. 1주·4주·13주·52주 전 대비 변동을 as-of 조회로 계산한다. 전방 참조·보간 없음
  5. **요인 분해(v2)**: Δ지준 ≈ Δ연준 신용자산 − ΔTGA − Δ역RP − Δ유통통화 − Δ기타.
     H.4.1 주간평균 계열로 계산하고 **항등식 잔차를 3차 교차검증으로 쓴다** →
     result["factors"]. '기타'는 잔차 흡수 항목이 아니라 실제 FRED 계열의 합이고,
     잔차는 별도 항목으로 값을 그대로 남긴다(은폐 금지)
  6. **헤드라인 기계 판정(v2)**: 지준 주간 증감의 부호·임계로 공급/흡수/중립을 분류하고
     주도 요인을 요인 분해에서 |Δ| 최대 항목으로 고른다 → result["headline"].
     시장 함의·금리 방향은 담지 않는다(규칙 문장도 config에 있다)
  7. 부록으로 미 국채 입찰 결과(TreasuryDirect)를 붙인다 → result["auctions"].
     **격리돼 있다** — 입찰 수집이 실패해도 위 1~6은 그대로 나가고 부록만 'failed'로 남는다.
     입찰은 단일 원천이라 교차검증이 불가능해 스키마 엄격 검증으로 갈음한다(fetch_auctions.py)

함정 (Phase 0에서 실측으로 확정)
  ① 52주 전은 365일이 아니라 **364일(=52주)**. 주간계열이 같은 요일에 착지해야
     연준 H.4.1의 'Change from year ago'와 일치한다. 13주도 90일이 아니라 91일
     (같은 정렬 원칙) — config.lookbacks에 기록
  ①-b **시점 정의가 두 가지 섞여 있다.** WRESBAL·WTREGEN·WCURCIR은 수요일 마감 주평균,
     WALCL·TREAST·WSHOMCB·WLCFLL은 수요일 잔액이다. 요인 분해는 **주평균 계열로만**
     구성했다 — 잔액 계열을 섞으면 항등식이 닫히지 않는다(2026-08-02 실측)
  ② WRESBAL·WTREGEN은 **주 평균이지 잔액이 아니다**. 일간 계열과 직접 가감 금지
     (계산하지 않고, 노션 본문 '데이터 주의'에 매번 명시한다)
  ③ FRED는 **브라우저 UA 위장 요청을 끊는다**(HTTP/2 INTERNAL_ERROR·403 실측).
     curl 기본 UA를 그대로 쓴다. _get()에 User-Agent 헤더를 추가하지 말 것

값 추정·보간 없음. FRED 결측('.')은 버리고 채우지 않는다.

사용
    python3 scripts/liquidity/fetch_liquidity.py            # 사람이 읽는 표
    python3 scripts/liquidity/fetch_liquidity.py --json     # 계산 결과 JSON(post_briefing 입력)
    python3 scripts/liquidity/fetch_liquidity.py --json --out snapshot.json
    python3 scripts/liquidity/fetch_liquidity.py --cache-dir ./fred_cache   # 원문 보관(재현용)

의존: 표준 라이브러리 + curl. pip install 없음.
종료 코드: 0=수집 성공(교차검증 불일치가 있어도 0 — 불일치는 mismatches에 담아 하류가 판단한다)
           1=수집 실패(네트워크·설정)
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import subprocess
import sys
import zipfile
from datetime import date, datetime, timedelta, timezone
from urllib.error import URLError
from urllib.request import Request, urlopen

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CONFIG = os.path.join(HERE, "config.json")

_MEM: dict[str, bytes] = {}


# ---------------------------------------------------------------- 설정

REQUIRED_TOP = ["fred", "treasurydirect", "lookbacks", "range_window_days", "series",
                "derived", "headline", "signal_board", "factors", "charts", "notion", "body"]
REQUIRED_SERIES = ["id", "label", "gloss", "expected_units", "expected_frequency", "display"]
REQUIRED_DISPLAY = ["unit", "divide_by", "decimals"]
REQUIRED_DERIVED = ["id", "label", "gloss", "minuend", "subtrahend", "multiplier", "display"]


def load_config(path=None):
    path = path or os.environ.get("LIQUIDITY_CONFIG") or DEFAULT_CONFIG
    with open(path, "r", encoding="utf-8") as fh:
        cfg = json.load(fh)
    validate_config(cfg, path)
    return cfg


def validate_config(cfg, path="<config>"):
    """깨진 설정으로 수집을 시작하는 것이 가장 위험하다. 여기서 먼저 터뜨린다."""
    missing = [k for k in REQUIRED_TOP if k not in cfg]
    if missing:
        raise RuntimeError("설정 누락: %s (%s)" % (", ".join(missing), path))
    if not cfg["series"]:
        raise RuntimeError("config.series가 비었다 — 수집할 시리즈가 없다 (%s)" % path)
    ids = set()
    for s in cfg["series"]:
        gone = [k for k in REQUIRED_SERIES if k not in s]
        if gone:
            raise RuntimeError("config.series[%s]에 %s가 없다" % (s.get("id", "?"), ", ".join(gone)))
        if s["id"] in ids:
            raise RuntimeError("config.series에 id가 중복된다: %r" % s["id"])
        ids.add(s["id"])
        for k in REQUIRED_DISPLAY:
            if k not in s["display"]:
                raise RuntimeError("config.series[%s].display에 %r가 없다" % (s["id"], k))
        if not s["display"]["divide_by"]:
            raise RuntimeError("config.series[%s].display.divide_by는 0이 될 수 없다" % s["id"])
    keys = [lb["key"] for lb in cfg["lookbacks"]]
    if keys[0] != "prev" or cfg["lookbacks"][0]["days"] is not None:
        raise RuntimeError("config.lookbacks의 첫 항목은 days=null인 'prev'여야 한다 (%s)" % path)
    for lb in cfg["lookbacks"][1:]:
        if not isinstance(lb["days"], int) or lb["days"] <= 0:
            raise RuntimeError("config.lookbacks[%s].days는 양의 정수여야 한다: %r"
                               % (lb["key"], lb["days"]))
    if not isinstance(cfg["derived"], list) or not cfg["derived"]:
        raise RuntimeError("config.derived는 비어 있지 않은 리스트여야 한다 (v2에서 단일 객체 → 리스트로 바뀌었다)")
    derived_ids = set()
    for der in cfg["derived"]:
        for k in REQUIRED_DERIVED:
            if k not in der:
                raise RuntimeError("config.derived[%s]에 %r가 없다" % (der.get("id", "?"), k))
        if der["id"] in ids or der["id"] in derived_ids:
            raise RuntimeError("config.derived에 id가 중복된다: %r" % der["id"])
        derived_ids.add(der["id"])
        for k in ("minuend", "subtrahend"):
            if der[k] not in ids:
                raise RuntimeError("config.derived[%s].%s=%r가 config.series에 없다"
                                   % (der["id"], k, der[k]))
    if cfg["notion"]["title_basis_series"] not in ids:
        raise RuntimeError("config.notion.title_basis_series=%r가 config.series에 없다"
                           % cfg["notion"]["title_basis_series"])

    # 표 헤더와 lookback 개수가 어긋나면 열이 밀린다. 조용히 밀리는 대신 여기서 터뜨린다.
    want_cols = 4 + len(cfg["lookbacks"])
    got_cols = len(cfg["body"]["table_headers"])
    if got_cols != want_cols:
        raise RuntimeError("config.body.table_headers가 %d열인데 lookbacks %d개면 %d열이어야 한다"
                           % (got_cols, len(cfg["lookbacks"]), want_cols))

    lb_keys = {lb["key"] for lb in cfg["lookbacks"]}
    validate_factors(cfg, ids, lb_keys, path)
    validate_headline(cfg, ids, lb_keys, path)
    validate_signal_board(cfg, ids | derived_ids, path)
    validate_charts(cfg, ids | derived_ids, path)
    return cfg


def validate_factors(cfg, ids, lb_keys, path="<config>"):
    """요인 분해 설정. **구성 계열이 실재하는지**와 부호가 ±1인지 강제한다."""
    fc = cfg["factors"]
    for k in ("heading", "target", "lookback", "divide_by", "decimals", "items",
              "residual_threshold", "history_weeks", "claim_format", "headers"):
        if k not in fc:
            raise RuntimeError("config.factors에 %r가 없다 (%s)" % (k, path))
    if fc["target"] not in ids:
        raise RuntimeError("config.factors.target=%r가 config.series에 없다" % fc["target"])
    if fc["lookback"] not in lb_keys:
        raise RuntimeError("config.factors.lookback=%r가 config.lookbacks에 없다" % fc["lookback"])
    if not fc["items"]:
        raise RuntimeError("config.factors.items가 비었다 — 분해할 요인이 없다")
    seen = set()
    for it in fc["items"]:
        for k in ("key", "label", "components", "sign_kind", "gloss"):
            if k not in it:
                raise RuntimeError("config.factors.items[%s]에 %r가 없다" % (it.get("key", "?"), k))
        if it["key"] in seen:
            raise RuntimeError("config.factors.items에 key가 중복된다: %r" % it["key"])
        seen.add(it["key"])
        if it["sign_kind"] not in fc.get("sign_kinds", {}):
            raise RuntimeError("config.factors.items[%s].sign_kind=%r가 sign_kinds에 없다"
                               % (it["key"], it["sign_kind"]))
        if not it["components"]:
            raise RuntimeError("config.factors.items[%s].components가 비었다" % it["key"])
        for c in it["components"]:
            if c.get("id") not in ids:
                raise RuntimeError("config.factors.items[%s]의 계열 %r이 config.series에 없다 "
                                   "— 요인은 실제 계열이어야 한다(잔차 흡수 금지)"
                                   % (it["key"], c.get("id")))
            if c.get("sign") not in (1, -1):
                raise RuntimeError("config.factors.items[%s].components[%s].sign은 1 또는 -1이어야 한다: %r"
                                   % (it["key"], c.get("id"), c.get("sign")))
    return cfg


def validate_headline(cfg, ids, lb_keys, path="<config>"):
    h = cfg["headline"]
    for k in ("series", "lookback", "divide_by", "decimals", "neutral_threshold",
              "verdicts", "format", "rule_line", "unavailable"):
        if k not in h:
            raise RuntimeError("config.headline에 %r가 없다 (%s)" % (k, path))
    if h["series"] not in ids:
        raise RuntimeError("config.headline.series=%r가 config.series에 없다" % h["series"])
    if h["lookback"] not in lb_keys:
        raise RuntimeError("config.headline.lookback=%r가 config.lookbacks에 없다" % h["lookback"])
    for k in ("supply", "absorb", "neutral"):
        if k not in h["verdicts"]:
            raise RuntimeError("config.headline.verdicts에 %r가 없다" % k)
    if h["neutral_threshold"] < 0:
        raise RuntimeError("config.headline.neutral_threshold는 음수가 될 수 없다: %r"
                           % h["neutral_threshold"])
    return cfg


def validate_signal_board(cfg, all_ids, path="<config>"):
    sb = cfg["signal_board"]
    for k in ("heading", "headers", "pending", "rows", "cautions", "claim_format"):
        if k not in sb:
            raise RuntimeError("config.signal_board에 %r가 없다 (%s)" % (k, path))
    if not sb["rows"]:
        raise RuntimeError("config.signal_board.rows가 비었다")
    for r in sb["rows"]:
        if r.get("id") not in all_ids:
            raise RuntimeError("config.signal_board.rows의 %r가 series에도 derived에도 없다"
                               % r.get("id"))
        if not r.get("read_rule"):
            raise RuntimeError("config.signal_board.rows[%s].read_rule이 비었다" % r["id"])
    return cfg


def validate_charts(cfg, all_ids, path="<config>"):
    """차트는 실패해도 본문을 막지 않지만, **설정 오타는 여기서 잡는다**(런타임에 조용히 죽지 않게)."""
    ch = cfg["charts"]
    for k in ("enabled", "items", "dpi", "figsize", "failure_format", "caption_format"):
        if k not in ch:
            raise RuntimeError("config.charts에 %r가 없다 (%s)" % (k, path))
    factor_keys = {it["key"] for it in cfg["factors"]["items"]}
    for it in ch["items"]:
        for k in ("key", "kind", "title_en", "ylabel_en", "claim", "note"):
            if k not in it:
                raise RuntimeError("config.charts.items[%s]에 %r가 없다" % (it.get("key", "?"), k))
        if it["kind"] == "levels":
            for s in it["series"]:
                if s["id"] not in all_ids:
                    raise RuntimeError("charts[%s]의 계열 %r이 없다" % (it["key"], s["id"]))
        elif it["kind"] == "spread":
            if it.get("id") not in all_ids:
                raise RuntimeError("charts[%s].id=%r가 없다" % (it["key"], it.get("id")))
        elif it["kind"] == "factor_stack":
            missing = (factor_keys | {"residual", "target"}) - set(it.get("labels_en") or {})
            if missing:
                raise RuntimeError("charts[%s].labels_en에 %s가 없다 — 범례가 비면 그림이 읽히지 않는다"
                                   % (it["key"], ", ".join(sorted(missing))))
        elif it["kind"] != "auction_btc":
            raise RuntimeError("charts[%s].kind를 모른다: %r" % (it["key"], it["kind"]))
    return cfg


# ---------------------------------------------------------------- 수집

def _get(url: str, fcfg: dict, cache_dir: str | None) -> bytes:
    """urllib 탐침 → curl 폴백.

    **User-Agent를 붙이지 않는다.** FRED는 브라우저 UA를 위장한 요청을 끊는다
    (HTTP/2 INTERNAL_ERROR·403, 2026-07-31 실측). curl 기본 UA만 통과한다.
    urllib 경로는 FRED_USE_URLLIB=1일 때만 짧게 시도하고 실패하면 즉시 curl로 넘긴다
    (이 맥 세션에서 urllib이 타임아웃한 실측이 있어 기본은 curl이다).
    """
    if url in _MEM:
        return _MEM[url]
    body = None
    if os.environ.get("FRED_USE_URLLIB") == "1":
        try:
            with urlopen(Request(url), timeout=8) as r:
                body = r.read()
        except (URLError, TimeoutError, OSError):
            body = None
    if body is None:
        p = subprocess.run(
            ["curl", "-sS", "--fail", "--retry", str(fcfg["retries"]), "--retry-delay", "2",
             "--max-time", str(fcfg["timeout_seconds"]), url],
            capture_output=True,
        )
        if p.returncode != 0:
            raise RuntimeError("수집 실패 %s: %s" % (url, p.stderr.decode(errors="replace")))
        body = p.stdout
    if cache_dir:  # 원문 보관은 옵션이다(CI에서는 의미가 없어 기본 꺼짐)
        os.makedirs(cache_dir, exist_ok=True)
        fname = re.sub(r"[^A-Za-z0-9._-]", "_", url.split("/")[-1])
        with open(os.path.join(cache_dir, fname), "wb") as f:
            f.write(body)
    _MEM[url] = body
    return body


def fetch_csv(sid, fcfg, cache_dir):
    """FRED CSV → [(관측일, 값)]. 결측('.')은 버린다(보간하지 않는다)."""
    raw = _get(fcfg["csv_url"].format(sid=sid), fcfg, cache_dir).decode("utf-8-sig")
    rows = list(csv.reader(io.StringIO(raw)))
    if not rows or len(rows[0]) < 2:
        raise ValueError("%s: 예상치 못한 CSV 헤더 %r" % (sid, rows[0] if rows else None))
    out = []
    for r in rows[1:]:
        if len(r) < 2 or r[1].strip() in {".", "", "NA"}:
            continue
        out.append((datetime.strptime(r[0].strip(), "%Y-%m-%d").date(), float(r[1])))
    out.sort(key=lambda x: x[0])
    if not out:
        raise ValueError("%s: 유효 관측치가 0건이다" % sid)
    return out


def fetch_meta(sid, fcfg, cache_dir):
    """fredgraph.xls(=xlsx)의 sharedStrings에서 단위·주기·최종갱신을 읽는다.

    /series/ 페이지는 FRED가 막아서(403 실측) 쓸 수 없다. xls는 열어준다.
    """
    z = zipfile.ZipFile(io.BytesIO(_get(fcfg["xls_url"].format(sid=sid), fcfg, cache_dir)))
    shared = re.findall(r"<t[^>]*>(.*?)</t>", z.read("xl/sharedStrings.xml").decode("utf-8"), re.S)
    desc = next((s for s in shared if not s.startswith(sid) and "," in s and
                 any(k in s for k in ("Daily", "Weekly", "Monthly"))), "")
    updated = next((s for s in shared if s.startswith("Data Updated:")), "")
    parts = [p.strip() for p in desc.split(",")]
    return {
        "description": desc,
        "units": parts[-3] if len(parts) >= 3 else "",
        "frequency": parts[-2] if len(parts) >= 2 else "",
        "sa": parts[-1] if parts else "",
        "data_updated": updated.replace("Data Updated:", "").strip(),
    }


def fetch_xls_series(sid, fcfg, cache_dir):
    """검증용: xlsx 시트에서 (관측일ISO -> 값)을 직접 재파싱. CSV와 다른 경로다."""
    z = zipfile.ZipFile(io.BytesIO(_get(fcfg["xls_url"].format(sid=sid), fcfg, cache_dir)))
    sheet = z.read("xl/worksheets/sheet2.xml").decode("utf-8")  # sheet1=메타, sheet2=관측치
    epoch = date(1899, 12, 30)  # Excel 1900 시스템
    out = {}
    for row in re.findall(r"<row[^>]*>(.*?)</row>", sheet, re.S):
        cells = re.findall(r'<c r="([A-Z]+)\d+"([^>]*)>(?:<v>(.*?)</v>)?', row)
        d = v = None
        for col, attrs, val in cells:
            if val is None or 't="s"' in attrs:  # 문자열 셀(메타 헤더)은 건너뜀
                continue
            if col == "A":
                d = epoch + timedelta(days=int(float(val)))
            elif col == "B":
                v = float(val)
        if d is not None and v is not None:
            out[d.isoformat()] = v
    return out


# ---------------------------------------------------------------- 집계

def as_of(obs, target):
    """target 이하 최신 관측치. 미래 보간·전방참조 없음."""
    cand = [o for o in obs if o[0] <= target]
    return cand[-1] if cand else None


def summarize(obs, cfg):
    """최신값 + config.lookbacks의 각 비교시점 + 최근 window 레인지."""
    if not obs:
        return {"latest": None}
    ld, lv = obs[-1]
    res = {"latest_date": ld.isoformat(), "latest": lv, "n": len(obs),
           "first_date": obs[0][0].isoformat()}
    for lb in cfg["lookbacks"]:
        if lb["days"] is None:
            ref = obs[-2] if len(obs) >= 2 else None
        else:
            ref = as_of(obs, ld - timedelta(days=lb["days"]))
        res[lb["key"]] = ({"date": ref[0].isoformat(), "value": ref[1], "delta": lv - ref[1]}
                          if ref else None)
    ref = as_of(obs, ld - timedelta(days=cfg["range_window_days"]))
    if ref:
        window = [v for d, v in obs if d >= ref[0]]
        res["range"] = {"date": ref[0].isoformat(), "value": ref[1], "delta": lv - ref[1],
                        "min": min(window), "max": max(window), "n": len(window),
                        "days": cfg["range_window_days"]}
    else:
        res["range"] = None
    return res


def build_derived(data, der):
    """파생 스프레드. 두 시리즈가 모두 관측된 날짜에서만 계산(전방 채움 없음)."""
    sub = dict(data[der["subtrahend"]])
    mul, nd = der["multiplier"], der.get("round_to", 2)
    return [(d, round((v - sub[d]) * mul, nd)) for d, v in data[der["minuend"]] if d in sub]


# ------------------------------------------------- 요인 분해 (v2)

def compute_factors(data, cfg):
    """Δ지준을 H.4.1 주간평균 요인으로 분해한다.

    설계 원칙 셋 — 어기면 숫자가 조용히 틀린다.
      ① **공통 관측일에서만** 계산한다. 한 계열이라도 그 주를 빠뜨리면 그 주는 통째로 건너뛴다
         (없는 주를 앞 값으로 메우면 변동이 0으로 위조된다)
      ② **'기타'는 실제 계열의 합이다.** 잔차를 여기에 흡수시키지 않는다
      ③ **잔차는 별도로 남긴다.** 임계를 넘어도 값을 숨기지 않고, 넘었다는 사실을 함께 싣는다
         (잔차 = 실제 Δ지준 − 요인 합. 항등식이 닫히는지가 3차 교차검증이다)

    반환: {"status": "ok", "items": [...], "residual": ..., "history": [...]} 또는
          {"status": "unavailable", "reason": ...}
    """
    fc = cfg["factors"]
    div, nd = fc["divide_by"], fc["decimals"]
    target = fc["target"]
    ids = sorted({c["id"] for it in fc["items"] for c in it["components"]} | {target})

    maps = {}
    for sid in ids:
        if sid not in data or not data[sid]:
            return {"status": "unavailable",
                    "reason": "요인 계열 %s를 수집하지 못했다" % sid, "items": [], "history": []}
        maps[sid] = dict(data[sid])
    common = sorted(set.intersection(*(set(m) for m in maps.values())))
    if len(common) < 2:
        return {"status": "unavailable",
                "reason": "요인 계열들의 공통 관측일이 %d개뿐이라 주간 변동을 만들 수 없다" % len(common),
                "items": [], "history": []}

    def week(cur, prev):
        """한 주치 분해. 값은 표시 단위(십억 달러)로 환산해 담는다."""
        out, total = [], 0.0
        for it in fc["items"]:
            comps, delta = [], 0.0
            for c in it["components"]:
                d = c["sign"] * (maps[c["id"]][cur] - maps[c["id"]][prev]) / div
                comps.append({"id": c["id"], "sign": c["sign"], "delta": round(d, nd)})
                delta += d
            total += delta
            out.append({"key": it["key"], "label": it["label"], "gloss": it["gloss"],
                        "sign_kind": it["sign_kind"], "delta": round(delta, nd),
                        "components": comps})
        tgt = (maps[target][cur] - maps[target][prev]) / div
        return {"date": cur.isoformat(), "prev_date": prev.isoformat(),
                "items": out, "sum": round(total, nd), "target_delta": round(tgt, nd),
                "residual": round(tgt - total, nd)}

    hist = [week(common[i], common[i - 1])
            for i in range(max(1, len(common) - fc["history_weeks"]), len(common))]
    last = hist[-1]
    thr = fc["residual_threshold"]
    driver = max(last["items"], key=lambda x: abs(x["delta"]))
    return {
        "status": "ok",
        "target": target, "unit": fc["unit"], "decimals": nd,
        "basis_date": last["date"], "prev_date": last["prev_date"],
        "items": last["items"], "sum": last["sum"], "target_delta": last["target_delta"],
        "residual": last["residual"],
        "residual_threshold": thr,
        "residual_ok": abs(last["residual"]) <= thr,
        "driver": {"key": driver["key"], "label": driver["label"], "delta": driver["delta"]},
        "history": hist,
        "identity_note": "잔차 = 실제 Δ지준 − 요인 합. 이 값이 임계 이내인지가 3차 교차검증이다.",
    }


def compute_headline(result, cfg):
    """구획① 기계 판정. **분류만 한다** — 시장 함의·금리 방향은 만들지 않는다."""
    h = cfg["headline"]
    ser = result["series"].get(h["series"]) or {}
    ref = ser.get(h["lookback"])
    if not ref or ref.get("delta") is None:
        return {"status": "unavailable", "text": h["unavailable"],
                "rule": h["rule_line"].format(threshold=h["neutral_threshold"],
                                              threshold_unit=h["threshold_unit"])}
    delta = ref["delta"] / h["divide_by"]
    thr = h["neutral_threshold"]
    key = "supply" if delta > thr else "absorb" if delta < -thr else "neutral"
    verdict = h["verdicts"][key]

    fac = result.get("factors") or {}
    if fac.get("status") == "ok" and fac.get("driver"):
        d = fac["driver"]
        text = h["format"].format(verdict=verdict, driver=d["label"],
                                  driver_delta="{:+,.{n}f}".format(d["delta"], n=h["decimals"]))
    else:
        text = h["format_no_driver"].format(
            verdict=verdict, reason=fac.get("reason") or "요인 분해 미산출")
    return {
        "status": "ok", "verdict_key": key, "verdict": verdict,
        "delta": round(delta, h["decimals"]),
        "basis_date": ser.get("latest_date"), "prev_date": ref.get("date"),
        "threshold": thr,
        "text": text,
        "rule": h["rule_line"].format(threshold=thr, threshold_unit=h["threshold_unit"]),
        "detail": h["detail_format"].format(
            delta="{:+,.{n}f}".format(delta, n=h["decimals"]),
            prev_date=ref.get("date"), basis_date=ser.get("latest_date")),
    }


# ---------------------------------------------------------------- 표시

def fmt(value, display, signed=False):
    """설정된 배수·자릿수로 환산해 표시 문자열을 만든다. None은 '미수집'."""
    if value is None:
        return "미수집"
    v = value / display["divide_by"]
    s = "{:+,.{d}f}" if signed else "{:,.{d}f}"
    return s.format(v, d=display["decimals"])


# ---------------------------------------------------------------- 본체

def collect(cfg, cache_dir=None):
    fcfg = cfg["fred"]
    data, meta, mismatches = {}, {}, []
    for s in cfg["series"]:
        sid = s["id"]
        data[sid] = fetch_csv(sid, fcfg, cache_dir)
        meta[sid] = fetch_meta(sid, fcfg, cache_dir)
        # ① 단위·주기 대조 — 원자료 단위가 바뀌면 표가 조용히 1,000배 틀린다
        for key, want in (("units", s["expected_units"]), ("frequency", s["expected_frequency"])):
            got = meta[sid].get(key, "")
            if got != want:
                mismatches.append("%s 메타 %s: 기대=%r 실제=%r (config.series.expected_%s 갱신 필요)"
                                  % (sid, key, want, got, key))
        # ② 값 대조 — CSV와 XLS는 서로 다른 엔드포인트다
        xls = fetch_xls_series(sid, fcfg, cache_dir)
        for d, v in data[sid][-fcfg["cross_check_last_n"]:]:
            xv = xls.get(d.isoformat())
            if xv is None or abs(xv - v) > 1e-9:
                mismatches.append("%s %s: csv=%r xls=%r" % (sid, d, v, xv))

    kst = timezone(timedelta(hours=cfg["notion"]["timezone_offset_hours"]))
    now = datetime.now(timezone.utc)
    result = {
        "generated_at_utc": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "generated_at_kst": now.astimezone(kst).strftime("%Y-%m-%d %H:%M KST"),
        "source": cfg["fred"]["source_label"],
        "source_url": cfg["fred"]["source_url"],
        "cross_check": {
            "method": "fredgraph.csv(값) ↔ fredgraph.xls(별도 엔드포인트) 재파싱 + FRED 메타 단위·주기 대조",
            "series_checked": len(cfg["series"]),
            "observations_compared": len(cfg["series"]) * fcfg["cross_check_last_n"],
            "mismatch_count": len(mismatches),
        },
        "lookbacks": cfg["lookbacks"],
        "mismatches": mismatches,
        "series": {},
        "order": [s["id"] for s in cfg["series"]] + [d["id"] for d in cfg["derived"]],
        # in_table=false인 요인 전용 계열은 잔액 표에서 뺀다(표가 20행이 되면 읽히지 않는다).
        "table_order": [s["id"] for s in cfg["series"] if s.get("in_table", True)]
                       + [d["id"] for d in cfg["derived"]],
    }
    for s in cfg["series"]:
        result["series"][s["id"]] = {
            "label": s["label"], "gloss": s.get("gloss", ""), "display": s["display"],
            "note": s.get("note", ""), "in_table": s.get("in_table", True),
            "meta": meta[s["id"]], **summarize(data[s["id"]], cfg),
        }
    for der in cfg["derived"]:
        spread = build_derived(data, der)
        data[der["id"]] = spread  # 차트가 파생 계열도 그린다
        result["series"][der["id"]] = {
            "label": der["label"], "gloss": der.get("gloss", ""), "display": der["display"],
            "note": der.get("note", ""), "in_table": True,
            "meta": {"units": der["display"]["unit"], "frequency": "Daily",
                     "description": "%s - %s, 두 시리즈 공통 관측일에서만 계산"
                                    % (der["minuend"], der["subtrahend"]),
                     "data_updated": ""},
            **summarize(spread, cfg),
        }
    basis = cfg["notion"]["title_basis_series"]
    result["basis_series"] = basis
    result["basis_date"] = result["series"][basis].get("latest_date")

    # 요인 분해 → 헤드라인 순서다(헤드라인의 '주도 요인'이 분해 결과를 참조한다).
    result["factors"] = compute_factors(data, cfg)
    result["headline"] = compute_headline(result, cfg)

    # 차트 원자료: 노션 적재 단계(post_briefing)가 그림을 그릴 수 있게 관측치를 실어 보낸다.
    # 여기서 그리지 않는 이유 — matplotlib을 수집 경로에 끌어들이면 라이브러리가 없는 환경에서
    # 표까지 못 만든다. 수집은 표준 라이브러리만으로 끝난다.
    # **필요한 기간만 잘라 담는다.** 전체 이력(일간 6,500관측 × 20계열)을 실으면 스냅샷이
    # 수 MB로 불어나 아티팩트·로그가 무거워진다. 자르는 기준은 차트 설정에서 파생한다.
    span = max([int(round(it.get("years", 0) * 366)) for it in cfg["charts"]["items"]] + [0])
    cutoff = date.today() - timedelta(days=span + 30) if span else None
    result["observations_window_days"] = span
    result["observations"] = {
        sid: [[d.isoformat(), v] for d, v in obs if cutoff is None or d >= cutoff]
        for sid, obs in data.items()}

    # 부록: 미 국채 입찰 결과(TreasuryDirect).
    # **격리한다** — 입찰 수집이 실패해도 위 FRED 본체는 그대로 나간다.
    # 부록이 본체를 인질로 잡지 않는다. 대신 조용히 비우지도 않는다:
    # 실패 사실을 auctions.status='failed'로 남겨 본문에 문장으로 찍히게 한다.
    # 스키마 검증에서 제외한 행도 mismatches에는 넣지 않는다 —
    # mismatches는 'FRED 값을 싣지 말라'는 신호라 입찰 결측이 본체를 데이터 이상으로 만들면 안 된다.
    from fetch_auctions import (collect_auction_history, collect_auctions,  # 지연 로드
                                failed_auctions)
    try:
        result["auctions"] = collect_auctions(cfg, cache_dir)
    except Exception as exc:  # noqa: BLE001 — 어떤 실패도 본체를 죽이지 않는다
        result["auctions"] = failed_auctions(cfg, exc)
        print("입찰 부록 수집 실패(본체는 계속): %s" % exc, file=sys.stderr)

    # 차트④ 전용 장기 이력. 이것 역시 격리한다 — 실패하면 차트 한 장만 빠진다.
    try:
        result["auction_history"] = collect_auction_history(cfg, cache_dir)
    except Exception as exc:  # noqa: BLE001
        result["auction_history"] = {"status": "failed", "error": str(exc)[:400], "rows": []}
        print("입찰 이력(차트용) 수집 실패(본체는 계속): %s" % exc, file=sys.stderr)
    return result


def print_table(result, cfg):
    if result["mismatches"]:
        print("!! 교차검증 불일치 — 값을 신뢰하지 말 것:", file=sys.stderr)
        for m in result["mismatches"]:
            print("   ", m, file=sys.stderr)
    print("수집: %s / 기준(%s 최신 관측일): %s"
          % (result["generated_at_kst"], result["basis_series"], result["basis_date"]))

    h = result.get("headline") or {}
    if h:
        print("\n=== %s ===" % h.get("text", "-"))
        print("  %s" % h.get("rule", ""))
        if h.get("detail"):
            print("  %s" % h["detail"])

    f = result.get("factors") or {}
    if f.get("status") == "ok":
        print("\n[요인 분해] %s → %s (%s)" % (f["prev_date"], f["basis_date"], f["unit"]))
        for it in f["items"]:
            print("  %-16s %+8.1f   [%s]" % (
                it["label"], it["delta"],
                ", ".join("%s%s" % (c["id"], "+" if c["sign"] > 0 else "-")
                          for c in it["components"])))
        print("  %-16s %+8.1f" % ("요인 합", f["sum"]))
        print("  %-16s %+8.1f" % ("실제 Δ지준", f["target_delta"]))
        print("  %-16s %+8.2f  (임계 ±%.1f, %s)" % (
            "항등식 잔차", f["residual"], f["residual_threshold"],
            "이내" if f["residual_ok"] else "!! 초과 — 분해 검증 실패"))
    elif f:
        print("\n[요인 분해] 산출 불가 — %s" % f.get("reason"))

    for sid in result["table_order"]:
        r = result["series"][sid]
        if r.get("latest") is None:
            print("%s: 미수집" % sid)
            continue
        d = r["display"]
        print("\n[%s] %s — %s (FRED 단위 %s, %s)"
              % (sid, r["label"], d["unit"], r["meta"].get("units"), r["meta"].get("frequency")))
        print("  최신 %s (%s)" % (fmt(r["latest"], d), r["latest_date"]))
        for lb in cfg["lookbacks"]:
            x = r.get(lb["key"])
            print("  %s: %s" % (lb["label"], "미수집" if not x else
                  "%s (%s) → %s" % (fmt(x["value"], d), x["date"], fmt(x["delta"], d, True))))
        rg = r.get("range")
        if rg:
            print("  최근 %d일 레인지: %s ~ %s (%d관측, 기준 %s)"
                  % (rg["days"], fmt(rg["min"], d), fmt(rg["max"], d), rg["n"], rg["date"]))
    if result.get("auctions"):
        from fetch_auctions import print_auctions  # 지연 로드
        print("\n[부록] 미 국채 입찰 — 단일 원천, 교차검증 불가")
        print_auctions(result["auctions"])


def main():
    ap = argparse.ArgumentParser(description="유동성 워치 FRED 수집")
    ap.add_argument("--json", action="store_true", help="계산 결과 JSON 출력")
    ap.add_argument("--out", help="JSON을 이 경로에 쓴다(--json 없이도 동작)")
    ap.add_argument("--cache-dir", default=os.environ.get("LIQUIDITY_CACHE_DIR") or None,
                    help="FRED 원문 보관 디렉터리(재현용). 기본은 보관하지 않음")
    ap.add_argument("--config", default=None)
    args = ap.parse_args()

    cfg = load_config(args.config)
    result = collect(cfg, args.cache_dir)

    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(result, fh, ensure_ascii=False, indent=2)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    elif not args.out:
        print_table(result, cfg)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # 실패는 조용히 넘기지 않는다
        print("수집 실패: %s" % exc, file=sys.stderr)
        sys.exit(1)
