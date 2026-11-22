import { describe, expect, it } from "vitest";
import {
  contactsFromText,
  isInstagramHost,
  parseCount,
  parseOgDescription,
  parseOgTitle,
  usernameFromPath,
  usernamesFromHrefs,
} from "../src/page/instagram.js";

describe("Instagram page helpers", () => {
  it("reads the account from a profile or list path, not from other pages", () => {
    expect(usernameFromPath("/Competitor.FX/")).toBe("competitor.fx");
    expect(usernameFromPath("/competitor/followers/")).toBe("competitor");
    expect(usernameFromPath("/p/ABC/")).toBeNull();
    expect(usernameFromPath("/explore/")).toBeNull();
    expect(usernameFromPath("/a/b/c")).toBeNull();
  });

  it("collects usernames from list links, skipping pages, duplicates and the list owner", () => {
    expect(
      usernamesFromHrefs(
        [
          "/fan_1/",
          "/Fan_1/",
          "https://www.instagram.com/fan.two/",
          "/competitor/",
          "/p/XYZ/",
          "/explore/tags/fx/",
          "https://evil.example/fan3/",
          "/stories/someone/",
          "#",
        ],
        "competitor",
      ),
    ).toEqual(["fan_1", "fan.two"]);
  });

  it("parses counts in English, abbreviations and Arabic", () => {
    expect(parseCount("1.2M")).toBe(1_200_000);
    expect(parseCount("12K")).toBe(12_000);
    expect(parseCount("1,234")).toBe(1234);
    expect(parseCount("٣٫٥ ألف".replace("٫", "."))).toBe(3500);
    expect(parseCount("abc")).toBeNull();
  });

  it("reads og:title and og:description", () => {
    expect(parseOgTitle("Acme Trading (@acme.fx) • Instagram photos and videos")).toEqual({
      name: "Acme Trading",
      username: "acme.fx",
    });
    expect(
      parseOgDescription(
        "1.5M Followers, 320 Following, 1,024 Posts - See Instagram photos and videos from Acme (@acme)",
      ),
    ).toEqual({ followers: 1_500_000, following: 320, posts: 1024 });
  });

  it("finds written-out emails and phones, including Arabic digits", () => {
    const c = contactsFromText(
      "تواصل: info [at] acme [dot] sa\nواتساب ٠٥٠١٢٣٤٥٦٧ أو +966 50 123 4567",
    );
    expect(c.emails).toEqual(["info@acme.sa"]);
    expect(c.phones).toEqual(expect.arrayContaining(["0501234567", "+966501234567"]));
  });

  it("recognises Instagram hosts", () => {
    expect(isInstagramHost("www.instagram.com")).toBe(true);
    expect(isInstagramHost("instagram.com.evil.io")).toBe(false);
  });
});
