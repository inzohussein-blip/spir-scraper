import {
  askOnce,
  MESSAGE_SYSTEM,
  messagePrompt,
  parseScore,
  SCORE_SYSTEM,
  scorePrompt,
  whatsappLink,
} from "./agent/leads.js";
import { runAgent } from "./agent/loop.js";
import { type AgentMode, systemPrompt, toolsFor } from "./agent/tools.js";
import { activeTab, createExecutor, pageCall, tabIdOf } from "./browser.js";
import type { CollectState, InstagramProfile } from "./page/protocol.js";
import { Platform } from "./platform.js";
import {
  ANTHROPIC_MODELS,
  type ChatModel,
  createModel,
  OPENAI_COMPATIBLE_PRESETS,
} from "./providers/index.js";
import {
  loadSettings,
  normalizeSite,
  originPatterns,
  type Settings,
  saveSettings,
  siteAllowed,
} from "./settings.js";
import { compareVersions } from "./version.js";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
let settings: Settings = await loadSettings();

// ---------- small UI helpers (model output is always set as text, never HTML) ----------

function bubble(log: HTMLElement, kind: "user" | "ai" | "tool" | "err", text: string) {
  const div = document.createElement("div");
  div.className = `msg ${kind}`;
  div.textContent = text;
  log.append(div);
  div.scrollIntoView({ block: "end" });
}

function showTab(name: string) {
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-tab]"))
    b.setAttribute("aria-selected", String(b.dataset.tab === name));
  for (const s of document.querySelectorAll<HTMLElement>("[data-panel]"))
    s.hidden = s.dataset.panel !== name;
}

function needsSetup(): boolean {
  const ai = settings.model && (settings.apiKey || settings.provider === "openai");
  $("#setup").hidden = Boolean(ai);
  return !ai;
}

for (const b of document.querySelectorAll<HTMLButtonElement>("[data-tab]"))
  b.addEventListener("click", () => showTab(b.dataset.tab ?? "manual"));

async function withButton(btn: HTMLButtonElement, fn: () => Promise<void>, out?: HTMLElement) {
  btn.disabled = true;
  try {
    await fn();
  } catch (err) {
    if (out) {
      out.hidden = false;
      out.textContent = `⚠ ${(err as Error).message}`;
    } else alert((err as Error).message);
  } finally {
    btn.disabled = false;
  }
}

async function allowedTab() {
  const tab = await activeTab();
  if (!tab.url || !siteAllowed(tab.url, settings.allowedSites))
    throw new Error("هذه الصفحة ليست ضمن المواقع المسموحة (الإعدادات).");
  return tab;
}

const platform = () => new Platform(settings.platformUrl, settings.platformKey);

// ---------- manual: the open profile ----------

let lastProfile: InstagramProfile | null = null;
const profileOut = $("#profileOut");

$<HTMLButtonElement>("#readProfile").addEventListener("click", (e) =>
  withButton(
    e.currentTarget as HTMLButtonElement,
    async () => {
      const tab = await allowedTab();
      const res = await pageCall(tabIdOf(tab), { kind: "instagram_profile" });
      if (!res.ok) throw new Error(res.error);
      const p = res.data as InstagramProfile;
      lastProfile = p;
      const lines = [
        `@${p.username}${p.name ? ` — ${p.name}` : ""}`,
        `المتابعون: ${p.followers?.toLocaleString("ar") ?? "؟"} · يتابع: ${p.following?.toLocaleString("ar") ?? "؟"} · المنشورات: ${p.posts?.toLocaleString("ar") ?? "؟"}`,
        p.bio ? `\n${p.bio}` : "",
        p.emails.length ? `\n✉ ${p.emails.join("، ")}` : "",
        p.phones.length ? `\n☎ ${p.phones.join("، ")}` : "",
        p.externalUrl ? `\n🔗 ${p.externalUrl}` : "",
      ];
      if (platform().configured) {
        const stored = await platform().lookup(p.username ?? "");
        lines.push(stored ? "\n✓ موجود في المنصة" : "\nغير موجود في المنصة بعد");
      }
      profileOut.hidden = false;
      profileOut.textContent = lines.filter(Boolean).join("\n");
      for (const id of ["#saveProfile", "#scoreProfile", "#draftMessage"])
        $<HTMLButtonElement>(id).disabled = !p.username;
      $("#scoreOut").hidden = true;
      $("#messageBox").hidden = true;
    },
    profileOut,
  ),
);

