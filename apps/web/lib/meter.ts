import "server-only";
import type { UsageCategory } from "@scrapers/core";
import { after } from "next/server";
import { getRuntime } from "./runtime";

/**
 * Counts this request for the «الاستهلاك» page, after the answer is sent.
 * Only called where the request touches the database anyway, so counting
 * never wakes it by itself.
 */
export function meter(category: UsageCategory): void {
  try {
    after(async () => {
      const rt = await getRuntime();
      await rt.scrapers.recordUsage(category).catch(() => {});
    });
  } catch {
    // Outside a request (tests, build): nothing to count.
  }
}
