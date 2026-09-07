#!/usr/bin/env bash
#
# 이름만 있는 명단 항목을 프로덕션 APP_ROSTER 뒤에 이어 붙이고, 배포하고, 결과를 확인한다.
#
# 왜 스크립트인가 —
#   APP_ROSTER 는 Encrypted 환경변수라 AI 세션의 셸에서는 값이 [SENSITIVE] 로 가려진다.
#   그래서 이 조작만은 사람의 터미널에서 돈다. 대신 손으로 할 일을 남기지 않도록
#   읽기·덧붙이기·교체·배포·검증을 한 번에 하고, 실패하면 원래 값으로 되돌린다.
#
# 이 스크립트는 비밀을 화면에 찍지 않는다. 이름과 개수만 보여준다.
# 덧붙이는 항목에는 자격증명이 없다(`이름:역할` 2필드) — 그 사람들은 번호를
# /admin/roster 에서 채우기 전까지 로그인할 수 없다.
#
#   ./scripts/roster-add-names.sh "고은하" "오은지" …
#   이름 뒤에 :admin 을 붙이면 관리자로 등록된다.
#
set -euo pipefail
cd "$(dirname "$0")/.."

[ $# -gt 0 ] || { echo "사용법: $0 \"이름\" \"이름\" …"; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "▶ 현재 APP_ROSTER 를 읽는다"
npx vercel env pull "$TMP/env" --environment=production --yes >/dev/null
CUR=$(grep '^APP_ROSTER=' "$TMP/env" | sed 's/^APP_ROSTER=//; s/^"//; s/"$//')
[ -n "$CUR" ] || { echo "중단: APP_ROSTER 를 읽지 못했다. 값을 지우지 않았다."; exit 1; }

# 되돌릴 값을 먼저 챙긴다 — 교체 도중 실패해도 전원이 잠기지 않게.
printf '%s' "$CUR" > "$TMP/backup"
echo "  기존 ${#CUR}자 / $(printf '%s' "$CUR" | tr ';' '\n' | grep -c . )명"

NEW="$CUR"
ADDED=0
for raw in "$@"; do
  role="S"; name="$raw"
  case "$raw" in *:admin|*:ADMIN) role="A"; name="${raw%:*}";; *:staff|*:STAFF) name="${raw%:*}";; esac
  case "$name" in *";"*|*":"*) echo "중단: 이름에 : 또는 ; 는 쓸 수 없다 — $name"; exit 1;; esac
  # 이미 있는 사람은 건너뛴다 — 번호가 등록된 사람을 이름만으로 덮어써 자격증명을 지우면 안 된다.
  if printf '%s' "$NEW" | tr ';' '\n' | cut -d: -f1 | grep -qxF "$name"; then
    echo "  건너뜀(이미 있음): $name"; continue
  fi
  NEW="$NEW;$name:$role"
  ADDED=$((ADDED+1))
  echo "  추가: $name ($([ "$role" = A ] && echo 관리자 || echo 팀원), 번호 미등록)"
done

[ "$ADDED" -gt 0 ] || { echo "추가할 사람이 없다. 아무것도 바꾸지 않았다."; exit 0; }

echo "▶ 환경변수를 교체한다 (${ADDED}명 추가)"
npx vercel env rm APP_ROSTER production --yes >/dev/null
if ! printf '%s' "$NEW" | npx vercel env add APP_ROSTER production >/dev/null 2>&1; then
  echo "!! 추가 실패 — 기존 값으로 되돌린다"
  npx vercel env add APP_ROSTER production < "$TMP/backup" >/dev/null 2>&1 || true
  echo "되돌렸다. 배포는 하지 않았다."
  exit 1
fi

echo "▶ 배포한다 (환경변수는 배포 시점에 구워진다 — 배포 없이는 반영되지 않는다)"
npx vercel --prod --yes >/dev/null

URL=$(npx vercel inspect --scope "$(node -p "require('./.vercel/project.json').orgId" 2>/dev/null || echo '')" 2>/dev/null >/dev/null; echo "https://report-studio-kr.vercel.app")

echo "▶ 확인 — 로그인 화면에 실제로 보이는 이름"
sleep 3
curl -fsS "$URL/login" \
  | grep -oE '<option value="[^"]*">[^<]*</option>' \
  | sed 's/<[^>]*>//g' | sed '/^선택하세요$/d' | sed 's/^/    /'

echo "▶ 확인 — 무인증 차단"
printf '    / → '; curl -s -o /dev/null -w "%{http_code}\n" "$URL/"
printf '    /api/indicators → '; curl -s -o /dev/null -w "%{http_code}\n" "$URL/api/indicators"
echo
echo "완료. 307 과 401 이 나오고 이름이 모두 보이면 정상이다."
echo "번호 미등록자는 로그인 화면에서 '(번호 미등록)' 으로 표시되고 입력칸이 잠긴다."
