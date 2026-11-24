import "server-only";
import { safeEqual } from "./tokens";

/** The home worker signs engine calls with the same shared secret the platform uses to call it. */
export function isEngineWorker(req: Request): boolean {
  const secret = process.env.WORKER_SHARED_SECRET;
  return !!secret && safeEqual(req.headers.get("x-worker-secret") ?? "", secret);
}
