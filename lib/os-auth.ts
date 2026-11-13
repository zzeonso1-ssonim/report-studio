import type { RosterPublicEntry } from "./auth-config";
import type { SessionUser } from "./auth";

export const OS_ORIGIN = "https://daishin-ai-research.vercel.app";
const ENDPOINT = `${OS_ORIGIN}/api/report-studio-auth`;
// Production always uses OS accounts. APP_ROSTER remains only for local fixtures.
export function usesOsAuth() {
  return Boolean(process.env.VERCEL) || process.env.NODE_ENV === "production";
}
async function callOs(body?: object) {
  const response = await fetch(ENDPOINT, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10000),
  });
  const data = await response.json();
  if (!response.ok && response.status !== 401) throw new Error("OS authentication unavailable");
  return { ok: response.ok, data };
}
function userFrom(value: unknown): SessionUser | null {
  if (!value || typeof value !== "object") return null;
  const u = value as Record<string, unknown>;
  return typeof u.id === "string" && typeof u.name === "string" && (u.role === "ADMIN" || u.role === "STAFF")
    ? { id: u.id, name: u.name, role: u.role } : null;
}
export async function osRoster(): Promise<RosterPublicEntry[]> {
  const { ok, data } = await callOs();
  if (!ok || !Array.isArray(data.roster)) throw new Error("OS roster unavailable");
  return data.roster.map((r: RosterPublicEntry) => {
    if (typeof r.id !== "string" || typeof r.name !== "string" || typeof r.hasPhone !== "boolean") {
      throw new Error("Invalid OS roster");
    }
    return { id: r.id, name: r.name, hasPhone: r.hasPhone };
  });
}
export async function osLogin(userId: string, last4: string) {
  const { ok, data } = await callOs({ action: "login", userId, last4 });
  const user = userFrom(data.user);
  return ok && user && typeof data.token === "string" && data.token.startsWith("rs1.")
    ? { user, token: data.token as string } : null;
}
export async function osSession(token: string | null | undefined): Promise<SessionUser | null> {
  if (!token || !token.startsWith("rs1.") || token.length > 2048) return null;
  try {
    const { ok, data } = await callOs({ action: "session", token });
    return ok ? userFrom(data.user) : null;
  } catch { return null; } // OS unavailable: deny access, never use the stale local roster.
}
