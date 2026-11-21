import "server-only";
import { createHash, randomInt } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { authSecret } from "./env";
import { getRuntime } from "./runtime";
import { safeEqual, sign, verify } from "./tokens";

export const SESSION_COOKIE = "scrapers_session";
const CODE_COOKIE = "scrapers_2fa";
const SESSION_TTL = 7 * 24 * 3600;
const CODE_TTL = 5 * 60;

/** Lockout, as in the Spir bot panel: 5 wrong tries per IP or 30 in total within 10 minutes. */
export const MAX_TRIES_PER_IP = 5;
export const MAX_TRIES_TOTAL = 30;

export function checkPassword(password: string): boolean {
  const expected = process.env.DASHBOARD_PASSWORD;
  if (!expected || expected.length < 12)
    throw new Error("DASHBOARD_PASSWORD must be set (12+ characters)");
  return safeEqual(password, expected);
}

/** Sessions carry a fingerprint of the password, so changing it signs every device out. */
const passwordStamp = () =>
  createHash("sha256")
    .update(`${process.env.DASHBOARD_PASSWORD ?? ""}`)
    .digest("base64url")
    .slice(0, 12);

const cookieOptions = (maxAge: number) => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge,
});

export async function startSession() {
  const token = await sign(
    authSecret(),
    "session",
    { sub: "owner", pw: passwordStamp() },
    SESSION_TTL,
  );
  (await cookies()).set(SESSION_COOKIE, token, cookieOptions(SESSION_TTL));
}

export async function endSession() {
  (await cookies()).delete(SESSION_COOKIE);
}

export async function hasSession(): Promise<boolean> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return false;
  const s = await verify<{ pw?: string }>(authSecret(), "session", token);
  return !!s && s.pw === passwordStamp();
}

/** For pages and server actions: sends visitors without a session to /login. */
export async function requireSession(next = "/") {
  if (!(await hasSession())) redirect(`/login?next=${encodeURIComponent(next)}`);
}

/** Telegram login codes are on when a Telegram bot is configured, unless TWO_FACTOR=off. */
export async function twoFactorEnabled(): Promise<boolean> {
  if (process.env.TWO_FACTOR === "off") return false;
  return !!(await getRuntime()).telegram;
}

const codeHash = (code: string) =>
  createHash("sha256")
    .update(`${code}:${process.env.AUTH_SECRET ?? ""}`)
    .digest("base64url");

/** Sends a 6-digit code to the owner's Telegram and remembers its hash in a short-lived cookie. */
export async function sendLoginCode(next: string) {
  const rt = await getRuntime();
  if (!rt.telegram) throw new Error("Telegram is not configured");
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await rt.telegram.sendText(
    `🔐 كود الدخول إلى Scrapers: <code>${code}</code>\nصالح 5 دقائق. إذا ما طلبته، غيّر كلمة المرور.`,
  );
  const token = await sign(authSecret(), "login", { h: codeHash(code), next }, CODE_TTL);
  (await cookies()).set(CODE_COOKIE, token, cookieOptions(CODE_TTL));
}

/** Returns where to go next when the code is right, null when wrong, "expired" when there is no pending login. */
export async function checkLoginCode(code: string): Promise<string | null | "expired"> {
  const jar = await cookies();
  const token = jar.get(CODE_COOKIE)?.value;
  const pending = token
    ? await verify<{ h: string; next: string }>(authSecret(), "login", token)
    : null;
  if (!pending) return "expired";
  if (!safeEqual(codeHash(code.trim()), pending.h)) return null;
  jar.delete(CODE_COOKIE);
  return pending.next;
}

export async function hasPendingCode(): Promise<boolean> {
  const token = (await cookies()).get(CODE_COOKIE)?.value;
  return !!token && !!(await verify(authSecret(), "login", token));
}
