import { handleCallback, handleCommand, handleLink } from "@scrapers/runtime";
import { scheduleDrain } from "@/lib/drain";
import { appOrigin } from "@/lib/env";
import { getRuntime } from "@/lib/runtime";
import { telegramWebhookSecret } from "@/lib/telegram";
import { safeEqual } from "@/lib/tokens";

export const runtime = "nodejs";
export const maxDuration = 60;

type Chat = { id?: number | string };
type Update = {
  message?: { text?: string; chat?: Chat };
  callback_query?: { id: string; data?: string; message?: { chat?: Chat } };
};

/**
 * Telegram webhook, from the owner's chat only: commands, any link (read and
 * summarised, with buttons), and the buttons pressed under replies.
 */
export async function POST(req: Request) {
  const secret = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!process.env.AUTH_SECRET || !safeEqual(secret, telegramWebhookSecret())) {
    return new Response("unauthorized", { status: 401 });
  }
  const rt = await getRuntime();
  const update = (await req.json().catch(() => ({}))) as Update;
  const cb = update.callback_query;
  const text = update.message?.text?.trim();
  const chat = String((cb ? cb.message?.chat?.id : update.message?.chat?.id) ?? "");
  // Anyone can message a bot; only the owner's chat is answered.
  if (!rt.telegram || chat !== rt.telegram.chat || (!cb && !text))
    return Response.json({ ok: true });

  const state =
    (await rt.scrapers.getValue<{ project?: string; lastLink?: string }>("telegram:state")) ?? {};
  const ctx = {
    scrapers: rt.scrapers,
    links: { ...rt.scrapers, readPage: rt.readPage },
    owner: rt.owner,
    appUrl: appOrigin(req),
    onJobStarted: () =>
      scheduleDrain({ origin: appOrigin(req), force: true, routeMaxSeconds: maxDuration }),
  };
  let action = "";
  if (cb) {
    await rt.telegram.answerCallback(cb.id);
    await rt.telegram.sendText(await handleCallback(ctx, cb.data ?? "", state));
    action = `telegram.button:${(cb.data ?? "").split(":")[0]}`;
  } else if (text?.startsWith("/")) {
    await rt.telegram.sendText(await handleCommand(ctx, text, state));
    action = `telegram.command:${text.split(/\s+/)[0]}`;
  } else if (text) {
    const reply = await handleLink(ctx, text, state);
    await rt.telegram.sendText(
      reply?.html ?? "أرسل رابط حساب أو موقع، أو /help لقائمة الأوامر.",
      reply?.buttons,
    );
    action = "telegram.link";
  }
  await rt.scrapers.setValue("telegram:state", state, 365 * 86_400_000);
  await rt.scrapers.audit({
    actor: "telegram",
    action: action.split(":")[0] ?? "telegram",
    detail: { action },
  });
  return Response.json({ ok: true });
}
