import Link from "next/link";
import { draftInboxReply, sendInboxReply } from "@/app/actions";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, cx, fmtAgo, Notice, Textarea } from "@/components/ui";
import { getRuntime } from "@/lib/runtime";

export const metadata = { title: "الرسائل" };

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ thread?: string; draft?: string }>;
}) {
  const q = await searchParams;
  const rt = await getRuntime();
  const threads = await rt.scrapers.listThreads(50);
  const threadId = q.thread ?? threads[0]?.threadId;
  const messages = threadId ? await rt.scrapers.threadMessages(threadId) : [];
  let draft = "";
  if (threadId && q.draft) {
    const projects = await rt.scrapers.listProjects();
    draft = await rt.scrapers.draftReply(threadId, projects[0]?.aiCriteria ?? "").catch(() => "");
  }
  const current = threads.find((t) => t.threadId === threadId);
  const lastIn = current?.lastIn ? new Date(current.lastIn).getTime() : 0;
  const open = Date.now() - lastIn < 24 * 3_600_000;

  return (
    <div className="space-y-4">
      {!rt.scrapers.ownAccountAvailable && (
        <Notice tone="info">
          الرسائل تصل هنا بعد ربط حسابك (IG_GRAPH_TOKEN) والاشتراك في Webhook من صفحة «حسابي».
        </Notice>
      )}
      <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
        <Card title="المحادثات" icon="users">
          {threads.length === 0 ? (
            <p className="text-sm text-muted">لا توجد رسائل بعد.</p>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {threads.map((t) => (
                <li key={t.threadId}>
                  <Link
                    href={`/inbox?thread=${encodeURIComponent(t.threadId)}`}
                    className={cx(
                      "flex items-center gap-2 rounded px-2 py-2 hover:bg-bg-2",
                      t.threadId === threadId && "bg-bg-2",
                    )}
                  >
                    <span className="ltr min-w-0 flex-1 truncate font-medium">
                      {t.username ? `@${t.username}` : t.threadId}
                    </span>
                    {t.unread > 0 && <Badge tone="ok">{t.unread}</Badge>}
                    <span className="text-xs text-muted">{fmtAgo(t.last)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {threadId && (
          <Card
            title={current?.username ? `@${current.username}` : "المحادثة"}
            icon="activity"
            description="الرد يُرسل فقط عندما تضغط «أرسل»، ويُراجَع قبلها لمنع وعود الأرباح."
          >
            <ul className="mb-4 space-y-2 text-sm">
              {messages.map((m) => (
                <li
                  key={m.id}
                  className={cx(
                    "max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2",
                    m.direction === "out" ? "ms-auto bg-accent-soft" : "bg-bg-2",
                  )}
                >
                  {m.text}
                  <div className="mt-1 text-[11px] text-muted">{fmtAgo(m.at)}</div>
                </li>
              ))}
            </ul>
            {open ? (
              <>
                <form action={draftInboxReply.bind(null, threadId)} className="mb-2">
                  <button
                    type="submit"
                    className="rounded px-2 py-0.5 text-xs text-accent hover:bg-accent-soft"
                  >
                    اقترح رداً بالذكاء الاصطناعي
                  </button>
                </form>
                <ActionForm action={sendInboxReply} submit="أرسل" className="space-y-2">
                  <input type="hidden" name="thread" value={threadId} />
                  <Textarea
                    name="text"
                    rows={4}
                    defaultValue={draft}
                    key={draft}
                    aria-label="الرد"
                    placeholder="اكتب ردك…"
                  />
                </ActionForm>
              </>
            ) : (
              <Notice tone="info">
                مرّ أكثر من 24 ساعة على آخر رسالة منه؛ Meta لا تسمح بالرد من هنا. رد من تطبيق
                إنستقرام.
              </Notice>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
