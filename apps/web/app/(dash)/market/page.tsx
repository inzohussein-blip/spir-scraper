import { Badge, Card, fmtNum } from "@/components/ui";
import { getRuntime } from "@/lib/runtime";

export const metadata = { title: "السوق" };

const sign = (n: number) => `${n > 0 ? "+" : ""}${n.toLocaleString("en")}`;

export default async function MarketPage() {
  const rt = await getRuntime();
  const m = await rt.scrapers.marketIndex();

  return (
    <div className="space-y-4">
      <Card
        title="المواضيع"
        icon="chart"
        description="نسبة العملاء الجدد الذين يذكرون كل موضوع في حساباتهم، شهراً بشهر. الصاعد أولاً. يُرسل ملخصه لتيليجرام أول كل شهر."
      >
        {m.months.length === 0 ? (
          <p className="text-sm text-muted">لا توجد بيانات بعد.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-[12.5px] text-muted">
                  <th className="py-2 pe-2 text-start font-medium">الموضوع</th>
                  {m.months.map((x) => (
                    <th key={x.month} className="ltr px-2 py-2 text-start font-medium">
                      {x.month}
                    </th>
                  ))}
                  <th className="px-2 py-2 text-start font-medium">التغير</th>
                </tr>
              </thead>
              <tbody>
                {m.topics.map((t) => (
                  <tr key={t.key} className="border-b border-line last:border-0">
                    <td className="py-2.5 pe-2 font-medium">{t.label}</td>
                    {m.months.map((x) => (
                      <td key={x.month} className="px-2 tabular-nums">
                        {x.topics[t.key]}%
                      </td>
                    ))}
                    <td className="px-2">
                      {t.change === null ? (
                        "—"
                      ) : (
                        <Badge
                          tone={t.change > 0 ? "ok" : t.change < 0 ? "bad" : "plain"}
                          dot={false}
                        >
                          {sign(t.change)}
                        </Badge>
                      )}
                    </td>
                  </tr>
                ))}
                <tr className="text-xs text-muted">
                  <td className="py-2 pe-2">عملاء جدد</td>
                  {m.months.map((x) => (
                    <td key={x.month} className="px-2 tabular-nums">
                      {fmtNum(x.total)}
                    </td>
                  ))}
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="نمو المنافسين (30 يوماً)"
          icon="radar"
          description="من اللقطات اليومية للحسابات التي تراقبها."
        >
          {m.competitors.length === 0 ? (
            <p className="text-sm text-muted">راقب منافسين من صفحة المنافسين.</p>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {m.competitors.map((c) => (
                <li key={c.username} className="flex items-center gap-2 py-2">
                  <span className="ltr min-w-0 flex-1 truncate font-medium">@{c.username}</span>
                  <span className="text-xs text-muted">{fmtNum(c.followers)}</span>
                  {c.percent !== null && (
                    <Badge tone={c.percent > 0 ? "ok" : "bad"} dot={false}>
                      {sign(c.change ?? 0)} ({c.percent}%)
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="حسابات صاعدة"
          icon="sparkles"
          description="أسرع الحسابات نمواً في بياناتك (ألف متابع فأكثر): مرشحون للشراكة أو منافسون قادمون."
        >
          {m.rising.length === 0 ? (
            <p className="text-sm text-muted">تظهر بعد قراءة الحسابات أكثر من مرة.</p>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {m.rising.map((r) => (
                <li key={r.username} className="flex items-center gap-2 py-2">
                  <a
                    href={`https://instagram.com/${r.username}`}
                    target="_blank"
                    rel="noreferrer"
                    className="ltr min-w-0 flex-1 truncate font-medium text-accent hover:underline"
                  >
                    @{r.username}
                  </a>
                  <span className="text-xs text-muted">{fmtNum(r.followers)}</span>
                  <Badge tone="ok" dot={false}>
                    +{r.percent}%
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
