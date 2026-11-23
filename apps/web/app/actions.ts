"use server";

import {
  checkMessage,
  parseBrokerCsv,
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
  const template = str(form, "template").slice(0, 1000);
  const check = template ? checkMessage(template) : { ok: true, issues: [] };
  if (!check.ok)
    return {
      error: `قالب الرسالة لم يُحفظ: ${check.issues
        .filter((i) => i.severity === "block")
        .map((i) => `«${i.match}» — ${i.message}`)
        .join(" ")}`,
    };
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
  const warnings = check.issues.map((i) => i.message);
  return {
    message: warnings.length
      ? `حُفظت إعدادات المشروع. ملاحظات على القالب: ${warnings.join(" ")}`
      : "حُفظت إعدادات المشروع",
  };
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

/** Records (or clears, with an empty value) what a closed deal was worth. */
export async function saveDeal(_: ActionState, form: FormData): Promise<ActionState> {
  await requireSession();
  const projectId = str(form, "project");
  const username = str(form, "username");
  const raw = str(form, "value").replace(/[,،\s$]/g, "");
  const value = raw === "" ? null : Number(raw);
  if (value !== null && (!Number.isFinite(value) || value < 0))
    return { error: "اكتب رقماً صحيحاً، مثل 500" };
  const ok = await (await getRuntime()).scrapers.setDeal({ projectId, username, value });
  if (!ok) return { error: "العميل غير موجود في هذا المشروع" };
  await audit("lead.deal", { username, value });
  revalidatePath(`/leads/${username}`);
  revalidatePath("/leads");
  revalidatePath("/insights");
  return { message: value === null ? "أُلغيت الصفقة" : "سُجّلت الصفقة وأصبح عميلاً" };
}

/** Finds the project's audience segments with AI and assigns every lead to one. */
export async function buildPersonas(_: ActionState, form: FormData): Promise<ActionState> {
  await requireSession();
  const projectId = str(form, "project");
  try {
    const r = await (await getRuntime()).scrapers.buildPersonas(projectId);
    await audit("project.personas", { count: r.personas.length, assigned: r.assigned });
    revalidatePath("/insights");
    revalidatePath("/leads");
    return { message: `وُجدت ${r.personas.length} شرائح، ووُزّع عليها ${r.assigned} عميلاً` };
  } catch (err) {
    return fail(
      /ANTHROPIC_API_KEY/.test((err as Error).message)
        ? new Error("الشرائح تحتاج ANTHROPIC_API_KEY في Vercel")
        : err,
    );
  }
}

/** Adds a lead's account on another platform from a pasted link, and reads it. */
export async function addAccount(_: ActionState, form: FormData): Promise<ActionState> {
  await requireSession();
  const username = str(form, "username");
  const r = await (await getRuntime()).scrapers.addAccount({ username, url: str(form, "url") });
  if (!r.ok)
    return {
      error:
        r.reason === "taken"
          ? "هذا الحساب مربوط بعميل آخر"
          : r.reason === "no_lead"
            ? "العميل غير موجود"
            : "الرابط ليس حساباً على منصة (مثال: t.me/قناة أو youtube.com/@قناة أو tiktok.com/@حساب)",
    };
  await audit("account.add", { username, platform: r.account?.platform ?? null });
  revalidatePath(`/leads/${username}`);
  return { message: r.account?.error ? `أُضيف، لكن: ${r.account.error}` : "أُضيف الحساب" };
}

/** Reads one account again through its platform's connector. */
export async function refreshAccount(id: string, username: string) {
  await requireSession();
  await (await getRuntime()).scrapers.refreshAccount(id);
  revalidatePath(`/leads/${username}`);
}

export async function removeAccount(id: string, username: string) {
  await requireSession();
  await (await getRuntime()).scrapers.removeAccount(id);
  await audit("account.remove", { id });
  revalidatePath(`/leads/${username}`);
}

/** Finds other-platform accounts in the bios of a project's leads and reads some of them. */
export async function linkProjectAccounts(_: ActionState, form: FormData): Promise<ActionState> {
  await requireSession();
  const r = await (await getRuntime()).scrapers.linkProjectAccounts(str(form, "project"), {
    read: 30,
  });
  await audit("project.link_accounts", r);
  revalidatePath("/leads");
  return {
    message: `فُحص ${r.leads} عميلاً: ${r.found} حساباً جديداً على منصات أخرى، قُرئ منها ${r.read}. الباقي يُقرأ مع المهمة اليومية.`,
  };
}

/** Searches Google Maps and keeps the businesses in the project. */
export async function searchPlaces(_: ActionState, form: FormData): Promise<ActionState> {
  await requireSession();
  const projectId = str(form, "project");
  try {
    const r = await (await getRuntime()).scrapers.searchPlaces({
      projectId,
      query: str(form, "query"),
      location: str(form, "location"),
      limit: Number(str(form, "limit")) || 30,
    });
    await audit("places.search", { query: str(form, "query"), found: r.found });
    revalidatePath("/places");
    return {
      message: `وُجدت ${r.found} شركة (≈ $${r.costUsd.toFixed(3)}). حلّل مواقعها لتجد حساباتها على إنستقرام.`,
    };
  } catch (err) {
    return fail(err);
  }
}

/** Reads the websites of businesses not analysed yet. */
export async function analyzePlaces(_: ActionState, form: FormData): Promise<ActionState> {
  await requireSession();
  const r = await (await getRuntime()).scrapers.analyzePlaces(str(form, "project"), 20);
  revalidatePath("/places");
  return {
    message: r.analyzed
      ? `حُلّل ${r.analyzed} موقعاً، ووُجد ${r.instagram} حساب إنستقرام. الباقي مع الضغطة التالية أو المهمة اليومية.`
      : "لا توجد مواقع جديدة للتحليل",
  };
}

/** Sends the businesses' Instagram accounts to the project as leads. */
export async function placesToLeads(_: ActionState, form: FormData): Promise<ActionState> {
  await requireSession();
  const projectId = str(form, "project");
  try {
    const r = await (await getRuntime()).scrapers.placesToLeads(projectId);
    if (!r.jobId) return { error: "لا توجد حسابات إنستقرام جديدة. حلّل المواقع أولاً." };
    await audit("places.to_leads", { sent: r.sent });
    await scheduleDrain();
    revalidatePath("/places");
    return { message: `بدأت مهمة لـ ${r.sent} حساباً`, url: `/jobs/${r.jobId}` };
  } catch (err) {
    return fail(err);
  }
}

/** Saves (or refreshes) one Instagram account shared from another app. */
export async function saveSharedAccount(_: ActionState, form: FormData): Promise<ActionState> {
  await requireSession();
  const username = str(form, "username").replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/.test(username)) return { error: "معرّف غير صالح" };
  try {
    await (await getRuntime()).scrapers.startJob({
      projectId: str(form, "project"),
      source: uploadSource([username], `مشاركة: @${username}`),
      limit: 1,
    });
    await audit("share.save", { username });
    await scheduleDrain();
    return { message: "بدأ الحفظ، يظهر في العملاء خلال لحظات", url: `/leads/${username}` };
  } catch (err) {
    return fail(err);
  }
}

