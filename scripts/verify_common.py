#!/usr/bin/env python3
"""검증 스크립트 공통 뼈대 — **기본은 무과금, 실호출은 `--live`에서만**.

왜 있는가 (2026-08-05):
  회귀 스크립트를 돌릴 때마다 dev 서버가 OpenAI를 실제로 호출해서, 개발 루프가
  그대로 청구서가 됐다. 그래서 실행 경로를 둘로 나눈다.

    기본(플래그 없음) : 저장된 응답 픽스처를 순서대로 재생한다. **네트워크 0회.**
    `--live`          : 실제 서버에 붙어 검증하고, 그 응답으로 픽스처를 갱신한다.

  픽스처가 썩지 않는 이유는 갱신이 검증과 같은 실행에서 일어나기 때문이다 —
  `--live`가 통과해야 픽스처가 저장된다.

설계 원칙
  - **순서 재생**: 요청을 키가 아니라 **호출 순서**로 재생한다. 같은 URL이 상태
    변화 전후로 다른 답을 주는 검사(index-missing-check의 ①/③)가 있어서 키
    방식으로는 표현이 안 된다. 순서가 어긋나면 조용히 통과시키지 않고 실패시킨다.
  - **조용한 통과 금지**: 픽스처가 없거나 요청이 어긋나면 즉시 실패하고
    "`--live`로 한 번 생성하라"고 말한다.
  - **비밀값은 픽스처에 넣지 않는다**: 저장 직전 `.env.local`·환경변수의
    비밀값이 본문에 섞였는지 대조해 마스킹한다(값은 절대 출력하지 않는다).
  - 경로·기본 URL·페이싱은 하드코딩하지 않고 `scripts/verify-config.json`에서 읽는다.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = REPO_ROOT / "scripts" / "verify-config.json"

with CONFIG_PATH.open(encoding="utf-8") as _f:
    CONFIG: dict[str, Any] = json.load(_f)

FIXTURE_DIR = REPO_ROOT / CONFIG["fixtureDir"]
BASES: dict[str, str] = CONFIG["bases"]
PACING: dict[str, float] = CONFIG["pacing"]

#: 이 이름들로 끝나는 환경변수 값은 픽스처에 들어가면 안 된다
SECRET_NAME_SUFFIXES = ("KEY", "TOKEN", "SECRET", "PASSWORD", "PW")
MASK = "***REDACTED***"


def add_common_args(ap: argparse.ArgumentParser, base_key: str = "default") -> None:
    """모든 검증 스크립트가 공유하는 인자 — 실호출 여부와 대상 서버."""
    ap.add_argument(
        "--live",
        action="store_true",
        help="실제 서버에 붙어 검증하고 픽스처를 갱신한다 (OpenAI 실호출·과금 발생)",
    )
    ap.add_argument("--base", default=os.environ.get("COCKPIT_BASE", BASES[base_key]))


def _dotenv_value(name: str) -> str | None:
    """`.env.local`에서 값 하나를 읽는다 — 셸로 export하지 않기 위한 최소 파서.

    값을 반환만 하고 어디에도 기록하지 않는다.
    """
    path = REPO_ROOT / CONFIG["envFile"]
    if not path.exists():
        return None
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        if k.strip() != name:
            continue
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        return v
    return None


def _secret_values() -> list[str]:
    """마스킹 대상 값 모음 — 환경변수와 `.env.local` 양쪽에서 이름으로 고른다."""
    names: set[str] = {k for k in os.environ if k.upper().endswith(SECRET_NAME_SUFFIXES)}
    path = REPO_ROOT / CONFIG["envFile"]
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            k = line.split("=", 1)[0].strip()
            if k and not k.startswith("#") and k.upper().endswith(SECRET_NAME_SUFFIXES):
                names.add(k)
    out = []
    for n in sorted(names):
        v = os.environ.get(n) or _dotenv_value(n)
        if v and len(v) >= 8:  # 짧은 값은 오탐이 더 위험하다
            out.append(v)
    return out


class Session:
    """서버 왕복 한 곳 — 실호출(live)과 픽스처 재생(replay)을 같은 인터페이스로."""

    def __init__(self, script: str, live: bool, base: str) -> None:
        self.script = script
        self.live = live
        self.base = base.rstrip("/")
        self.network_calls = 0  # **실제로 나간 요청 수** — 무과금 증거로 출력한다
        self._recorded: list[dict[str, Any]] = []
        self._replay: list[dict[str, Any]] = []
        self._cursor = 0
        self._token = ""
        self.fixture_path = FIXTURE_DIR / f"{script}.json"
        if live:
            self._token = self._login()
        else:
            self._load_fixture()

    # ── 픽스처 ────────────────────────────────────────────────
    def _load_fixture(self) -> None:
        if not self.fixture_path.exists():
            sys.exit(
                f"픽스처 없음: {self.fixture_path.relative_to(REPO_ROOT)}\n"
                f"  → `python3 scripts/{self.script}.py --live` 로 한 번 생성해야 합니다 "
                f"(실호출·과금 발생). 픽스처 없이 통과시키지 않습니다."
            )
        with self.fixture_path.open(encoding="utf-8") as f:
            data = json.load(f)
        self._replay = data.get("calls", [])
        print(
            f"[replay] {self.fixture_path.relative_to(REPO_ROOT)} "
            f"({len(self._replay)}건, 기록 {data.get('recordedAt')}) — 네트워크 호출 없음"
        )

    def _save_fixture(self) -> None:
        payload = {
            "script": self.script,
            "recordedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "base": self.base,
            "note": "scripts/verify_common.py가 --live 실행에서 기록. 손으로 고치지 말 것.",
            "calls": self._recorded,
        }
        text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        masked = 0
        for v in _secret_values():
            if v in text:
                text = text.replace(v, MASK)
                masked += 1
        FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
        self.fixture_path.write_text(text + "\n", encoding="utf-8")
        note = f" · 비밀값 {masked}건 마스킹" if masked else " · 비밀값 검출 0건"
        print(
            f"[live] 픽스처 갱신 {self.fixture_path.relative_to(REPO_ROOT)} "
            f"({len(self._recorded)}건, {len(text) // 1024}KB){note}"
        )

    def finish(self, ok: bool) -> None:
        """실행 마무리 — live에서 통과했을 때만 픽스처를 갱신한다."""
        if self.live and ok:
            self._save_fixture()
        elif self.live:
            print("[live] 검증 실패 — 픽스처를 갱신하지 않았습니다")
        print(f"[{'live' if self.live else 'replay'}] 실제 네트워크 호출 {self.network_calls}건")

    # ── 로그인 ────────────────────────────────────────────────
    def _login(self) -> str:
        """live 전용. 픽스처에는 세션 쿠키를 기록하지 않는다."""
        token = os.environ.get("COCKPIT_SESSION")
        if token:
            return token
        pw = os.environ.get("APP_PASSWORD")
        if pw is None:
            pw = _dotenv_value("APP_PASSWORD")
        if not pw:
            return ""  # 게이트가 열린 로컬 dev
        req = urllib.request.Request(
            f"{self.base}/api/login",
            data=json.dumps({"password": pw}).encode(),
            headers={"Content-Type": "application/json"},
        )
        self.network_calls += 1
        with urllib.request.urlopen(req, timeout=30) as r:
            for k, v in r.getheaders():
                if k.lower() == "set-cookie" and v.startswith("econ_cockpit_session="):
                    return v.split(";")[0].split("=", 1)[1]
        sys.exit("로그인 응답에 세션 쿠키가 없습니다")

    def _headers(self, json_body: bool) -> dict:
        h = {}
        if json_body:
            h["Content-Type"] = "application/json"
        if self._token:
            h["Cookie"] = f"econ_cockpit_session={self._token}"
        return h

    # ── 요청 ──────────────────────────────────────────────────
    def request(
        self, method: str, path: str, body: dict | None = None, timeout: int = 120
    ) -> tuple[int, Any]:
        """(status, json) 반환. HTTP 오류도 본문을 읽어 돌려준다(503 검사용)."""
        if not self.live:
            return self._replay_one(method, path, body)

        req = urllib.request.Request(
            f"{self.base}{path}",
            data=json.dumps(body).encode() if body is not None else None,
            headers=self._headers(body is not None),
            method=method,
        )
        self.network_calls += 1
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                status, payload = r.status, json.load(r)
        except urllib.error.HTTPError as e:
            status, payload = e.code, json.load(e)
        self._recorded.append(
            {"method": method, "path": path, "body": body, "status": status, "response": payload}
        )
        return status, payload

    def _replay_one(self, method: str, path: str, body: dict | None) -> tuple[int, Any]:
        if self._cursor >= len(self._replay):
            sys.exit(
                f"픽스처 부족: {method} {path} 차례에 기록이 없습니다 "
                f"({len(self._replay)}건까지만 기록됨) → `--live`로 갱신하세요"
            )
        e = self._replay[self._cursor]
        self._cursor += 1
        if e["method"] != method or e["path"] != path or e.get("body") != body:
            sys.exit(
                f"픽스처 불일치 #{self._cursor}\n"
                f"  기대: {e['method']} {e['path']}\n"
                f"  실제: {method} {path}\n"
                f"  → 스크립트가 바뀌었습니다. `--live`로 픽스처를 갱신하세요"
            )
        return e["status"], e["response"]

    def get(self, path: str, timeout: int = 120) -> tuple[int, Any]:
        return self.request("GET", path, None, timeout)

    def post(self, path: str, body: dict, timeout: int = 120) -> tuple[int, Any]:
        return self.request("POST", path, body, timeout)

    # ── 페이싱 ────────────────────────────────────────────────
    def sleep(self, key: str) -> None:
        """기관 API·TPM 페이싱. 재생 모드에서는 기다릴 이유가 없다."""
        if self.live:
            time.sleep(PACING[key])
