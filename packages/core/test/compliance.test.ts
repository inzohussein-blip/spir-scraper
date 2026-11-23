import { describe, expect, it } from "vitest";
import { checkMessage } from "../src/index.js";

const codes = (t: string) => checkMessage(t).issues.map((i) => i.code);

describe("compliance check", () => {
  it("blocks promised and guaranteed returns and 'risk-free'", () => {
    expect(codes("انضم لنا وحقق أرباح مضمونة كل شهر")).toContain("guaranteed");
    expect(checkMessage("أرباح مضمونة").ok).toBe(false);
    expect(codes("عائد 20% شهري على حسابك")).toContain("promised_return");
    expect(codes("اربح 500$ في أسبوع")).toContain("promised_return");
    expect(codes("Earn $1000 daily, risk-free")).toEqual(
      expect.arrayContaining(["promised_return", "risk_free"]),
    );
    expect(codes("تداول بدون أي مخاطرة")).toContain("risk_free");
  });

  it("warns about pressure, certainty, license claims and a missing risk warning", () => {
    expect(codes("توصيات ذهب ناجحة 100% سارع بالتسجيل")).toEqual(
      expect.arrayContaining(["certain_signals", "pressure", "no_risk_warning"]),
    );
    expect(codes("وسيط مرخص من هيئة دبي")).toContain("license_claim");
    const fine = checkMessage(
      "مرحباً أحمد، أعجبني محتواك عن تداول الذهب. هل تهتم بشراكة؟ التداول ينطوي على مخاطر.",
    );
    expect(fine).toEqual({ ok: true, issues: [] });
    expect(checkMessage("مرحباً، كيف حالك؟")).toEqual({ ok: true, issues: [] });
  });
});
