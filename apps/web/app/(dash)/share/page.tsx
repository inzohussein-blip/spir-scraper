import { PLATFORM_LABELS, type Platform, parseAccountUrl } from "@scrapers/core";
import Link from "next/link";
import { addAccount, saveSharedAccount } from "@/app/actions";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, fmtNum, Input, Notice, Select } from "@/components/ui";
import { getRuntime } from "@/lib/runtime";

export const metadata = { title: "مشاركة" };

/** The first web address in what another app shared (some put it in text, some in url). */
function sharedUrl(q: { url?: string; text?: string; title?: string }): string | null {
  for (const v of [q.url, q.text, q.title]) {
    const m = v ? /https?:\/\/\S+/i.exec(v) : null;
    if (m) return m[0].replace(/[)\]،.,]+$/, "");
  }
  return null;
}

/**
 * Where the installed app lands when the owner shares a link from another
 * app: an Instagram account can be saved, another platform's account linked
 * to a lead, and any other page read.
 */
export default async function SharePage({
  searchParams,
}: {
  searchParams: Promise<{ url?: string; text?: string; title?: string }>;
}) {
  const q = await searchParams;
  const url = sharedUrl(q);
  const rt = await getRuntime();
  if (!url)
    return (
      <Notice tone="info">
        شارك رابط حساب أو صفحة من أي تطبيق واختر «Scrapers»، أو الصق الرابط هنا:
        <form method="get" className="mt-3 flex gap-2">
          <Input name="url" className="ltr" placeholder="https://…" aria-label="رابط" />
          <button type="submit" className="rounded-lg border border-line px-3">
            افتح
          </button>
        </form>
      </Notice>
    );
  const ref = parseAccountUrl(url);
  const projects = await rt.scrapers.listProjects();

  if (ref?.platform === "instagram") {
    const stored = await rt.scrapers.getStoredProfile(ref.handle);
    return (
      <Card title={`@${ref.handle}`} icon="users" description="حساب إنستقرام">
        {stored ? (
          <p className="mb-3 text-sm">
            {stored.fullName} · {fmtNum(stored.followers)} متابع ·{" "}
            <Link href={`/leads/${ref.handle}`} className="text-accent hover:underline">
              صفحة العميل
            </Link>
          </p>
        ) : (
          <p className="mb-3 text-sm text-muted">غير محفوظ بعد.</p>
        )}
        <ActionForm
          action={saveSharedAccount}
          submit={stored ? "حدّث بياناته" : "احفظ كعميل"}
          className="flex gap-2"
        >
          <input type="hidden" name="username" value={ref.handle} />
          <Select name="project" aria-label="المشروع" className="w-auto">
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </ActionForm>
      </Card>
    );
  }

  if (ref && ref.platform !== "website") {
    const peek = await rt.scrapers.peekAccount(ref.url);
    const a = peek?.account;
    return (
      <Card
        title={`@${ref.handle}`}
        icon="plug"
        description={PLATFORM_LABELS[ref.platform as Platform] ?? ref.platform}
      >
        {a ? (
          <div className="mb-3 space-y-1 text-sm">
            <p>
              <b>{a.displayName}</b> {a.followers !== null && <span>· {fmtNum(a.followers)}</span>}
            </p>
            {a.bio && <p className="whitespace-pre-line text-muted">{a.bio.slice(0, 400)}</p>}
          </div>
        ) : (
          <p className="mb-3 text-sm text-muted">
            {peek?.error ? `تعذّرت القراءة: ${peek.error}` : "لا تُقرأ هذه المنصة تلقائياً."}
          </p>
        )}
        <p className="mb-2 text-sm">اربطه بعميل عندك (حسابه على إنستقرام):</p>
        <ActionForm action={addAccount} submit="اربط" className="flex items-start gap-2">
          <input type="hidden" name="url" value={ref.url} />
          <Input
            name="username"
            required
            className="ltr"
            placeholder="@instagram"
            aria-label="حساب العميل على إنستقرام"
          />
        </ActionForm>
      </Card>
    );
  }

  let page: Awaited<ReturnType<typeof rt.readPage>> | null = null;
  let error: string | null = null;
  try {
    page = await rt.readPage(url);
  } catch (err) {
    error = (err as Error).message;
  }
  return (
    <Card title={page?.title ?? url} icon="search" description={page?.description ?? undefined}>
      {error && <Notice tone="warn">تعذّرت قراءة الصفحة: {error}</Notice>}
      {page && (
        <div className="space-y-2 text-sm">
          {page.emails.length > 0 && <p className="ltr">✉️ {page.emails.join("، ")}</p>}
          {page.phones.length > 0 && <p className="ltr">📞 {page.phones.join("، ")}</p>}
          {page.accounts.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {page.accounts.map((acc) => (
                <Link key={acc.url} href={`/share?url=${encodeURIComponent(acc.url)}`}>
                  <Badge tone="accent" dot={false}>
                    {PLATFORM_LABELS[acc.platform as Platform] ?? acc.platform} @{acc.handle}
                  </Badge>
                </Link>
              ))}
            </div>
          )}
          <p className="whitespace-pre-line text-muted">{page.text.slice(0, 1500)}</p>
        </div>
      )}
    </Card>
  );
}
