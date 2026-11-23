import { describe, expect, it } from "vitest";
import { followUpCalendar } from "../lib/ics";

describe("follow-up calendar", () => {
  it("writes one all-day event per follow-up, escaped and folded", () => {
    const ics = followUpCalendar(
      [
        {
          username: "acme",
          fullName: "Acme, Inc; FX",
          at: new Date("2030-01-15T06:00:00Z"),
          project: "وكلاء",
          projectId: "p1",
          status: "مهتم",
          note: "اتصل\nبعد الظهر",
        },
        {
          username: "none",
          fullName: null,
          at: null,
          project: "x",
          projectId: "p1",
          status: "جديد",
          note: null,
        },
      ],
      "https://app.example",
      new Date("2030-01-01T00:00:00Z"),
    );
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(ics).toContain("DTSTART;VALUE=DATE:20300115");
    expect(ics).toContain("DTEND;VALUE=DATE:20300116");
    expect(ics).toContain("UID:followup-p1-acme@spir-scraper");
    const flat = ics.replace(/\r\n /g, "");
    expect(flat).toContain("Acme\\, Inc\\; FX");
    expect(ics.replace(/\r\n /g, "")).toContain("اتصل\\nبعد الظهر");
    // No line is longer than 75 bytes.
    for (const line of ics.split("\r\n")) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
  });
});
