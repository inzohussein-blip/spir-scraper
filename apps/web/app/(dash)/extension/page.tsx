import { createKey } from "@/app/actions";
import { ActionForm } from "@/components/action-form";
import { CopyText, ExtensionBuildInfo } from "@/components/extension-info";
import { Card, LinkButton, Notice } from "@/components/ui";
import { appOrigin } from "@/lib/env";

export const metadata = { title: "إضافة المتصفح" };

export default function ExtensionPage() {
  const origin = appOrigin();
  return (
    <div className="space-y-5">
      <h1 className="text-xl font-bold">إضافة المتصفح</h1>

      <Card
        title="مساعد التصفح بالذكاء الاصطناعي"
        description="لوحة جانبية بالذكاء الاصطناعي (Claude أو OpenAI أو Gemini أو نموذج على جهازك) تقرأ حسابات إنستقرام وتلتقط قوائم المتابعين وتحفظها هنا."
        icon="download"
      >
        <div className="space-y-3">
          <p className="text-sm">
            <ExtensionBuildInfo />
          </p>
          <LinkButton href="/downloads/spir-extension.zip" download="spir-extension.zip">
            تحميل الإضافة (zip)
          </LinkButton>
          <p className="text-[12.5px] text-muted">
            تعمل على Chrome وEdge وBrave. تُبنى من نفس كود المنصة مع كل نشر، فهذا الملف دائماً أحدث
            نسخة.
          </p>
        </div>
      </Card>

      <Card title="التثبيت (مرة واحدة)" icon="plug">
        <ol className="list-decimal space-y-2.5 ps-5 text-sm">
          <li>حمّل الملف من الزر أعلاه، وفك ضغطه في مجلد ثابت لن تحذفه (مثلاً «المستندات»).</li>
          <li>
            افتح صفحة الإضافات في المتصفح بنسخ هذا العنوان ولصقه في شريط العنوان:{" "}
            <CopyText text="chrome://extensions" />
          </li>
          <li>فعّل «وضع المطوّر» (Developer mode) أعلى يمين الصفحة.</li>
          <li>اضغط «تحميل إضافة غير مضغوطة» (Load unpacked) واختر المجلد الذي فككته.</li>
          <li>ثبّت أيقونة العدسة الزرقاء في شريط الأدوات واضغطها لتفتح اللوحة الجانبية.</li>
        </ol>
      </Card>

      <Card
        title="ربط الإضافة بالمنصة"
        description="الصق هذين في إعدادات الإضافة (⚙ ← المنصة)، ثم اضغط «تحميل المشاريع» واختر المشروع."
        icon="key"
      >
        <div className="space-y-4 text-sm">
          <p>
            رابط المنصة: <CopyText text={origin} />
          </p>
          <ActionForm action={createKey} submit="أنشئ مفتاحاً للإضافة">
            <input type="hidden" name="name" value="إضافة المتصفح" />
            <input type="hidden" name="write" value="on" />
          </ActionForm>
          <p className="text-[12.5px] text-muted">
            يظهر المفتاح مرة واحدة فقط. يمكنك إلغاؤه في أي وقت من الإعدادات ← مفاتيح API، فتتوقف
            الإضافة عن الحفظ فوراً.
          </p>
        </div>
      </Card>

      <Card title="التحديث" icon="sparkles">
        <p className="text-sm">
          حمّل الملف من جديد، وضع محتواه مكان المجلد القديم، ثم اضغط ↻ عند الإضافة في صفحة الإضافات.
          إعداداتك ومفاتيحك تبقى كما هي.
        </p>
      </Card>

      <Notice tone="warn">
        الوضع اليدوي آمن لحسابك. الوضع التلقائي يتصفح بنفسه، وإنستقرام قد يقيّد الحساب مع الاستخدام
        الكثيف؛ استخدمه بأعداد صغيرة، ويُفضّل بحساب ثانوي.
      </Notice>
    </div>
  );
}
