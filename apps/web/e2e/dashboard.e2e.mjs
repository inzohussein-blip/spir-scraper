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
  // A file that is not an encrypted backup of this platform is refused with a reason.
  const junk = await page.request.post(`${B}/api/backup/decrypt`, {
    multipart: {
      file: { name: "x.enc", mimeType: "application/octet-stream", buffer: Buffer.from("nope") },
    },
  });
  assert.equal(junk.status(), 400);
  assert.match(await junk.text(), /تعذّر فك التشفير/);
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

  // Broker reports: the postback address, a CSV report, a partner with a tracking link.
  await page.goto(`${B}/partners`);
  const postback = (await page.inputValue('input[aria-label="رابط إشعارات الوسيط"]')).split("?")[0];
  const pb = await fetch(
    `${postback.replace(/^https?:\/\/[^/]+/, B)}?event=ftd&email=e2e@example.com&amount=500&sub=none`,
  );
  assert.equal(pb.status, 200);
  assert.equal((await fetch(`${B}/api/broker/postback/wrong?event=ftd&amount=1`)).status, 404);
  await page.setInputFiles('input[aria-label="تقرير الوسيط"]', {
    name: "report.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("Email,Commission\nx@example.com,40\ny@example.com,60\n"),
  });
  await page.click('button:has-text("استورد التقرير")');
  await page.waitForSelector("text=قُرئ 2 حدثاً");
  await page.fill('input[name="signup_url"]', "https://broker.example/register?affid=1");
  await page.click('button:has-text("حفظ")');
  await page.waitForSelector("text=حُفظ");
  await page.fill('input[name="name"]', "وكيل التجربة");
  await page.fill('input[name="code"]', "e2epartner");
  await page.click('button:has-text("أضف وكيلاً")');
  await page.waitForSelector("text=أُضيف وكيل التجربة");
  const r = await fetch(`${B}/r/e2epartner`, { redirect: "manual" });
  assert.equal(r.status, 302);
  assert.match(
    r.headers.get("location") ?? "",
    /broker\.example\/register\?affid=1&sub=e2epartner/,
  );
  await page.goto(`${B}/partners`);
  await page.waitForSelector("text=وكيل التجربة");
  step("broker postback, CSV report, partner and tracking link");

  // Own account and inbox without Graph credentials; the webhook refuses unsigned calls.
  await page.goto(`${B}/own`);
  await page.waitForSelector("text=IG_GRAPH_TOKEN");
  await page.goto(`${B}/inbox`);
  await page.waitForSelector("text=لا توجد رسائل بعد");
  assert.equal(
    (await fetch(`${B}/api/meta/webhook?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1`))
      .status,
    403,
  );
  assert.equal((await fetch(`${B}/api/meta/webhook`, { method: "POST", body: "{}" })).status, 401);
  step("own account, inbox and the Meta webhook guard");

  // Content plan (template without an AI key) and the market index.
  await page.goto(`${B}/content`);
  await page.click('button:has-text("اصنع الخطة")');
  await page.waitForSelector("text=السبت");
  await page.waitForSelector("text=الدعوة:");
  await page.goto(`${B}/market`);
  await page.waitForSelector("text=الذهب");
  await page.waitForSelector("text=نمو المنافسين");
  step("content plan and market index");

  // Spir engine: a run created in the dashboard, read by a "home worker" through the API.
  await page.goto(`${B}/engine`);
  await page.waitForSelector("text=لا يوجد جهاز متصل");
  await page.fill('input[name="quiet_from"]', "0");
  await page.fill('input[name="quiet_to"]', "0");
  await page.fill('input[name="interval"]', "20");
  await page.click('button:has-text("حفظ")');
  await page.waitForSelector("text=حُفظ: حساب كل 20 ثانية");
  await page.fill('input[name="name"]', "زحف التجربة");
  await page.fill('textarea[name="seeds"]', "@seed_e2e");
  await page.fill('input[name="keywords"]', "تداول");
  await page.click('button:has-text("ابدأ التشغيل")');
  await page.waitForSelector("text=بدأ «زحف التجربة»");
  const secret = process.env.WORKER_SHARED_SECRET ?? "e2e";
  const engine = (path, body) =>
    fetch(`${B}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-worker-secret": secret },
      body: JSON.stringify(body),
    }).then((r) => r.json());
  assert.equal((await fetch(`${B}/api/engine/next`, { method: "POST" })).status, 404);
  const job = await engine("/api/engine/next", {});
  assert.equal(job.action, "read");
  assert.equal(job.item.username, "seed_e2e");
  const after = await engine("/api/engine/report", {
    itemId: job.item.id,
    status: "ok",
    profile: {
      igUserId: "e2e-seed",
      username: "seed_e2e",
      fullName: "Seed",
      bio: "مدرب تداول مع @coach_e2e",
      followers: 5000,
      isBusiness: true,
      isVerified: false,
    },
  });
  assert.equal(after.action, "wait");
  await page.goto(`${B}/engine`);
  await page.click("text=زحف التجربة");
  await page.waitForSelector("text=@seed_e2e");
  await page.waitForSelector("text=@coach_e2e");
  const csv = await (
    await page.request.get(page.url().replace(/\/engine\/([^/?]+).*/, "/api/engine/runs/$1/csv"))
  ).text();
  assert.match(csv, /seed_e2e,yes/);
  step("Spir engine: run, worker read and report, dataset and CSV");

  // «العامل المنزلي»: a proxy added in the dashboard reaches the program (decrypted), never the page.
  await page.goto(`${B}/workers`);
  await page.fill('input[name="url"]', "http://user:pw-secret@proxy.example:8000");
  await page.fill('input[name="rotate_url"]', "https://rot.example/change?key=k");
  await page.click('button:has-text("أضف البروكسي")');
  await page.waitForSelector("text=أُضيف proxy.example:8000");
  await page.goto(`${B}/workers`);
  assert.ok(
    !((await page.textContent("body")) ?? "").includes("pw-secret"),
    "the password never shows",
  );
  const program = { id: "pc-e2e", kind: "program", name: "جهاز التجربة", ip: "5.6.7.8" };
  const first = await engine("/api/engine/next", { worker: program });
  assert.equal(first.config.proxies[0].url, "http://user:pw-secret@proxy.example:8000");
  assert.equal(first.config.proxies[0].rotateUrl, "https://rot.example/change?key=k");
  await page.goto(`${B}/workers`);
  await page.waitForSelector("text=جهاز التجربة");
  await page.waitForSelector("text=5.6.7.8");
  await page.click('button:has-text("غيّر IP")');
  await page.waitForLoadState("networkidle");
  const again = await engine("/api/engine/next", {
    worker: { ...program, configVersion: first.config.version },
  });
  assert.equal(again.config, undefined);
  assert.equal(again.commands?.[0]?.type, "rotate");
  // The program file is offered for download.
  const py = await (await fetch(`${B}/downloads/spir-worker.py`)).text();
  assert.match(py, /Spir home worker/);
  step("home worker page: devices, encrypted proxy, change IP, program download");

  // Usage: every page visit and engine call above was counted by source.
  await page.goto(`${B}/usage`);
  await page.waitForSelector("text=ساعات تشغيل قاعدة البيانات");
  await page.waitForSelector("text=حجم قاعدة البيانات");
  await page.waitForSelector("text=من يوقظ المنصة");
  await page.waitForSelector("text=اللوحة");
  await page.waitForSelector("text=محرك Spir");
  await page.fill('input[name="db_hours"]', "150");
  await page.click('button:has-text("حفظ")');
  await page.waitForSelector("text=حُفظت الحدود");
  step("usage page: meters, requests by source, plan limits");

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
