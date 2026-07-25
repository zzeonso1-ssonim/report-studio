import { NextResponse } from "next/server";
import {
  SESSION_COOKIE_OPTIONS,
  SESSION_MAX_AGE_SECONDS,
  UNCONFIGURED_MESSAGE,
  createSessionToken,
  gateMode,
  verifyPassword,
} from "@/lib/auth";

/** 로그인 실패 메시지 — 비밀번호가 틀린 경우 (원인은 구분해 알려주지 않는다) */
const INVALID_MESSAGE = "비밀번호가 올바르지 않습니다";

/**
 * POST /api/login — { password } 를 APP_PASSWORD와 상수시간 비교하고,
 * 일치하면 HMAC 서명 세션 쿠키(httpOnly·secure·sameSite=lax·30일)를 발급한다.
 */
export async function POST(request: Request) {
  const mode = gateMode();
  if (mode === "unconfigured") {
    return NextResponse.json({ error: UNCONFIGURED_MESSAGE }, { status: 503 });
  }

  let password = "";
  try {
    const body = (await request.json()) as { password?: unknown };
    password = typeof body.password === "string" ? body.password : "";
  } catch {
    return NextResponse.json({ error: "요청 형식이 올바르지 않습니다" }, { status: 400 });
  }

  // 게이트가 열린 로컬 개발 환경에서는 검증할 비밀번호 자체가 없다
  if (mode === "open") {
    return NextResponse.json({ ok: true, note: "로컬 개발 모드 — 인증이 비활성 상태입니다" });
  }

  if (!verifyPassword(password)) {
    return NextResponse.json({ error: INVALID_MESSAGE }, { status: 401 });
  }

  const token = createSessionToken();
  if (!token) {
    return NextResponse.json({ error: UNCONFIGURED_MESSAGE }, { status: 503 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    ...SESSION_COOKIE_OPTIONS,
    value: token,
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return response;
}
