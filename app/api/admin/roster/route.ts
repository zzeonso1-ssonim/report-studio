import { NextResponse } from "next/server";
import { FORBIDDEN_MESSAGE, isAdminRequest } from "@/lib/auth";
import {
  ROSTER_ENV_NAME,
  formatRoster,
  hasCredential,
  loadRoster,
  makeEntry,
  makeNameOnlyEntry,
  parseRoster,
  validateName,
  validatePhone,
  type RosterEntry,
  type RosterRole,
} from "@/lib/roster";

/**
 * POST /api/admin/roster — 명단에 사람을 넣거나 뺀 **새 APP_ROSTER 값**을 계산해 돌려준다.
 *
 * 이 앱에는 DB가 없다(보고서 초안도 브라우저 localStorage에만 있다).
 * 그래서 이 창구는 저장을 하지 않고 "붙여넣을 값"만 만든다 —
 * 관리자가 결과를 Vercel 환경변수 APP_ROSTER에 넣고 재배포하면 반영된다.
 *
 * 전화번호는 요청 본문으로 들어와 makeEntry에서 뒤 4자리 해시로 바뀌고 그대로 버려진다.
 * 응답에도, 로그에도, 파일에도 남지 않는다.
 *
 * 요청의 `base`(직전 응답의 roster 값)가 있으면 그것을 기준으로 편집한다.
 *   저장소가 없으므로 서버는 요청 사이에 아무것도 기억하지 못한다. base가 없으면 매번
 *   배포된 APP_ROSTER로 되돌아가서, 한 화면에서 두 명을 연달아 추가하면 **앞사람이 조용히 사라진다**
 *   (2026-09-07 로컬 검증에서 실제로 재현됨). 그래서 편집 중인 명단을 클라이언트가 들고 다닌다.
 *   base는 이미 그 관리자가 화면에서 보고 있는 값이라 새로 노출되는 정보가 없고,
 *   어차피 ADMIN은 환경변수를 직접 쓸 수 있으므로 권한이 늘어나지도 않는다.
 *
 * 응답: { ok, roster, entries: [{id, name, role, hasPhone}], count }
 *   roster 는 salt·해시를 포함하지만 전화번호는 포함하지 않는다.
 *
 * action:
 *   add      — 이름(+선택적 전화번호). 번호를 비우면 **이름만** 등록되고 로그인은 막힌다.
 *   setPhone — 이름만 있던 사람에게 번호를 채운다(번호 교체도 같은 창구).
 *   remove   — 명단에서 뺀다.
 */
export async function POST(request: Request) {
  // proxy(/api/admin 접두사)가 이미 막지만, 경로 목록이 어긋날 때를 대비해 여기서도 확인한다.
  if (!(await isAdminRequest())) {
    return NextResponse.json({ error: FORBIDDEN_MESSAGE }, { status: 403 });
  }

  let action = "";
  let name = "";
  let phone = "";
  let role: RosterRole = "STAFF";
  let id = "";
  let base = "";
  let hasBase = false;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    action = typeof body.action === "string" ? body.action : "";
    name = typeof body.name === "string" ? body.name : "";
    phone = typeof body.phone === "string" ? body.phone : "";
    id = typeof body.id === "string" ? body.id : "";
    base = typeof body.base === "string" ? body.base : "";
    hasBase = body.hasBase === true;
    role = body.role === "ADMIN" ? "ADMIN" : "STAFF";
  } catch {
    return NextResponse.json({ error: "요청 형식이 올바르지 않습니다" }, { status: 400 });
  }

  // 편집 중인 명단(base)이 있으면 그 위에서 이어 편집한다. 없으면 배포된 APP_ROSTER가 기준.
  // hasBase를 따로 두는 이유: 전원을 뺀 뒤 다시 추가하는 경우 base가 빈 문자열인데,
  // 이때 환경변수로 되돌아가면 방금 한 삭제가 조용히 취소된다.
  let current: RosterEntry[];
  if (hasBase) {
    current = parseRoster(base);
    if (base.trim() && current.length === 0) {
      return NextResponse.json(
        { error: "편집 중인 명단을 읽지 못했습니다 — 화면을 새로고침하고 다시 시도하세요" },
        { status: 400 }
      );
    }
  } else {
    current = loadRoster();
  }

  if (action === "add") {
    const nameCheck = validateName(name);
    if (!nameCheck.ok) return NextResponse.json({ error: nameCheck.error }, { status: 400 });

    // 동명이인은 로그인 화면에서 구분이 안 된다 — 이름을 다르게 등록하도록 막는다.
    if (current.some((e) => e.name === nameCheck.value)) {
      return NextResponse.json(
        { error: `이미 등록된 이름입니다: ${nameCheck.value} (구분되는 이름으로 넣으세요)` },
        { status: 409 }
      );
    }

    // 전화번호는 선택이다 — 비우면 이름만 등록되고, 그 사람은 번호를 넣기 전까지 로그인할 수 없다.
    // 빈 문자열이 "아무 번호나 통과"로 새지 않도록 여기서 두 갈래를 명확히 나눈다.
    if (!phone.trim()) {
      return NextResponse.json(buildResponse([...current, makeNameOnlyEntry(nameCheck.value, role)]));
    }
    const phoneCheck = validatePhone(phone);
    if (!phoneCheck.ok) return NextResponse.json({ error: phoneCheck.error }, { status: 400 });

    const next = [...current, makeEntry(nameCheck.value, phoneCheck.value, role)];
    return NextResponse.json(buildResponse(next));
  }

  // 이름만 있던 사람에게 번호를 채운다(번호 교체에도 같은 창구를 쓴다).
  if (action === "setPhone") {
    const target = current.find((e) => e.id === id);
    if (!target) return NextResponse.json({ error: "해당 사용자를 찾지 못했습니다" }, { status: 404 });
    const phoneCheck = validatePhone(phone);
    if (!phoneCheck.ok) return NextResponse.json({ error: phoneCheck.error }, { status: 400 });

    const filled = makeEntry(target.name, phoneCheck.value, target.role);
    const next = current.map((e) => (e.id === target.id ? filled : e));
    return NextResponse.json(buildResponse(next));
  }

  if (action === "remove") {
    const next = current.filter((e) => e.id !== id);
    if (next.length === current.length) {
      return NextResponse.json({ error: "해당 사용자를 찾지 못했습니다" }, { status: 404 });
    }
    return NextResponse.json(buildResponse(next));
  }

  return NextResponse.json(
    { error: "action은 add, setPhone, remove 중 하나여야 합니다" },
    { status: 400 }
  );
}

function buildResponse(entries: RosterEntry[]) {
  return {
    ok: true,
    envName: ROSTER_ENV_NAME,
    roster: formatRoster(entries),
    entries: entries.map((e) => ({
      id: e.id,
      name: e.name,
      role: e.role,
      hasPhone: hasCredential(e),
    })),
    count: entries.length,
  };
}
