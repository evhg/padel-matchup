import { baseUrl } from "@/lib/config";
import { getWebhookInfo, setMenuButton, setMyCommands, setWebhook, telegramEnabled, telegramWebhookSecret } from "@/lib/telegram/api";
import { BOT_COMMANDS } from "@/lib/telegram/bot";

export const dynamic = "force-dynamic";

/** One-time (idempotent) registration of the webhook and the command menu. Protected like the cron routes. */
export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) return new Response("unauthorized", { status: 401 });
  if (!telegramEnabled() || !telegramWebhookSecret()) return Response.json({ ok: false, error: "TELEGRAM_BOT_TOKEN or TELEGRAM_WEBHOOK_SECRET missing" }, { status: 400 });
  const url = `${baseUrl()}/api/telegram/webhook`;
  const hook = await setWebhook(url, telegramWebhookSecret()!);
  const commands = await setMyCommands(BOT_COMMANDS.en);
  const commandsRu = await setMyCommands(BOT_COMMANDS.ru, "ru");
  // The Mini App button in the private chat needs no BotFather step: the page signs the player in from initData.
  const menu = await setMenuButton(`${baseUrl()}/tg`, "Kicksmash");
  const info = await getWebhookInfo();
  return Response.json({ ok: hook.ok && commands.ok && commandsRu.ok, url, hook, commands: commands.ok && commandsRu.ok, menuButton: menu.ok, info: info.ok ? info.result : info });
}
