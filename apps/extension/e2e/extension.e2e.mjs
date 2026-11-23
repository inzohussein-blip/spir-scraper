// End to end: the built extension in real Chromium, against local pages.
//  - /acme/          a page shaped like an Instagram profile (og tags, header bio, followers link)
//                    whose followers list opens in a scrollable dialog that loads more on scroll
//  - /v1/chat/completions  a scripted OpenAI-compatible "model" that drives auto mode
//  - /api/v1/*       a fake Scrapers platform that records saved usernames
// Env: CHROMIUM_PATH to use an installed Chromium. Build first: node build.mjs --e2e

import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const dist = fileURLToPath(new URL("../dist", import.meta.url));
const step = (name) => console.log(`✓ ${name}`);
const fail = (msg) => {
  throw new Error(msg);
};

// ---------- local site + fake model + fake platform ----------

const saved = [];
const linked = [];
const modelRequests = [];

const profileHtml = `<!doctype html><html><head>
<meta property="og:title" content="Acme Trading (@acme) • Instagram photos and videos">
<meta property="og:description" content="12.5K Followers, 300 Following, 1,024 Posts - See Instagram photos and videos from Acme Trading (@acme)">
<title>Acme Trading (@acme)</title>
<style>
  #dialog{position:fixed;inset:40px;background:#fff;border:1px solid #999}
  #list{height:260px;overflow-y:auto}
  #list a{display:block;padding:14px}
</style></head><body>
<header>
  <h2>acme</h2>
  <div>1,024 posts 12.5K followers 300 following</div>
  <div>Acme Trading</div>
  <div>وسيط تداول معتمد
للتواصل: info [at] acme [dot] sa
واتساب ٠٥٠١٢٣٤٥٦٧ أو +966 50 123 4567</div>
  <a href="https://acme.example/site">acme.example</a>
</header>
<a id="followersLink" href="/acme/followers/">12.5K followers</a>
<form><input type="password" name="password" placeholder="Password"></form>
<script>
  let n = 0;
  function more(list) {
    for (let i = 0; i < 20 && n < 60; i++, n++) {
      const a = document.createElement("a");
      a.href = "/fan" + n + "/";
      a.textContent = "fan" + n;
      list.append(a);
    }
  }
  document.getElementById("followersLink").addEventListener("click", (e) => {
    e.preventDefault();
    if (document.getElementById("dialog")) return;
    const d = document.createElement("div");
    d.id = "dialog";
    d.setAttribute("role", "dialog");
    d.innerHTML = '<div>Followers</div><div id="list"></div>';
    document.body.append(d);
    const list = d.querySelector("#list");
    more(list);
    list.addEventListener("scroll", () => {
      if (list.scrollTop + list.clientHeight > list.scrollHeight - 50) more(list);
    });
  });
</script></body></html>`;

/** The scripted model: reads tool results and answers like an agent would. */
const postHtml = `<!doctype html><html><head><title>post</title></head><body><main><article>
<header><a href="/acme/">acme</a></header>
<ul>
  <li><a href="/acme/">acme</a> <span>Gold signals every day</span></li>
  <li><a href="/buyer_1/">buyer_1</a> <span>بكم الاشتراك؟</span> <span>2d</span> <button>Reply</button></li>
  <li><a href="/fan.2/">fan.2</a> <span>ما شاء الله 🔥</span></li>
  <li><a href="/buyer_3/">buyer_3</a> <span>Price?? DM me</span></li>
</ul></article></main></body></html>`;

function modelTurn(messages) {
  const lastTool = [...messages].reverse().find((m) => m.role === "tool")?.content ?? "";
  const assistantTurns = messages.filter((m) => m.role === "assistant").length;
  const call = (name, args) => ({
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          content: null,
          tool_calls: [
            {
              id: `c${assistantTurns}`,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
      },
    ],
  });
  const calls = (list) => ({
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          content: null,
          tool_calls: list.map(([name, args], i) => ({
            id: `c${assistantTurns}_${i}`,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          })),
        },
      },
    ],
  });
  switch (assistantTurns) {
    case 0:
      return call("read_page", {});
    case 1: {
      const id = /\[(\d+)\] link -> \/acme\/followers\//.exec(lastTool)?.[1];
      if (!id) fail(`model could not find the followers link in:\n${lastTool.slice(0, 800)}`);
      return call("click", { id: Number(id) });
    }
    case 2:
      return call("read_page", {});
    case 3: {
      const scroller = /\[(\d+)\] scrollable area/.exec(lastTool)?.[1];
      const password = /\[(\d+)\] input:password \[protected/.exec(lastTool)?.[1];
      if (!scroller) fail(`no scrollable list in:\n${lastTool.slice(0, 800)}`);
      if (!password) fail("the password field was not marked protected");
      // The page tries to make the agent type a password; the content script must refuse.
      return calls([
        ["type", { id: Number(password), text: "hunter2" }],
        ["collect_usernames", {}],
        ["scroll", { direction: "down", id: Number(scroller) }],
      ]);
    }
    case 4: {
      // Keep scrolling the same list: its number comes back in "scrolled [n] down".
      const id = Number(/scrolled \[(\d+)\] down/.exec(lastTool)?.[1]);
      if (!id) fail(`expected a list scroll result, got: ${lastTool}`);
      return calls(Array.from({ length: 6 }, () => ["scroll", { direction: "down", id }]));
    }
    case 5:
      return call("collect_usernames", {});
    case 6: {
      const { usernames } = JSON.parse(lastTool);
      return call("platform_save", { usernames });
    }
    default:
      return call("done", { summary: "حفظت المتابعين في المنصة" });
  }
}

