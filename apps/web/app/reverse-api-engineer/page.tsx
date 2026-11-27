import Link from "next/link";
import { Icon } from "@/components/icons";
import { RaeApp } from "@/components/rae-app";

export const metadata = { title: "reverse-api-engineer" };

/**
 * A standalone window, built once and served as a static file: opening it
 * runs no server function and touches no database. All work happens on the
 * owner's computer through the local bridge.
 */
export const dynamic = "force-static";

function origin(): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL)
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return "https://your-app.vercel.app";
}

export default function ReverseApiEngineer() {
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 border-b border-line bg-bg/80 backdrop-blur">
        <div className="mx-auto flex max-w-[1100px] items-center gap-3 px-4 py-3.5">
          <span className="grid size-[34px] place-items-center rounded-[10px] bg-gradient-to-br from-accent to-accent-2 text-white">
            <Icon name="plug" className="size-[19px]" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="ltr text-start text-lg font-bold">reverse-api-engineer</h1>
            <p className="text-[12.5px] text-muted">تحويل أي موقع إلى API · يعمل على جهازك فقط</p>
          </div>
          <Link
            href="/store"
            className="rounded-[10px] border border-line bg-surface px-3 py-2 text-sm hover:bg-surface-2"
          >
            رجوع للمنصة
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-[1100px] space-y-4 px-4 pt-6 pb-16">
        <p className="text-sm text-fg-2">
          تفتح الأداة الموقع في متصفح، وتسجّل طلبات الشبكة التي يرسلها، ثم يكتب نموذج الذكاء
          الاصطناعي الذي تختاره كوداً جاهزاً يستدعي نفس الواجهات مباشرة. المشروع الأصلي:{" "}
          <a
            href="https://github.com/kalil0321/reverse-api-engineer"
            target="_blank"
            rel="noreferrer"
            className="ltr text-accent underline"
          >
            kalil0321/reverse-api-engineer
          </a>{" "}
          (رخصة MIT). لا يُستهلك شيء من Vercel أو قاعدة البيانات.
        </p>
        <RaeApp origin={origin()} />
      </main>
    </div>
  );
}
