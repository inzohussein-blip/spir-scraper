import { LANGUAGE_LABELS } from "@scrapers/core";
import Link from "next/link";
import { addLeadNote } from "@/app/actions";
import { ActionForm } from "@/components/action-form";
import { FollowUpInput } from "@/components/follow-up";
import { StatusSelect } from "@/components/status-select";
import { Badge, Card, fmtDate, fmtNum, Notice, Textarea } from "@/components/ui";
import { getRuntime } from "@/lib/runtime";
import { fillTemplate, waLink } from "@/lib/whatsapp";

export const metadata = { title: "العميل" };

const KIND: Record<string, { label: string; tone: "info" | "accent" | "ok" | "warn" }> = {
  note: { label: "ملاحظة", tone: "accent" },
  status: { label: "حالة", tone: "info" },
  follow_up: { label: "متابعة", tone: "ok" },
  change: { label: "تغيّر الحساب", tone: "warn" },
};

export default async function LeadPage({
  params,
  searchParams,
}: {
  params: Promise<{ username: string }>;
  searchParams: Promise<{ project?: string }>;
}) {
  const { username } = await params;
  const { project: projectParam } = await searchParams;
  const rt = await getRuntime();
  const projects = await rt.scrapers.listProjects();
  const projectId = projectParam ?? projects[0]?.id;
  const project = projects.find((p) => p.id === projectId);
  if (!projectId || !project) return <Notice tone="info">لا توجد مشاريع بعد.</Notice>;
  const detail = await rt.scrapers.leadDetail(projectId, decodeURIComponent(username));
  if (!detail) return <Notice tone="warn">هذا الحساب غير موجود في المشروع {project.name}.</Notice>;
  const { lead: r, bio, events } = detail;
  const wa = waLink(r.phone, r.phoneConfirmed, fillTemplate(project.messageTemplate, r));

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
      <div className="space-y-4">
        <Card
          title={`@${r.username}`}
          icon="users"
          description={[r.fullName, r.category, r.city].filter(Boolean).join(" · ") || undefined}
          actions={
            <a
              href={`https://www.instagram.com/${r.username}/`}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-accent hover:underline"
            >
              فتح في إنستقرام
            </a>
          }
        >
          {bio && <p className="mb-3 whitespace-pre-line text-sm">{bio}</p>}
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted">المتابعون</dt>
              <dd className="tabular-nums">{fmtNum(r.followers)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">التفاعل</dt>
              <dd>{r.engagementRate !== null ? `${r.engagementRate.toFixed(1)}%` : "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">الدرجة</dt>
              <dd title={r.aiReason ?? undefined}>{r.aiScore ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">الدولة · اللغة</dt>
              <dd>
                {[r.country, r.language ? (LANGUAGE_LABELS[r.language] ?? r.language) : null]
                  .filter(Boolean)
                  .join(" · ") || "—"}
              </dd>
            </div>
            <div className="col-span-2">
              <dt className="text-xs text-muted">الإيميل</dt>
              <dd className="ltr">{r.email ?? "—"}</dd>
            </div>
            <div className="col-span-2">
              <dt className="text-xs text-muted">الهاتف</dt>
              <dd>
                <span className="ltr">{r.phone ?? "—"}</span>
                {wa && (
                  <a
                    href={wa}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ms-2 text-xs text-ok hover:underline"
                  >
                    واتساب ←
                  </a>
                )}
              </dd>
            </div>
          </dl>
          {r.aiReason && <p className="mt-3 text-xs text-muted">سبب الدرجة: {r.aiReason}</p>}
        </Card>

        <Card title="السجل والملاحظات" icon="activity">
          <ActionForm action={addLeadNote} submit="أضف ملاحظة">
            <input type="hidden" name="project" value={projectId} />
            <input type="hidden" name="username" value={r.username} />
            <Textarea
              name="text"
              required
              rows={3}
              placeholder="مثال: اتصلت به، طلب عرض الأسعار يوم الأحد"
              aria-label="ملاحظة"
            />
          </ActionForm>
          {events.length === 0 ? (
            <p className="mt-4 text-sm text-muted">لا يوجد سجل بعد.</p>
          ) : (
            <ol className="mt-4 space-y-3 text-sm">
              {events.map((e) => (
                <li key={`${e.at.toISOString()}-${e.kind}`} className="flex gap-3">
                  <span className="w-28 shrink-0 text-xs text-muted">{fmtDate(e.at)}</span>
                  <span className="space-x-2">
                    <Badge tone={KIND[e.kind]?.tone ?? "plain"} dot={false}>
                      {KIND[e.kind]?.label ?? e.kind}
                    </Badge>
                    <span className="whitespace-pre-line">{e.text}</span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>

      <div className="space-y-4">
        <Card title="المتابعة" icon="check">
          <div className="space-y-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span>الحالة</span>
              <StatusSelect projectId={projectId} username={r.username} status={r.status} />
            </div>
            <div className="flex items-center justify-between gap-2">
              <span>تذكير</span>
              <FollowUpInput projectId={projectId} username={r.username} at={r.followUpAt} />
            </div>
          </div>
        </Card>
        <Card title="أين وُجد" icon="radar">
          <ul className="space-y-1.5 text-sm">
            {(r.sources ?? [r.sourceUrl]).map((s) => (
              <li key={s} className="ltr truncate text-xs">
                {s}
              </li>
            ))}
          </ul>
          {r.otherProjects > 0 && (
            <p className="mt-2 text-xs text-muted">موجود أيضاً في {r.otherProjects} مشروع آخر.</p>
          )}
        </Card>
        <Link
          href={`/leads?project=${projectId}`}
          className="block text-sm text-accent hover:underline"
        >
          ← كل العملاء
        </Link>
      </div>
    </div>
  );
}