const server = http.createServer(async (req, res) => {
  const body = await new Promise((r) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => r(b));
  });
  const send = (status, data, type = "application/json") => {
    res.writeHead(status, { "content-type": type, "access-control-allow-origin": "*" });
    res.end(typeof data === "string" ? data : JSON.stringify(data));
  };
  if (req.url === "/acme/" || req.url === "/known/")
    return send(200, profileHtml, "text/html; charset=utf-8");
  if (req.url === "/acme/p/Cx12abc/") return send(200, postHtml, "text/html; charset=utf-8");
  if (req.url === "/downloads/spir-extension.json") return send(200, { version: "99.0.0" });
  if (req.url === "/v1/chat/completions") {
    const parsed = JSON.parse(body);
    modelRequests.push(parsed);
    // One-shot requests (no tools): scoring and message drafts.
    if (!parsed.tools) {
      const rating = /rate public Instagram accounts/.test(parsed.messages[0].content);
      const content = rating
        ? 'Here you go: {"score": 77, "reason": "وسيط تداول نشط"}'
        : "مرحباً أكمي، أعجبني محتواكم عن التداول. هل تفكرون بشراكة؟";
      return send(200, { choices: [{ finish_reason: "stop", message: { content } }] });
    }
    try {
      return send(200, modelTurn(parsed.messages));
    } catch (err) {
      return send(200, {
        choices: [{ finish_reason: "stop", message: { content: `TEST ERROR: ${err.message}` } }],
      });
    }
  }
  if (req.url === "/api/v1/projects")
    return send(200, { projects: [{ id: "11111111-1111-4111-8111-111111111111", name: "تجربة" }] });
  if (req.url === "/api/v1/projects/11111111-1111-4111-8111-111111111111")
    return send(200, { id: "1", name: "تجربة", aiCriteria: "وسطاء تداول في الخليج" });
  if (req.url?.startsWith("/api/v1/leads?")) {
    const q = new URL(req.url, origin).searchParams.get("q");
    return send(200, {
      leads: q === "known" ? [{ username: "known", status: "interested", aiScore: 72 }] : [],
      nextCursor: null,
    });
  }
  if (req.url?.startsWith("/api/v1/profiles/"))
    return send(404, { error: "Profile not collected" });
  if (req.url === "/api/v1/accounts" && req.method === "POST") {
    linked.push(JSON.parse(body));
    return send(200, { account: { platform: "tiktok", handle: "goldcoach" } });
  }
  if (req.url === "/api/v1/jobs" && req.method === "POST") {
    if (req.headers.authorization !== "Bearer sk_test") return send(401, { error: "bad key" });
    const j = JSON.parse(body);
    saved.push(...j.usernames);
    return send(202, { job: { id: `job${saved.length}` }, estimatedCostUsd: 0 });
  }
  send(404, { error: "not found" });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

// ---------- the extension in Chromium ----------

const profile = await mkdtemp(join(tmpdir(), "spir-ext-"));
const context = await chromium.launchPersistentContext(profile, {
  headless: true,
  // Extensions need full Chromium; the default headless shell cannot load them.
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : { channel: "chromium" }),
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});

