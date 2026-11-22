import { handleCommand } from "@scrapers/runtime";
import { scheduleDrain } from "@/lib/drain";
import { appOrigin } from "@/lib/env";
import { getRuntime } from "@/lib/runtime";
import { telegramWebhookSecret } from "@/lib/telegram";
import { safeEqual } from "@/lib/tokens";

export const runtime = "nodejs";
export const maxDuration = 60;

type Update = { message?: { text?: string; chat?: { id?: number | string } } };

/** Telegram webhook: commands from the owner's chat only (idea from the Spir bot). */
export async function POST(req: Request) {
  const secret = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!process.env.AUTH_SECRET || !safeEqual(secret, telegramWebhookSecret())) {
    return new Response("unauthorized", { status: 401 });
  }
  const rt = await getRuntime();
  const update = (await req.json().catch(() => ({}))) as Update;
  const text = update.message?.text?.trim();
  const chat = String(update.message?.chat?.id ?? "");
  // Anyone can message a bot; only the owner's chat is answered.
  if (!rt.telegram || !text?.startsWith("/") || chat !== rt.telegram.chat)
    return Response.json({ ok: true });

  const state = (await rt.scrapers.getValue<{ project?: string }>("telegram:state")) ?? {};
  const reply = await handleCommand(
    {
      scrapers: rt.scrapers,
      owner: rt.owner,
      appUrl: appOrigin(req),
      onJobStarted: () => scheduleDrain(appOrigin(req)),
    },
    text,
    state,
  );
  await rt.scrapers.setValue("telegram:state", state, 365 * 86_400_000);
  await rt.telegram.sendText(reply);
  await rt.scrapers.audit({
    actor: "telegram",
    action: "telegram.command",
    detail: { command: text.split(/\s+/)[0] },
  });
  return Response.json({ ok: true });
}
