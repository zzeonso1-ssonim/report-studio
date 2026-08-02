#!/usr/bin/env python3
"""유동성 워치 v2 — 차트 4장 생성 (matplotlib PNG).

**이 모듈은 격리돼 있다.**
  matplotlib import를 여기에만 둔다. 라이브러리가 없거나 그리기가 실패해도
  post_briefing은 표를 그대로 적재하고 차트 자리에만 사유 한 줄을 남긴다
  (config.charts.failure_format / matplotlib_missing).
  수집 경로(fetch_liquidity)는 이 파일을 아예 import하지 않는다 — 표준 라이브러리만으로 끝난다.

**그림 안 텍스트는 전부 영문이다.**
  GitHub 러너에 한글 폰트가 없어 한글을 그리면 두부(□)로 나온다.
  제목·축·범례는 config의 *_en 필드에서만 읽고, 한글 설명은 노션 본문 캡션으로 단다.
  코드에 표시 문자열을 두지 않는다(하드코딩 금지) — 색·순서까지 config에서 파생한다.

무엇을 그리나 (전부 config.charts.items에서 읽는다)
  ① levels        지준·ON RRP·TGA 수준 추이 (기본 3년)
  ② factor_stack  주간 Δ지준 요인 분해 스택 막대 + 실제 증감 점 (기본 12주)
  ③ spread        SOFR−IORB 추이 (기본 1년)
  ④ auction_btc   입찰 응찰배수 유형별 산점 (기본 10주)

사용
    python3 scripts/liquidity/charts.py --input snapshot.json --outdir ./charts
의존: matplotlib. 없으면 build_charts가 status='skipped'를 돌려준다(예외를 던지지 않는다).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date, datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fetch_liquidity import load_config  # noqa: E402


def _iso(s):
    return datetime.strptime(s[:10], "%Y-%m-%d").date()


def _obs(result, sid, years=None):
    """스냅샷의 관측치를 [(date, 표시단위 값)]로. years가 있으면 그만큼만 자른다.

    **반드시 display.divide_by로 환산한다.** observations는 FRED 원자료라 계열마다 단위가
    다르다 — WRESBAL·WTREGEN은 백만 달러, RRPONTSYD는 십억 달러다. 환산하지 않고 한 축에
    그리면 축 라벨이 'USD bn'인데 값은 백만 단위로 찍히고, 십억 단위 계열은 0선에 눌려
    보이지 않는다(2026-08-02 로컬 렌더에서 실제로 그렇게 나왔다).
    """
    raw = (result.get("observations") or {}).get(sid) or []
    div = (((result.get("series") or {}).get(sid) or {}).get("display") or {}).get("divide_by", 1)
    if not div:
        raise RuntimeError("%s: display.divide_by가 0이다 — 환산할 수 없다" % sid)
    out = [(_iso(d), float(v) / div) for d, v in raw]
    if years and out:
        cutoff = out[-1][0] - timedelta(days=int(round(years * 365.25)))
        out = [x for x in out if x[0] >= cutoff]
    return out


# ---------------------------------------------------------------- 개별 차트

def _finish(fig, ax, item, path, dpi):
    ax.set_title(item["title_en"])
    ax.set_ylabel(item["ylabel_en"])
    ax.grid(True, alpha=0.25, linewidth=0.6)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    fig.tight_layout()
    fig.savefig(path, dpi=dpi)
    return path


def chart_levels(plt, result, item, path, ch):
    fig, ax = plt.subplots(figsize=tuple(ch["figsize"]))
    drawn = 0
    for s in item["series"]:
        obs = _obs(result, s["id"], item.get("years"))
        if not obs:
            continue
        ax.plot([d for d, _ in obs], [v for _, v in obs], linewidth=1.4, label=s["label_en"])
        drawn += 1
    if not drawn:
        plt.close(fig)
        raise RuntimeError("levels: 그릴 관측치가 없다")
    ax.legend(loc="best", fontsize=8, frameon=False)
    fig.autofmt_xdate()
    return _finish(fig, ax, item, path, ch["dpi"])


def chart_factor_stack(plt, result, item, path, ch):
    """요인 기여를 쌓고, 실제 Δ지준을 점으로 겹친다.

    양(+)과 음(−)을 각각 따로 쌓는다 — 부호가 섞인 항목을 한 바닥에서 쌓으면
    막대가 서로를 잘라먹어 기여 크기가 눈으로 틀리게 읽힌다.
    """
    fac = result.get("factors") or {}
    if fac.get("status") != "ok" or not fac.get("history"):
        raise RuntimeError("factor_stack: 요인 분해가 없다 (%s)" % fac.get("reason", "사유 미상"))
    hist = fac["history"][-item["weeks"]:]
    labels = item["labels_en"]
    keys = [it["key"] for it in hist[-1]["items"]]
    x = list(range(len(hist)))

    fig, ax = plt.subplots(figsize=tuple(ch["figsize"]))
    pos = [0.0] * len(hist)
    neg = [0.0] * len(hist)
    for k in keys + ["residual"]:
        vals = [(h["residual"] if k == "residual"
                 else next(i["delta"] for i in h["items"] if i["key"] == k)) for h in hist]
        bottoms = [pos[i] if vals[i] >= 0 else neg[i] for i in range(len(hist))]
        ax.bar(x, vals, bottom=bottoms, width=0.68, label=labels[k])
        for i, v in enumerate(vals):
            if v >= 0:
                pos[i] += v
            else:
                neg[i] += v
    ax.scatter(x, [h["target_delta"] for h in hist], color="black", zorder=5, s=18,
               label=labels["target"])
    ax.axhline(0, color="black", linewidth=0.8)
    ax.set_xticks(x)
    ax.set_xticklabels([h["date"][5:] for h in hist], rotation=45, ha="right", fontsize=8)
    ax.legend(loc="best", fontsize=7, ncol=3, frameon=False)
    return _finish(fig, ax, item, path, ch["dpi"])


def chart_spread(plt, result, item, path, ch):
    obs = _obs(result, item["id"], item.get("years"))
    if not obs:
        raise RuntimeError("spread: %s 관측치가 없다" % item["id"])
    fig, ax = plt.subplots(figsize=tuple(ch["figsize"]))
    ax.plot([d for d, _ in obs], [v for _, v in obs], linewidth=1.3)
    if item.get("zero_line"):
        ax.axhline(0, color="black", linewidth=0.9, linestyle="--", alpha=0.7)
    fig.autofmt_xdate()
    return _finish(fig, ax, item, path, ch["dpi"])


def chart_auction_btc(plt, result, item, path, ch, cfg):
    """입찰 응찰배수. 유형별로 나눠 그린다 — 유형 간 수준대가 달라 한 선으로 묶으면 안 된다."""
    hist = (result.get("auction_history") or {})
    rows = hist.get("rows") or []
    if not rows:
        raise RuntimeError("auction_btc: 입찰 이력이 없다 (%s)"
                           % (hist.get("error") or hist.get("status") or "미수집"))
    cutoff = max(_iso(r["auction_date"]) for r in rows) - timedelta(weeks=item["weeks"])
    rows = [r for r in rows if _iso(r["auction_date"]) >= cutoff]
    if not rows:
        raise RuntimeError("auction_btc: 최근 %d주 입찰이 0건이다" % item["weeks"])

    en = cfg["treasurydirect"]["type_labels_en"]
    groups = {}
    for r in rows:
        groups.setdefault(en.get(r["type"], r["type"]), []).append(r)

    fig, ax = plt.subplots(figsize=tuple(ch["figsize"]))
    for label in sorted(groups):
        g = sorted(groups[label], key=lambda r: r["auction_date"])
        ax.scatter([_iso(r["auction_date"]) for r in g], [r["btc"] for r in g],
                   s=26, alpha=0.85, label=label)
    ax.legend(loc="best", fontsize=8, frameon=False, title=None)
    fig.autofmt_xdate()
    return _finish(fig, ax, item, path, ch["dpi"])


# ---------------------------------------------------------------- 본체

BUILDERS = {"levels": chart_levels, "factor_stack": chart_factor_stack, "spread": chart_spread}


def build_charts(result, cfg, outdir):
    """차트를 만들고 [{key, path, caption, ...}]를 돌려준다.

    **개별 차트의 실패가 다른 차트를 죽이지 않는다.** 실패한 항목은 status='failed'로
    사유를 달고 남는다 — 조용히 사라지지 않게. matplotlib 자체가 없으면 전체를
    status='skipped'로 돌려주고 예외를 던지지 않는다(표는 그대로 나가야 한다).
    """
    ch = cfg["charts"]
    if not ch.get("enabled"):
        return {"status": "disabled", "items": [],
                "reason": ch["skipped_format"].format(reason="config.charts.enabled=false")}
    try:
        import matplotlib
        matplotlib.use("Agg")  # 헤드리스 러너 — 디스플레이가 없다
        import matplotlib.pyplot as plt
    except Exception as exc:  # noqa: BLE001
        return {"status": "skipped", "items": [],
                "reason": ch["skipped_format"].format(
                    reason="%s (%s)" % (ch["matplotlib_missing"], exc))}

    os.makedirs(outdir, exist_ok=True)
    as_of = result.get("basis_date") or "-"
    out = []
    for item in ch["items"]:
        path = os.path.join(outdir, "liquidity_%s.png" % item["key"])
        source = (ch["auction_source_label"] if item["kind"] == "auction_btc"
                  else ch["source_label"])
        rec = {"key": item["key"], "kind": item["kind"], "title_en": item["title_en"],
               "caption": ch["caption_format"].format(claim=item["claim"], note=item["note"],
                                                      as_of=as_of, source=source)}
        try:
            if item["kind"] == "auction_btc":
                chart_auction_btc(plt, result, item, path, ch, cfg)
            else:
                BUILDERS[item["kind"]](plt, result, item, path, ch)
            plt.close("all")
            rec.update(status="ok", path=path, bytes=os.path.getsize(path))
        except Exception as exc:  # noqa: BLE001 — 한 장의 실패가 나머지를 죽이지 않는다
            plt.close("all")
            rec.update(status="failed", path=None,
                       error=ch["failure_format"].format(error="%s: %s" % (item["key"], exc)))
            print("차트 실패(계속): %s — %s" % (item["key"], exc), file=sys.stderr)
        out.append(rec)
    ok = [r for r in out if r["status"] == "ok"]
    return {"status": "ok" if ok else "failed", "items": out,
            "generated": len(ok), "total": len(out), "outdir": outdir}


def main():
    ap = argparse.ArgumentParser(description="유동성 워치 차트 생성")
    ap.add_argument("--input", required=True, help="fetch_liquidity.py --json 결과 파일")
    ap.add_argument("--outdir", required=True)
    ap.add_argument("--config", default=None)
    args = ap.parse_args()
    cfg = load_config(args.config)
    result = json.load(open(args.input, encoding="utf-8"))
    res = build_charts(result, cfg, args.outdir)
    print(json.dumps({k: v for k, v in res.items()}, ensure_ascii=False, indent=2))
    return 0 if res["status"] in ("ok", "skipped", "disabled") else 1


if __name__ == "__main__":
    sys.exit(main())
