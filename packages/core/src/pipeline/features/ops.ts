import { engineWorkers, leads, profiles } from "@scrapers/db";
import { and, desc, eq, gte, isNotNull, or, sql } from "drizzle-orm";
import type { FeatureContext } from "./context.js";

/** The service methods the daily manager uses (typed here to keep modules independent). */
interface OpsSelf {
  listProjects(): Promise<{ id: string; name: string }[]>;
  budgetPlan(
    projectId: string,
    budgetUsd: number,
  ): Promise<{
    lines: {
      source: string;
      decision: string;
      monitorId: string | null;
      monitorEnabled: boolean | null;
    }[];
  }>;
  marketIndex(now?: Date): Promise<{ competitors: { username: string; percent: number | null }[] }>;
  engineStatus(now?: Date): Promise<{ state: string; readToday: number; queued: number }>;
  listEngineRuns(limit?: number): Promise<{ status: string }[]>;
  setMonitorEnabled(id: string, enabled: boolean): Promise<void>;
  saveEngineSettings(input: { enabled: boolean }): Promise<unknown>;
  analyzeCompetitor(input: { username: string }): Promise<{
    username: string;
    followers: number | null;
    brief: string | null;
    growth: { percent: number | null } | null;
    analysis: { bestHour?: number | null } | unknown;
  }>;
}

export type OpsButton = { text: string; data: string };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The daily operations manager on Telegram: one morning message with what
 * happened, who to contact and the buttons for the day's decisions. Nothing
 * happens without the owner pressing a button, and no message is ever sent
 * to a lead from here.
 */
