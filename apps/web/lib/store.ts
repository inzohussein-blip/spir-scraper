import "server-only";
import { STORE_NEEDS, type StoreNeed, type StoreTool } from "@scrapers/core";
import type { IconName } from "@/components/icons";
import { integrationStatus } from "./env";

/** What a tool still needs here (keys or settings), in words for the owner. */
export function missingNeeds(tool: StoreTool, engineOnline: boolean): string[] {
  const s = integrationStatus();
  const have: Record<StoreNeed, boolean> = {
    apify: s.apify,
    youtube: s.youtube,
    own: s.graph,
    engine: engineOnline,
  };
  return tool.needs.filter((n) => !have[n]).map((n) => STORE_NEEDS[n]);
}

/** The price line on a tool's card. */
export function priceLabel(tool: StoreTool): string {
  const p = tool.pricing;
  if (p.kind === "free") return "مجاني";
  if (p.kind === "engine-or-apify") return "مجاني بالمحرك · أو من رصيد Apify";
  return p.per1k ? `$${p.per1k.toFixed(2)} لكل 1000 ${p.unit ?? "نتيجة"}` : "من رصيد Apify";
}

export const TOOL_ICON: Record<StoreTool["category"], IconName> = {
  instagram: "radar",
  tiktok: "play",
  youtube: "play",
  facebook: "users",
  maps: "folder",
  web: "search",
  own: "chart",
};
