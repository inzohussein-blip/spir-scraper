"use server";

import {
  parseSource,
  parseUsernameCsv,
  type Source,
  SourceError,
  uploadSource,
} from "@scrapers/core";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit, clientIp } from "@/lib/audit";
import {
  checkLoginCode,
  checkPassword,
  endSession,
  MAX_TRIES_PER_IP,
  MAX_TRIES_TOTAL,
  passwordSettingProblem,
  requireSession,
  sendLoginCode,
  startSession,
  twoFactorEnabled,
} from "@/lib/auth";
import { scheduleDrain } from "@/lib/drain";
import { appOrigin } from "@/lib/env";
import { getRuntime } from "@/lib/runtime";
import { telegramWebhookSecret } from "@/lib/telegram";
import { safeNext } from "@/lib/tokens";

export type ActionState = {
  error?: string;
  message?: string;
  url?: string;
  secret?: string;
} | null;

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" ? v.trim() : "";
};
const fail = (err: unknown): ActionState => ({
  error: err instanceof SourceError ? err.message : (err as Error).message || "حدث خطأ",
});

/** Refuses when too many wrong tries happened recently (per IP and in total). */
async function lockedOut(): Promise<boolean> {
  const tries = await (await getRuntime()).scrapers.failedLogins(await clientIp());
  return tries.ip >= MAX_TRIES_PER_IP || tries.all >= MAX_TRIES_TOTAL;
}

const LOCKED = "محاولات خاطئة كثيرة. حاول بعد 10 دقائق.";

export async function login(_: ActionState, form: FormData): Promise<ActionState> {
  // A missing or too short setting is the owner's to fix, not a wrong try.
  const setting = passwordSettingProblem();
  if (setting) return { error: setting };
  if (await lockedOut()) return { error: LOCKED };
  if (!checkPassword(str(form, "password"))) {
    await audit("login.failed", { stage: "password" }, "anonymous");
    return { error: "كلمة المرور غير صحيحة" };
  }
  const next = safeNext(str(form, "next"));
  if (await twoFactorEnabled()) {
    try {
      await sendLoginCode(next);
    } catch (err) {
      return { error: `تعذّر إرسال الكود على تلكرام: ${(err as Error).message}` };
    }
    await audit("login.code_sent", undefined, "anonymous");
    redirect("/login/verify");
  }
  await startSession();
  await audit("login.ok");
  redirect(next);
}

export async function verifyLoginCode(_: ActionState, form: FormData): Promise<ActionState> {
  if (await lockedOut()) return { error: LOCKED };
  const result = await checkLoginCode(str(form, "code"));
  if (result === "expired") return { error: "انتهت صلاحية الكود. سجّل الدخول من جديد." };
  if (result === null) {
    await audit("login.failed", { stage: "telegram_code" }, "anonymous");
    return { error: "الكود غير صحيح" };
  }
  await startSession();
  await audit("login.ok", { twoFactor: true });
  redirect(result);
}

export async function logout() {
  await audit("logout");
  await endSession();
  redirect("/login");
}

export async function createProject(_: ActionState, form: FormData): Promise<ActionState> {
  await requireSession();
  const name = str(form, "name");
  if (!name) return { error: "اكتب اسم المشروع" };
  try {
    const rt = await getRuntime();
    const retention = Number(str(form, "retention") || 90);
    await rt.scrapers.createProject({
      name,
      owner: rt.owner,
      retentionDays: Math.min(365, Math.max(1, retention)),
      ...(str(form, "sheet") ? { sheetId: str(form, "sheet") } : {}),
      ...(str(form, "criteria") ? { aiCriteria: str(form, "criteria") } : {}),
    });
  } catch (err) {
    return fail(err);
  }
  await audit("project.create", { name });
  revalidatePath("/");
  return { message: "أُنشئ المشروع" };
}

