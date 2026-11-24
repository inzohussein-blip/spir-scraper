import {
  type AccountRef,
  PLATFORM_LABELS,
  type Platform,
  parseAccountUrl,
  parseSource,
  type RemoteAccount,
  type Source,
  SourceError,
  uploadSource,
} from "@scrapers/core";
import { escapeHtml } from "./telegram.js";

/** What the Telegram commands need from the runtime. */
export interface CommandContext {
  /** The daily operations manager's buttons (ops:contacts, ops:analyze:x, ops:pause:id, ops:engine:on|off). */
  ops?: { opsAction(data: string, appUrl?: string): Promise<string> };
  scrapers: {
    listProjects(): Promise<{ id: string; name: string }[]>;
    createProject(input: { name: string; owner: string }): Promise<{ id: string; name: string }>;
    startJob(input: {
      projectId: string;
      source: Source;
      limit: number;
    }): Promise<{ job: { id: string; limit: number }; estimatedCostUsd: number }>;
    listJobs(opts?: {
      limit?: number;
    }): Promise<
      { id: string; status: string; sourceUrl: string; counts: Record<string, unknown> }[]
    >;
    listLeads(f: {
      projectId: string;
      limit?: number;
      minScore?: number;
    }): Promise<
      { username: string; aiScore: number | null; email: string | null; phone: string | null }[]
    >;
    overviewStats(): Promise<{
      leads: number;
      withContact: number;
      scored: number;
      activeJobs: number;
      jobsToday: number;
    }>;
  };
  /** Weekly plans waiting for the owner's approval. */
  plans?: {
    approvePlan(id: string): Promise<{ ok: boolean; reason?: string; changed?: number }>;
  };
  /** Optional readers used for links sent to the bot. */
  links?: {
    getStoredProfile(username: string): Promise<{
      username: string;
      fullName: string | null;
      followers: number | null;
      bio: string | null;
      sources: unknown[];
    } | null>;
    peekAccount(
      url: string,
    ): Promise<{ ref: AccountRef; account: RemoteAccount | null; error?: string } | null>;
    addAccount(input: { username: string; url: string }): Promise<{ ok: boolean; reason?: string }>;
    readPage(url: string): Promise<{
      title: string | null;
      description: string | null;
      emails: string[];
      phones: string[];
      accounts: { platform: string; handle: string; url: string }[];
    }>;
  };
  owner: string;
  appUrl?: string;
  /** Called after a job starts (Vercel: keep processing). */
  onJobStarted?: (jobId: string) => void;
}

const HELP = [
  "<b>أوامر Scrapers</b>",
  "/run &lt;رابط أو @حساب أو #هاشتاق&gt; [العدد] — ابدأ مهمة",
  "/run @a @b @c — اجلب حسابات محددة",
  "/status — المهام الجارية والأخيرة",
  "/top [العدد] — أفضل العملاء في المشروع",
  "/stats — الأرقام العامة",
  "/project &lt;الاسم&gt; — المشروع الذي تستخدمه الأوامر",
  "",
  "أرسل أي رابط بلا أمر: حساب إنستقرام أو تيك توك أو يوتيوب أو تلكرام أو موقع، فأقرأه لك.",
  "/link @حساب_إنستقرام — اربط آخر حساب أرسلته بعميل عندك",
].join("\n");

export interface BotReply {
  html: string;
  /** Inline buttons: each sends its `data` back as a callback. */
  buttons?: { text: string; data: string }[];
}

const fmt = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : n.toLocaleString("en");

/**
 * A message that is not a command: the first link (or @handle) in it is read
 * and summarised, with buttons for what can be done next.
 */
