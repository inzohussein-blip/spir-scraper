import { describe, expect, it } from "vitest";
import { parseBrokerCsv, parseBrokerEvent, parseCsvRows } from "../src/index.js";

describe("broker reports", () => {
  it("reads a postback whatever the system calls its fields", () => {
    expect(
      parseBrokerEvent({
        goal: "FTD",
        player_id: "9921",
        Email: "Ali@Example.com",
        payout: "250.50",
        cur: "usd",
        aff_sub: "gold7",
        date: "1767225600",
      }),
    ).toEqual({
      event: "ftd",
      externalId: "9921",
      email: "ali@example.com",
      phone: null,
      amount: 250.5,
      currency: "USD",
      sub: "gold7",
      at: new Date("2026-01-01T00:00:00Z"),
    });
    // Unfilled macros are empty; unknown events are ignored.
    expect(
      parseBrokerEvent({ event: "registration", email: "{email}", sub: "{subid}" }),
    ).toMatchObject({
      event: "registration",
      email: null,
      sub: null,
    });
    expect(parseBrokerEvent({ event: "click" })).toBeNull();
  });

  it("parses CSV with quotes, semicolons and Arabic headers", () => {
    expect(parseCsvRows('a;b\n"x;1";"say ""hi"""\n')).toEqual([{ a: "x;1", b: 'say "hi"' }]);
    const events = parseBrokerCsv(
      "﻿رقم العميل,البريد,الهاتف,الإيداع,العمولة,التاريخ\n" +
        "77,sara@ex.com,+966500000001,1000,120,2026-02-01\n" +
        "78,omar@ex.com,,0,0,2026-02-02\n",
    );
    expect(events).toEqual([
      expect.objectContaining({
        event: "ftd",
        externalId: "77",
        email: "sara@ex.com",
        amount: 1000,
      }),
      expect.objectContaining({
        event: "commission",
        externalId: "77",
        amount: 120,
        phone: "+966500000001",
      }),
    ]);
  });

  it("uses the event column when there is one", () => {
    const events = parseBrokerCsv("type,email,amount\nsignup,a@b.co,\ncommission,a@b.co,40\n");
    expect(events.map((e) => [e.event, e.amount])).toEqual([
      ["registration", null],
      ["commission", 40],
    ]);
  });
});