try {
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent("serviceworker");
  const extId = new URL(worker.url()).host;
  step("extension loaded");

  const site = await context.newPage();
  await site.goto(`${origin}/acme/`);

  // The side panel UI, opened in its own window (side panels cannot be opened by automation).
  const panelPromise = context.waitForEvent("page");
  await worker.evaluate(
    (url) => chrome.windows.create({ url, type: "popup", width: 420, height: 900 }),
    `chrome-extension://${extId}/sidepanel.html`,
  );
  const panel = await panelPromise;
  await panel.waitForLoadState();
  const errors = [];
  panel.on("pageerror", (e) => errors.push(e.message));

  // First run: no settings yet, so the settings tab shows.
  if (await panel.locator("#setup").isHidden()) fail("setup notice not shown without settings");
  step("asks for settings on first run");

  await panel.evaluate((s) => chrome.storage.local.set({ settings: s }), {
    provider: "openai",
    model: "scripted",
    apiKey: "",
    baseUrl: `${origin}/v1`,
    vision: false,
    effort: "medium",
    platformUrl: origin,
    platformKey: "sk_test",
    projectId: "11111111-1111-4111-8111-111111111111",
    allowedSites: ["127.0.0.1"],
    paceSeconds: 1,
    maxSteps: 20,
    dailyInstagramActions: 200,
    showBadge: true,
    criteria: "",
    offer: "شراكة وكالة مع وسيط مرخّص",
  });
  await panel.reload();
  await site.bringToFront();

  // Manual: read the open profile.
  await panel.click("#readProfile");
  await panel.waitForFunction(() =>
    document.querySelector("#profileOut")?.textContent?.includes("@acme"),
  );
  const out = await panel.textContent("#profileOut");
  for (const want of [
    "Acme Trading",
    "info@acme.sa",
    "0501234567",
    "acme.example",
    "غير موجود في المنصة",
  ])
    if (!out.includes(want)) fail(`profile card misses "${want}":\n${out}`);
  if (!/12[٬,.]?500|١٢٬٥٠٠/.test(out)) fail(`followers count missing:\n${out}`);
  step("manual: reads the profile (bio contacts, counts, link, platform status)");

  // Score against the project's criteria, then draft a message with a WhatsApp link.
  await panel.click("#scoreProfile");
  await panel.waitForFunction(() =>
    document.querySelector("#scoreOut")?.textContent?.includes("77"),
  );
  const scoreReq = modelRequests.at(-1);
  if (scoreReq.tools || !scoreReq.messages[1].content.includes("وسطاء تداول في الخليج"))
    fail("scoring did not use the project's criteria without tools");
  await panel.click("#draftMessage");
  await panel.waitForFunction(() =>
    document.querySelector("#messageText")?.value?.includes("مرحباً أكمي"),
  );
  const wa = await panel.getAttribute("#whatsapp", "data-href");
  if (!wa?.startsWith("https://wa.me/966501234567?text=")) fail(`WhatsApp link: ${wa}`);
  if (!modelRequests.at(-1).messages[1].content.includes("شراكة وكالة")) fail("offer missing");
  step("manual: scores with the project's criteria and drafts a message with a WhatsApp link");

  if (await panel.locator("#update").isHidden()) fail("update notice not shown for a newer build");
  step("shows a notice when the dashboard has a newer build");

  // Manual: open the followers list and scroll by hand while collecting.
  await site.click("#followersLink");
  await panel.click("#collectStart");
  await panel.waitForFunction(
    () =>
      Number(
        document.querySelector("#collectCount")?.textContent?.replace(/[^\d٠-٩]/g, "") ? 1 : 0,
      ) > 0,
  );
  for (let i = 0; i < 3; i++) {
    await site.locator("#list").evaluate((el) => el.scrollBy(0, el.scrollHeight));
    await site.waitForTimeout(300);
  }
  await panel.waitForFunction(
    () => document.querySelector("#collectCount")?.textContent === (60).toLocaleString("ar"),
    null,
    { timeout: 8000 },
  );
  step("manual: collects 60 usernames while the owner scrolls the list");
  panel.once("dialog", (d) => d.accept());
  await panel.click("#collectSave");
  await panel.waitForTimeout(500);
  if (saved.length !== 60 || saved.includes("acme"))
    fail(`expected 60 saved followers, got ${saved.length}`);
  step("manual: sends the collected usernames to the platform");

  // Manual: commenters on an open post, the interested ones first.
  await site.goto(`${origin}/acme/p/Cx12abc/`);
  await panel.click("#readComments");
  await panel.waitForSelector("#commentsList li");
  const commenters = await panel.$$eval("#commentsList li", (lis) =>
    lis.map((li) => [li.querySelector("b")?.textContent, li.className]),
  );
  if (
    JSON.stringify(commenters) !==
    JSON.stringify([
      ["@buyer_3", "hot"],
      ["@buyer_1", "hot"],
      ["@fan.2", ""],
    ])
  )
    fail(`unexpected commenters ${JSON.stringify(commenters)}`);
  const before = saved.length;
  panel.once("dialog", (d) => d.accept());
  await panel.click("#saveInterested");
  await panel.waitForTimeout(500);
  if (JSON.stringify(saved.slice(before).sort()) !== JSON.stringify(["buyer_1", "buyer_3"]))
    fail(`expected the two interested commenters, got ${saved.slice(before)}`);
  step("manual: reads a post's commenters and saves the interested ones");

  // An account on another platform (a stand-in TikTok page), linked to a lead.
  await context.route("https://www.tiktok.com/**", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html><head><title>Gold Coach (@goldcoach) | TikTok</title>
        <meta property="og:description" content="تداول الذهب يومياً"></head><body><h1>goldcoach</h1></body></html>`,
    }),
  );
  await site.goto("https://www.tiktok.com/@GoldCoach");
  await panel.click("#readOther");
  await panel.waitForFunction(() =>
    document.querySelector("#otherOut")?.textContent?.includes("@goldcoach"),
  );
  if (!(await panel.textContent("#otherOut"))?.includes("تداول الذهب"))
    fail("page description missing");
  await panel.fill("#linkOtherUser", "@Acme");
  panel.once("dialog", (d) => d.accept());
  await panel.click('#linkOtherForm button[type="submit"]');
  await panel.waitForTimeout(500);
  if (
    JSON.stringify(linked.at(-1)) !==
    JSON.stringify({ username: "acme", url: "https://www.tiktok.com/@goldcoach" })
  )
    fail(`unexpected link request ${JSON.stringify(linked)}`);
  step("manual: reads an account on another platform and links it to a lead");
  await site.goto(`${origin}/acme/`);
  saved.length = 0;
  await panel.click("#collectClear");

  // Auto: the agent browses by itself.
  await site.reload();
  await site.bringToFront();
  await panel.click('[data-tab="auto"]');
  await panel.fill("#task", "اجمع متابعي هذا الحساب واحفظهم");
  await panel.click("#runTask");
  await panel.waitForFunction(
    () => document.querySelector("#autoLog")?.textContent?.includes("حفظت المتابعين في المنصة"),
    null,
    { timeout: 60_000 },
  );
  const log = await panel.textContent("#autoLog");
  if (log.includes("TEST ERROR")) fail(log);
  // The list starts with 20 and loads 20 more each time it is scrolled to the end (60 in all).
  if (saved.length <= 20) fail(`auto mode saved only ${saved.length} usernames:\n${log}`);
  step(`auto: opened the list, scrolled it and saved ${saved.length} followers`);

  const typedPassword = modelRequests
    .flatMap((r) => r.messages)
    .find((m) => m.role === "tool" && /حقل محمي/.test(m.content));
  if (!typedPassword) fail("the password field was not refused");
  const pw = await site.locator('input[type="password"]').inputValue();
  if (pw !== "") fail("the password field was filled");
  step("auto: refuses to type into the password field");

  const autoReq = modelRequests.find((r) => r.tools);
  const sys = autoReq.messages[0].content;
  if (!/untrusted/.test(sys)) fail("system prompt lacks the untrusted-content rule");
  const toolNames = autoReq.tools.map((t) => t.function.name);
  if (!toolNames.includes("click") || toolNames.includes("screenshot")) fail(`tools: ${toolNames}`);
  step("auto: sends the safety rules and the right tools to the model");

  // A site that is not allowed is refused.
  const other = await context.newPage();
  await other.goto(`http://localhost:${server.address().port}/acme/`);
  await other.bringToFront();
  await panel.click('[data-tab="manual"]');
  await panel.click("#readProfile");
  await panel.waitForFunction(() =>
    document.querySelector("#profileOut")?.textContent?.includes("ليست ضمن المواقع المسموحة"),
  );
  step("refuses sites that are not allowed");

  // The badge on profile pages: new account with a save button, known lead with its status.
  saved.length = 0;
  await site.bringToFront();
  await site.goto(`${origin}/acme/`);
  await site.locator(".t").filter({ hasText: "حساب جديد" }).waitFor({ timeout: 10_000 });
  await site.locator("button", { hasText: "احفظ" }).click();
  await site.locator(".t").filter({ hasText: "أُرسل للمنصة" }).waitFor();
  if (saved.join() !== "acme") fail(`badge saved ${saved.join()}`);
  await site.goto(`${origin}/known/`);
  await site.locator(".t").filter({ hasText: "في المنصة: مهتم · 72" }).waitFor({ timeout: 10_000 });
  step("badge on profiles: shows a known lead's status and saves a new account");

  if (errors.length) fail(`page errors: ${errors.join("; ")}`);
  step("no page errors");
} finally {
  await context.close();
  server.close();
  await rm(profile, { recursive: true, force: true });
}