/** Watches a competitor page (prices, offers, partner terms) for changes. */
export async function addSiteWatch(_: ActionState, form: FormData): Promise<ActionState> {
  await requireSession();
  try {
    const rt = await getRuntime();
    await rt.scrapers.addSiteWatch({ url: str(form, "url"), label: str(form, "label") || null });
    // First reading now sets the baseline.
    await rt.scrapers.checkSiteWatches();
  } catch (err) {
    return fail(err);
  }
  await audit("site_watch.add", { url: str(form, "url") });
  revalidatePath("/competitors");
  return { message: "تُراقب الصفحة الآن، ويصلك تنبيه حين تتغيّر" };
}

export async function removeSiteWatch(id: string) {
  await requireSession();
  await (await getRuntime()).scrapers.removeSiteWatch(id);
  revalidatePath("/competitors");
}

/** Retrains the project's own model on the owner's decisions. */
export async function trainModel(_: ActionState, form: FormData): Promise<ActionState> {
  await requireSession();
  const r = await (await getRuntime()).scrapers.trainProjectModel(str(form, "project"));
  revalidatePath("/insights");
  revalidatePath("/leads");
  if (!r.trained)
    return {
      error: `يحتاج النموذج قرارات أكثر: ${r.positives} عميل/مهتم و${r.negatives} مرفوض حتى الآن. سجّل ${r.needed.positives} عملاء و${r.needed.negatives} مرفوضين على الأقل (${r.needed.total} قراراً إضافياً).`,
    };
  return {
    message: `تدرّب النموذج على ${r.positives + r.negatives} قراراً، ودقة ترتيبه ${Math.round((r.auc ?? 0) * 100)}%. قُيّم ${r.scored} عميلاً.`,
  };
}

