// End-to-end check of the dashboard against a running server (see the e2e job in .github/workflows/ci.yml).
// Env: BASE_URL, DASHBOARD_PASSWORD; CHROMIUM_PATH to use an already installed Chromium.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium, devices } from "playwright";

const B = process.env.BASE_URL ?? "http://localhost:3100";
const PASSWORD = process.env.DASHBOARD_PASSWORD ?? "";
const step = (name) => console.log(`✓ ${name}`);

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(`${B}/`);
  await page.waitForURL(/\/login/);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(`${B}/`);
  step("login");

  await page.fill('input[name="name"]', "وكلاء مصر");
  await page.click('button:has-text("إنشاء")');
  await page.waitForSelector("text=أُنشئ المشروع");
  step("create project");

  await page.goto(`${B}/jobs/new`);
  await page.fill(
    'textarea[name="usernames"]',
    `${Array.from({ length: 12 }, (_, i) => `@user${i + 1}`).join("\n")}\nghost`,
  );
  await page.click('button:has-text("ابدأ")');
  await page.waitForURL(/\/jobs\/[0-9a-f-]+$/);
  await page.waitForSelector("text=اكتملت", { timeout: 90_000 });
  step("job runs to completion without a worker process");

  await page.goto(`${B}/leads`);
  const rows = page.locator("tbody tr");
  assert.equal(await rows.count(), 12);
  await page.fill('input[name="q"]', "user12");
  await page.click('button:has-text("تطبيق")');
  await page.waitForURL(/q=user12/);
  assert.equal(await rows.count(), 1);
  // Wait for hydration so the change reaches the server action, then for the save to finish
  // (the select is disabled while it runs) instead of a fixed pause.
  await page.waitForSelector("html[data-ready]", { state: "attached" });
  const statusSelect = page.locator('select[aria-label="حالة @user12"]');
  const saved = page.waitForResponse((r) => r.request().method() === "POST" && r.ok());
  await statusSelect.selectOption("interested");
  await saved;
  await statusSelect.waitFor({ state: "visible" });
  await page.waitForFunction(
    () => !document.querySelector('select[aria-label="حالة @user12"]')?.hasAttribute("disabled"),
  );
  await page.goto(`${B}/leads?status=interested`);
  assert.equal(await page.locator("tbody tr").count(), 1);
  // Status chips show their label with the count.
  await page.getByRole("link", { name: "مهتم 1" }).waitFor({ timeout: 10_000 });
  step("search and CRM status");

  // Follow-up date (saved on change, kept after reload).
  await page.fill('input[aria-label="تذكير متابعة @user12"]', "2030-01-15");
  await page.waitForTimeout(1000);
  await page.reload();
  assert.equal(await page.inputValue('input[aria-label="تذكير متابعة @user12"]'), "2030-01-15");
  step("follow-up reminder date");

  // Kanban board: move a card with the keyboard-friendly select.
  await page.goto(`${B}/leads/board`);
  const interested = page.locator('section[data-status="interested"]');
  await interested.getByText("@user12").waitFor();
  await page.selectOption('select[aria-label="نقل @user12"]', "customer");
  await page.locator('section[data-status="customer"]').getByText("@user12").waitFor();
  await page.waitForTimeout(1000);
  await page.reload();
  await page.locator('section[data-status="customer"]').getByText("@user12").waitFor();
  step("leads board: move a card between columns");

  await page.goto(`${B}/leads`);
  // Bulk: tick two leads and mark them contacted with one click.
  await page.check('input[aria-label="تحديد @user1"]');
  await page.check('input[aria-label="تحديد @user2"]');
  await page.selectOption('select[aria-label="حالة المحدد"]', "contacted");
  await page.click('button:has-text("طبّق على المحدد")');
  await page.waitForSelector("text=تغيّر 2 عميلاً");
  await page.goto(`${B}/leads?status=contacted`);
  assert.equal(await page.locator("tbody tr").count(), 2);
  step("bulk status change");

  // Lead page: history and a note.
  await page.click('tbody tr:first-child a:has-text("التفاصيل")');
  await page.waitForURL(/\/leads\/user\d+\?project=/);
  await page.waitForSelector("text=(جماعي)");
  await page.fill('textarea[aria-label="ملاحظة"]', "طلب عرض الأسعار");
  await page.click('button:has-text("أضف ملاحظة")');
  await page.waitForSelector("li >> text=طلب عرض الأسعار");
  step("lead page: history and notes");

  await page.fill(
    'input[aria-label="رابط حساب على منصة أخرى"]',
    "https://www.tiktok.com/@gold.coach",
  );
  await page.click('button:has-text("أضف")');
  await page.waitForSelector("text=أُضيف الحساب");
  await page.waitForSelector("a:has-text('@gold.coach')");
  step("lead page: an account on another platform");

  // A closed deal shows up as revenue for the source that found the lead.
  await page.fill('input[aria-label="قيمة الصفقة بالدولار"]', "750");
  await page.click('button:has-text("حفظ")');
  await page.waitForSelector("text=سُجّلت الصفقة");
  await page.goto(`${B}/insights`);
  await page.waitForSelector("text=$750");
  await page.waitForSelector("text=قائمة ملصقة");
  step("deal value and revenue by source");

  // The project's own model says how many more decisions it needs; the plan is written on demand.
  await page.click('button:has-text("درّب النموذج الآن")');
  await page.waitForSelector("text=يحتاج النموذج قرارات أكثر");
  await page.click('button:has-text("اكتب الخطة الآن")');
  await page.waitForSelector("text=خطة الأسبوع ·");
  await page.waitForSelector("text=الميزانية الذكية");
  step("own model, budget plan and weekly plan");

  // A WhatsApp template that promises returns is refused.
  await page.goto(`${B}/leads`);
  await page.fill('textarea[name="template"]', "مرحباً {name}، أرباح مضمونة كل شهر!");
  await page.click('button:has-text("حفظ")');
  await page.waitForSelector("text=قالب الرسالة لم يُحفظ");
  step("compliance: a template promising returns is refused");

  await page.goto(`${B}/leads`);
  const download = page.waitForEvent("download");
  await page.click("text=Excel");
  // An XLSX file is a ZIP archive: it starts with "PK".
  const file = await (await download).path();
  assert.equal((await readFile(file)).subarray(0, 2).toString(), "PK");
  step("Excel export");

  await page.goto(`${B}/settings`);
  await page.fill('input[name="name"]', "e2e");
  await page.click('button:has-text("إنشاء مفتاح")');
  await page.waitForSelector("text=انسخ المفتاح الآن");
  assert.ok(await page.locator("text=صحة النظام").isVisible());
  assert.ok(await page.locator("text=الصرف هذا الشهر").isVisible());
  step("API key, health and spend cards");

  const backup = page.waitForEvent("download");
  await page.click("text=تحميل نسخة الآن");
  const gz = await readFile(await (await backup).path());
  assert.deepEqual([...gz.subarray(0, 2)], [0x1f, 0x8b], "the backup is gzip");
  const calendarUrl = await page.inputValue('input[aria-label="رابط تقويم المتابعات"]');
  const ics = await (await fetch(calendarUrl.replace(/^https?:\/\/[^/]+/, B))).text();
  assert.match(ics, /^BEGIN:VCALENDAR/);
  assert.equal((await fetch(`${B}/api/calendar/wrong.ics`)).status, 404);
  step("backup download and follow-up calendar feed");

  await page.goto(`${B}/competitors`);
  await page.fill('input[aria-label="حساب المنافس"]', "@rival7");
  await page.click('button:has-text("حلّل")');
  await page.waitForURL(/\/competitors\?u=rival7/);
  await page.waitForSelector("text=@rival7");
  step("competitor analysis");

  // Google Maps needs Apify; without it the page says so instead of failing.
  await page.goto(`${B}/places`);
  await page.waitForSelector("text=APIFY_TOKEN");
  step("businesses page without Apify");

  // Shared from another app (Android share sheet → /share).
  await page.goto(
    `${B}/share?text=${encodeURIComponent("شوف https://www.instagram.com/user40/ 👌")}`,
  );
  await page.waitForSelector("text=غير محفوظ بعد");
  await page.click('button:has-text("احفظ كعميل")');
  await page.waitForSelector("text=بدأ الحفظ");
  await page.goto(`${B}/share?url=${encodeURIComponent("https://www.tiktok.com/@gold.coach")}`);
  await page.waitForSelector("text=اربطه بعميل");
  step("share target: save an Instagram account, link another platform");

  // The browser extension is offered from the dashboard (built into public/downloads by the deploy).
  await page.goto(`${B}/extension`);
  await page.waitForSelector("text=الإصدار");
  const extDownload = page.waitForEvent("download");
  await page.click("text=تحميل الإضافة");
  const zip = await readFile(await (await extDownload).path());
  assert.equal(zip.subarray(0, 2).toString(), "PK");
  assert.ok(zip.includes("manifest.json"), "the zip holds the extension manifest");
  await page.click('button:has-text("أنشئ مفتاحاً للإضافة")');
  await page.waitForSelector("text=انسخ المفتاح الآن");
  assert.match((await page.textContent("body")) ?? "", /sk_[A-Za-z0-9_-]{10,}/);
  step("extension page: download and a key for the extension");

  await page.goto(`${B}/`);
  // Shortcuts work once React has hydrated the page.
  await page.waitForSelector("html[data-ready]", { state: "attached" });
  await page.keyboard.press("Control+k");
  try {
    await page.waitForSelector('input[placeholder^="ابحث"]', { timeout: 10_000 });
  } catch (err) {
    // Diagnostics for CI: was the page hydrated, and where did the key go?
    const state = await page.evaluate(() => ({
      ready: document.documentElement.dataset.ready ?? null,
      active: document.activeElement?.tagName ?? null,
      url: location.href,
    }));
    console.error("palette did not open", state, await browser.version());
    throw err;
  }
  await page.fill('input[placeholder^="ابحث"]', "وكلاء");
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/leads\?project=/);
  step("Ctrl+K palette");

  const mobile = await browser.newContext({ ...devices["iPhone 13"] });
  await mobile.addCookies(await ctx.cookies());
  const m = await mobile.newPage();
  await m.goto(`${B}/leads`);
  assert.equal(
    await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
    false,
  );
  step("no horizontal scroll on mobile");

  // Lockout last, so it does not affect the steps above.
  const anon = await (await browser.newContext()).newPage();
  for (let i = 0; i < 5; i++) {
    await anon.goto(`${B}/login`);
    await anon.fill('input[name="password"]', `wrong-${i}-password`);
    await anon.click('button[type="submit"]');
    await anon.waitForSelector("text=كلمة المرور غير صحيحة");
  }
  await anon.goto(`${B}/login`);
  await anon.fill('input[name="password"]', PASSWORD);
  await anon.click('button[type="submit"]');
  await anon.waitForSelector("text=محاولات خاطئة كثيرة");
  step("login lockout");

  assert.deepEqual(errors, []);
  step("no page errors");
} finally {
  await browser.close();
}