export async function startJob(_: ActionState, form: FormData): Promise<ActionState> {
  await requireSession("/jobs/new");
  let jobId: string;
  try {
    const rt = await getRuntime();
    const limit = Math.max(1, Math.min(Number(str(form, "limit") || 100), 5000));
    const file = form.get("csv");
    let source: Source;
    if (file instanceof File && file.size > 0) {
      if (file.size > 2_000_000) return { error: "الملف أكبر من 2MB" };
      const usernames = parseUsernameCsv(await file.text(), limit);
      if (usernames.length === 0) return { error: "لم أجد معرّفات صالحة في الملف" };
      source = uploadSource(usernames, file.name);
    } else if (str(form, "usernames")) {
      const usernames = parseUsernameCsv(str(form, "usernames"), limit);
      if (usernames.length === 0) return { error: "لم أجد معرّفات صالحة في القائمة" };
      source = uploadSource(usernames, "قائمة ملصقة");
    } else if (str(form, "source")) {
      const type = str(form, "type");
      source = parseSource(
        str(form, "source"),
        type === "hashtag" || type === "post" || type === "profile" || type === "followers"
          ? type
          : undefined,
      );
    } else {
      return { error: "أدخل رابطاً أو ارفع ملف CSV" };
    }
    const cost = rt.scrapers.estimateCost(source, limit);
    if (cost > 0 && form.get("accept_cost") !== "on") {
      return {
        error: `التكلفة التقديرية ≈ $${cost.toFixed(2)}. فعّل خيار الموافقة على التكلفة ثم أعد الإرسال.`,
      };
    }
    const { job } = await rt.scrapers.startJob({ projectId: str(form, "project"), source, limit });
    jobId = job.id;
    await audit("job.start", { jobId, source: source.url, limit });
  } catch (err) {
    return fail(err);
  }
  scheduleDrain({ force: true });
  redirect(`/jobs/${jobId}`);
}

export async function cancelJob(jobId: string) {
  await requireSession();
  await (await getRuntime()).scrapers.cancelJob(jobId);
  await audit("job.cancel", { jobId });
  revalidatePath(`/jobs/${jobId}`);
}

/** Called while a job page is open, so work continues without a worker. */
export async function keepJobMoving() {
  await requireSession();
  scheduleDrain();
}

export async function scoreJob(_: ActionState, form: FormData): Promise<ActionState> {
  await requireSession();
  const jobId = str(form, "job");
  const criteria = str(form, "criteria");
  if (criteria.length < 3) return { error: "اكتب معايير التقييم" };
  try {
    const r = await (await getRuntime()).scrapers.scoreLeads(jobId, criteria, {
      rescore: form.get("rescore") === "on",
    });
    revalidatePath(`/jobs/${jobId}`);
    if (r.mode === "batch") {
      return {
        message: `أُرسل ${r.count} حساباً للتقييم دفعةً واحدة، وتصل النتائج خلال ساعة تقريباً.`,
      };
    }
    return { message: r.count ? `قُيّم ${r.count} حساباً` : "لا توجد حسابات جديدة للتقييم" };
  } catch (err) {
    return fail(err);
  }
}

export async function buildReport(_: ActionState, form: FormData): Promise<ActionState> {
  await requireSession();
  const jobId = str(form, "job");
  try {
    const { report } = await (await getRuntime()).scrapers.audienceReport(jobId);
    revalidatePath(`/jobs/${jobId}`);
    return {
      message: report ? "كُتب التقرير" : "لا يكفي التقييم لكتابة تقرير بعد. قيّم العملاء أولاً.",
    };
  } catch (err) {
    return fail(err);
  }
}

export async function exportToSheet(_: ActionState, form: FormData): Promise<ActionState> {
  await requireSession();
  try {
    const mode = str(form, "mode");
    const r = await (await getRuntime()).exportLeads({
      projectId: str(form, "project"),
      format: "sheet",
      ...(str(form, "job") ? { jobId: str(form, "job") } : {}),
      ...(mode === "new-file" || mode === "new-tab" || mode === "append"
        ? { sheetMode: mode }
        : {}),
      ...(str(form, "spreadsheet") ? { spreadsheetId: str(form, "spreadsheet") } : {}),
      filters: {
        ...(form.get("business") ? { business: true } : {}),
        ...(form.get("has_phone") ? { hasPhone: true } : {}),
        ...(form.get("has_email") ? { hasEmail: true } : {}),
      },
    });
    if (r.kind !== "sheet") return { error: "نتيجة غير متوقعة" };
    await audit("export.sheet", { spreadsheetId: r.spreadsheetId, written: r.written });
    return { message: `كُتب ${r.written} عميلاً في تبويب «${r.tab}»`, url: r.url };
  } catch (err) {
    return fail(err);
  }
}

