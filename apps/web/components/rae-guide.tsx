import type { ReactNode } from "react";

/** One collapsible section of the operating guide (native <details>: works without JavaScript). */
function Section({
  title,
  children,
  open,
}: {
  title: string;
  children: ReactNode;
  open?: boolean;
}) {
  return (
    <details className="group border-b border-line last:border-0" open={open}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-[18px] py-3 text-sm font-medium hover:bg-surface-2">
        {title}
        <span className="text-muted transition group-open:rotate-180" aria-hidden>
          ▾
        </span>
      </summary>
      <div className="space-y-2 px-[18px] pb-4 text-sm text-fg-2">{children}</div>
    </details>
  );
}

const Cmd = ({ children }: { children: string }) => (
  <pre className="ltr overflow-x-auto rounded-lg bg-bg-2 p-2 text-xs">{children}</pre>
);

/** The window's operating instructions, in collapsible sections. */
export function RaeGuide({ origin }: { origin: string }) {
  return (
    <section className="card overflow-hidden" data-rae-guide>
      <details className="group/all" open>
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 border-b border-line px-[18px] py-3.5">
          <span>
            <span className="block text-[15px] font-semibold">تعليمات التشغيل</span>
            <span className="text-[12.5px] text-muted">
              من التثبيت حتى الكود الجاهز، وحل المشاكل الشائعة
            </span>
          </span>
          <span className="text-muted transition group-open/all:rotate-180" aria-hidden>
            ▾
          </span>
        </summary>

        <Section title="1. التثبيت (مرة واحدة)">
          <p>
            تحتاج <b>Python 3.11</b> فما فوق، و <b>Node.js 20</b> فما فوق، ثم الأداة نفسها. الأجهزة
            المدعومة: ويندوز 64 بت، وماك بمعالج Apple، ولينكس.
          </p>
          <p>ويندوز (PowerShell):</p>
          <Cmd>
            {
              "winget install Python.Python.3.12 OpenJS.NodeJS.LTS astral-sh.uv\nuv tool install reverse-api-engineer"
            }
          </Cmd>
          <p>ماك (Homebrew):</p>
          <Cmd>{"brew install python node uv\nuv tool install reverse-api-engineer"}</Cmd>
          <p>
            للتصفح بيدك (الوضع اليدوي) أضف:{" "}
            <span className="ltr font-mono text-xs">
              uv tool install "reverse-api-engineer[manual]"
            </span>{" "}
            ثم <span className="ltr font-mono text-xs">playwright install chromium</span>.
          </p>
        </Section>

        <Section title="2. تشغيل الجسر (كل مرة تستعمل فيها النافذة)">
          <p>
            نزّل{" "}
            <a href="/downloads/rae-bridge.py" download className="text-accent underline">
              rae-bridge.py
            </a>{" "}
            مرة واحدة، ثم افتح نافذة الأوامر في مجلده وشغّل:
          </p>
          <Cmd>{`python rae-bridge.py --origin ${origin}`}</Cmd>
          <p>
            يطبع الجسر <b>رمز الربط</b>: الصقه في أعلى النافذة واضغط «اتصل». الرمز ثابت، فيكفي لصقه
            مرة على هذا المتصفح. اترك نافذة الأوامر مفتوحة أثناء العمل، وأوقف الجسر بـ <b>Ctrl+C</b>
            .
          </p>
        </Section>

        <Section title="3. اختيار المزوّد">
          <ul className="list-disc space-y-1 ps-5">
            <li>
              <b>مجاني:</b> «OpenCode» يعمل بلا مفتاح. «Ollama» على جهازك يحتاج نموذجاً مثبتاً وجهازاً
              قوياً.
            </li>
            <li>
              <b>بمفتاح:</b> اختر الشركة، والصق المفتاح، واضغط «احفظ». يُحفظ على جهازك فقط ولا يظهر
              مرة أخرى.
            </li>
            <li>
              <b>Claude بلا مفتاح:</b> إن كان Claude Code مسجَّلاً على هذا الجهاز، اختر «Anthropic
              Claude» واترك المفتاح فارغاً.
            </li>
            <li>
              <b>Codex:</b> ثبّت{" "}
              <span className="ltr font-mono text-xs">reverse-api-engineer[codex]</span> ثم{" "}
              <span className="ltr font-mono text-xs">codex login</span> مرة واحدة.
            </li>
          </ul>
        </Section>

        <Section title="4. أول تشغيل">
          <ol className="list-decimal space-y-1 ps-5">
            <li>
              ضع رابط الموقع، واكتب الهدف كبيانات لا كضغطات: «قائمة الوسطاء مع الاسم والرخصة
              والموقع، مع كل الصفحات».
            </li>
            <li>اضغط «فحص مسبق»: بلا تكلفة، ويُظهر أي نقص في الإعداد (المزوّد، Node.js، المتصفح).</li>
            <li>اضغط «ابدأ التشغيل». يأخذ عادة بضع دقائق، وتظهر الخطوات والتكلفة في البطاقة.</li>
            <li>عند الانتهاء: «اعرض الكود» لترى الملفات، وانسخها أو نزّلها.</li>
          </ol>
          <p>
            «بلا نافذة متصفح ظاهرة» مناسب للمواقع العامة. أزل العلامة إن احتاج الموقع تدخلك (تسجيل
            دخول، تحقق).
          </p>
        </Section>

        <Section title="5. بعد التشغيل">
          <ul className="list-disc space-y-1 ps-5">
            <li>
              <b>راجع الكود قبل تشغيله:</b> كتبه الذكاء الاصطناعي. النافذة لا تشغّله؛ شغّله بنفسك من
              مجلده على جهازك.
            </li>
            <li>
              <b>حسّن دون تصفح جديد:</b> «حسّن» يعيد كتابة الكود من نفس التسجيل (يعمل مع المتصفح
              المنفصل، لا مع Chrome الحقيقي لأنه لا يحفظ تسجيلاً).
            </li>
            <li>
              <b>إلى المتجر:</b> إن كان الكود مفيداً، أعطه لـ Claude في جلسة على المستودع ليحوّله إلى
              أداة رسمية في المتجر.
            </li>
          </ul>
        </Section>

        <Section title="6. مشاكل شائعة">
          <ul className="list-disc space-y-1.5 ps-5">
            <li>
              <b>«لا يوجد جسر يعمل»:</b> تأكد أن نافذة الأوامر مفتوحة، وأن العنوان{" "}
              <span className="ltr font-mono text-xs">http://127.0.0.1:7466</span>، وأنك على نفس
              الكمبيوتر.
            </li>
            <li>
              <b>«هذا الموقع غير مسموح له»:</b> شغّلت الجسر بعنوان منصة مختلف. أعد تشغيله بـ{" "}
              <span className="ltr font-mono text-xs">--origin {origin}</span>.
            </li>
            <li>
              <b>خطأ في رمز الربط:</b> انسخ الرمز من آخر تشغيل للجسر (محفوظ في{" "}
              <span className="ltr font-mono text-xs">~/.spir-rae/token</span>).
            </li>
            <li>
              <b>Safari لا يتصل:</b> استعمل Chrome أو Edge؛ Safari يمنع الاتصال بالجهاز المحلي من
              صفحة آمنة.
            </li>
            <li>
              <b>«غير مثبّت»:</b> أعد فتح نافذة الأوامر بعد تثبيت الأداة، أو شغّل{" "}
              <span className="ltr font-mono text-xs">uv tool update-shell</span>.
            </li>
            <li>
              <b>Chrome الحقيقي:</b> يحتاج Chrome 146 فما فوق مع «Enable auto-connect» في{" "}
              <span className="ltr font-mono text-xs">chrome://inspect/#remote-debugging</span>،
              وقبول طلب الاتصال عند بدء التشغيل.
            </li>
            <li>
              <b>موقع يحجب البوتات:</b> أزل «بلا نافذة متصفح ظاهرة»، أو استعمل الوضع اليدوي من
              الأداة نفسها ثم «حسّن» من التسجيل.
            </li>
            <li>
              <b>رابط مرفوض:</b> إنستقرام وتيك توك وفيسبوك وثريدز وواتساب ممنوعة عمداً.
            </li>
          </ul>
        </Section>

        <Section title="7. الأمان والخصوصية">
          <ul className="list-disc space-y-1 ps-5">
            <li>الجسر يستمع على جهازك فقط، ويقبل منصتك فقط، وبرمز الربط.</li>
            <li>لا يمر شيء بخوادم المنصة، ولا يُحفظ شيء في قاعدة بياناتها.</li>
            <li>التسجيلات قد تحتوي ملفات تعريف ارتباط ورموز دخول: لا تشاركها.</li>
            <li>احترم شروط كل موقع وحدوده.</li>
          </ul>
        </Section>
      </details>
    </section>
  );
}
