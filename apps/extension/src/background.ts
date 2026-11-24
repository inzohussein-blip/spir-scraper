import { type EngineState, engineTick } from "./engine.js";
import { fromEntries, type LeadIndex, lookup, needsRefresh, withSaved } from "./lead-index.js";
import type { BadgeAnswer, BadgeRequest } from "./page/badge.js";
import { Platform } from "./platform.js";
import { loadSettings } from "./settings.js";

/** The toolbar button opens the side panel; everything else runs there. */
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

const INDEX_KEY = "leadIndex";

/** The project's leads on this computer, downloaded at most once a day. */
async function leadIndex(platform: Platform, projectId: string): Promise<LeadIndex> {
  const saved = (await chrome.storage.local.get(INDEX_KEY))[INDEX_KEY] as LeadIndex | undefined;
  if (saved && !needsRefresh(saved, projectId)) return saved;
  const idx = fromEntries(projectId, await platform.leadIndex(projectId));
  await chrome.storage.local.set({ [INDEX_KEY]: idx });
  return idx;
}

async function answer(req: BadgeRequest): Promise<BadgeAnswer> {
  const s = await loadSettings();
  if (!s.showBadge) return { ok: true, enabled: false, lead: null };
  const platform = new Platform(s.platformUrl, s.platformKey);
  if (!platform.configured || !s.projectId) return { ok: true, enabled: false, lead: null };
  if (req.kind === "lead_save") {
    await platform.save(s.projectId, [req.username]);
    const idx = await leadIndex(platform, s.projectId);
    await chrome.storage.local.set({ [INDEX_KEY]: withSaved(idx, req.username) });
    return { ok: true, enabled: true, lead: { status: "new", aiScore: null } };
  }
  // Answered here: visiting a profile no longer costs a request to the platform.
  const idx = await leadIndex(platform, s.projectId);
  return { ok: true, enabled: true, lead: lookup(idx, req.username) };
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

// ---------- Spir engine mode (reads for the platform while the browser is open) ----------

const ENGINE_KEY = "engine";
const ALARM = "spir-engine";
let engineRunning = false;

async function loadEngine(): Promise<EngineState> {
  const got = (await chrome.storage.local.get(ENGINE_KEY))[ENGINE_KEY] as EngineState | undefined;
  return (
    got ?? {
      enabled: false,
      workerId: `ext-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
      ip: null,
      last: null,
      readToday: 0,
      day: "",
    }
  );
}

function schedule(seconds: number) {
  chrome.alarms.create(ALARM, { when: Date.now() + Math.max(1, seconds) * 1000 });
}

async function runEngine() {
  if (engineRunning) return;
  engineRunning = true;
  try {
    const state = await loadEngine();
    if (!state.enabled) return;
    const s = await loadSettings();
    if (!/^https?:\/\//.test(s.platformUrl) || !s.platformKey) {
      state.last = { at: new Date().toISOString(), text: "اربط المنصة أولاً (الرابط والمفتاح)" };
      await chrome.storage.local.set({ [ENGINE_KEY]: state });
      schedule(600);
      return;
    }
    const r = await engineTick({
      platformUrl: s.platformUrl,
      key: s.platformKey,
      state,
      version: chrome.runtime.getManifest().version,
    });
    // The owner may have switched it off while this visit ran.
    const latest = await loadEngine();
    await chrome.storage.local.set({ [ENGINE_KEY]: { ...r.state, enabled: latest.enabled } });
    if (latest.enabled) schedule(r.waitSeconds);
  } finally {
    engineRunning = false;
  }
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) runEngine().catch(() => schedule(300));
});

chrome.storage.onChanged.addListener((changes, area) => {
  const c = changes[ENGINE_KEY];
  if (area !== "local" || !c) return;
  const was = (c.oldValue as EngineState | undefined)?.enabled;
  const now = (c.newValue as EngineState | undefined)?.enabled;
  if (now && !was) schedule(1);
  if (!now && was) chrome.alarms.clear(ALARM);
});

chrome.runtime.onStartup.addListener(async () => {
  if ((await loadEngine()).enabled) schedule(5);
});