/** Applies the budget plan to the competitor monitors. */
export async function applyBudget(_: ActionState, form: FormData): Promise<ActionState> {
  await requireSession();
  const projectId = str(form, "project");
  const rt = await getRuntime();
  const usage = await rt.apifyUsage().catch(() => null);
  const plan = await rt.scrapers.budgetPlan(
    projectId,
    usage ? Math.max(0, usage.allowedUsd - usage.usedUsd) : 5,
  );
  const r = await rt.scrapers.applyBudgetPlan(projectId, plan.lines);
  await audit("budget.apply", r);
  revalidatePath("/insights");
  revalidatePath("/leads");
  return { message: `طُبّقت الخطة على ${r.changed} من مراقبات المنافسين` };
}

/** Finds new sources from what the best customers follow (paid: Apify). */
export async function suggestSources(_: ActionState, form: FormData): Promise<ActionState> {
  await requireSession();
  try {
    const r = await (await getRuntime()).scrapers.suggestSources(str(form, "project"));
    revalidatePath("/insights");
    return {
      message: `قُرئ ما يتابعه ${r.seeds} من أفضل عملائك (≈ $${r.costUsd}). وُجد ${r.suggestions.length} مصدراً يتابعه اثنان منهم أو أكثر.`,
    };
  } catch (err) {
    return fail(err);
  }
}

/** Watches a suggested source (its followers, weekly, new accounts only). */
export async function watchSuggested(projectId: string, username: string) {
  await requireSession();
  await (await getRuntime()).scrapers.createMonitor({
    projectId,
    source: parseSource(`https://www.instagram.com/${username}/`, "followers") as Exclude<
      Source,
      { type: "upload" }
    >,
  });
  await audit("monitor.add", { username, from: "suggestion" });
  revalidatePath("/insights");
}

/** Writes this week's plan now (it is also sent every week on Telegram). */
export async function makeWeeklyPlan(_: ActionState, form: FormData): Promise<ActionState> {
  await requireSession();
  const rt = await getRuntime();
  const usage = await rt.apifyUsage().catch(() => null);
  await rt.scrapers.weeklyPlan(
    str(form, "project"),
    usage ? Math.max(0, usage.allowedUsd - usage.usedUsd) : 5,
  );
  revalidatePath("/insights");
  return { message: "كُتبت خطة الأسبوع" };
}

export async function approvePlan(id: string) {
  await requireSession();
  await (await getRuntime()).scrapers.approvePlan(id);
  revalidatePath("/insights");
}

/** Where tracking links send visitors (the broker's affiliate sign-up link) and its sub-id parameter. */
export async function saveBrokerSettings(_: ActionState, form: FormData): Promise<ActionState> {
  await requireSession();
  const signupUrl = str(form, "signup_url");
  if (signupUrl && !/^https:\/\//.test(signupUrl))
    return { error: "الرابط يجب أن يبدأ بـ https://" };
  const subParam =
    (str(form, "sub_param") || "sub").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 30) || "sub";
  await (await getRuntime()).scrapers.setValue(
    "broker:settings",
    { signupUrl: signupUrl || null, subParam },
    10 * 365 * 86_400_000,
  );
  await audit("broker.settings", { subParam });
  revalidatePath("/partners");
  return { message: "حُفظ" };
}

