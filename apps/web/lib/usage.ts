import "server-only";
import type { Runtime } from "@scrapers/runtime";

export type Meter = {
  key: "dbHours" | "dbStorage" | "requests" | "apify";
  label: string;
  used: number;
  limit: number;
  /** At this month's pace, by the end of the month. */
  forecast: number | null;
  unit: string;
  /** Measured by the provider itself, or estimated by the platform. */
  exact: boolean;
};

type NeonFigures = { computeHours: number; storageMb: number } | null;

/**
 * Neon's own figures for this billing period, when NEON_API_KEY and
 * NEON_PROJECT_ID are set; cached for 30 minutes so the page does not
 * call Neon on every visit. Null when not configured or not available.
 */
async function neonFigures(rt: Runtime): Promise<NeonFigures> {
  const key = process.env.NEON_API_KEY;
  const project = process.env.NEON_PROJECT_ID;
  if (!key || !project) return null;
  const cached = await rt.scrapers.getValue<NeonFigures>("usage:neon");
  if (cached) return cached;
  try {
    const res = await fetch(
      `https://console.neon.tech/api/v2/projects/${encodeURIComponent(project)}`,
      {
        headers: { authorization: `Bearer ${key}`, accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) return null;
    const p = ((await res.json()) as { project?: Record<string, unknown> }).project ?? {};
    const seconds = Number(p.compute_time_seconds ?? p.active_time_seconds ?? Number.NaN);
    const storage = Number(p.synthetic_storage_size ?? Number.NaN);
    if (!Number.isFinite(seconds)) return null;
    const out = {
      computeHours: seconds / 3600,
      storageMb: Number.isFinite(storage) ? storage / 1_048_576 : Number.NaN,
    };
    await rt.scrapers.setValue("usage:neon", out, 30 * 60_000);
    return out;
  } catch {
    return null;
  }
}

/** Every meter for this month, with its limit and forecast. */
export async function usageMeters(rt: Runtime, now = new Date()) {
  const [report, limits, apify, neon] = await Promise.all([
    rt.scrapers.usageReport(now),
    rt.scrapers.usageLimits(),
    rt.apifyUsage().catch(() => null),
    neonFigures(rt),
  ]);
  const f = report.fraction;
  const storageMb = report.storageBytes / 1_048_576;
  const meters: Meter[] = [
    {
      key: "dbHours",
      label: "ساعات تشغيل قاعدة البيانات",
      used: neon?.computeHours ?? report.dbHours,
      limit: limits.dbHours,
      forecast: (neon?.computeHours ?? report.dbHours) / f,
      unit: "ساعة",
      exact: !!neon,
    },
    {
      key: "dbStorage",
      label: "حجم قاعدة البيانات",
      used: neon && Number.isFinite(neon.storageMb) ? neon.storageMb : storageMb,
      limit: limits.dbStorageMb,
      forecast: null,
      unit: "MB",
      exact: true,
    },
    {
      key: "requests",
      label: "طلبات المنصة (Vercel)",
      used: report.requests,
      limit: limits.requests,
      forecast: report.forecast.requests,
      unit: "طلب",
      exact: false,
    },
  ];
  if (apify)
    meters.push({
      key: "apify",
      label: "رصيد Apify",
      used: apify.usedUsd,
      limit: apify.allowedUsd || limits.apifyUsd,
      forecast: apify.usedUsd / f,
      unit: "$",
      exact: true,
    });
  return { report, limits, meters, neonConnected: !!neon };
}

export const pct = (m: Meter) => (m.limit > 0 ? (m.used / m.limit) * 100 : 0);

/** The worst state of a meter: over 90% now or heading past the limit, or over 70%. */
export function level(m: Meter): "ok" | "warn" | "bad" {
  const p = pct(m);
  const f = m.forecast !== null && m.limit > 0 ? (m.forecast / m.limit) * 100 : 0;
  if (p >= 90 || f >= 100) return "bad";
  if (p >= 70 || f >= 85) return "warn";
  return "ok";
}

const fmt = (n: number, unit: string) =>
  unit === "$"
    ? `$${n.toFixed(2)}`
    : `${n < 10 ? n.toFixed(1) : Math.round(n).toLocaleString("en")} ${unit}`;

/** One line per meter, for Telegram. */
export function meterLine(m: Meter): string {
  const f = m.forecast !== null ? ` (توقع الشهر ${fmt(m.forecast, m.unit)})` : "";
  return `${m.label}: ${fmt(m.used, m.unit)} من ${fmt(m.limit, m.unit)}${f}`;
}

/**
 * Alerts once per meter, level and month (bell and Telegram) when a meter
 * passes 70% or 90%, or is heading past its limit. Returns the lines sent.
 */
export async function usageAlerts(rt: Runtime, now = new Date()) {
  const { meters } = await usageMeters(rt, now);
  const month = now.toISOString().slice(0, 7);
  const sent: string[] = [];
  for (const m of meters) {
    const lv = level(m);
    if (lv === "ok") continue;
    const ok = await rt.scrapers.notify({
      type: "system",
      level: lv === "bad" ? "bad" : "warn",
      title: lv === "bad" ? `الاستهلاك قارب الحد: ${m.label}` : `الاستهلاك يرتفع: ${m.label}`,
      body: `${meterLine(m)}. التفاصيل ونصائح التوفير في صفحة الاستهلاك.`,
      url: "/usage",
      key: `usage:${m.key}:${lv}:${month}`,
    });
    if (ok) sent.push(meterLine(m));
  }
  return { meters, sent };
}