$<HTMLButtonElement>("#saveProfile").addEventListener("click", (e) =>
  withButton(
    e.currentTarget as HTMLButtonElement,
    async () => {
      if (!lastProfile?.username) return;
      const r = await platform().save(settings.projectId, [lastProfile.username]);
      profileOut.textContent += `\n\n✓ أُرسل للمنصة (${r.count})، وتُجلب تفاصيله الآن.`;
    },
    profileOut,
  ),
);

// ---------- manual: score the profile and draft a first message ----------

const scoreOut = $("#scoreOut");

$<HTMLButtonElement>("#scoreProfile").addEventListener("click", (e) =>
  withButton(
    e.currentTarget as HTMLButtonElement,
    async () => {
      if (!lastProfile || needsSetup()) return;
      // The project's own criteria first (set in the dashboard), then the extension's.
      let criteria = settings.criteria;
      if (platform().configured && settings.projectId) {
        const project = await platform()
          .project(settings.projectId)
          .catch(() => null);
        criteria = project?.aiCriteria || criteria;
      }
      if (!criteria)
        throw new Error("اكتب «العميل المناسب لك» في الإعدادات، أو معايير المشروع في اللوحة");
      scoreOut.hidden = false;
      scoreOut.textContent = "يقيّم…";
      const reply = await askOnce(
        createModel(settings, SCORE_SYSTEM, []),
        scorePrompt(lastProfile, criteria),
      );
      const s = parseScore(reply);
      if (!s) throw new Error("لم يرجع النموذج درجة مفهومة؛ جرّب مرة أخرى");
      scoreOut.textContent = `الدرجة: ${s.score} / 100\n${s.reason}`;
    },
    scoreOut,
  ),
);

$<HTMLButtonElement>("#draftMessage").addEventListener("click", (e) =>
  withButton(
    e.currentTarget as HTMLButtonElement,
    async () => {
      if (!lastProfile || needsSetup()) return;
      if (!settings.offer) throw new Error("اكتب «ماذا تقدّم» في الإعدادات أولاً");
      const box = $("#messageBox");
      const text = $<HTMLTextAreaElement>("#messageText");
      box.hidden = false;
      text.value = "يكتب…";
      text.value = (
        await askOnce(
          createModel(settings, MESSAGE_SYSTEM, []),
          messagePrompt(lastProfile, settings.offer),
        )
      ).trim();
      updateWhatsapp();
    },
    profileOut,
  ),
);

function updateWhatsapp() {
  const button = $<HTMLButtonElement>("#whatsapp");
  const phone = lastProfile?.phones.find((p) => whatsappLink(p, "x"));
  const href = phone ? whatsappLink(phone, $<HTMLTextAreaElement>("#messageText").value) : null;
  button.hidden = !href;
  button.dataset.href = href ?? "";
}
$<HTMLButtonElement>("#whatsapp").addEventListener("click", (e) => {
  const url = (e.currentTarget as HTMLButtonElement).dataset.href;
  if (url) void chrome.tabs.create({ url });
});
$<HTMLTextAreaElement>("#messageText").addEventListener("input", updateWhatsapp);
$<HTMLButtonElement>("#copyMessage").addEventListener("click", () =>
  navigator.clipboard.writeText($<HTMLTextAreaElement>("#messageText").value),
);

// ---------- manual: collect a followers list while the owner scrolls ----------

let collectTimer: ReturnType<typeof setInterval> | undefined;
let collected: string[] = [];

function renderCollected(state: CollectState) {
  collected = state.usernames;
  $("#collectCount").textContent = collected.length.toLocaleString("ar");
  $<HTMLButtonElement>("#collectSave").disabled = collected.length === 0;
  $<HTMLButtonElement>("#collectCopy").disabled = collected.length === 0;
}

async function pollCollect(tabId: number) {
  const res = await pageCall(tabId, { kind: "collect_get" }).catch(() => null);
  if (res?.ok) renderCollected(res.data as CollectState);
}

$<HTMLButtonElement>("#collectStart").addEventListener("click", (e) =>
  withButton(e.currentTarget as HTMLButtonElement, async () => {
    const tab = await allowedTab();
    const res = await pageCall(tabIdOf(tab), { kind: "collect_start" });
    if (!res.ok) throw new Error(res.error);
    renderCollected(res.data as CollectState);
    clearInterval(collectTimer);
    collectTimer = setInterval(() => void pollCollect(tabIdOf(tab)), 1500);
  }),
);

$<HTMLButtonElement>("#collectClear").addEventListener("click", async () => {
  clearInterval(collectTimer);
  const tab = await activeTab().catch(() => null);
  if (tab?.id) await pageCall(tab.id, { kind: "collect_clear" }).catch(() => null);
  renderCollected({ collecting: false, usernames: [], owner: null });
});

