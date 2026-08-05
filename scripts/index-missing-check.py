#!/usr/bin/env python3
"""ECOS 항목명 색인이 없을 때의 동작을 고정하는 테스트.

색인이 빠지면 검색은 **조용히** 수정 전 상태로 회귀한다(항목 이름에만 있는
국고채 계열이 통째로 안 잡힘). 겉으로는 "결과가 좀 적네"로만 보여서 아무도
눈치채지 못하는 부류의 결손이라, 다음 3가지를 테스트로 못박는다.

  ① 색인이 없으면 /api/health가 503 + 사유를 돌려준다
  ② /api/search 응답의 errors·indexStatus에 같은 신호가 실린다
  ③ 색인 파일을 놓으면 **서버 재시작 없이** 복구된다 (실패를 캐시하지 않는다)

③이 핵심이다 — 종전 로더는 모듈 로드 시 1회 메모이제이션이라 첫 시도에 실패하면
그 인스턴스 수명 내내 꺼진 채 돌았다.

**기본 실행은 무과금·무네트워크다** — 저장된 픽스처를 재생한다(파일 조작·대기도
하지 않는다). 실제 서버를 세우는 것은 `--live`일 때뿐이다(scripts/verify_common.py).
이 검사는 `llm=off`로만 조회하므로 `--live`에서도 OpenAI는 호출하지 않는다.

사용법:
  # 기본 — 서버 없이, 네트워크 0회
  python3 scripts/index-missing-check.py

  # 실측 — 없는 경로를 가리켜 dev 서버를 띄운 뒤 픽스처를 갱신한다
  APP_PASSWORD= ECOS_ITEM_INDEX_PATH=/tmp/econ-idx-test.json npx next dev --webpack -p 3501
  python3 scripts/index-missing-check.py --live \
      --index-path /tmp/econ-idx-test.json \
      --source data/ecos-item-names.json
"""
import argparse
import json
import os
import shutil
import sys
import time
import urllib.parse

from verify_common import PACING, Session, add_common_args

#: lib/ecos-item-index.ts의 RETRY_AFTER_MS(30초)보다 넉넉해야 한다 (단일 소스: verify-config.json)
RETRY_WAIT_S = PACING["indexRetryWaitS"]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    add_common_args(ap, base_key="indexMissing")
    ap.add_argument("--index-path", help="서버에 ECOS_ITEM_INDEX_PATH로 준 경로 (--live 필수)")
    ap.add_argument("--source", default="data/ecos-item-names.json", help="복사해 넣을 실제 색인")
    args = ap.parse_args()
    if args.live and not args.index_path:
        sys.exit("--live에는 --index-path가 필요합니다")

    S = Session("index-missing-check", args.live, args.base)
    failures = []

    # 시작 상태: 색인 파일이 없어야 한다 (재생 모드에서는 파일을 건드리지 않는다)
    if args.live and os.path.exists(args.index_path):
        os.remove(args.index_path)
        print(f"기존 파일 제거: {args.index_path} (재시도 대기 {RETRY_WAIT_S}s)")
        S.sleep("indexRetryWaitS")

    print("① 색인 없음 — /api/health")
    status, health = S.get("/api/health")
    print(f"   HTTP {status} · {json.dumps(health.get('ecosItemIndex', {}), ensure_ascii=False)}")
    if status != 503 or health.get("ok") is not False:
        failures.append("색인이 없는데 /api/health가 정상(200/ok)으로 응답했다")
    if not health.get("ecosItemIndex", {}).get("reason"):
        failures.append("/api/health에 사용 불가 사유(reason)가 없다")

    print("② 색인 없음 — /api/search 신호와 품질 저하")
    q = urllib.parse.quote("국고채 커브")
    _, before = S.get(f"/api/search?q={q}&llm=off")
    ecos_before = sum(1 for r in before.get("results", []) if r["source"] == "ecos")
    signalled = any("색인" in e for e in before.get("errors", []))
    print(f"   ecos {ecos_before}건 · errors에 색인 신호 {'있음' if signalled else '없음'}")
    if not signalled:
        failures.append("/api/search의 errors에 색인 부재 신호가 없다")
    if before.get("indexStatus", {}).get("available") is not False:
        failures.append("/api/search의 indexStatus가 사용 불가를 알리지 않는다")

    print(f"③ 색인 배치 후 재시작 없이 복구 (대기 {RETRY_WAIT_S if args.live else 0}s)")
    if args.live:
        shutil.copyfile(args.source, args.index_path)
        time.sleep(RETRY_WAIT_S)
    status, health = S.get("/api/health")
    _, after = S.get(f"/api/search?q={q}&llm=off")
    ecos_after = sum(1 for r in after.get("results", []) if r["source"] == "ecos")
    built = after.get("indexStatus", {}).get("builtAt")
    print(f"   HTTP {status} · ecos {ecos_before} → {ecos_after}건 · 색인 기준일 {built}")
    if status != 200:
        failures.append("색인을 놓았는데 /api/health가 복구되지 않았다 (실패가 캐시된 것)")
    if ecos_after <= ecos_before:
        failures.append(f"복구 후에도 ECOS 결과가 늘지 않았다 ({ecos_before} → {ecos_after})")
    if not built:
        failures.append("indexStatus.builtAt(색인 기준일)이 비어 있다")

    print()
    if failures:
        for f in failures:
            print(f"FAIL {f}")
        S.finish(False)
        return 1
    print("PASS 색인 부재 신호·복구 모두 확인")
    S.finish(True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
