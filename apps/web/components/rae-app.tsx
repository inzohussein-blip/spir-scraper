"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RaeGuide } from "./rae-guide";
import { Badge, Card, cx, Notice } from "./ui";

/**
 * The «reverse-api-engineer» window. Everything here talks to the local
 * bridge (rae-bridge.py) straight from the browser: no request goes to the
 * platform's servers, so it costs nothing on Vercel or the database.
 */

type Status = {
  bridge: string;
  rae: string | null;
  config: Record<string, string | null>;
  keys: Record<string, boolean>;
  running: string | null;
  blocked_hosts: string[];
};
type JobState = {
  job_id: string;
  label: string;
  events: Record<string, unknown>[];
  next: number;
  done: boolean;
  exit_code: number | null;
  result: Record<string, unknown> | null;
  log: string[];
  seconds: number;
};
type RunFile = { name: string; size: number; content: string | null };

type Provider = {
  id: string;
  company: string;
  sdk: "claude" | "opencode" | "codex" | "cursor" | "copilot";
  /** OpenCode's provider id, when the SDK is opencode. */
  via?: string;
  /** Environment variable the SDK reads its key from. */
  key?: string;
  /** Where the model name goes in reverse-api-engineer's settings. */
  modelField: string;
  model?: string;
  note: string;
  free?: boolean;
};

/** The best-known AI companies, through the SDKs reverse-api-engineer supports. */
const PROVIDERS: Provider[] = [
  {
    id: "opencode",
    company: "OpenCode (نموذج مجاني)",
    sdk: "opencode",
    via: "opencode",
    modelField: "opencode_model",
    model: "big-pickle",
    note: "بلا مفتاح ولا تكلفة. يحتاج Node.js 20 فما فوق، ويُشغَّل وحده.",
    free: true,
  },
  {
    id: "anthropic",
    company: "Anthropic Claude",
    sdk: "claude",
    key: "ANTHROPIC_API_KEY",
    modelField: "claude_code_model",
    model: "claude-sonnet-5-5",
    note: "الأفضل جودة. مفتاح API، أو تسجيل دخول Claude Code على هذا الجهاز بدل المفتاح.",
  },
  {
    id: "openai",
    company: "OpenAI (مفتاح API)",
    sdk: "opencode",
    via: "openai",
    key: "OPENAI_API_KEY",
    modelField: "opencode_model",
    note: "عبر OpenCode بمفتاحك من platform.openai.com.",
  },
  {
    id: "codex",
    company: "OpenAI Codex (حساب ChatGPT)",
    sdk: "codex",
    modelField: "codex_model",
    note: "ثبّت reverse-api-engineer[codex] ثم سجّل الدخول مرة: codex login.",
  },
  {
    id: "google",
    company: "Google Gemini",
    sdk: "opencode",
    via: "google",
    key: "GOOGLE_GENERATIVE_AI_API_KEY",
    modelField: "opencode_model",
    note: "عبر OpenCode بمفتاح من Google AI Studio.",
  },
  {
    id: "deepseek",
    company: "DeepSeek",
    sdk: "opencode",
    via: "deepseek",
    key: "DEEPSEEK_API_KEY",
    modelField: "opencode_model",
    note: "عبر OpenCode، رخيص.",
  },
  {
    id: "xai",
    company: "xAI Grok",
    sdk: "opencode",
    via: "xai",
    key: "XAI_API_KEY",
    modelField: "opencode_model",
    note: "عبر OpenCode.",
  },
  {
    id: "mistral",
    company: "Mistral",
    sdk: "opencode",
    via: "mistral",
    key: "MISTRAL_API_KEY",
    modelField: "opencode_model",
    note: "عبر OpenCode.",
  },
  {
    id: "groq",
    company: "Groq",
    sdk: "opencode",
    via: "groq",
    key: "GROQ_API_KEY",
    modelField: "opencode_model",
    note: "عبر OpenCode، سريع.",
  },
  {
    id: "openrouter",
    company: "OpenRouter (مئات النماذج)",
    sdk: "opencode",
    via: "openrouter",
    key: "OPENROUTER_API_KEY",
    modelField: "opencode_model",
    note: "مفتاح واحد لنماذج كثيرة من شركات مختلفة.",
  },
  {
    id: "copilot",
    company: "GitHub Copilot",
    sdk: "copilot",
    key: "GITHUB_COPILOT_TOKEN",
    modelField: "copilot_model",
    note: "باشتراك Copilot.",
  },
  {
    id: "cursor",
    company: "Cursor",
    sdk: "cursor",
    key: "CURSOR_API_KEY",
    modelField: "cursor_model",
    note: "باشتراك Cursor.",
  },
  {
    id: "ollama",
    company: "Ollama (على جهازك)",
    sdk: "opencode",
    via: "ollama",
    modelField: "opencode_model",
    note: "مجاني تماماً، لكنه يحتاج جهازاً قوياً ونموذجاً مثبتاً يدعم الأدوات (سياق 64k فما فوق).",
    free: true,
  },
];