export async function handleLink(
  ctx: CommandContext,
  text: string,
  state: { project?: string; lastLink?: string } = {},
): Promise<BotReply | null> {
  if (!ctx.links) return null;
  const url = /https?:\/\/\S+|(?:www\.)?[a-z0-9-]+\.[a-z]{2,}(?:\/\S*)?/i.exec(text)?.[0];
  if (!url) return null;
  const ref = parseAccountUrl(url);
  if (ref?.platform === "instagram") {
    const p = await ctx.links.getStoredProfile(ref.handle);
    const lines = [`<b>@${escapeHtml(ref.handle)}</b> · إنستقرام`];
    if (p) {
      lines.push(
        `${escapeHtml(p.fullName ?? "")} · ${fmt(p.followers)} متابع`,
        escapeHtml((p.bio ?? "").slice(0, 300)),
        `موجود في ${p.sources.length} مشروع`,
      );
    } else lines.push("غير محفوظ بعد في المنصة.");
    return {
      html: lines.filter(Boolean).join("\n"),
      buttons: [{ text: p ? "حدّث بياناته" : "احفظ في المشروع", data: `save:${ref.handle}` }],
    };
  }
  if (ref && ref.platform !== "website") {
    state.lastLink = ref.url;
    const peek = await ctx.links.peekAccount(ref.url);
    const name = PLATFORM_LABELS[ref.platform as Platform] ?? ref.platform;
    const lines = [`<b>@${escapeHtml(ref.handle)}</b> · ${name}`];
    if (peek?.account) {
      const a = peek.account;
      lines.push(
        `${escapeHtml(a.displayName ?? "")} · ${fmt(a.followers)}`,
        escapeHtml((a.bio ?? "").slice(0, 300)),
      );
    } else if (peek?.error) lines.push(`تعذّرت القراءة: ${escapeHtml(peek.error.slice(0, 120))}`);
    else lines.push("لا تُقرأ هذه المنصة تلقائياً، لكن يمكن ربطها بعميل.");
    lines.push("", "لربطه بعميل: /link @حساب_إنستقرام");
    return { html: lines.filter((l, i) => l || i > 0).join("\n") };
  }
  try {
    const page = await ctx.links.readPage(url);
    const lines = [
      `<b>${escapeHtml(page.title ?? url)}</b>`,
      escapeHtml((page.description ?? "").slice(0, 300)),
      page.emails.length ? `✉️ ${escapeHtml(page.emails.slice(0, 3).join("، "))}` : "",
      page.phones.length ? `📞 ${escapeHtml(page.phones.slice(0, 3).join("، "))}` : "",
      page.accounts.length
        ? `حسابات: ${page.accounts
            .slice(0, 6)
            .map(
              (a) =>
                `${PLATFORM_LABELS[a.platform as Platform] ?? a.platform} @${escapeHtml(a.handle)}`,
            )
            .join("، ")}`
        : "",
    ];
    const ig = page.accounts.find((a) => a.platform === "instagram");
    return {
      html: lines.filter(Boolean).join("\n"),
      ...(ig ? { buttons: [{ text: `احفظ @${ig.handle}`, data: `save:${ig.handle}` }] } : {}),
    };
  } catch (err) {
    return { html: `تعذّرت قراءة الصفحة: ${escapeHtml((err as Error).message.slice(0, 160))}` };
  }
}

/** A button pressed under a bot reply. */
export async function handleCallback(
  ctx: CommandContext,
  data: string,
  state: { project?: string } = {},
): Promise<string> {
  if (data.startsWith("ops:")) {
    if (!ctx.ops) return "غير متاح هنا";
    return ctx.ops.opsAction(data, ctx.appUrl);
  }
  const plan = /^plan:([a-f0-9]{12})$/.exec(data);
  if (plan?.[1]) {
    if (!ctx.plans) return "الخطط غير متاحة هنا";
    const r = await ctx.plans.approvePlan(plan[1]);
    if (r.ok) return `✅ طُبّقت الخطة: تغيّرت ${r.changed} من مراقبات المنافسين.`;
    return r.reason === "applied"
      ? "طُبّقت هذه الخطة من قبل."
      : "انتهت صلاحية الخطة؛ تصلك خطة جديدة الأسبوع القادم.";
  }
  const save = /^save:([a-z0-9._]{1,30})$/.exec(data);
  if (!save?.[1]) return "زر غير معروف";
  // Save this one account (not its audience, which is what "/run @x" collects).
  const username = save[1];
  const all = await ctx.scrapers.listProjects();
  const project =
    (state.project ? all.find((p) => p.name === state.project) : undefined) ??
    all[0] ??
    (await ctx.scrapers.createProject({ name: "تلكرام", owner: ctx.owner }));
  const { job } = await ctx.scrapers.startJob({
    projectId: project.id,
    source: uploadSource([username], `تلكرام: @${username}`),
    limit: 1,
  });
  ctx.onJobStarted?.(job.id);
  const open = ctx.appUrl
    ? `\n<a href="${escapeHtml(`${ctx.appUrl.replace(/\/$/, "")}/leads/${username}?project=${project.id}`)}">فتح في اللوحة</a>`
    : "";
  return `🔄 بدأت قراءة @${escapeHtml(username)} وحفظه في <b>${escapeHtml(project.name)}</b>.${open}`;
}

const STATUS: Record<string, string> = {
  queued: "⏳",
  running: "🔄",
  done: "✅",
  failed: "⛔",
  cancelled: "✖️",
};

/**
 * Handles one Telegram command from the owner (idea from the Spir bot, which is
 * driven from Telegram). Returns the HTML reply. `state` keeps the chosen project.
 */
