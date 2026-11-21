import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { authSecret } from "./env";
import { safeEqual, sign, verify } from "./tokens";

export const SESSION_COOKIE = "scrapers_session";
const SESSION_TTL = 30 * 24 * 3600;

export function checkPassword(password: string): boolean {
  const expected = process.env.DASHBOARD_PASSWORD;
  if (!expected || expected.length < 12)
    throw new Error("DASHBOARD_PASSWORD must be set (12+ characters)");
  return safeEqual(password, expected);
}

export async function startSession() {
  const token = await sign(authSecret(), "session", { sub: "owner" }, SESSION_TTL);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL,
  });
}

export async function endSession() {
  (await cookies()).delete(SESSION_COOKIE);
}

export async function hasSession(): Promise<boolean> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return !!token && !!(await verify(authSecret(), "session", token));
}

/** For pages and server actions: sends visitors without a session to /login. */
export async function requireSession(next = "/") {
  if (!(await hasSession())) redirect(`/login?next=${encodeURIComponent(next)}`);
}
