import type { BadgeAnswer, BadgeRequest } from "./page/badge.js";
import { Platform } from "./platform.js";
import { loadSettings } from "./settings.js";

/** The toolbar button opens the side panel; everything else runs there. */
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

/** Lookups are cached briefly so moving between profiles stays light on the platform. */
const cache = new Map<string, { at: number; answer: BadgeAnswer }>();
const CACHE_MS = 5 * 60_000;

async function answer(req: BadgeRequest): Promise<BadgeAnswer> {
  const s = await loadSettings();
  if (!s.showBadge) return { ok: true, enabled: false, lead: null };
  const platform = new Platform(s.platformUrl, s.platformKey);
  if (!platform.configured || !s.projectId) return { ok: true, enabled: false, lead: null };
  if (req.kind === "lead_save") {
    await platform.save(s.projectId, [req.username]);
    cache.delete(req.username);
    return { ok: true, enabled: true, lead: { status: "new", aiScore: null } };
  }
  const hit = cache.get(req.username);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.answer;
  const res: BadgeAnswer = {
    ok: true,
    enabled: true,
    lead: await platform.lead(s.projectId, req.username),
  };
  cache.set(req.username, { at: Date.now(), answer: res });
  return res;
}

chrome.runtime.onMessage.addListener((req: BadgeRequest, sender, reply) => {
  // Only this extension's own scripts (the badge on Instagram) can ask.
  if (sender.id !== chrome.runtime.id || (req.kind !== "lead_lookup" && req.kind !== "lead_save"))
    return false;
  answer(req)
    .then(reply)
    .catch((err: Error) => reply({ ok: false, error: err.message } satisfies BadgeAnswer));
  return true;
});
