import Link from "next/link";
import { markAllRead } from "@/app/actions";
import { Badge, Button, Card, Dot, fmtAgo, fmtDate } from "@/components/ui";
import { getRuntime } from "@/lib/runtime";

const TYPE: Record<string, string> = {
  job: "مهمة",
  provider: "مصدر",
  budget: "رصيد",
  ai: "ذكاء اصطناعي",
  security: "أمان",
  system: "النظام",
};

export default async function Notifications() {
  const rt = await getRuntime();
  const list = await rt.scrapers.listNotifications(100);
  const unread = list.filter((n) => !n.readAt).length;
  return (
    <Card
      title="الإشعارات"
      icon="bell"
      description={
        rt.telegram
          ? "تصلك أيضاً على تلكرام."
          : "أضف TELEGRAM_BOT_TOKEN و TELEGRAM_CHAT_ID لتصلك على تلكرام."
      }
      actions={
        unread > 0 && (
          <form action={markAllRead}>
            <Button variant="default" type="submit">
              تعليم الكل كمقروء ({unread})
            </Button>
          </form>
        )
      }
    >
      {list.length === 0 ? (
        <p className="text-sm text-muted">
          لا إشعارات. تصلك هنا عند انتهاء المهام، وتوقف المصادر، ونفاد الرصيد.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {list.map((n) => (
            <li
              key={n.id}
              className={`flex items-start gap-3 py-3 ${n.readAt ? "opacity-70" : ""}`}
            >
              <span className="pt-2">
                <Dot tone={n.level === "info" ? "plain" : (n.level as "ok" | "warn" | "bad")} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  {n.url ? (
                    <Link href={n.url} className="font-medium hover:text-accent">
                      {n.title}
                    </Link>
                  ) : (
                    <span className="font-medium">{n.title}</span>
                  )}
                  <Badge dot={false}>{TYPE[n.type] ?? n.type}</Badge>
                </div>
                {n.body && (
                  <p className="mt-0.5 whitespace-pre-line text-[13px] text-fg-2">{n.body}</p>
                )}
                <span className="text-xs text-muted" title={fmtDate(n.at)}>
                  {fmtAgo(n.at)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