$<HTMLButtonElement>("#collectCopy").addEventListener("click", () =>
  navigator.clipboard.writeText(collected.join("\n")),
);

$<HTMLButtonElement>("#collectSave").addEventListener("click", (e) =>
  withButton(e.currentTarget as HTMLButtonElement, async () => {
    const r = await platform().save(settings.projectId, collected);
    alert(`أُرسل ${r.count} اسماً للمنصة. تُجلب تفاصيلهم في الخلفية (${r.jobIds.length} مهمة).`);
  }),
);

// ---------- agent runs (ask = read only, auto = acts) ----------

let running: AbortController | null = null;
const askModels = new Map<string, ChatModel>();

async function run(mode: AgentMode, task: string, log: HTMLElement, chat?: ChatModel) {
  if (needsSetup()) {
    showTab("settings");
    return;
  }
  bubble(log, "user", task);
  running = new AbortController();
  $<HTMLButtonElement>("#stopTask").disabled = mode !== "auto";
  $<HTMLButtonElement>("#runTask").disabled = true;
  try {
    const tools = toolsFor(mode, settings.vision ?? false);
    const model = chat ?? createModel(settings, systemPrompt(mode), tools);
    if (mode === "ask") askModels.set("ask", model);
    const result = await runAgent(task, {
      model,
      execute: createExecutor(settings),
      maxSteps: mode === "auto" ? settings.maxSteps : 8,
      paceMs: mode === "auto" ? settings.paceSeconds * 1000 : 0,
      signal: running.signal,
      onEvent: (ev) => {
        if (ev.type === "assistant") bubble(log, "ai", ev.text);
        else if (ev.type === "tool")
          bubble(log, "tool", `→ ${ev.name} ${JSON.stringify(ev.input)}`);
        else if (ev.type === "tool_result" && !ev.ok) bubble(log, "err", `✗ ${ev.summary}`);
        else if (ev.type === "status") bubble(log, "tool", ev.text);
      },
    });
    if (result.status !== "done")
      bubble(log, result.status === "stopped" ? "tool" : "err", result.summary);
  } catch (err) {
    bubble(log, "err", (err as Error).message);
  } finally {
    running = null;
    $<HTMLButtonElement>("#stopTask").disabled = true;
    $<HTMLButtonElement>("#runTask").disabled = false;
  }
}

$<HTMLFormElement>("#askForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("#askInput");
  const q = input.value.trim();
  if (!q || running) return;
  input.value = "";
  void run("ask", q, $("#askLog"), askModels.get("ask"));
});

for (const chip of document.querySelectorAll<HTMLButtonElement>(".chip"))
  chip.addEventListener("click", () => {
    $<HTMLTextAreaElement>("#task").value = chip.dataset.task ?? "";
  });

$<HTMLButtonElement>("#runTask").addEventListener("click", () => {
  const task = $<HTMLTextAreaElement>("#task").value.trim();
  if (task && !running) void run("auto", task, $("#autoLog"));
});
$<HTMLButtonElement>("#stopTask").addEventListener("click", () => running?.abort());

// ---------- settings ----------

const form = $<HTMLFormElement>("#settingsForm");
const field = <T extends HTMLElement = HTMLInputElement>(name: string) =>
  form.elements.namedItem(name) as unknown as T;

function syncProviderFields() {
  const provider = field<HTMLSelectElement>("provider").value;
  for (const el of form.querySelectorAll<HTMLElement>("[data-for]"))
    el.hidden = el.dataset.for !== provider;
  const list = $("#models");
  list.replaceChildren(
    ...(provider === "anthropic" ? ANTHROPIC_MODELS : []).map((m) => {
      const o = document.createElement("option");
      o.value = m.id;
      o.label = m.label;
      return o;
    }),
  );
}

function fillSettings() {
  const preset = field<HTMLSelectElement>("preset");
  preset.replaceChildren(
    ...OPENAI_COMPATIBLE_PRESETS.map((p) => new Option(p.label, p.baseUrl)),
    new Option("خادم آخر", ""),
  );
  field<HTMLSelectElement>("provider").value = settings.provider;
  field("baseUrl").value = settings.baseUrl ?? "";
  preset.value = OPENAI_COMPATIBLE_PRESETS.some((p) => p.baseUrl === settings.baseUrl)
    ? (settings.baseUrl ?? "")
    : "";
  field("model").value = settings.model;
  field("apiKey").value = settings.apiKey;
  field<HTMLInputElement>("vision").checked = settings.vision ?? false;
  field<HTMLSelectElement>("effort").value = settings.effort;
  field("platformUrl").value = settings.platformUrl;
  field("platformKey").value = settings.platformKey;
  const project = field<HTMLSelectElement>("projectId");
  if (settings.projectId && ![...project.options].some((o) => o.value === settings.projectId))
    project.append(new Option(settings.projectId, settings.projectId));
  project.value = settings.projectId;
  field<HTMLTextAreaElement>("allowedSites").value = settings.allowedSites.join("\n");
  field("paceSeconds").value = String(settings.paceSeconds);
  field("maxSteps").value = String(settings.maxSteps);
  field("dailyInstagramActions").value = String(settings.dailyInstagramActions);
  field<HTMLInputElement>("showBadge").checked = settings.showBadge;
  field<HTMLTextAreaElement>("criteria").value = settings.criteria;
  field<HTMLTextAreaElement>("offer").value = settings.offer;
  syncProviderFields();
}

