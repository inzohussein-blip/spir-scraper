import type { ModelSettings } from "./providers/types.js";

export interface Settings extends ModelSettings {
  effort: "low" | "medium" | "high";
  /** The owner's Scrapers platform, e.g. https://spir-scraper.vercel.app */
  platformUrl: string;
  /** An API key from the platform (scrapers keys create … -s read,write). */
  platformKey: string;
  projectId: string;
  /** Sites the agent may read and act on (host names, subdomains included). */
  allowedSites: string[];
  /** Minimum seconds between page actions in auto mode. */
  paceSeconds: number;
  /** Model turns per auto task. */
  maxSteps: number;
  /** Page actions per day on Instagram in auto mode (a guard against account limits). */
  dailyInstagramActions: number;
  /** Page actions per hour on Instagram, so the daily allowance is spread out. */
  hourlyInstagramActions: number;
  /** Show the lead badge on Instagram profiles. */
  showBadge: boolean;
  /** What the owner offers, for message drafts. */
  offer: string;
  /** What a good lead looks like, when the project has no AI criteria. */
  criteria: string;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: "anthropic",
  model: "claude-opus-5-5",
  apiKey: "",
  baseUrl: "",
  vision: true,
  effort: "medium",
  platformUrl: "",
  platformKey: "",
  projectId: "",
  allowedSites: ["instagram.com"],
  paceSeconds: 4,
  maxSteps: 25,
  dailyInstagramActions: 200,
  hourlyInstagramActions: 60,
  showBadge: true,
  offer: "",
  criteria: "",
};

const KEY = "settings";

export async function loadSettings(): Promise<Settings> {
  const got = (await chrome.storage.local.get(KEY))[KEY] as Partial<Settings> | undefined;
  return { ...DEFAULT_SETTINGS, ...(got ?? {}) };
}

export async function saveSettings(s: Settings): Promise<void> {
  // storage.local stays on this computer; it is never synced to the Google account.
  await chrome.storage.local.set({ [KEY]: s });
}

/** "https://www.Instagram.com/x" or "instagram.com" → "instagram.com". */
export function normalizeSite(input: string): string | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  try {
    const host = new URL(/^[a-z]+:\/\//.test(s) ? s : `https://${s}`).hostname;
    return host.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

export function siteAllowed(url: string, allowed: readonly string[]): boolean {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowed.some((a) => host === a || host.endsWith(`.${a}`));
}

/** Host permission patterns for the allowed sites (requested from Chrome when saved). */
export function originPatterns(allowed: readonly string[]): string[] {
  return allowed.flatMap((a) => [`https://${a}/*`, `https://*.${a}/*`]);
}

/**
 * Counts Instagram actions per day and per hour. Returns null when the action
 * may go ahead, or which limit was reached.
 */
export async function takeInstagramAction(
  dailyLimit: number,
  hourlyLimit = Number.POSITIVE_INFINITY,
  now = new Date(),
): Promise<null | "day" | "hour"> {
  const day = now.toISOString().slice(0, 10);
  const hour = now.toISOString().slice(0, 13);
  const key = "igActions";
  const cur = (await chrome.storage.local.get(key))[key] as
    | { day: string; n: number; hour?: string; h?: number }
    | undefined;
  const n = cur?.day === day ? cur.n : 0;
  const h = cur?.hour === hour ? (cur.h ?? 0) : 0;
  if (n >= dailyLimit) return "day";
  if (h >= hourlyLimit) return "hour";
  await chrome.storage.local.set({ [key]: { day, n: n + 1, hour, h: h + 1 } });
  return null;
}