export function opsMethods(ctx: FeatureContext) {
  const { db, notify, getValue, setValue } = ctx;
  const self = () => ctx.self() as unknown as OpsSelf;

  /** New leads with a way to reach them, best first (the project's model, then AI score). */
  async function toContact(limit: number, since?: Date) {
    return db
      .select({
        projectId: leads.projectId,
        username: profiles.username,
        fullName: profiles.fullName,
        winProb: leads.winProb,
        aiScore: leads.aiScore,
        email: leads.email,
        phone: leads.phoneE164,
      })
      .from(leads)
      .innerJoin(profiles, eq(profiles.igUserId, leads.profileId))
      .where(
        and(
          eq(leads.status, "new"),
          or(isNotNull(leads.email), isNotNull(leads.phoneE164)),
          ...(since ? [gte(leads.createdAt, since)] : []),
        ),
      )
      .orderBy(
        sql`${leads.winProb} desc nulls last`,
        sql`${leads.aiScore} desc nulls last`,
        desc(leads.createdAt),
      )
      .limit(limit);
  }

  /** No device has asked for work in `hours` while runs are waiting. */
  async function devicesSilent(now: Date, hours: number) {
    const runs = await self().listEngineRuns(20);
    if (!runs.some((r) => r.status === "active")) return false;
    const [w] = await db
      .select({ id: engineWorkers.id })
      .from(engineWorkers)
      .where(
        and(
          eq(engineWorkers.disabled, false),
          gte(engineWorkers.lastSeen, new Date(now.getTime() - hours * 3600_000)),
        ),
      )
      .limit(1);
    return !w;
  }

  return {
    /**
     * The morning message (once a day): yesterday in numbers, the engine, who
     * to contact first, and buttons. Null when it was already sent today.
     */
    async dailyOps(now = new Date()): Promise<{ html: string; buttons: OpsButton[] } | null> {
      const day = now.toISOString().slice(0, 10);
      if (await getValue(`ops:day:${day}`)) return null;
      const since = new Date(now.getTime() - 86_400_000);
      const [y] = await db
        .select({
          added: sql<number>`count(*) filter (where ${leads.createdAt} >= ${since})::int`,
          interested: sql<number>`count(*) filter (where ${leads.status} = 'interested' and ${leads.statusAt} >= ${since})::int`,
          customers: sql<number>`count(*) filter (where ${leads.status} = 'customer' and ${leads.statusAt} >= ${since})::int`,
          revenue: sql<number>`coalesce(sum(${leads.dealValue}) filter (where ${leads.dealAt} >= ${since}), 0)::float`,
        })
        .from(leads);
      const engine = await self().engineStatus(now);
      const silent = await devicesSilent(now, 12);
      const top = await toContact(5);
      const lines = [
        "☀️ <b>صباح الخير: ملخص آخر 24 ساعة</b>",
        `• عملاء جدد: ${y?.added ?? 0} · مهتمون: ${y?.interested ?? 0} · عملاء: ${y?.customers ?? 0}${
          Number(y?.revenue) ? ` · صفقات: $${Math.round(Number(y?.revenue))}` : ""
        }`,
        `• محرك Spir: قرأ ${engine.readToday}، وفي الطابور ${engine.queued}${
          silent ? "\n⚠️ لا يوجد جهاز متصل منذ 12 ساعة: افتح المتصفح أو شغّل البرنامج المنزلي." : ""
        }`,
      ];
      if (top.length)
        lines.push(
          "",
          "<b>تواصل معهم أولاً</b>",
          ...top.map(
            (l) =>
              `• @${esc(l.username)}${l.fullName ? ` (${esc(l.fullName.slice(0, 30))})` : ""}${
                l.winProb !== null
                  ? ` · ${l.winProb}%`
                  : l.aiScore !== null
                    ? ` · ${l.aiScore}/100`
                    : ""
              }`,
          ),
        );
      const buttons: OpsButton[] = [];
      if (top.length) buttons.push({ text: "📞 قائمة التواصل مع الروابط", data: "ops:contacts" });
      // The competitor growing fastest, to analyse.
      const market = await self()
        .marketIndex(now)
        .catch(() => ({ competitors: [] }));
      const fast = market.competitors.find((c) => (c.percent ?? 0) > 0);
      if (fast) {
        lines.push("", `📈 الأسرع نمواً: @${esc(fast.username)} (${fast.percent}%)`);
        buttons.push({ text: `🔍 حلّل @${fast.username}`, data: `ops:analyze:${fast.username}` });
      }
      // A source the budget plan says to stop, still running.
      for (const p of await self().listProjects()) {
        const plan = await self()
          .budgetPlan(p.id, 5)
          .catch(() => ({ lines: [] }));
        const losing = plan.lines.find(
          (l) => l.decision === "stop" && l.monitorId && l.monitorEnabled,
        );
        if (losing?.monitorId) {
          lines.push(`⏸ مصدر خاسر في «${esc(p.name)}»: ${esc(losing.source.slice(0, 60))}`);
          buttons.push({ text: "⏸ أوقف المصدر الخاسر", data: `ops:pause:${losing.monitorId}` });
          break;
        }
      }
      buttons.push(
        engine.state === "paused"
          ? { text: "▶️ شغّل المحرك", data: "ops:engine:on" }
          : { text: "⏸ أوقف المحرك اليوم", data: "ops:engine:off" },
      );
      await setValue(`ops:day:${day}`, true, 3 * 86_400_000);
      if (silent)
        await notify({
          type: "system",
          level: "warn",
          title: "لا يوجد جهاز متصل بمحرك Spir",
          body: "مرت 12 ساعة بلا اتصال من المتصفح أو البرنامج المنزلي، وهناك تشغيلات تنتظر.",
          url: "/workers",
          key: `engine-silent:${day}`,
        });
      return { html: lines.join("\n"), buttons };
    },

    /** A button from the morning message. Returns the reply (HTML). */
    async opsAction(data: string, appUrl?: string): Promise<string> {
      const [, action, arg] = data.split(":");
      const base = appUrl?.replace(/\/$/, "");
      if (action === "contacts") {
        const list = await toContact(10);
        if (list.length === 0) return "لا يوجد عملاء جدد لديهم وسيلة تواصل.";
        return [
          "<b>تواصل معهم</b> (الرسالة منك، والقالب في صفحة العملاء):",
          ...list.map((l) => {
            const wa = l.phone
              ? ` · <a href="https://wa.me/${l.phone.replace(/\D/g, "")}">واتساب</a>`
              : "";
            const mail = l.email ? ` · ${esc(l.email)}` : "";
            const open = base
              ? ` · <a href="${esc(`${base}/leads/${l.username}?project=${l.projectId}`)}">اللوحة</a>`
              : "";
            return `• @${esc(l.username)}${wa}${mail}${open}`;
          }),
        ].join("\n");
      }
      if (action === "analyze" && arg && /^[a-z0-9._]{1,30}$/.test(arg)) {
        const a = await self().analyzeCompetitor({ username: arg });
        const growth = a.growth?.percent != null ? ` · نمو ${a.growth.percent}%` : "";
        return [
          `🔍 <b>@${esc(a.username)}</b>: ${a.followers ?? "?"} متابع${growth}`,
          a.brief
            ? esc(a.brief.slice(0, 3000))
            : "التحليل المكتوب يحتاج مفتاح الذكاء الاصطناعي؛ الأرقام في صفحة المنافسين.",
        ].join("\n");
      }
      if (action === "pause" && arg) {
        await self().setMonitorEnabled(arg, false);
        return "⏸ أُوقف المصدر الخاسر. تعيده من صفحة المنافسين متى شئت.";
      }
      if (action === "engine" && (arg === "on" || arg === "off")) {
        await self().saveEngineSettings({ enabled: arg === "on" });
        return arg === "on"
          ? "▶️ المحرك يعمل."
          : "⏸ أُوقف المحرك. شغّله من صفحة المحرك أو من هنا غداً.";
      }
      return "زر غير معروف";
    },
  };
}
