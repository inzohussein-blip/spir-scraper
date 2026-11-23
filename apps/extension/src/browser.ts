import { isInstagramHost } from "./page/instagram.js";
import type { CollectState, PageRequest, PageResponse } from "./page/protocol.js";
import { Platform } from "./platform.js";
import type { ToolCall, ToolResult } from "./providers/types.js";
import { type Settings, siteAllowed, takeInstagramAction } from "./settings.js";

const isWebTab = (t: chrome.tabs.Tab | undefined): t is chrome.tabs.Tab =>
  !!t?.id && !!t.url && /^https?:/.test(t.url);

export function tabIdOf(tab: chrome.tabs.Tab): number {
  if (tab.id === undefined) throw new Error("لا توجد صفحة مفتوحة");
  return tab.id;
}

/**
 * The tab the agent works on: the active tab of the side panel's window, or
 * (when the panel is open as its own window) the active tab of a normal window.
 */
export async function activeTab(): Promise<chrome.tabs.Tab> {
  const [own] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (isWebTab(own)) return own;
  const others = await chrome.tabs.query({ active: true, windowType: "normal" });
  const tab = others.find(isWebTab);
  if (!tab) throw new Error("لا توجد صفحة ويب مفتوحة");
  return tab;
}

function requireAllowed(tab: chrome.tabs.Tab, s: Settings) {
  if (!tab.url || !siteAllowed(tab.url, s.allowedSites)) {
    const host = tab.url ? new URL(tab.url).hostname : "هذه الصفحة";
    throw new Error(`${host} غير مسموح للوكيل. أضفه في الإعدادات (المواقع المسموحة).`);
  }
}

/** Sends a request to the content script, injecting it first if needed. */
export async function pageCall(tabId: number, req: PageRequest): Promise<PageResponse> {
  const send = () => chrome.tabs.sendMessage(tabId, req) as Promise<PageResponse | undefined>;
  let res: PageResponse | undefined;
  try {
    res = await send();
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    res = await send();
  }
  if (!res) throw new Error("لم ترد الصفحة؛ أعد تحميلها وحاول مرة أخرى");
  return res;
}

async function pageText(tabId: number, req: PageRequest): Promise<string> {
  const res = await pageCall(tabId, req);
  if (!res.ok) throw new Error(res.error);
  return res.text ?? JSON.stringify(res.data ?? null);
}

function waitForLoad(tabId: number, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id: number, info: chrome.tabs.OnUpdatedInfo) => {
      if (id === tabId && info.status === "complete") done();
    };
    const timer = setTimeout(done, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/** Runs one tool call for the agent in the active tab or against the platform. */
export function createExecutor(settings: Settings) {
  const platform = new Platform(settings.platformUrl, settings.platformKey);

  async function countInstagramAction(tab: chrome.tabs.Tab) {
    if (!tab.url || !isInstagramHost(new URL(tab.url).hostname)) return;
    const limit = await takeInstagramAction(
      settings.dailyInstagramActions,
      settings.hourlyInstagramActions,
    );
    if (limit === "day")
      throw new Error(
        `بلغت حد اليوم (${settings.dailyInstagramActions} خطوة على إنستقرام). يحمي هذا الحد حسابك؛ غيّره من الإعدادات إن أردت.`,
      );
    if (limit === "hour")
      throw new Error(
        `بلغت حد الساعة (${settings.hourlyInstagramActions} خطوة على إنستقرام). أكمل بعد بداية الساعة القادمة؛ هذا يوزّع العمل على اليوم.`,
      );
  }

  return async function execute(call: ToolCall): Promise<ToolResult> {
    const ok = (content: string, image?: ToolResult["image"]): ToolResult => ({
      id: call.id,
      name: call.name,
      content,
      ...(image ? { image } : {}),
    });
    const input = call.input;
    const tab = await activeTab();
    const tabId = tabIdOf(tab);

    switch (call.name) {
      case "read_page":
        requireAllowed(tab, settings);
        return ok(await pageText(tabId, { kind: "snapshot" }));
      case "screenshot": {
        requireAllowed(tab, settings);
        const url = await chrome.tabs.captureVisibleTab(tab.windowId, {
          format: "jpeg",
          quality: 60,
        });
        return ok("Screenshot of the visible page.", {
          mediaType: "image/jpeg",
          data: url.slice(url.indexOf(",") + 1),
        });
      }
      case "instagram_profile":
        requireAllowed(tab, settings);
        return ok(await pageText(tabId, { kind: "instagram_profile" }));
      case "collect_usernames": {
        requireAllowed(tab, settings);
        const res = await pageCall(tabId, { kind: "collect_get" });
        if (!res.ok) throw new Error(res.error);
        let state = res.data as CollectState;
        if (!state.collecting) {
          const started = await pageCall(tabId, { kind: "collect_start" });
          if (!started.ok) throw new Error(started.error);
          state = started.data as CollectState;
        }
        return ok(JSON.stringify({ count: state.usernames.length, usernames: state.usernames }));
      }
      case "platform_lookup": {
        const p = await platform.lookup(String(input.username ?? ""));
        return ok(p ? JSON.stringify(p).slice(0, 4000) : "Not in the platform yet.");
      }
      case "click":
        requireAllowed(tab, settings);
        await countInstagramAction(tab);
        return ok(await pageText(tabId, { kind: "click", id: Number(input.id) }));
      case "type":
        requireAllowed(tab, settings);
        await countInstagramAction(tab);
        return ok(
          await pageText(tabId, {
            kind: "type",
            id: Number(input.id),
            text: String(input.text ?? ""),
            submit: input.submit === true,
          }),
        );
      case "scroll":
        requireAllowed(tab, settings);
        await countInstagramAction(tab);
        return ok(
          await pageText(tabId, {
            kind: "scroll",
            direction: input.direction === "up" ? "up" : "down",
            ...(typeof input.id === "number" ? { id: input.id } : {}),
          }),
        );
      case "navigate": {
        const url = String(input.url ?? "");
        if (!siteAllowed(url, settings.allowedSites))
          throw new Error(
            `الانتقال إلى ${url} غير مسموح؛ المواقع المسموحة: ${settings.allowedSites.join("، ")}`,
          );
        await countInstagramAction({ ...tab, url });
        await chrome.tabs.update(tabId, { url });
        await waitForLoad(tabId);
        return ok(`opened ${url}`);
      }
      case "back":
        requireAllowed(tab, settings);
        await countInstagramAction(tab);
        await chrome.tabs.goBack(tabId);
        await waitForLoad(tabId, 8000);
        return ok("went back");
      case "wait": {
        const s = Math.min(10, Math.max(1, Number(input.seconds) || 1));
        await new Promise((r) => setTimeout(r, s * 1000));
        return ok(`waited ${s}s`);
      }
      case "platform_save": {
        const names = Array.isArray(input.usernames) ? input.usernames.map(String) : [];
        const r = await platform.save(settings.projectId, names);
        return ok(
          `Saved ${r.count} usernames; the platform collects their details (jobs: ${r.jobIds.join(", ")}).`,
        );
      }
      default:
        throw new Error(`أداة غير معروفة: ${call.name}`);
    }
  };
}
