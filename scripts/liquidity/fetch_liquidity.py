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
  4. 직전·4주·1년 전 대비 변동을 as-of 조회로 계산한다. 전방 참조·보간 없음

함정 (Phase 0에서 실측으로 확정)
  ① 1년 전은 365일이 아니라 **364일(=52주)**. 주간계열이 같은 요일에 착지해야
     연준 H.4.1의 'Change from year ago'와 일치한다 (config.lookbacks에 기록)
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

REQUIRED_TOP = ["fred", "lookbacks", "range_window_days", "series", "derived", "notion", "body"]
REQUIRED_SERIES = ["id", "label", "expected_units", "expected_frequency", "display"]
REQUIRED_DISPLAY = ["unit", "divide_by", "decimals"]


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
    der = cfg["derived"]
    for k in ("id", "label", "minuend", "subtrahend", "multiplier", "display"):
        if k not in der:
            raise RuntimeError("config.derived에 %r가 없다" % k)
    for k in ("minuend", "subtrahend"):
        if der[k] not in ids:
            raise RuntimeError("config.derived.%s=%r가 config.series에 없다" % (k, der[k]))
    if cfg["notion"]["title_basis_series"] not in ids:
        raise RuntimeError("config.notion.title_basis_series=%r가 config.series에 없다"
                           % cfg["notion"]["title_basis_series"])
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
        "order": [s["id"] for s in cfg["series"]] + [cfg["derived"]["id"]],
    }
    for s in cfg["series"]:
        result["series"][s["id"]] = {
            "label": s["label"], "display": s["display"], "note": s.get("note", ""),
            "meta": meta[s["id"]], **summarize(data[s["id"]], cfg),
        }
    der = cfg["derived"]
    spread = build_derived(data, der)
    result["series"][der["id"]] = {
        "label": der["label"], "display": der["display"], "note": der.get("note", ""),
        "meta": {"units": der["display"]["unit"], "frequency": "Daily",
                 "description": "%s - %s, 두 시리즈 공통 관측일에서만 계산"
                                % (der["minuend"], der["subtrahend"]),
                 "data_updated": ""},
        **summarize(spread, cfg),
    }
    basis = cfg["notion"]["title_basis_series"]
    result["basis_series"] = basis
    result["basis_date"] = result["series"][basis].get("latest_date")
    return result


def print_table(result, cfg):
    if result["mismatches"]:
        print("!! 교차검증 불일치 — 값을 신뢰하지 말 것:", file=sys.stderr)
        for m in result["mismatches"]:
            print("   ", m, file=sys.stderr)
    print("수집: %s / 기준(%s 최신 관측일): %s"
          % (result["generated_at_kst"], result["basis_series"], result["basis_date"]))
    for sid in result["order"]:
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