export async function handleCommand(
  ctx: CommandContext,
  text: string,
  state: { project?: string } = {},
): Promise<string> {
  const [rawCmd = "", ...args] = text.trim().split(/\s+/);
  const cmd = rawCmd.toLowerCase().replace(/@.*$/, "");

  const project = async () => {
    const all = await ctx.scrapers.listProjects();
    const named = state.project ? all.find((p) => p.name === state.project) : undefined;
    return (
      named ?? all[0] ?? (await ctx.scrapers.createProject({ name: "تلكرام", owner: ctx.owner }))
    );
  };
  const link = (path: string) =>
    ctx.appUrl
      ? `\n<a href="${escapeHtml(ctx.appUrl.replace(/\/$/, "") + path)}">فتح في اللوحة</a>`
      : "";

  switch (cmd) {
    case "/start":
    case "/help":
      return HELP;

    case "/link": {
      const s = state as { lastLink?: string };
      const user = (args[0] ?? "").replace(/^@/, "");
      if (!ctx.links) return "الربط غير متاح هنا";
      if (!s.lastLink) return "أرسل رابط الحساب أولاً، ثم /link @حساب_إنستقرام";
      if (!user) return "اكتب حساب إنستقرام للعميل بعد /link";
      const r = await ctx.links.addAccount({ username: user, url: s.lastLink });
      if (!r.ok)
        return r.reason === "taken"
          ? "هذا الحساب مربوط بعميل آخر"
          : r.reason === "no_lead"
            ? `@${escapeHtml(user)} غير محفوظ في المنصة بعد`
            : "تعذّر الربط";
      const done = s.lastLink;
      delete s.lastLink;
      return `رُبط ${escapeHtml(done)} بالعميل @${escapeHtml(user)}${link(`/leads/${user}`)}`;
    }

    case "/project": {
      const name = args.join(" ").trim();
      if (!name) return `المشروع الحالي: <b>${escapeHtml((await project()).name)}</b>`;
      const all = await ctx.scrapers.listProjects();
      const p =
        all.find((x) => x.name === name) ??
        (await ctx.scrapers.createProject({ name, owner: ctx.owner }));
      state.project = p.name;
      return `صار المشروع: <b>${escapeHtml(p.name)}</b>`;
    }

    case "/run": {
      if (args.length === 0) return "اكتب رابطاً أو @حساباً بعد /run";
      const last = args.at(-1) ?? "";
      const limit = /^\d+$/.test(last) ? Math.min(Number(last), 1000) : 100;
      const inputs = /^\d+$/.test(last) ? args.slice(0, -1) : args;
      let source: Source;
      try {
        if (inputs.length > 1) {
          source = uploadSource(
            inputs.map((u) => u.replace(/^@/, "").toLowerCase()),
            "telegram",
          );
        } else {
          source = parseSource(inputs[0] ?? "");
        }
      } catch (err) {
        return err instanceof SourceError ? `⛔ ${escapeHtml(err.message)}` : "⛔ مدخل غير صالح";
      }
      const p = await project();
      const { job, estimatedCostUsd } = await ctx.scrapers.startJob({
        projectId: p.id,
        source,
        limit,
      });
      ctx.onJobStarted?.(job.id);
      const cost =
        estimatedCostUsd > 0 ? ` · التكلفة التقديرية ≈ $${estimatedCostUsd.toFixed(2)}` : "";
      return `🔄 بدأت المهمة في <b>${escapeHtml(p.name)}</b> (حتى ${job.limit} حساب${cost}). يصلك إشعار عند انتهائها.${link(`/jobs/${job.id}`)}`;
    }

    case "/status": {
      const jobs = await ctx.scrapers.listJobs({ limit: 6 });
      if (jobs.length === 0) return "لا توجد مهام بعد.";
      return jobs
        .map((j) => {
          const c = j.counts as { discovered?: number; enriched?: number; leads?: number };
          return `${STATUS[j.status] ?? "•"} ${escapeHtml(j.sourceUrl).slice(0, 60)}\n   ${c.enriched ?? 0}/${c.discovered ?? 0} · بوسيلة تواصل ${c.leads ?? 0}`;
        })
        .join("\n");
    }

    case "/top": {
      const n = Math.min(Math.max(Number(args[0]) || 10, 1), 30);
      const p = await project();
      const leads = await ctx.scrapers.listLeads({ projectId: p.id, limit: n });
      if (leads.length === 0) return `لا عملاء في <b>${escapeHtml(p.name)}</b> بعد.`;
      const lines = leads.map((l, i) => {
        const contact = [l.email, l.phone].filter(Boolean).join(" · ");
        return `${i + 1}. @${escapeHtml(l.username)}${l.aiScore !== null ? ` (${l.aiScore})` : ""}${contact ? ` — ${escapeHtml(contact)}` : ""}`;
      });
      return `<b>أفضل ${leads.length} في ${escapeHtml(p.name)}</b>\n${lines.join("\n")}${link(`/leads?project=${p.id}`)}`;
    }

    case "/stats": {
      const s = await ctx.scrapers.overviewStats();
      return `العملاء: ${s.leads} (بوسيلة تواصل ${s.withContact}) · قُيّم ${s.scored}\nمهام اليوم: ${s.jobsToday} · تعمل الآن: ${s.activeJobs}`;
    }

    default:
      return `أمر غير معروف.\n\n${HELP}`;
  }
}