const LANGUAGES = [
  ["typescript", "TypeScript"],
  ["python", "Python"],
  ["javascript", "JavaScript"],
  ["go", "Go"],
  ["java", "Java"],
  ["csharp", "C#"],
  ["php", "PHP"],
  ["ruby", "Ruby"],
  ["c", "C"],
  ["powershell", "PowerShell"],
] as const;

const BROWSERS = [
  ["auto", "متصفح منفصل (Playwright): بلا حساباتك، ويحفظ التسجيل لإعادة التوليد"],
  ["agent-browser", "agent-browser من Vercel: متصفح منفصل، ويحفظ التسجيل"],
  ["chrome-mcp", "Chrome الحقيقي: بحساباتك المسجّلة (انتبه: الوكيل يتصرف فيها)"],
] as const;

const DEFAULT_URL = "http://127.0.0.1:7466";
const STORE = "spir-rae-bridge";

function loadSaved(): { url: string; token: string } {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? "{}");
    return { url: v.url || DEFAULT_URL, token: v.token || "" };
  } catch {
    return { url: DEFAULT_URL, token: "" };
  }
}

function download(name: string, content: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name.replace(/[\\/]/g, "_");
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const btn =
  "inline-flex items-center justify-center gap-1.5 rounded-[10px] border px-3.5 py-2 text-sm font-medium disabled:opacity-50";
const primary = `${btn} border-accent bg-accent text-accent-text`;
const secondary = `${btn} border-line bg-surface hover:bg-surface-2`;
const input = "w-full rounded-[10px] border border-line bg-surface px-3 py-2 text-sm";

export function RaeApp() {
  // The address the bridge must allow is this page's own (known only in the browser:
  // the window is built once, before any deployment address exists).
  const [origin, setOrigin] = useState("https://<موقعك>");
  useEffect(() => setOrigin(window.location.origin), []);
  const [conn, setConn] = useState<{ url: string; token: string }>({ url: DEFAULT_URL, token: "" });
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [provider, setProvider] = useState("opencode");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [language, setLanguage] = useState("typescript");
  const [browser, setBrowser] = useState("auto");
  const [url, setUrl] = useState("");
  const [goal, setGoal] = useState("");
  const [headless, setHeadless] = useState(true);
  const [check, setCheck] = useState<unknown>(null);
  const [job, setJob] = useState<JobState | null>(null);
  const [runs, setRuns] = useState<Record<string, unknown>[] | null>(null);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<{ id: string; files: RunFile[]; folder: string | null } | null>(
    null,
  );
  const [shown, setShown] = useState<string | null>(null);
  const [refine, setRefine] = useState("");
  const [fresh, setFresh] = useState(false);
  const jobRef = useRef<JobState | null>(null);

  const api = useCallback(
    async <T,>(path: string, init?: { method?: string; body?: unknown }): Promise<T> => {
      const res = await fetch(`${conn.url.replace(/\/$/, "")}${path}`, {
        method: init?.method ?? "GET",
        headers: { authorization: `Bearer ${conn.token}`, "content-type": "application/json" },
        ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data as T;
    },
    [conn],
  );

  const connect = useCallback(
    async (c = conn) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`${c.url.replace(/\/$/, "")}/status`, {
          headers: { authorization: `Bearer ${c.token}` },
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setStatus(data as Status);
        try {
          localStorage.setItem(STORE, JSON.stringify(c));
        } catch {
          // Storage blocked: the token lasts for this page only.
        }
        const cfg = (data as Status).config;
        const p =
          PROVIDERS.find((x) => x.sdk === cfg.sdk && (!x.via || x.via === cfg.opencode_provider)) ??
          null;
        if (p) {
          setProvider(p.id);
          setModel(String(cfg[p.modelField] ?? ""));
        }
        if (cfg.output_language) setLanguage(cfg.output_language);
        if (cfg.agent_provider) setBrowser(cfg.agent_provider);
      } catch (e) {
        setStatus(null);
        setError(
          e instanceof TypeError
            ? "لا يوجد جسر يعمل على هذا العنوان. شغّله بالأمر في الأسفل، ثم اضغط «اتصل»."
            : (e as Error).message,
        );
      } finally {
        setBusy(false);
      }
    },
    [conn],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once, with the saved connection
  useEffect(() => {
    const c = loadSaved();
    setConn(c);
    if (c.token) void connect(c);
  }, []);

  const loadRuns = useCallback(async () => {
    try {
      const r = await api<{ runs: Record<string, unknown>[] | null }>(
        `/runs${search ? `?search=${encodeURIComponent(search)}` : ""}`,
      );
      setRuns(Array.isArray(r.runs) ? r.runs : []);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, search]);

  useEffect(() => {
    if (status) void loadRuns();
  }, [status, loadRuns]);

  // Follow a running capture: the browser asks the bridge on this computer every 2 seconds.
  useEffect(() => {
    if (!job || job.done) return;
    const t = setTimeout(async () => {
      try {
        const next = await api<JobState>(`/jobs/${job.job_id}?from=0`);
        jobRef.current = next;
        setJob(next);
        if (next.done) void loadRuns();
      } catch (e) {
        setError((e as Error).message);
      }
    }, 2000);
    return () => clearTimeout(t);
  }, [job, api, loadRuns]);

  const current = useMemo(
    () => PROVIDERS.find((p) => p.id === provider) ?? PROVIDERS[0],
    [provider],
  );

  async function saveSettings() {
    if (!current) return;
    setBusy(true);
    setSaved(null);
    try {
      const body: Record<string, string | null> = {
        sdk: current.sdk,
        output_language: language,
        agent_provider: browser,
        [current.modelField]: model.trim() || current.model || null,
      };
      if (current.via) body.opencode_provider = current.via;
      let s = await api<Status>("/config", { method: "PUT", body });
      if (current.key && apiKey.trim())
        s = await api<Status>("/keys", { method: "PUT", body: { [current.key]: apiKey.trim() } });
      setApiKey("");
      setStatus(s);
      setSaved("حُفظت الإعدادات على جهازك.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function dryRun() {
    setBusy(true);
    setCheck(null);
    setError(null);
    try {
      const r = await api<{ result: unknown }>("/dry-run", {
        method: "POST",
        body: { url, prompt: goal, headless },
      });
      setCheck(r.result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ job_id: string }>("/jobs", {
        method: "POST",
        body: { url, prompt: goal, headless },
      });
      setJob({
        job_id: r.job_id,
        label: url,
        events: [],
        next: 0,
        done: false,
        exit_code: null,
        result: null,
        log: [],
        seconds: 0,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function openRun(id: string) {
    try {
      const r = await api<{ files: RunFile[]; folder: string | null }>(
        `/runs/${encodeURIComponent(id)}/files`,
      );
      setOpen({ id, files: r.files, folder: r.folder });
      setShown(
        r.files.find((f) => /api_client|client/i.test(f.name))?.name ?? r.files[0]?.name ?? null,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function engineer() {
    if (!open) return;
    setBusy(true);
    try {
      const r = await api<{ job_id: string }>(`/runs/${encodeURIComponent(open.id)}/engineer`, {
        method: "POST",
        body: { prompt: refine, fresh },
      });
      setJob({
        job_id: r.job_id,
        label: open.id,
        events: [],
        next: 0,
        done: false,
        exit_code: null,
        result: null,
        log: [],
        seconds: 0,
      });
      setRefine("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const runCmd = `python rae-bridge.py --origin ${origin}`;
  const mcpJson = JSON.stringify(
    {
      mcpServers: {
        "reverse-api-engineer": { command: "python", args: ["/path/to/rae-bridge.py", "mcp"] },
      },
    },
    null,
    2,
  );
  const file = open?.files.find((f) => f.name === shown) ?? null;
  const cost = Number(
    (job?.result?.usage as { total_cost_usd?: number } | undefined)?.total_cost_usd ?? 0,
  );

  return (
    <div className="space-y-4">
      <Card
        title="الاتصال بجهازك"
        icon="plug"
        description="النافذة تكلّم برنامجاً صغيراً على جهازك مباشرة. لا يمر شيء بخوادم المنصة."
        actions={
          status ? (
            <Badge tone="ok">متصل · الجسر {status.bridge}</Badge>
          ) : (
            <Badge tone="warn">غير متصل</Badge>
          )
        }
      >
        <div className="grid gap-3 sm:grid-cols-[1fr_1.4fr_auto] sm:items-end">
          <label className="space-y-1 text-sm">
            <span className="text-fg-2">عنوان الجسر</span>
            <input
              className={cx(input, "ltr")}
              value={conn.url}
              onChange={(e) => setConn({ ...conn, url: e.target.value })}
              aria-label="عنوان الجسر"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-fg-2">رمز الربط (يظهر عند تشغيل الجسر)</span>
            <input
              className={cx(input, "ltr")}
              type="password"
              value={conn.token}
              onChange={(e) => setConn({ ...conn, token: e.target.value })}
              aria-label="رمز الربط"
            />
          </label>
          <button type="button" className={primary} disabled={busy} onClick={() => connect()}>
            اتصل
          </button>
        </div>
        {status && (
          <p className="mt-3 text-sm">
            reverse-api-engineer:{" "}
            {status.rae ? (
              <span className="ltr font-mono text-xs">{status.rae}</span>
            ) : (
              <span className="text-warn">غير مثبّت على هذا الجهاز (الخطوة 2 في الأسفل)</span>
            )}
            {status.running && <span className="ms-2 text-warn">· تشغيل جارٍ</span>}
          </p>
        )}
        {!status && (
          <ol className="mt-4 list-decimal space-y-2 ps-5 text-sm text-fg-2">
            <li>
              نزّل الجسر:{" "}
              <a href="/downloads/rae-bridge.py" download className="text-accent underline">
                rae-bridge.py
              </a>{" "}
              (Python فقط، بلا مكتبات إضافية).
            </li>
            <li>
              ثبّت الأداة مرة واحدة (Python 3.11 فما فوق، و Node.js 20 فما فوق):
              <pre className="ltr mt-1 overflow-x-auto rounded-lg bg-bg-2 p-2 text-xs">
                uv tool install reverse-api-engineer
              </pre>
            </li>
            <li>
              شغّل الجسر في مجلد التنزيل، والصق رمز الربط الذي يطبعه في الأعلى:
              <pre className="ltr mt-1 overflow-x-auto rounded-lg bg-bg-2 p-2 text-xs">
                {runCmd}
              </pre>
            </li>
          </ol>
        )}
      </Card>

      {error && <Notice tone="error">{error}</Notice>}

      {status && (
        <>
          <Card
            title="المزوّد والإعدادات"
            icon="settings"
            description="تُحفظ في إعدادات reverse-api-engineer على جهازك. المفاتيح لا تُرسل للمنصة ولا تُعاد للنافذة."
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-sm">
                <span className="text-fg-2">مزوّد الذكاء الاصطناعي</span>
                <select
                  className={input}
                  value={provider}
                  onChange={(e) => {
                    setProvider(e.target.value);
                    setModel("");
                  }}
                  aria-label="المزوّد"
                >
                  {PROVIDERS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.company}
                      {p.free ? " · مجاني" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-fg-2">النموذج</span>
                <input
                  className={cx(input, "ltr")}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={current?.model ?? "اسم النموذج من قائمة المزوّد"}
                  aria-label="النموذج"
                />
              </label>
              {current?.key && (
                <label className="space-y-1 text-sm sm:col-span-2">
                  <span className="text-fg-2">
                    المفتاح ({current.key}){" "}
                    {status.keys[current.key] ? (
                      <Badge tone="ok">محفوظ على جهازك</Badge>
                    ) : (
                      <Badge tone="plain">غير محفوظ</Badge>
                    )}
                  </span>
                  <input
                    className={cx(input, "ltr")}
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={status.keys[current.key] ? "اتركه فارغاً للإبقاء على المحفوظ" : ""}
                    aria-label="مفتاح المزوّد"
                  />
                </label>
              )}
              <p className="text-xs text-muted sm:col-span-2">{current?.note}</p>
              <label className="space-y-1 text-sm">
                <span className="text-fg-2">لغة الكود الناتج</span>
                <select
                  className={input}
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  aria-label="لغة الكود"
                >
                  {LANGUAGES.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-fg-2">المتصفح</span>
                <select
                  className={input}
                  value={browser}
                  onChange={(e) => setBrowser(e.target.value)}
                  aria-label="المتصفح"
                >
                  {BROWSERS.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button type="button" className={primary} disabled={busy} onClick={saveSettings}>
                احفظ
              </button>
              {saved && <span className="text-sm text-ok">{saved}</span>}
            </div>
          </Card>

          <Card
            title="تشغيل جديد"
            icon="play"
            description="اكتب البيانات التي تريدها، لا الضغطات: «قائمة الوسطاء المرخصين مع الاسم والرقم والموقع، مع كل الصفحات»."
          >
            <div className="space-y-3">
              <label className="block space-y-1 text-sm">
                <span className="text-fg-2">رابط الموقع</span>
                <input
                  className={cx(input, "ltr")}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com"
                  aria-label="رابط الموقع"
                />
              </label>
              <label className="block space-y-1 text-sm">
                <span className="text-fg-2">الهدف</span>
                <textarea
                  className={input}
                  rows={2}
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                  aria-label="الهدف"
                />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={headless}
                  onChange={(e) => setHeadless(e.target.checked)}
                />
                بلا نافذة متصفح ظاهرة (للمواقع العامة)
              </label>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={secondary}
                  disabled={busy || !url || !goal}
                  onClick={dryRun}
                >
                  فحص مسبق (بلا تكلفة)
                </button>
                <button
                  type="button"
                  className={primary}
                  disabled={busy || !url || !goal || !!(job && !job.done)}
                  onClick={start}
                >
                  ابدأ التشغيل
                </button>
              </div>
              <p className="text-xs text-muted">
                ممنوع: {status.blocked_hosts.slice(0, 5).join("، ")}… (واجهاتها الداخلية ليست
                للاستعمال دون إذنها). احترم شروط كل موقع. التشغيل يأخذ دقائق ويستهلك من مزوّد الذكاء
                الاصطناعي.
              </p>
              {check !== null && (
                <pre className="ltr max-h-64 overflow-auto rounded-lg bg-bg-2 p-3 text-xs">
                  {JSON.stringify(check, null, 2)}
                </pre>
              )}
            </div>
          </Card>

          {job && (
            <Card
              title={
                job.done ? (job.exit_code === 0 ? "انتهى التشغيل" : "فشل التشغيل") : "جارٍ التشغيل…"
              }
              icon="activity"
              description={`${job.label} · ${job.seconds} ثانية${cost > 0 ? ` · التكلفة $${cost.toFixed(3)}` : ""}`}
              actions={
                !job.done ? (
                  <button
                    type="button"
                    className={secondary}
                    onClick={() => api(`/jobs/${job.job_id}/cancel`, { method: "POST" })}
                  >
                    أوقف
                  </button>
                ) : job.result?.run_id ? (
                  <button
                    type="button"
                    className={primary}
                    onClick={() => openRun(String(job.result?.run_id))}
                  >
                    اعرض الكود
                  </button>
                ) : null
              }
            >
              <pre
                className="ltr max-h-72 overflow-auto rounded-lg bg-bg-2 p-3 text-xs"
                data-rae-log
              >
                {job.events
                  .map((e) =>
                    e.event === "result"
                      ? `✓ ${e.status} ${e.run_id ?? ""} ${e.error ?? ""}`
                      : String(e.text ?? e.message ?? e.event ?? JSON.stringify(e)),
                  )
                  .concat(job.done ? job.log.slice(-5) : [])
                  .join("\n") || "…"}
              </pre>
            </Card>
          )}

          <Card
            title="التشغيلات السابقة"
            icon="clock"
            flush
            actions={
              <div className="flex gap-2">
                <input
                  className={cx(input, "w-48")}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="بحث"
                  aria-label="بحث في التشغيلات"
                />
                <button type="button" className={secondary} onClick={loadRuns}>
                  تحديث
                </button>
              </div>
            }
          >
            <ul className="divide-y divide-line">
              {(runs ?? []).length === 0 && (
                <li className="px-[18px] py-5 text-center text-sm text-muted">لا تشغيلات بعد.</li>
              )}
              {(runs ?? []).map((r) => {
                const id = String(r.run_id ?? r.id ?? "");
                return (
                  <li key={id} className="flex flex-wrap items-center gap-3 px-[18px] py-3 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{String(r.prompt ?? r.name ?? id)}</div>
                      <div className="ltr truncate text-xs text-muted">
                        {id} {r.url ? `· ${String(r.url)}` : ""}
                      </div>
                    </div>
                    {Number(r.file_count ?? 0) > 0 ? (
                      <Badge tone="ok">{String(r.file_count)} ملف</Badge>
                    ) : (
                      <Badge tone="plain">بلا كود</Badge>
                    )}
                    <button type="button" className={secondary} onClick={() => openRun(id)}>
                      افتح
                    </button>
                  </li>
                );
              })}
            </ul>
          </Card>

          {open && (
            <Card
              title={`الكود: ${open.id}`}
              icon="sheet"
              description={open.folder ? `على جهازك: ${open.folder}` : "لم يُنتج هذا التشغيل كوداً."}
            >
              <Notice tone="warn">
                هذا كود كتبه الذكاء الاصطناعي: راجعه قبل تشغيله. النافذة لا تشغّله، فشغّله بنفسك من
                جهازك بعد المراجعة. وإن أعجبك، أعطه لي في جلسة لأحوّله إلى أداة في المتجر.
              </Notice>
              <div className="mt-3 flex flex-wrap gap-2">
                {open.files.map((f) => (
                  <button
                    key={f.name}
                    type="button"
                    onClick={() => setShown(f.name)}
                    className={cx(
                      "rounded-full border px-3 py-1 text-xs ltr",
                      shown === f.name ? "border-accent bg-accent-soft text-accent" : "border-line",
                    )}
                  >
                    {f.name}
                  </button>
                ))}
              </div>
              {file && (
                <div className="mt-3">
                  <div className="mb-2 flex gap-2">
                    <button
                      type="button"
                      className={secondary}
                      disabled={file.content === null}
                      onClick={() => navigator.clipboard?.writeText(file.content ?? "")}
                    >
                      انسخ
                    </button>
                    <button
                      type="button"
                      className={secondary}
                      disabled={file.content === null}
                      onClick={() => download(file.name, file.content ?? "")}
                    >
                      نزّل
                    </button>
                  </div>
                  <pre
                    className="ltr max-h-[28rem] overflow-auto rounded-lg bg-bg-2 p-3 text-xs"
                    data-rae-code
                  >
                    {file.content ?? "الملف أكبر من أن يُعرض هنا: افتحه من المجلد على جهازك."}
                  </pre>
                </div>
              )}
              <div className="mt-4 space-y-2 border-t border-line pt-4">
                <div className="text-sm font-medium">حسّن الكود من نفس التسجيل (بلا تصفح جديد)</div>
                <textarea
                  className={input}
                  rows={2}
                  value={refine}
                  onChange={(e) => setRefine(e.target.value)}
                  placeholder="أضف الصفحات التالية ونوعاً لكل عنصر"
                  aria-label="تحسين الكود"
                />
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={fresh}
                    onChange={(e) => setFresh(e.target.checked)}
                  />
                  ابدأ من جديد من التسجيل (بدل البناء على الكود الحالي)
                </label>
                <button type="button" className={secondary} disabled={busy} onClick={engineer}>
                  حسّن
                </button>
              </div>
            </Card>
          )}

          <Card
            title="استعماله من Claude (MCP على جهازك)"
            icon="sparkles"
            description="الجسر نفسه خادم MCP محلي: Claude Desktop أو Claude Code يشغّلان الأداة على جهازك، بلا المنصة."
          >
            <p className="text-sm text-fg-2">Claude Code:</p>
            <pre className="ltr mt-1 overflow-x-auto rounded-lg bg-bg-2 p-2 text-xs">
              claude mcp add reverse-api-engineer -- python /path/to/rae-bridge.py mcp
            </pre>
            <p className="mt-3 text-sm text-fg-2">Claude Desktop (claude_desktop_config.json):</p>
            <pre className="ltr mt-1 overflow-x-auto rounded-lg bg-bg-2 p-2 text-xs">{mcpJson}</pre>
          </Card>
        </>
      )}

      <RaeGuide origin={origin} />
    </div>
  );
}
