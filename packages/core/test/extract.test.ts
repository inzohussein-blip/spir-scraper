import { describe, expect, it } from "vitest";
import {
  contactsFromUrl,
  extractContact,
  findEmails,
  findPhones,
  flagCountries,
  inferCountries,
  isContactEligible,
  namedCountries,
  parseButtonPhone,
} from "../src/extract/index.js";
import { normalizeBio, toLatinDigits } from "../src/normalize.js";
import type { RawProfile } from "../src/types.js";

const biz = (over: Partial<RawProfile>): RawProfile => ({
  igUserId: "1",
  username: "acme",
  isBusiness: true,
  isVerified: false,
  ...over,
});

describe("normalize", () => {
  it("converts Arabic-Indic and Persian digits", () => {
    expect(toLatinDigits("٠١٢٣٤٥٦٧٨٩ ۰۱۲۳۴۵۶۷۸۹")).toBe("0123456789 0123456789");
  });

  it("undoes common email obfuscations", () => {
    expect(normalizeBio("info [at] acme [dot] com")).toContain("info@acme.com");
    expect(normalizeBio("info(at)acme.com")).toContain("info@acme.com");
    expect(normalizeBio("sales at acme dot co dot uk")).toContain("sales@acme.co.uk");
    expect(normalizeBio("mail me: hi @ acme.io")).toContain("hi@acme.io");
  });

  it("does not invent addresses from ordinary English", () => {
    expect(normalizeBio("Trading at night")).toBe("Trading at night");
  });

  it("strips invisible bidi characters", () => {
    expect(normalizeBio("a‏b‫c")).toBe("abc");
  });
});

describe("emails", () => {
  it("finds addresses and lowercases them", () => {
    expect(findEmails("Contact: Info@Acme.COM or sales@acme.com")).toEqual([
      "info@acme.com",
      "sales@acme.com",
    ]);
  });

  it("ignores image names and placeholders", () => {
    expect(findEmails("logo@2x.png example@gmail.com you@domain.com")).toEqual([]);
  });
});

describe("country inference", () => {
  it("reads flag emoji", () => {
    expect(flagCountries("📍 🇸🇦 🇦🇪")).toEqual(["SA", "AE"]);
  });

  it("reads English and Arabic country names and cities", () => {
    expect(namedCountries("Based in Dubai")).toEqual(["AE"]);
    expect(namedCountries("مقيم في الرياض")).toEqual(["SA"]);
    expect(namedCountries("العراق - بغداد")).toEqual(expect.arrayContaining(["IQ"]));
    expect(namedCountries("Germany & France")).toEqual(expect.arrayContaining(["DE", "FR"]));
  });

  it("prefers the longer name", () => {
    expect(namedCountries("South Sudan")).toEqual(["SS"]);
  });

  it("matches English names on word boundaries only", () => {
    expect(namedCountries("omanager")).toEqual([]);
  });

  it("uses email ccTLDs but not generic ones", () => {
    expect(inferCountries({ emails: ["a@b.com.sa"] })).toEqual(["SA"]);
    expect(inferCountries({ emails: ["a@b.io", "c@d.co"] })).toEqual([]);
  });

  it("orders flags before names before TLDs and de-duplicates", () => {
    expect(inferCountries({ bio: "🇮🇶 Kuwait", emails: ["x@y.iq"] })).toEqual(["IQ", "KW"]);
  });
});

describe("phones", () => {
  it("parses international numbers for any country", () => {
    expect(findPhones("+966 50 123 4567")).toEqual([{ e164: "+966501234567", country: "SA" }]);
    expect(findPhones("call +44 7911 123456")[0]?.e164).toBe("+447911123456");
    expect(findPhones("+55 11 91234-5678")[0]?.country).toBe("BR");
  });

  it("treats a 00 prefix as international", () => {
    expect(findPhones("00964 770 123 4567")[0]).toEqual({ e164: "+9647701234567", country: "IQ" });
  });

  it("parses local numbers using country hints", () => {
    expect(findPhones("0501234567", ["SA"])[0]).toEqual({ e164: "+966501234567", country: "SA" });
    expect(findPhones("07701234567", ["IQ"])[0]?.e164).toBe("+9647701234567");
  });

  it("skips hints the number is not valid for", () => {
    expect(findPhones("0501234567", ["DE", "SA"])[0]?.country).toBe("SA");
  });

  it("parses Arabic-Indic digits after normalisation", () => {
    const text = normalizeBio("واتساب ٠٥٠١٢٣٤٥٦٧");
    expect(findPhones(text, ["SA"])[0]?.e164).toBe("+966501234567");
  });

  it("returns an unconfirmed raw number when the country is unknown", () => {
    expect(findPhones("واتساب 0501234567")).toEqual([{ raw: "0501234567" }]);
  });

  it("does not treat short numbers or years as phones", () => {
    expect(findPhones("since 2019, 120k followers")).toEqual([]);
  });

  it("reads WhatsApp and tel links", () => {
    expect(findPhones("wa.me/9647701234567")[0]?.e164).toBe("+9647701234567");
    expect(findPhones("api.whatsapp.com/send?phone=201001234567")[0]?.country).toBe("EG");
  });
});

