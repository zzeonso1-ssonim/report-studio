import { NextResponse } from "next/server";
import {
  SESSION_COOKIE_OPTIONS,
  SESSION_MAX_AGE_SECONDS,
  UNCONFIGURED_MESSAGE,
  createSessionToken,
  gateMode,
} from "@/lib/auth";
import { verifyCredential } from "@/lib/roster";

/**
 * 로그인 실패 메시지 — 이름이 틀렸는지 4자리가 틀렸는지 구분해 알려주지 않는다.
 * (구분해 주면 등록 여부를 확인하는 조회 창구가 되고, 전수 대입 대상도 좁혀진다.)
 */
const INVALID_MESSAGE = "이름 또는 전화번호 뒤 4자리가 올바르지 않습니다";

/**
 * POST /api/login — { userId, last4 }.
 *
 * 명단(APP_ROSTER)에서 userId로 엔트리를 찾아 뒤 4자리를 scrypt 해시로 대조하고,
 * 일치하면 HMAC 서명 세션 쿠키(httpOnly·secure·sameSite=lax·30일)를 발급한다.
 * 실패는 항상 같은 지연(lib/roster.ts FAIL_DELAY_MS)을 거친다.
 *
 * 요청 본문의 전화번호 뒤 4자리는 검증에만 쓰고 로그·쿠키 어디에도 남기지 않는다.
 */
export async function POST(request: Request) {
  const mode = gateMode();
  if (mode === "unconfigured") {
    return NextResponse.json({ error: UNCONFIGURED_MESSAGE }, { status: 503 });
  }

  let userId = "";
  let last4 = "";
  try {
    const body = (await request.json()) as { userId?: unknown; last4?: unknown };
    userId = typeof body.userId === "string" ? body.userId : "";
    last4 = typeof body.last4 === "string" ? body.last4 : "";
  } catch {
    return NextResponse.json({ error: "요청 형식이 올바르지 않습니다" }, { status: 400 });
  }

  // 게이트가 열린 로컬 개발 환경에서는 대조할 명단 자체가 없다
  if (mode === "open") {
    return NextResponse.json({ ok: true, note: "로컬 개발 모드 — 인증이 비활성 상태입니다" });
  }

  const result = await verifyCredential(userId, last4);
  if (!result.ok) {
    return NextResponse.json({ error: INVALID_MESSAGE }, { status: 401 });
  }

  const token = createSessionToken(result.entry);
  if (!token) {
    return NextResponse.json({ error: UNCONFIGURED_MESSAGE }, { status: 503 });
  }

  const response = NextResponse.json({ ok: true, name: result.entry.name, role: result.entry.role });
  response.cookies.set({
    ...SESSION_COOKIE_OPTIONS,
    value: token,
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return response;
}
