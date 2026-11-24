import "server-only";
import type { EngineDecision, EngineWorkerInfo } from "@scrapers/core";
import { getRuntime } from "./runtime";
import { open } from "./secretbox";
import { safeEqual } from "./tokens";

/**
 * Engine calls come from the home program (WORKER_SHARED_SECRET, or a
 * platform key) or from the browser extension (its platform key with write
 * access).
 */
export async function isEngineWorker(req: Request): Promise<boolean> {
  const secret = process.env.WORKER_SHARED_SECRET;
  if (secret && safeEqual(req.headers.get("x-worker-secret") ?? "", secret)) return true;
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  if (!bearer) return false;
  const rt = await getRuntime();
  const key = await rt.scrapers.verifyApiKey(bearer);
  return !!key?.scopes.includes("write");
}

/** The worker's description in a request body (checked field by field). */
export function workerInfo(v: unknown): EngineWorkerInfo | undefined {
  if (!v || typeof v !== "object") return undefined;
  const w = v as Record<string, unknown>;
  const str = (x: unknown, n: number) => (typeof x === "string" && x ? x.slice(0, n) : null);
  const id = str(w.id, 64);
  if (!id || (w.kind !== "extension" && w.kind !== "program")) return undefined;
  const exits = Array.isArray(w.exits)
    ? w.exits
        .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
        .slice(0, 30)
        .map((e) => ({
          id: str(e.id, 64) ?? "?",
          label: str(e.label, 120) ?? "?",
          ok: e.ok === true,
          restingUntil: str(e.restingUntil, 40),
          ip: str(e.ip, 64),
          error: str(e.error, 200),
        }))
    : undefined;
  return {
    id,
    kind: w.kind,
    name: str(w.name, 60),
    version: str(w.version, 30),
    ip: str(w.ip, 64),
    configVersion: str(w.configVersion, 40),
    ...(exits ? { exits } : {}),
  };
}

/** Proxy addresses go to the program decrypted, over the authenticated HTTPS answer only. */
export function forWorker(d: EngineDecision) {
  if (!d.config) return d;
  return {
    ...d,
    config: {
      version: d.config.version,
      useDirect: d.config.useDirect,
      proxies: d.config.proxies
        .map((p) => ({
          id: p.id,
          url: open(p.urlEnc),
          rotateUrl: p.rotateUrlEnc ? open(p.rotateUrlEnc) : null,
        }))
        .filter((p) => p.url),
    },
  };
}