describe("contact button phones", () => {
  it("combines the number with its calling code", () => {
    expect(parseButtonPhone("0501234567", "966")).toEqual({ e164: "+966501234567", country: "SA" });
    expect(parseButtonPhone("966501234567", "966")?.e164).toBe("+966501234567");
  });

  it("accepts an already international number", () => {
    expect(parseButtonPhone("+971 50 123 4567")?.country).toBe("AE");
  });

  it("falls back to hints, then to raw", () => {
    expect(parseButtonPhone("0501234567", null, ["SA"])?.e164).toBe("+966501234567");
    expect(parseButtonPhone("12345678")).toEqual({ raw: "12345678" });
    expect(parseButtonPhone("--")).toBeUndefined();
  });
});

describe("links", () => {
  it("reads mailto, tel and WhatsApp links without fetching", () => {
    expect(contactsFromUrl("mailto:Hi@Acme.com?subject=x").emails).toEqual(["hi@acme.com"]);
    expect(contactsFromUrl("tel:+9647701234567").text).toBe("tel:+9647701234567");
    expect(contactsFromUrl("https://wa.me/9647701234567").text).toBe("wa.me/9647701234567");
  });

  it("ignores ordinary websites and junk", () => {
    expect(contactsFromUrl("https://acme.com")).toEqual({ emails: [], text: "" });
    expect(contactsFromUrl("http://")).toEqual({ emails: [], text: "" });
    expect(contactsFromUrl(null)).toEqual({ emails: [], text: "" });
  });
});

describe("eligibility", () => {
  it("allows business, verified and influencer accounts", () => {
    expect(isContactEligible({ isBusiness: true, isVerified: false, followers: 10 })).toBe(true);
    expect(isContactEligible({ isBusiness: false, isVerified: true, followers: 10 })).toBe(true);
    expect(isContactEligible({ isBusiness: false, isVerified: false, followers: 10_000 })).toBe(
      true,
    );
    expect(isContactEligible({ isBusiness: false, isVerified: false, followers: 9_999 })).toBe(
      false,
    );
    expect(isContactEligible({ isBusiness: false, isVerified: false, followers: null })).toBe(
      false,
    );
  });
});

describe("extractContact", () => {
  it("prefers the contact button", () => {
    const c = extractContact(
      biz({
        businessEmail: "Sales@Acme.com",
        businessPhone: "0501234567",
        businessPhoneCountryCode: "966",
        bio: "x@y.com",
      }),
    );
    expect(c).toMatchObject({
      email: "sales@acme.com",
      phoneE164: "+966501234567",
      phoneCountry: "SA",
      contactSource: "business_button",
    });
  });

  it("fills a missing button field from the bio", () => {
    const c = extractContact(biz({ businessEmail: "a@acme.com", bio: "📞 +971501234567" }));
    expect(c).toMatchObject({
      email: "a@acme.com",
      phoneE164: "+971501234567",
      contactSource: "business_button",
    });
  });

  it("uses a button phone alone", () => {
    const c = extractContact(biz({ businessPhone: "+201001234567", bio: "hello" }));
    expect(c).toMatchObject({
      email: null,
      phoneE164: "+201001234567",
      contactSource: "business_button",
    });
  });

  it("reads the bio with countries inferred from it", () => {
    const c = extractContact(
      biz({ bio: "مدرب تداول 🇸🇦\nواتساب: ٠٥٠١٢٣٤٥٦٧\ninfo [at] acme [dot] sa" }),
    );
    expect(c).toMatchObject({
      email: "info@acme.sa",
      phoneE164: "+966501234567",
      phoneCountry: "SA",
      contactSource: "bio",
    });
    expect(c.countries[0]).toBe("SA");
  });

  it("keeps an unconfirmed number raw", () => {
    const c = extractContact(biz({ bio: "WhatsApp 0501234567" }));
    expect(c).toMatchObject({
      phoneE164: null,
      phoneRaw: "0501234567",
      phoneCountry: null,
      contactSource: "bio",
    });
  });

  it("falls back to the bio link", () => {
    expect(
      extractContact(biz({ bio: "hi", externalUrl: "https://wa.me/9647701234567" })),
    ).toMatchObject({
      phoneE164: "+9647701234567",
      contactSource: "link",
    });
    expect(extractContact(biz({ externalUrl: "mailto:a@acme.com" }))).toMatchObject({
      email: "a@acme.com",
      contactSource: "link",
    });
  });

  it("returns nothing when there is no contact", () => {
    expect(
      extractContact(biz({ bio: "just vibes", externalUrl: "https://acme.com" })),
    ).toMatchObject({
      email: null,
      phoneE164: null,
      phoneRaw: null,
      contactSource: null,
    });
  });

  it("never returns contact details for personal accounts", () => {
    const c = extractContact(
      biz({
        isBusiness: false,
        followers: 300,
        bio: "🇮🇶 me@gmail.com +9647701234567",
        businessEmail: "me@gmail.com",
      }),
    );
    expect(c).toMatchObject({ email: null, phoneE164: null, phoneRaw: null, contactSource: null });
    expect(c.countries).toEqual(["IQ"]);
  });

  it("ignores an implausible button email", () => {
    expect(extractContact(biz({ businessEmail: "logo@2x.png" })).contactSource).toBeNull();
  });
});
