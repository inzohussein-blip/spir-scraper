import { usernameFromPath } from "./instagram.js";

/**
 * Runs on Instagram pages (declared in the manifest). When a profile is open
 * it shows a small badge: already a lead (with status and score) or new, with
 * a save button. It only reads the URL; the platform key stays in the
 * extension, which answers through the background worker.
 */

export type BadgeRequest =
  | { kind: "lead_lookup"; username: string }
  | { kind: "lead_save"; username: string };
export type BadgeAnswer =
  | { ok: true; enabled: boolean; lead: { status: string; aiScore: number | null } | null }
  | { ok: false; error: string };

const STATUS_AR: Record<string, string> = {
  new: "جديد",
  contacted: "تواصلت",
  interested: "مهتم",
  customer: "عميل",
  rejected: "مرفوض",
};

/** Set by the build: the test build opens the shadow root so the browser test can read it. */
declare const __E2E__: boolean;

type Win = typeof window & { __spirBadge?: boolean };
const w = window as Win;

if (!w.__spirBadge) {
  w.__spirBadge = true;
  let current: string | null = null;
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:16px;bottom:16px;z-index:2147483646;";
  // Closed, so the page's own scripts cannot read the lead's status from the badge.
  const root = host.attachShadow({ mode: __E2E__ ? "open" : "closed" });
  root.innerHTML = `<style>
    .b{font:13px/1.4 system-ui,Tahoma,sans-serif;direction:rtl;display:flex;gap:8px;align-items:center;
       padding:8px 12px;border-radius:999px;background:#1e2128;color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.25)}
    .dot{width:8px;height:8px;border-radius:50%;background:#9aa1b2}
    .ok .dot{background:#3ecf8e}.new .dot{background:#5b8cff}
    button{font:inherit;border:0;border-radius:999px;padding:3px 10px;background:#5b8cff;color:#fff;cursor:pointer}
    button:disabled{opacity:.6;cursor:default}
  </style><div class="b"><span class="dot"></span><span class="t"></span><button type="button" hidden>احفظ</button></div>`;
  const box = root.querySelector(".b") as HTMLDivElement;
  const text = root.querySelector(".t") as HTMLSpanElement;
  const save = root.querySelector("button") as HTMLButtonElement;

  const ask = (req: BadgeRequest) =>
    chrome.runtime.sendMessage(req) as Promise<BadgeAnswer | undefined>;

  function show(kind: "ok" | "new" | "err", label: string, canSave: boolean) {
    box.className = `b ${kind}`;
    text.textContent = label;
    save.hidden = !canSave;
    save.disabled = false;
    if (!host.isConnected) document.documentElement.append(host);
  }

  async function check() {
    const username = usernameFromPath(location.pathname);
    if (username === current) return;
    current = username;
    if (!username) {
      host.remove();
      return;
    }
    const res = await ask({ kind: "lead_lookup", username }).catch(() => undefined);
    if (current !== username) return;
    if (!res || (res.ok && !res.enabled)) {
      host.remove();
      return;
    }
    if (!res.ok) return show("err", res.error, false);
    if (res.lead) {
      const score = res.lead.aiScore === null ? "" : ` · ${res.lead.aiScore}`;
      show("ok", `في المنصة: ${STATUS_AR[res.lead.status] ?? res.lead.status}${score}`, false);
    } else show("new", "حساب جديد", true);
  }

  save.addEventListener("click", async () => {
    if (!current) return;
    save.disabled = true;
    const res = await ask({ kind: "lead_save", username: current }).catch(() => undefined);
    if (res?.ok) show("ok", "أُرسل للمنصة ✓", false);
    else show("err", res && !res.ok ? res.error : "تعذّر الحفظ", true);
  });

  // Instagram changes pages without reloading: watch the URL.
  void check();
  setInterval(() => void check(), 1000);
}
