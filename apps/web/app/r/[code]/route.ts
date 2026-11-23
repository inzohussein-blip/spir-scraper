import { getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";

/**
 * A partner's tracking link: counts the click and sends the visitor to the
 * broker's sign-up page with the partner's code as the sub id, so the
 * broker's reports say who brought each client.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const rt = await getRuntime();
  const partner = await rt.scrapers.partnerByCode(code);
  const settings = await rt.scrapers.getValue<{ signupUrl?: string; subParam?: string }>(
    "broker:settings",
  );
  if (!partner?.active || !settings?.signupUrl)
    return new Response("الرابط غير متاح", { status: 404 });
  await rt.scrapers.recordClick(partner.id);
  const target = new URL(settings.signupUrl);
  target.searchParams.set(settings.subParam || "sub", partner.code);
  return Response.redirect(target.toString(), 302);
}
