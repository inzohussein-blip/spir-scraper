/** Minimal iCalendar (RFC 5545) feed of follow-up reminders, one all-day event per lead. */
export interface FollowUpEvent {
  username: string;
  fullName: string | null;
  at: Date | null;
  project: string;
  projectId: string;
  status: string;
  note: string | null;
}

const esc = (s: string) => s.replace(/[;,]/g, (m) => `\\${m}`).replace(/\r?\n/g, "\\n");
const day = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");

/** Lines longer than 75 octets are folded with a leading space. */
function fold(line: string): string {
  const out: string[] = [];
  let cur = "";
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > 73) {
      out.push(cur);
      cur = ` ${ch}`;
    } else cur += ch;
  }
  out.push(cur);
  return out.join("\r\n");
}

export function followUpCalendar(
  events: FollowUpEvent[],
  origin: string,
  now = new Date(),
): string {
  const stamp = `${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//spir-scraper//follow-ups//AR",
    "CALSCALE:GREGORIAN",
    "X-WR-CALNAME:متابعات العملاء",
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
  ];
  for (const e of events) {
    if (!e.at) continue;
    const start = new Date(e.at);
    const end = new Date(start.getTime() + 86_400_000);
    lines.push(
      "BEGIN:VEVENT",
      `UID:followup-${e.projectId}-${e.username}@spir-scraper`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${day(start)}`,
      `DTEND;VALUE=DATE:${day(end)}`,
      `SUMMARY:${esc(`متابعة @${e.username}${e.fullName ? ` (${e.fullName})` : ""}`)}`,
      `DESCRIPTION:${esc(`${e.project} · ${e.status}${e.note ? `\n${e.note}` : ""}\nhttps://instagram.com/${e.username}`)}`,
      `URL:${origin}/leads?project=${e.projectId}&q=${encodeURIComponent(e.username)}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}
