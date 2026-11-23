import { syncOwnAccount } from "@/app/actions";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, Field, fmtDate, fmtNum, Input, Notice, Select } from "@/components/ui";
import { metaVerifyToken } from "@/lib/backup";
import { appOrigin } from "@/lib/env";
import { getRuntime } from "@/lib/runtime";

export const metadata = { title: "حسابي" };

const money = (n: number) => `$${n.toLocaleString("en", { maximumFractionDigits: 0 })}`;

export default async function OwnPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const q = await searchParams;
  const rt = await getRuntime();
  const projects = await rt.scrapers.listProjects();
  const projectId = q.project ?? projects[0]?.id;
  const connected = rt.scrapers.ownAccountAvailable;
  const [posts, hot] = await Promise.all([
    projectId ? rt.scrapers.ownPostPerformance(projectId) : Promise.resolve([]),
    rt.scrapers.hotComments(30),
  ]);

  return (
    <div className="space-y-4">
      {!connected && (
        <Notice tone="info">
          اربط حسابك التجاري (Business أو Creator) بإضافة IG_BUSINESS_ACCOUNT_ID و IG_GRAPH_TOKEN في
          إعدادات الاستضافة، ثم META_APP_SECRET لاستقبال الرسائل والتعليقات فوراً. الشرح في
          docs/DEPLOY-VERCEL.md.
        </Notice>
      )}

      <Card
        title="منشوراتي"
        icon="chart"
        description="كل منشور: إعجاباته وتعليقاته، وكم تعليقاً يدل على اهتمام، وما جلبه فعلاً من عملاء ومال."
      >
        {connected && projectId && (
          <ActionForm
            action={syncOwnAccount}
            submit="اقرأ الآن"
            className="mb-4 flex flex-wrap items-end gap-2"
          >
            <Field label="أضف المهتمين إلى">
              <Select name="project" defaultValue={projectId}>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
          </ActionForm>
        )}
        {posts.length === 0 ? (
          <p className="text-sm text-muted">لم تُقرأ منشوراتك بعد.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-[12.5px] text-muted">
                  {["المنشور", "إعجاب", "تعليق", "مهتمون", "عملاء", "صفقات", "العائد"].map((h) => (
                    <th key={h} className="px-2 py-2 text-start font-medium first:ps-0">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {posts.map((p) => (
                  <tr key={p.mediaId} className="border-b border-line align-top last:border-0">
                    <td className="max-w-xs py-2.5 pe-2">
                      <a
                        href={p.permalink ?? "#"}
                        target="_blank"
                        rel="noreferrer"
                        className="line-clamp-2 hover:underline"
                      >
                        {p.caption?.slice(0, 120) || "منشور"}
                      </a>
                      <div className="text-xs text-muted">
                        {p.type ?? ""} {p.postedAt ? `· ${fmtDate(p.postedAt)}` : ""}
                      </div>
                    </td>
                    <td className="px-2 tabular-nums">{fmtNum(p.likes)}</td>
                    <td className="px-2 tabular-nums">{fmtNum(p.comments)}</td>
                    <td className="px-2 tabular-nums">{fmtNum(p.intentComments)}</td>
                    <td className="px-2 tabular-nums">{fmtNum(p.leads)}</td>
                    <td className="px-2 tabular-nums">{fmtNum(p.customers)}</td>
                    <td className="px-2 tabular-nums">{money(p.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="تعليقات ساخنة"
        icon="sparkles"
        description="من سأل عن السعر أو التفاصيل في تعليقاته. يُضافون للعملاء عند القراءة، والرد عليهم منك."
      >
        {hot.length === 0 ? (
          <p className="text-sm text-muted">لا توجد بعد.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {hot.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2 py-2">
                {c.username && (
                  <a
                    href={`https://instagram.com/${c.username}`}
                    target="_blank"
                    rel="noreferrer"
                    className="ltr font-medium text-accent hover:underline"
                  >
                    @{c.username}
                  </a>
                )}
                <span className="min-w-0 flex-1 truncate">{c.text}</span>
                {c.intent?.map((w) => (
                  <Badge key={w} tone="ok" dot={false}>
                    {w}
                  </Badge>
                ))}
                {c.at && <span className="text-xs text-muted">{fmtDate(c.at)}</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="استقبال فوري (Webhook)"
        icon="plug"
        description="في تطبيق Meta للمطورين، اشترك في حقلي messages و comments بهذا الرابط ورمز التحقق."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="رابط الاستقبال">
            <Input
              readOnly
              className="ltr font-mono text-xs"
              value={`${appOrigin()}/api/meta/webhook`}
              aria-label="رابط الاستقبال"
            />
          </Field>
          <Field label="رمز التحقق (Verify token)">
            <Input
              readOnly
              className="ltr font-mono text-xs"
              value={metaVerifyToken()}
              aria-label="رمز التحقق"
            />
          </Field>
        </div>
      </Card>
    </div>
  );
}
