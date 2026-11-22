import "server-only";
import { createRuntime, databaseRegion, databaseUrl, type Runtime } from "@scrapers/runtime";

const g = globalThis as unknown as { __scrapersRuntime?: Promise<Runtime> };

/** One runtime per server instance, reused across requests. */
export function getRuntime(): Promise<Runtime> {
  g.__scrapersRuntime ??= createRuntime(process.env, { serverless: true })
    .then((rt) => {
      // Once per cold start: where the function runs and where the database is.
      const db = databaseRegion(databaseUrl());
      console.info(
        `[runtime] function region ${process.env.VERCEL_REGION ?? "local"} · database region ${db.region ?? "unknown"}${db.vercelRegion ? ` (nearest function region ${db.vercelRegion})` : ""}`,
      );
      return rt;
    })
    .catch((err) => {
      g.__scrapersRuntime = undefined;
      throw err;
    });
  return g.__scrapersRuntime;
}
