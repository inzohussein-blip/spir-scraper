import { parseSource, type Source, SourceError, uploadSource } from "@scrapers/core";
import { escapeHtml } from "./telegram.js";

/** What the Telegram commands need from the runtime. */
export interface CommandContext {
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
].join("\n");

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