/** Imports a broker report (CSV export from the affiliate system). */
export async function importBrokerCsv(_: ActionState, form: FormData): Promise<ActionState> {
  await requireSession();
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "اختر ملف CSV" };
  if (file.size > 5_000_000) return { error: "الملف أكبر من 5MB" };
  const events = parseBrokerCsv(await file.text());
  if (events.length === 0)
    return { error: "لم أجد في الملف أعمدة معروفة (البريد أو الهاتف، والإيداع أو العمولة)" };
  const r = await (await getRuntime()).scrapers.ingestBrokerEvents(events, "csv");
  await audit("broker.import", r);
  revalidatePath("/partners");
  revalidatePath("/insights");
  return {
    message: `قُرئ ${events.length} حدثاً: خُزّن ${r.stored}، وطوبق منها ${r.matched} مع عملائك، و${r.duplicates} مكرر.`,
  };
}

export async function createPartner(_: ActionState, form: FormData): Promise<ActionState> {
  await requireSession();
  try {
    const p = await (await getRuntime()).scrapers.createPartner({
      name: str(form, "name"),
      instagram: str(form, "instagram") || null,
      sharePercent: Number(str(form, "share")) || 0,
      ...(str(form, "code") ? { code: str(form, "code") } : {}),
    });
    await audit("partner.create", { code: p.code });
    revalidatePath("/partners");
    return { message: `أُضيف ${p.name}. أرسل له رابط لوحته من الجدول.` };
  } catch (err) {
    return fail(
      /unique|duplicate/i.test((err as Error).message) ? new Error("هذا الكود مستخدم") : err,
    );
  }
}

export async function togglePartner(id: string, active: boolean) {
  await requireSession();
  await (await getRuntime()).scrapers.updatePartner(id, { active });
  revalidatePath("/partners");
}

/** Adds a recruit candidate as a partner (named after their account). */
export async function recruitPartner(username: string, name: string) {
  await requireSession();
  await (await getRuntime()).scrapers.createPartner({
    name: name || `@${username}`,
    instagram: username,
  });
  await audit("partner.create", { from: "recruit", username });
  revalidatePath("/partners");
}

/** Reads the owner's posts and comments now; interested commenters become leads. */
export async function syncOwnAccount(_: ActionState, form: FormData): Promise<ActionState> {
  await requireSession();
  const projectId = str(form, "project");
  if (!projectId) return { error: "اختر مشروعاً" };
  try {
    const rt = await getRuntime();
    const r = await rt.scrapers.syncOwnAccount(projectId);
    // The daily sync sends interested commenters to the project chosen last.
    await rt.scrapers.setValue("own:project", projectId, 10 * 365 * 86_400_000);
    await audit("own.sync", r);
    revalidatePath("/own");
    return {
      message: `قُرئ ${r.posts} منشوراً و${r.newComments} تعليقاً جديداً؛ ${r.hot} مهتمون أُضيفوا للعملاء.`,
    };
  } catch (err) {
    return fail(err);
  }
}

/** Opens the thread with an AI-drafted reply in the box (nothing is sent). */
export async function draftInboxReply(threadId: string) {
  await requireSession();
  redirect(`/inbox?thread=${encodeURIComponent(threadId)}&draft=1`);
}

/** Sends the owner's reply to a direct message: only when they press send. */
export async function sendInboxReply(_: ActionState, form: FormData): Promise<ActionState> {
  await requireSession();
  const threadId = str(form, "thread");
  const text = str(form, "text");
  if (!threadId || !text) return { error: "اكتب الرد" };
  try {
    await (await getRuntime()).scrapers.sendReply(threadId, text);
    revalidatePath("/inbox");
    return { message: "أُرسل" };
  } catch (err) {
    return fail(err);
  }
}

/** Builds this week's content plan from posts, topics, competitors and segments. */
export async function makeContentPlan(_: ActionState, form: FormData): Promise<ActionState> {
  await requireSession();
  const projectId = str(form, "project");
  if (!projectId) return { error: "اختر مشروعاً" };
  try {
    const plan = await (await getRuntime()).scrapers.contentPlan(projectId);
    await audit("content.plan", { projectId, byAi: plan.byAi });
    revalidatePath("/content");
    return {
      message: plan.byAi ? "جاهزة (بالذكاء الاصطناعي)" : "جاهزة (قالب: أضف مفتاح AI لخطة أدق)",
    };
  } catch (err) {
    return fail(err);
  }
}
