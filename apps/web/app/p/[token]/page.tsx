import { notFound } from "next/navigation";
import { getRuntime } from "@/lib/runtime";

export const metadata = { title: "لوحة الشريك", robots: { index: false, follow: false } };

/**
 * A partner's own read-only page (the link is the secret): their tracking
 * link and their numbers. No client names, emails or phones are shown.
 */
export default async function PartnerPortal({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const rt = await getRuntime();
  const partner = await rt.scrapers.partnerByToken(token);
  if (!partner) notFound();
  const [stats] = await rt.scrapers.partnerStats({ partnerId: partner.id });
  const [month] = await rt.scrapers.partnerStats({
    partnerId: partner.id,
    since: new Date(Date.now() - 30 * 86_400_000),
  });
  const origin = process.env.APP_URL?.replace(/\/$/, "") ?? "";
  const money = (n: number) => `$${n.toLocaleString("en", { maximumFractionDigits: 2 })}`;
  const rows: [string, string, string][] = [
    ["الزيارات من رابطك", String(month?.clicks ?? 0), String(stats?.clicks ?? 0)],
    ["التسجيلات", String(month?.registrations ?? 0), String(stats?.registrations ?? 0)],
    ["أول إيداع", String(month?.ftds ?? 0), String(stats?.ftds ?? 0)],
    ["مجموع الإيداعات", money(month?.deposits ?? 0), money(stats?.deposits ?? 0)],
    [
      `حصتك (${partner.sharePercent}%)`,
      money(month?.partnerShare ?? 0),
      money(stats?.partnerShare ?? 0),
    ],
  ];
  return (
    <main dir="rtl" className="mx-auto max-w-xl space-y-5 p-6">
      <h1 className="text-xl font-bold">أهلاً {partner.name}</h1>
      {!partner.active && (
        <p className="rounded-lg bg-bg-2 p-3 text-sm">هذه الشراكة متوقفة حالياً.</p>
      )}
      <div className="rounded-xl border border-line p-4">
        <div className="mb-1 text-xs text-muted">رابطك</div>
        <code className="ltr block select-all break-all text-sm">{`${origin}/r/${partner.code}`}</code>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-xs text-muted">
            <th className="py-2 text-start font-medium">البند</th>
            <th className="py-2 text-start font-medium">آخر 30 يوماً</th>
            <th className="py-2 text-start font-medium">منذ البداية</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, m, all]) => (
            <tr key={label} className="border-b border-line last:border-0">
              <td className="py-2.5">{label}</td>
              <td className="tabular-nums">{m}</td>
              <td className="tabular-nums">{all}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-muted">
        الأرقام من تقارير الوسيط، وتتحدّث عند وصولها. التداول ينطوي على مخاطر.
      </p>
    </main>
  );
}
