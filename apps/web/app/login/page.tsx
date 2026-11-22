import { redirect } from "next/navigation";
import { login } from "@/app/actions";
import { ActionForm } from "@/components/action-form";
import { Card, Field, Input } from "@/components/ui";
import { hasSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next = "/" } = await searchParams;
  if (await hasSession()) redirect(next);
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4">
      <h1 className="mb-6 text-center text-2xl font-bold">Scrapers</h1>
      <Card title="تسجيل الدخول">
        <ActionForm action={login} submit="دخول">
          <input type="hidden" name="next" value={next} />
          <Field label="كلمة المرور">
            <Input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              autoFocus
            />
          </Field>
        </ActionForm>
      </Card>
    </main>
  );
}
