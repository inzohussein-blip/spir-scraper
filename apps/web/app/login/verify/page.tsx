import { redirect } from "next/navigation";
import { verifyLoginCode } from "@/app/actions";
import { ActionForm } from "@/components/action-form";
import { Card, Field, Input } from "@/components/ui";
import { hasPendingCode } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function VerifyPage() {
  if (!(await hasPendingCode())) redirect("/login");
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4">
      <Card title="التحقق بخطوتين" icon="shield" description="أرسلنا كوداً من 6 أرقام إلى تلكرام.">
        <ActionForm action={verifyLoginCode} submit="تأكيد">
          <Field label="الكود">
            <Input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              autoFocus
              className="ltr text-center text-lg tracking-[.5em]"
            />
          </Field>
        </ActionForm>
      </Card>
    </main>
  );
}
