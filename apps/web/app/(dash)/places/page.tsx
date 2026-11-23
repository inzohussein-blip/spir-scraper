import Link from "next/link";
import { analyzePlaces, placesToLeads, searchPlaces } from "@/app/actions";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, cx, Field, fmtNum, Input, Notice } from "@/components/ui";
import { getRuntime } from "@/lib/runtime";

export const metadata = { title: "الشركات" };
// A Google Maps search runs for up to a few minutes.
export const maxDuration = 300;

export default async function PlacesPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; query?: string }>;
}) {
  const q = await searchParams;
  const rt = await getRuntime();
  const projects = await rt.scrapers.listProjects();
  const projectId = q.project ?? projects[0]?.id;
  const project = projects.find((p) => p.id === projectId);
  if (!projectId || !project) return <Notice tone="info">لا توجد مشاريع بعد.</Notice>;
  const [list, queries] = await Promise.all([
    rt.scrapers.listPlaces(projectId, q.query ? { query: q.query } : {}),
    rt.scrapers.placeQueries(projectId),
  ]);
  const pending = list.filter((p) => p.website && !p.analyzedAt).length;
  const ready = list.filter((p) => p.instagram && !p.sentAt).length;

  return (
    <div className="space-y-4">
      <Card
        title="ابحث في خرائط جوجل"
        icon="search"
        description="شركات محلية بأرقامها ومواقعها: مكاتب صرافة، ووسطاء، ومراكز تدريب. كل 1000 نتيجة حوالي 4$ من رصيد Apify."
      >
        {!rt.scrapers.placesAvailable ? (
          <Notice tone="warn">البحث في خرائط جوجل يحتاج APIFY_TOKEN.</Notice>
        ) : (
          <ActionForm
            action={searchPlaces}
            submit="ابحث"
            className="grid gap-3 sm:grid-cols-[1fr_1fr_8rem_auto] sm:items-end"
          >
            <input type="hidden" name="project" value={projectId} />
            <Field label="ماذا">
              <Input name="query" required placeholder="مكتب صرافة، أكاديمية تداول…" />
            </Field>
            <Field label="أين">
              <Input name="location" required placeholder="الرياض، السعودية" />
            </Field>
            <Field label="العدد">
              <Input name="limit" type="number" min={1} max={200} defaultValue={30} />
            </Field>
          </ActionForm>
        )}
      </Card>

      <Card
        title={`الشركات · ${project.name}`}
        icon="folder"
        description="«حلّل المواقع» يقرأ موقع كل شركة (التواصل، ومن نحن، والشراكة) ويستخرج حسابها على إنستقرام وإيميلاتها. ثم «أرسل للعملاء» يجعل حسابات إنستقرام عملاء عاديين في المشروع."
        actions={
          <div className="flex flex-wrap gap-2">
            <ActionForm action={analyzePlaces} submit={`حلّل المواقع (${pending})`} className="flex">
              <input type="hidden" name="project" value={projectId} />
            </ActionForm>
            <ActionForm action={placesToLeads} submit={`أرسل للعملاء (${ready})`} className="flex">
              <input type="hidden" name="project" value={projectId} />
            </ActionForm>
          </div>
        }
      >
        {queries.length > 1 && (
          <div className="mb-3 flex flex-wrap gap-2 text-sm">
            {queries.map((x) => (
              <Link
                key={x.query}
                href={`/places?project=${projectId}${q.query === x.query ? "" : `&query=${encodeURIComponent(x.query)}`}`}
                className={cx(
                  "rounded-full px-3 py-1",
                  q.query === x.query ? "bg-accent-soft text-accent" : "bg-bg-2 text-fg-2",
                )}
              >
                {x.query} {x.count}
              </Link>
            ))}
          </div>
        )}
        {list.length === 0 ? (
          <p className="text-sm text-muted">لا توجد شركات بعد.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-[12.5px] text-muted">
                  {["الشركة", "التقييم", "الهاتف", "الموقع", "إنستقرام", "الإيميل"].map((h) => (
                    <th key={h} className="px-2 py-2 text-start font-medium first:ps-0">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {list.map((p) => (
                  <tr key={p.id} className="border-b border-line align-top last:border-0">
                    <td className="py-2.5 pe-2">
                      {p.url ? (
                        <a
                          href={p.url}
                          target="_blank"
                          rel="noreferrer"
                          className="font-medium hover:text-accent"
                        >
                          {p.name}
                        </a>
                      ) : (
                        <span className="font-medium">{p.name}</span>
                      )}
                      <div className="text-xs text-muted">
                        {[p.category, p.city, p.country].filter(Boolean).join(" · ")}
                      </div>
                    </td>
                    <td className="px-2 tabular-nums">
                      {p.rating ? `${p.rating} ★` : "—"}
                      {p.reviews ? (
                        <div className="text-xs text-muted">{fmtNum(p.reviews)} مراجعة</div>
                      ) : null}
                    </td>
                    <td className="ltr px-2">{p.phone ?? "—"}</td>
                    <td className="px-2">
                      {p.website ? (
                        <a
                          href={p.website}
                          target="_blank"
                          rel="noreferrer"
                          className="ltr text-xs text-accent hover:underline"
                        >
                          {p.website.replace(/^https?:\/\/(www\.)?/, "").slice(0, 30)}
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-2">
                      {p.instagram ? (
                        <span className="flex flex-wrap items-center gap-1">
                          <a
                            href={`https://www.instagram.com/${p.instagram}/`}
                            target="_blank"
                            rel="noreferrer"
                            className="ltr text-accent hover:underline"
                          >
                            @{p.instagram}
                          </a>
                          {p.sentAt && (
                            <Badge tone="ok" dot={false}>
                              في العملاء
                            </Badge>
                          )}
                        </span>
                      ) : p.analyzedAt ? (
                        <span className="text-xs text-muted">لا يوجد</span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="ltr px-2 text-xs">{p.emails?.join("، ") ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