export async function suppress(_: ActionState, form: FormData): Promise<ActionState> {
  await requireSession();
  const kind = str(form, "kind");
  const value = str(form, "value");
  if (!value || (kind !== "username" && kind !== "email" && kind !== "phone"))
    return { error: "بيانات ناقصة" };
  try {
    await (await getRuntime()).scrapers.suppress(kind, value, "dashboard");
    await audit("suppress", { kind });
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/leads");
  return { message: "أُوقف وحُذفت بياناته" };
}

export async function createKey(_: ActionState, form: FormData): Promise<ActionState> {
  await requireSession();
  const name = str(form, "name") || "key";
  const scopes: ("read" | "write")[] = form.get("write") === "on" ? ["read", "write"] : ["read"];
  try {
    const k = await (await getRuntime()).scrapers.createApiKey(name, scopes);
    await audit("key.create", { name, scopes });
    revalidatePath("/settings");
    return { message: "انسخ المفتاح الآن، فلن يظهر مرة أخرى.", secret: k.key };
  } catch (err) {
    return fail(err);
  }
}

export async function revokeKey(id: string) {
  await requireSession();
  await (await getRuntime()).scrapers.revokeApiKey(id);
  await audit("key.revoke", { id });
  revalidatePath("/settings");
}

export async function markAllRead() {
  await requireSession();
  await (await getRuntime()).scrapers.markNotificationsRead();
  revalidatePath("/", "layout");
}

export async function sendTestNotification(): Promise<ActionState> {
  await requireSession();
  const rt = await getRuntime();
  if (!rt.telegram) return { error: "تلكرام غير مضبوط" };
  try {
    await rt.telegram.sendText("✅ <b>Scrapers</b>: الإشعارات تعمل.");
  } catch (err) {
    return fail(err);
  }
  return { message: "أُرسلت رسالة تجربة إلى تلكرام" };
}

export async function checkProviders(): Promise<ActionState> {
  await requireSession();
  const results = await (await getRuntime()).healthCheck();
  revalidatePath("/", "layout");
  if (results.length === 0) return { error: "لا يوجد مصدر مفعّل" };
  const lines = results.map((r) => `${r.ok ? "✓" : "✗"} ${r.provider}: ${r.detail}`).join(" · ");
  return results.every((r) => r.ok) ? { message: lines } : { error: lines };
}

export async function connectTelegramCommands(): Promise<ActionState> {
  await requireSession();
  const rt = await getRuntime();
  if (!rt.telegram) return { error: "تلكرام غير مضبوط" };
  const origin = appOrigin();
  if (!origin.startsWith("https://"))
    return { error: "يحتاج تلكرام رابطاً يبدأ بـ https (ضع APP_URL)" };
  try {
    await rt.telegram.setWebhook(`${origin}/api/telegram`, telegramWebhookSecret());
  } catch (err) {
    return fail(err);
  }
  await audit("telegram.webhook");
  return { message: "تم الربط. أرسل /help للبوت على تلكرام." };
}

const STATUSES = ["new", "contacted", "interested", "customer", "rejected"] as const;
type Status = (typeof STATUSES)[number];

export async function setLeadStatus(projectId: string, username: string, status: string) {
  await requireSession();
  if (!STATUSES.includes(status as Status)) return;
  await (await getRuntime()).scrapers.setLeadStatus({
    projectId,
    username,
    status: status as Status,
  });
  revalidatePath("/leads");
  revalidatePath("/leads/board");
}

export async function updateProjectSettings(_: ActionState, form: FormData): Promise<ActionState> {
  await requireSession();
  const id = str(form, "project");
  const keywords = str(form, "keywords")
    .split(/[,،\n]/)
    .map((k) => k.trim())
    .filter(Boolean)
    .slice(0, 50);
  try {
    await (await getRuntime()).scrapers.updateProject(id, {
      autoExport: form.get("auto_export") === "on",
      watchKeywords: keywords.length ? keywords : null,
      aiCriteria: str(form, "criteria") || null,
      sheetId: str(form, "sheet") || null,
      messageTemplate: str(form, "template").slice(0, 1000) || null,
      skipFake: form.get("skip_fake") === "on",
    });
  } catch (err) {
    return fail(err);
  }
  await audit("project.update", { id });
  revalidatePath("/leads");
  return { message: "حُفظت إعدادات المشروع" };
}

/** Sets (or clears, with an empty value) the day to be reminded about a lead. */
export async function setFollowUp(projectId: string, username: string, day: string) {
  await requireSession();
  const at = /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(`${day}T06:00:00Z`) : null;
  await (await getRuntime()).scrapers.setFollowUp({ projectId, username, at });
  await audit("lead.follow_up", { username, day: day || null });
  revalidatePath("/leads");
  revalidatePath("/leads/board");
}

export async function addMonitor(_: ActionState, form: FormData): Promise<ActionState> {
  await requireSession();
  try {
    const source = parseSource(str(form, "source"));
    await (await getRuntime()).scrapers.createMonitor({
      projectId: str(form, "project"),
      source,
      limit: Number(str(form, "limit") || 100),
      everyDays: Number(str(form, "every") || 7),
    });
  } catch (err) {
    return fail(err);
  }
  await audit("monitor.create", { source: str(form, "source") });
  revalidatePath("/leads");
  return { message: "أُضيفت المراقبة. تعمل مع المهمة اليومية وتجمع الحسابات الجديدة فقط." };
}

export async function toggleMonitor(id: string, enabled: boolean) {
  await requireSession();
  await (await getRuntime()).scrapers.setMonitorEnabled(id, enabled);
  revalidatePath("/leads");
}

export async function removeMonitor(id: string) {
  await requireSession();
  await (await getRuntime()).scrapers.deleteMonitor(id);
  await audit("monitor.delete", { id });
  revalidatePath("/leads");
}

const STATUS_VALUES = ["new", "contacted", "interested", "customer", "rejected"] as const;

/** Changes the ticked leads at once: status, follow-up day, or both. */
export async function bulkLeads(_: ActionState, form: FormData): Promise<ActionState> {
  await requireSession();
  const projectId = str(form, "project");
  const usernames = form
    .getAll("u")
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  if (usernames.length === 0) return { error: "اختر عميلاً واحداً على الأقل" };
  const status = STATUS_VALUES.find((s) => s === str(form, "bulk_status"));
  const day = str(form, "bulk_day");
  const followUpAt = /^\d{4}-\d{2}-\d{2}$/.test(day)
    ? new Date(`${day}T06:00:00Z`)
    : form.get("bulk_clear") === "on"
      ? null
      : undefined;
  if (!status && followUpAt === undefined) return { error: "اختر حالة أو تاريخ متابعة" };
  const n = await (await getRuntime()).scrapers.bulkUpdateLeads({
    projectId,
    usernames,
    ...(status ? { status } : {}),
    ...(followUpAt !== undefined ? { followUpAt } : {}),
  });
  await audit("lead.bulk", { count: n, status: status ?? null, day: day || null });
  revalidatePath("/leads");
  revalidatePath("/leads/board");
  return { message: `تغيّر ${n} عميلاً` };
}

/** Adds a note to a lead's history. */
export async function addLeadNote(_: ActionState, form: FormData): Promise<ActionState> {
  await requireSession();
  const projectId = str(form, "project");
  const username = str(form, "username");
  const ok = await (await getRuntime()).scrapers.addLeadNote({
    projectId,
    username,
    text: str(form, "text"),
  });
  if (!ok) return { error: "اكتب الملاحظة أولاً" };
  await audit("lead.note", { username });
  revalidatePath(`/leads/${username}`);
  return { message: "حُفظت الملاحظة" };
}

/**
 * Reads a competitor now (one Apify profile call, about $0.003) and keeps the
 * result for a week so reloading the page costs nothing.
 */
export async function analyzeCompetitor(_: ActionState, form: FormData): Promise<ActionState> {
  await requireSession();
  const username =
    str(form, "username")
      .replace(/^@/, "")
      .replace(/.*instagram\.com\//, "")
      .split(/[/?]/)[0]
      ?.toLowerCase() ?? "";
  if (!/^[a-z0-9._]{1,30}$/.test(username)) return { error: "اكتب معرّف حساب صحيحاً" };
  const rt = await getRuntime();
  try {
    const result = await rt.scrapers.analyzeCompetitor({
      username,
      ...(str(form, "project") ? { projectId: str(form, "project") } : {}),
    });
    await rt.scrapers.setValue(`competitor:${username}`, result, 30 * 86_400_000);
    const list = ((await rt.scrapers.getValue<string[]>("competitor:list")) ?? []).filter(
      (u) => u !== username,
    );
    await rt.scrapers.setValue(
      "competitor:list",
      [username, ...list].slice(0, 30),
      365 * 86_400_000,
    );
  } catch (err) {
    return fail(err);
  }
  await audit("competitor.analyze", { username });
  revalidatePath("/competitors");
  redirect(`/competitors?u=${username}`);
}
