#!/usr/bin/env python3
"""배터리 실행의 눈금 4개 — 정답률 / 라운드 / 비용 / 응답시간.

왜 있는가 (2026-08-05 디렉터 지적): 2026-08-01에 플래너 모델을 gpt-4o-mini에서
gpt-4o로 올려 비용을 크게 늘렸는데, **나아졌다는 증거를 남기지 않았다.**
"돈을 더 썼는데 나아졌나"에 숫자로 답하려면 배터리가 정답률만이 아니라 라운드·
토큰·시간을 함께 뱉어야 한다.

라운드 수를 넣는 이유: /api/chat은 지표를 못 찾으면 도구 호출 라운드를 더 태운다.
**라운드 수는 검색 결손의 대리지표이고 동시에 비용의 직접 원인**이다.

비용은 `scripts/verify-config.json`의 요금표에서 계산한다(단일 소스). 요금표는
사람이 확인한 값이고 출처·확인일이 그 파일에 적혀 있다 — 코드에 숫자를 박지 않는다.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from verify_common import CONFIG

PRICING: dict[str, Any] = CONFIG["pricingUsdPerMTok"]


def cost_usd(by_model: dict[str, dict]) -> tuple[float, list[str]]:
    """모델별 토큰 → USD. 요금표에 없는 모델은 계산하지 않고 이름만 돌려준다.

    (추정·보간 금지 — 모르는 요금은 0으로 때우지 않고 '미산정'으로 남긴다)
    """
    total = 0.0
    unknown = []
    for model, m in by_model.items():
        p = PRICING.get(model)
        if not p:
            unknown.append(model)
            continue
        cached = m.get("cachedPromptTokens", 0)
        fresh = max(m.get("promptTokens", 0) - cached, 0)
        total += (
            fresh * p["input"] + cached * p["cachedInput"] + m.get("completionTokens", 0) * p["output"]
        ) / 1_000_000
    return total, unknown


@dataclass
class Row:
    query: str
    ok: bool
    rounds: int
    seconds: float
    prompt: int = 0
    completion: int = 0
    cached: int = 0
    cost: float = 0.0
    models: str = ""
    detail: str = ""


@dataclass
class Battery:
    """행을 모아 4지표를 낸다. 실패 행도 비용·라운드에는 포함한다(실제로 썼으므로)."""

    label: str
    rows: list[Row] = field(default_factory=list)
    unknown_models: set[str] = field(default_factory=set)

    def add(self, query: str, ok: bool, seconds: float, usage: dict | None, detail: str = "") -> Row:
        usage = usage or {}
        by_model = usage.get("byModel") or {}
        c, unknown = cost_usd(by_model)
        self.unknown_models.update(unknown)
        row = Row(
            query=query,
            ok=ok,
            rounds=usage.get("rounds", 0),
            seconds=seconds,
            prompt=sum(m.get("promptTokens", 0) for m in by_model.values()),
            completion=sum(m.get("completionTokens", 0) for m in by_model.values()),
            cached=sum(m.get("cachedPromptTokens", 0) for m in by_model.values()),
            cost=c,
            models="+".join(sorted(by_model)),
            detail=detail,
        )
        self.rows.append(row)
        return row

    def summary(self) -> dict:
        n = len(self.rows) or 1
        rounds = [r.rounds for r in self.rows]
        return {
            "label": self.label,
            "n": len(self.rows),
            "pass": sum(1 for r in self.rows if r.ok),
            "passRate": sum(1 for r in self.rows if r.ok) / n,
            "roundsAvg": sum(rounds) / n,
            "roundsMax": max(rounds) if rounds else 0,
            "promptAvg": sum(r.prompt for r in self.rows) / n,
            "completionAvg": sum(r.completion for r in self.rows) / n,
            "cachedAvg": sum(r.cached for r in self.rows) / n,
            "cachedShare": (
                sum(r.cached for r in self.rows) / sum(r.prompt for r in self.rows)
                if sum(r.prompt for r in self.rows)
                else 0.0
            ),
            "costPerQueryUsd": sum(r.cost for r in self.rows) / n,
            "costTotalUsd": sum(r.cost for r in self.rows),
            "secondsAvg": sum(r.seconds for r in self.rows) / n,
            "secondsMax": max((r.seconds for r in self.rows), default=0.0),
            "models": sorted({m for r in self.rows for m in r.models.split("+") if m}),
            "unpricedModels": sorted(self.unknown_models),
        }

    def print_summary(self) -> None:
        s = self.summary()
        print(f"\n{'=' * 78}\n[{s['label']}] 배터리 눈금 4개 (모델: {', '.join(s['models']) or '미상'})")
        print(f"  ① 정답률      {s['pass']}/{s['n']} ({s['passRate'] * 100:.1f}%)")
        print(f"  ② 라운드      평균 {s['roundsAvg']:.2f} · 최대 {s['roundsMax']}")
        print(
            f"  ③ 질의당 비용 ${s['costPerQueryUsd']:.4f} "
            f"(총 ${s['costTotalUsd']:.4f} · 요금표 {PRICING['_source']})"
        )
        print(
            f"     토큰 평균   prompt {s['promptAvg']:.0f} (캐시 {s['cachedAvg']:.0f}"
            f" = {s['cachedShare'] * 100:.1f}%) · completion {s['completionAvg']:.0f}"
        )
        print(f"  ④ 응답시간    평균 {s['secondsAvg']:.1f}s · 최대 {s['secondsMax']:.1f}s")
        if s["unpricedModels"]:
            print(f"  ※ 요금 미산정 모델: {', '.join(s['unpricedModels'])} — 비용은 과소계상")
