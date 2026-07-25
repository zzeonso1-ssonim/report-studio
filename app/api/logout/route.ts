import { NextResponse } from "next/server";
import { SESSION_COOKIE_OPTIONS } from "@/lib/auth";

/** POST /api/logout — 세션 쿠키를 즉시 만료시킨다. */
export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    ...SESSION_COOKIE_OPTIONS,
    value: "",
    maxAge: 0,
  });
  return response;
}