field<HTMLSelectElement>("provider").addEventListener("change", syncProviderFields);
field<HTMLSelectElement>("preset").addEventListener("change", (e) => {
  const v = (e.target as HTMLSelectElement).value;
  if (v) field("baseUrl").value = v;
});

$<HTMLButtonElement>("#loadProjects").addEventListener("click", (e) =>
  withButton(e.currentTarget as HTMLButtonElement, async () => {
    const url = field("platformUrl").value.trim();
    if (url) await chrome.permissions.request({ origins: [`${new URL(url).origin}/*`] });
    const projects = await new Platform(url, field("platformKey").value.trim()).projects();
    const select = field<HTMLSelectElement>("projectId");
    const keep = select.value;
    select.replaceChildren(new Option("—", ""), ...projects.map((p) => new Option(p.name, p.id)));
    select.value = keep;
    if (projects.length === 0) alert("لا توجد مشاريع؛ أنشئ مشروعاً من اللوحة أولاً.");
  }),
);

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const sites = field<HTMLTextAreaElement>("allowedSites")
    .value.split(/\s+/)
    .map(normalizeSite)
    .filter((s): s is string => !!s);
  const next: Settings = {
    ...settings,
    provider: field<HTMLSelectElement>("provider").value as Settings["provider"],
    baseUrl: field("baseUrl").value.trim(),
    model: field("model").value.trim(),
    apiKey: field("apiKey").value.trim(),
    vision: field<HTMLInputElement>("vision").checked,
    effort: field<HTMLSelectElement>("effort").value as Settings["effort"],
    platformUrl: field("platformUrl").value.trim().replace(/\/$/, ""),
    platformKey: field("platformKey").value.trim(),
    projectId: field<HTMLSelectElement>("projectId").value,
    allowedSites: sites.length ? [...new Set(sites)] : ["instagram.com"],
    paceSeconds: Math.max(1, Number(field("paceSeconds").value) || 4),
    maxSteps: Math.max(1, Number(field("maxSteps").value) || 25),
    dailyInstagramActions: Math.max(1, Number(field("dailyInstagramActions").value) || 200),
    showBadge: field<HTMLInputElement>("showBadge").checked,
    criteria: field<HTMLTextAreaElement>("criteria").value.trim(),
    offer: field<HTMLTextAreaElement>("offer").value.trim(),
  };
  // Chrome asks the owner to approve access to the allowed sites and servers (must start in the click).
  const origins = [
    ...originPatterns(next.allowedSites),
    ...[next.platformUrl, next.provider === "openai" ? next.baseUrl : ""]
      .filter((u): u is string => !!u && /^https?:\/\//.test(u))
      .map((u) => `${new URL(u).origin}/*`),
  ];
  void chrome.permissions
    .request({ origins })
    .catch(() => false)
    .then(async () => {
      settings = next;
      await saveSettings(next);
      needsSetup();
      const saved = $("#saved");
      saved.hidden = false;
      setTimeout(() => (saved.hidden = true), 2000);
    });
});

/** Shows a notice when the dashboard offers a newer build than this one. */
async function checkForUpdate() {
  if (!/^https?:\/\//.test(settings.platformUrl)) return;
  try {
    const res = await fetch(`${settings.platformUrl}/downloads/spir-extension.json`, {
      cache: "no-store",
    });
    if (!res.ok) return;
    const { version } = (await res.json()) as { version?: string };
    if (version && compareVersions(version, chrome.runtime.getManifest().version) > 0) {
      $("#updateLink").onclick = () =>
        void chrome.tabs.create({ url: `${settings.platformUrl}/extension` });
      $("#update").hidden = false;
    }
  } catch {
    // Offline or no access yet: try again next time the panel opens.
  }
}

fillSettings();
if (needsSetup()) showTab("settings");
void checkForUpdate();
