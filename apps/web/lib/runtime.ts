import "server-only";
import { createRuntime, type Runtime } from "@scrapers/runtime";

const g = globalThis as unknown as { __scrapersRuntime?: Promise<Runtime> };

/** One runtime per server instance, reused across requests. */
export function getRuntime(): Promise<Runtime> {
  g.__scrapersRuntime ??= createRuntime(process.env, { serverless: true }).catch((err) => {
    g.__scrapersRuntime = undefined;
    throw err;
  });
  return g.__scrapersRuntime;
}
