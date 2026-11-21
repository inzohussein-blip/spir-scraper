import { redirect } from "next/navigation";
import { Button, Card, Notice } from "@/components/ui";
import { audit } from "@/lib/audit";
import { hasSession } from "@/lib/auth";
import { authSecret } from "@/lib/env";
import { sign, verify } from "@/lib/tokens";

export const dynamic = "force-dynamic";

type Params = {
  client_id?: string;
  redirect_uri?: string;
  response_type?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  state?: string;
};

async function validate(p: Params) {
  if (p.response_type !== "code") return { error: "response_type must be code" };
  if (p.code_challenge_method !== "S256" || !p.code_challenge)
    return { error: "PKCE S256 is required" };
  const client = p.client_id
    ? await verify<{ redirect_uris: string[]; name: string }>(authSecret(), "client", p.client_id)
    : null;
  if (!client) return { error: "Unknown client" };
  if (!p.redirect_uri || !client.redirect_uris.includes(p.redirect_uri))
    return { error: "redirect_uri not registered" };
  return { client };
}

/** The owner approves an MCP client (e.g. claude.ai) after logging in to the dashboard. */
export default async function Authorize({ searchParams }: { searchParams: Promise<Params> }) {
  const p = await searchParams;
  const here = `/oauth/authorize?${new URLSearchParams(p as Record<string, string>)}`;
  if (!(await hasSession())) redirect(`/login?next=${encodeURIComponent(here)}`);

  const v = await validate(p);
  if ("error" in v) {
    return (
      <main className="mx-auto max-w-md px-4 py-16">
        <Notice tone="error">طلب غير صالح: {v.error}</Notice>
      </main>
    );
  }

  async function approve() {
    "use server";
    if (!(await hasSession())) redirect("/login");
    const ok = await validate(p);
    if ("error" in ok || !p.client_id || !p.redirect_uri || !p.code_challenge) redirect("/");
    const code = await sign(
      authSecret(),
      "code",
      { cid: p.client_id.slice(-16), redirect_uri: p.redirect_uri, challenge: p.code_challenge },
      300,
    );
    await audit("oauth.approve", { client: ok.client.name, redirect: p.redirect_uri });
    const target = new URL(p.redirect_uri);
    target.searchParams.set("code", code);
    if (p.state) target.searchParams.set("state", p.state);
    redirect(target.toString());
  }

  async function deny() {
    "use server";
    if (!p.redirect_uri) redirect("/");
    const target = new URL(p.redirect_uri);
    target.searchParams.set("error", "access_denied");
    if (p.state) target.searchParams.set("state", p.state);
    redirect(target.toString());
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4">
      <Card title="السماح بالوصول">
        <p className="mb-2 text-sm leading-7">
          يطلب <strong>{v.client.name}</strong> الوصول إلى Scrapers: بدء المهام، وقراءة العملاء،
          والتصدير.
        </p>
        <p className="ltr mb-6 truncate text-xs text-muted">{p.redirect_uri}</p>
        <div className="flex gap-3">
          <form action={approve}>
            <Button type="submit">سماح</Button>
          </form>
          <form action={deny}>
            <Button type="submit" variant="ghost">
              رفض
            </Button>
          </form>
        </div>
      </Card>
    </main>
  );
}
