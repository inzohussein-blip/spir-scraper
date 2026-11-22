import "server-only";
import { headers } from "next/headers";
import { getRuntime } from "./runtime";

/** Client IP as seen by Vercel's proxy (first x-forwarded-for entry). */
export async function clientIp(): Promise<string | null> {
  const h = await headers();
  return h.get("x-real-ip") || h.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
}

/** Records a dashboard action in the activity log; never fails the action itself. */
export async function audit(action: string, detail?: Record<string, unknown>, actor = "owner") {
  try {
    const rt = await getRuntime();
    await rt.scrapers.audit({ actor, action, ...(detail ? { detail } : {}), ip: await clientIp() });
  } catch (err) {
    console.error("[audit]", (err as Error).message);
  }
}
