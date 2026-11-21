import { BlockedError, ProviderError, RateLimitedError } from "@scrapers/core";
import { describe, expect, it } from "vitest";
import { GraphProvider, providersFromEnv } from "../src/index.js";

const respond =
  (body: unknown, status = 200) =>
  async () =>
    new Response(JSON.stringify(body), { status });

describe("GraphProvider", () => {
  it("maps Business Discovery onto a business profile", async () => {
    let url = "";
    const p = new GraphProvider({
      igUserId: "1789",
      accessToken: "tok",
      fetch: async (u) => {
        url = u;
        return new Response(
          JSON.stringify({
            business_discovery: {
              id: "42",
              username: "Acme",
              name: "Acme",
              biography: "bio",
              followers_count: 9,
              website: "https://a.co",
            },
          }),
        );
      },
    });
    expect(await p.getProfile("acme")).toMatchObject({
      igUserId: "42",
      username: "acme",
      isBusiness: true,
      followers: 9,
      externalUrl: "https://a.co",
      category: null,
    });
    expect(url).toContain("/v23.0/1789?fields=business_discovery.username%28acme%29");
  });

  it("maps rate limits, token problems and invisible accounts", async () => {
    const make = (body: unknown, status = 400) =>
      new GraphProvider({ igUserId: "1", accessToken: "t", fetch: respond(body, status) });
    await expect(
      make({ error: { code: 4, message: "limit" } }).getProfile("a"),
    ).rejects.toBeInstanceOf(RateLimitedError);
    await expect(
      make({ error: { code: 190, message: "expired" } }).getProfile("a"),
    ).rejects.toBeInstanceOf(BlockedError);
    const personal = make({ error: { code: 110, message: "Invalid user id" } }).getProfile("a");
    await expect(personal).rejects.toBeInstanceOf(ProviderError);
    await expect(personal).rejects.not.toBeInstanceOf(BlockedError);
    await expect(make({}, 200).getProfile("a")).rejects.toThrow(/empty response/);
  });

  it("is added between the worker and Apify when configured", () => {
    const ids = providersFromEnv({
      WORKER_URL: "w",
      IG_BUSINESS_ACCOUNT_ID: "1",
      IG_GRAPH_TOKEN: "t",
      APIFY_TOKEN: "a",
    }).map((p) => p.id);
    expect(ids).toEqual(["worker", "graph", "apify"]);
  });
});
