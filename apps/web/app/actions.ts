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
import { checkPassword, endSession, requireSession, startSession } from "@/lib/auth";
import { scheduleDrain } from "@/lib/drain";
import { getRuntime } from "@/lib/runtime";

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

export async function login(_: ActionState, form: FormData): Promise<ActionState> {
  if (!checkPassword(str(form, "password"))) return { error: "كلمة المرور غير صحيحة" };
  await startSession();
  const next = str(form, "next");
  redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/");
}

export async function logout() {
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
        type === "hashtag" || type === "post" || type === "profile" ? type : undefined,
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
  } catch (err) {
    return fail(err);
  }
  scheduleDrain();
  redirect(`/jobs/${jobId}`);
}

export async function cancelJob(jobId: string) {
  await requireSession();
  await (await getRuntime()).scrapers.cancelJob(jobId);
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
    revalidatePath("/settings");
    return { message: "انسخ المفتاح الآن، فلن يظهر مرة أخرى.", secret: k.key };
  } catch (err) {
    return fail(err);
  }
}

export async function revokeKey(id: string) {
  await requireSession();
  await (await getRuntime()).scrapers.revokeApiKey(id);
  revalidatePath("/settings");
}
