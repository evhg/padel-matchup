import { after } from "next/server";
import { getDb } from "@/db";
import type { OpContext } from "@/lib/api/operations";
import { emitMatchEvent } from "@/lib/api/webhooks";
import { reportError } from "@/lib/alerts";
import { telegramEnabled, telegramWebhookSecret, type TgUpdate } from "@/lib/telegram/api";
import { handleTelegramUpdate } from "@/lib/telegram/bot";

export const dynamic = "force-dynamic";

/**
 * Telegram calls this for every update. The secret header proves it is
 * Telegram; the answer is always 200 so a bad update is not retried forever.
 */
export async function POST(req: Request) {
  if (!telegramEnabled()) return new Response("telegram disabled", { status: 404 });
  const secret = telegramWebhookSecret();
  if (!secret || req.headers.get("x-telegram-bot-api-secret-token") !== secret) return new Response("forbidden", { status: 403 });
  let update: TgUpdate | null = null;
  try {
    update = (await req.json()) as TgUpdate;
  } catch {
    return Response.json({ ok: true, outcome: "bad_json" });
  }
  const db = await getDb();
  const ctx: OpContext = {
    afterwards: (fn) => after(fn),
    emit: (event, code, extra) => after(() => emitMatchEvent(db, event, code, extra)),
  };
  const outcome = await handleTelegramUpdate(db, update, ctx);
  if (outcome.startsWith("error:")) void reportError("server", new Error(`telegram update ${update.update_id}: ${outcome}`));
  return Response.json({ ok: true, outcome });
}
