import { describe, expect, it } from "vitest";
import { uploadSource } from "../src/source.js";
import type { RawProfile } from "../src/types.js";
import { FakeProvider, setup } from "./helpers.js";

type T = Awaited<ReturnType<typeof setup>>;
const settle = async (t: T) => {
  for (let i = 0; i < 50; i++)
    if ((await t.scrapers.drain({ budgetMs: 5_000 })).activeJobs === 0) return;
};

/** Business accounts that show no email or number on their profile. */
const PROFILES: Record<string, RawProfile> = {
  site1: {
    igUserId: "id-site1",
    username: "site1",
    fullName: "FX Academy",
    isBusiness: true,
    isVerified: false,
    followers: 5000,
    bio: "Trading academy",
    externalUrl: "https://fx-academy.example/",
  },
  again2: {
    igUserId: "id-again2",
    username: "again2",
    fullName: "Coach",
    isBusiness: true,
    isVerified: false,
    followers: 3000,
    bio: "Gold signals",
  },
  personal3: {
    igUserId: "id-personal3",
    username: "personal3",
    fullName: "Someone",
    isBusiness: false,
    isVerified: false,
    followers: 120,
    bio: "just me",
    externalUrl: "https://my-blog.example/",
  },
  none4: {
    igUserId: "id-none4",
    username: "none4",
    fullName: "Quiet shop",
    isBusiness: true,
    isVerified: false,
    followers: 900,
    bio: "Shop",
  },
};

function make(opts: { reread?: boolean } = {}) {
  const sites: string[] = [];
  const rereads: string[][] = [];
  const t = setup(
    [new FakeProvider("worker", ["profile"], { profile: (u) => PROFILES[u] as RawProfile })],
    undefined,
    {
      tools: {
        siteContacts: async (url) => {
          sites.push(url);
          return url.includes("fx-academy")
            ? { emails: ["info@fx-academy.example"], phones: ["+971 50 123 4567"] }
            : { emails: ["me@my-blog.example"], phones: [] };
        },
        ...(opts.reread
          ? {
              rereadProfiles: async (names: string[]) => {
                rereads.push(names);
                return names
                  .filter((n) => n === "again2")
                  .map((n) => ({
                    ...(PROFILES[n] as RawProfile),
                    businessEmail: "hello@coach.example",
                  }));
              },
            }
          : {}),
      },
    },
  );
  return { t, sites, rereads };
}

describe("deep contact search", () => {
  it("finds emails on the website and through a second read, once per account", async () => {
    const { t: ready, sites, rereads } = make({ reread: true });
    const t = await ready;
    try {
      const p = await t.scrapers.createProject({ name: "p", owner: "o" });
      const { job } = await t.scrapers.startJob({
        projectId: p.id,
        source: uploadSource(Object.keys(PROFILES), "list"),
        limit: 10,
      });
      await settle(t);
      expect(await t.scrapers.jobContactCounts(job.id)).toMatchObject({ total: 4, email: 0 });
      // The personal account is never searched: only business, verified and large ones.
      expect(await t.scrapers.deepContactCandidates({ projectId: p.id })).toBe(3);

      const r = await t.scrapers.deepContactSearch({ projectId: p.id, reread: true });
      expect(r).toMatchObject({ checked: 3, found: 2, emails: 2, phones: 1, remaining: 0 });
      expect(r.bySource).toEqual({ website: 1, business_button: 1 });
      expect(r.costUsd).toBeGreaterThan(0);
      expect(rereads[0]?.sort()).toEqual(["again2", "none4", "site1"]);
      expect(sites).toEqual(["https://fx-academy.example/"]);

      const leads = await t.scrapers.listLeads({ projectId: p.id });
      const by = (u: string) => leads.find((l) => l.username === u);
      expect(by("site1")).toMatchObject({
        email: "info@fx-academy.example",
        phone: "+971501234567",
        contactSource: "website",
      });
      expect(by("again2")?.email).toBe("hello@coach.example");
      expect(by("personal3")?.email ?? null).toBeNull();

      // Searched accounts are not searched again for 30 days.
      expect(await t.scrapers.deepContactCandidates({ projectId: p.id })).toBe(0);
      expect((await t.scrapers.deepContactSearch({ projectId: p.id })).checked).toBe(0);
    } finally {
      await t.close();
    }
  });

  it("runs by itself after a job when asked, and respects the do-not-contact list", async () => {
    const { t: ready } = make();
    const t = await ready;
    try {
      await t.scrapers.suppress("email", "info@fx-academy.example");
      const p = await t.scrapers.createProject({ name: "p", owner: "o" });
      const { job } = await t.scrapers.startJob({
        projectId: p.id,
        source: uploadSource(["site1", "none4"], "list"),
        limit: 10,
        deepContacts: { reread: false },
      });
      await settle(t);
      // site1's email is on the do-not-contact list, so nothing is added.
      const leads = await t.scrapers.listLeads({ projectId: p.id });
      expect(leads.every((l) => !l.email)).toBe(true);
      expect(await t.scrapers.deepContactCandidates({ jobId: job.id })).toBe(0);
    } finally {
      await t.close();
    }
  });
});
