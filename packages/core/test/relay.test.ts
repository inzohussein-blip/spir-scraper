import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkRelayUrl, openRelay, relayKeys, sealRelay } from "../src/rae-relay.js";
import { setup } from "./helpers.js";

const SECRET = "x".repeat(40);
const BRIDGE = join(__dirname, "../../../services/ig-worker/rae_bridge.py");

/** Runs the bridge's own seal/open in Python (the other end of the relay). */
function python(code: string): string {
  return execFileSync(
    "python3",
    [
      "-c",
      `import importlib.util,sys,json
spec=importlib.util.spec_from_file_location("b", ${JSON.stringify(BRIDGE)})
b=importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
k=b.relay_keys(${JSON.stringify(SECRET)})
${code}`,
    ],
    { encoding: "utf8" },
  ).trim();
}

describe("relay seal", () => {
  it("is the same construction in Node and in the Python bridge", () => {
    const keys = relayKeys(SECRET);
    expect(python("print(k['topic'], k['token'])")).toBe(`${keys.topic} ${keys.token}`);
    const fromNode = sealRelay(keys, { id: "n1", text: "من المنصة" });
    expect(
      python(`print(json.dumps(b.open_relay(k, ${JSON.stringify(fromNode)}), ensure_ascii=False))`),
    ).toBe('{"id": "n1", "text": "من المنصة"}');
    const fromPython = python(`print(b.seal_relay(k, {"id": "p1", "text": "من الجسر"}))`);
    expect(openRelay(keys, fromPython)).toEqual({ id: "p1", text: "من الجسر" });
    expect(openRelay(relayKeys("y".repeat(40)), fromPython)).toBeNull();
  });

  it("refuses Meta and TikTok sites", () => {
    expect(checkRelayUrl("https://www.instagram.com/a/")).toHaveProperty("error");
    expect(checkRelayUrl("https://business.facebook.com")).toHaveProperty("error");
    expect(checkRelayUrl("ftp://example.com")).toHaveProperty("error");
    expect(checkRelayUrl("https://example.com/jobs")).toEqual({ url: "https://example.com/jobs" });
  });
});

describe("relay through the platform", () => {
  it("sends a sealed request, takes sealed reports only with the token, and returns the files", async () => {
    const published: string[] = [];
    const t = await setup([], undefined, {
      relay: { secret: SECRET, publish: async (m) => void published.push(m) },
    });
    try {
      const keys = relayKeys(SECRET);
      expect(t.scrapers.raeRelayAvailable).toBe(true);
      await expect(
        t.scrapers.raeRelayStart({ url: "https://tiktok.com/@a", prompt: "x" }),
      ).rejects.toThrow(/tiktok/);
      const { job_id } = await t.scrapers.raeRelayStart({
        url: "https://example.com/brokers",
        prompt: "licensed brokers",
      });
      const sent = openRelay<Record<string, unknown>>(keys, published[0] as string);
      expect(sent).toMatchObject({
        v: 1,
        id: job_id,
        kind: "agent",
        url: "https://example.com/brokers",
      });
      expect(published[0]).not.toContain("brokers"); // ntfy sees only ciphertext
      expect((await t.scrapers.raeRelayResult(job_id))?.status).toBe("sent");

      const report = (m: Record<string, unknown>) => sealRelay(keys, m);
      expect(
        await t.scrapers.raeRelayReport("wrong", report({ id: job_id, status: "accepted" })),
      ).toBe(false);
      expect(await t.scrapers.raeRelayReport(keys.token, "garbage")).toBe(false);
      expect(
        await t.scrapers.raeRelayReport(keys.token, report({ id: "unknown", status: "done" })),
      ).toBe(false);
      expect(
        await t.scrapers.raeRelayReport(keys.token, report({ id: job_id, status: "accepted" })),
      ).toBe(true);
      expect((await t.scrapers.raeRelayResult(job_id))?.status).toBe("accepted");
      const fromBridge = python(
        `print(b.seal_relay(k, {"id": ${JSON.stringify(job_id)}, "status": "done", "result": {"status": "ok", "run_id": "r1"}, "files": [{"name": "api_client.ts", "content": "fetch()"}]}))`,
      );
      expect(await t.scrapers.raeRelayReport(keys.token, fromBridge)).toBe(true);
      const done = await t.scrapers.raeRelayResult(job_id);
      expect(done).toMatchObject({ status: "done", result: { run_id: "r1" } });
      expect(done?.files?.[0]).toEqual({ name: "api_client.ts", content: "fetch()" });

      const eng = await t.scrapers.raeRelayEngineer({
        run_id: "r1",
        prompt: "pagination",
        fresh: true,
      });
      expect(openRelay(keys, published[1] as string)).toMatchObject({
        id: eng.job_id,
        kind: "engineer",
        fresh: true,
      });
    } finally {
      await t.close();
    }
  });

  it("says it is off without RAE_RELAY_SECRET", async () => {
    const t = await setup([]);
    try {
      expect(t.scrapers.raeRelayAvailable).toBe(false);
      await expect(
        t.scrapers.raeRelayStart({ url: "https://example.com", prompt: "x" }),
      ).rejects.toThrow(/RAE_RELAY_SECRET/);
    } finally {
      await t.close();
    }
  });
});
