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
  await page.selectOption('select[aria-label="حالة @user12"]', "interested");
  await page.waitForTimeout(1000);
  await page.goto(`${B}/leads?status=interested`);
  assert.equal(await page.locator("tbody tr").count(), 1);
  // Status chips show their label with the count.
  assert.ok(await page.getByRole("link", { name: "مهتم 1" }).isVisible());
  step("search and CRM status");

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
  step("API key and health card");

  await page.goto(`${B}/`);
  await page.keyboard.press("Control+k");
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
