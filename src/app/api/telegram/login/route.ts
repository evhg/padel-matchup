import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getSessionPlayer, setSessionPlayer } from "@/lib/session";
import { telegramEnabled, verifyLoginWidget } from "@/lib/telegram/api";
import { findOrCreateTelegramPlayer, linkTelegram } from "@/lib/telegram/bot";

export const dynamic = "force-dynamic";

/**
 * Telegram Login Widget callback: the widget redirects here with signed
 * fields. Signed-in players get their Telegram account linked; everyone else
 * is signed in as the player behind that account (created on first contact).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const dest = new URL("/me", url.origin);
  if (!telegramEnabled()) return NextResponse.redirect(dest);
  const fields: Record<string, string> = {};
  for (const [k, v] of url.searchParams) fields[k] = v;
  if (!verifyLoginWidget(fields)) {
    dest.searchParams.set("telegram", "invalid");
    return NextResponse.redirect(dest);
  }
  const user = { id: Number(fields.id), first_name: fields.first_name ?? "Player", last_name: fields.last_name, username: fields.username };
  const db = await getDb();
  const me = await getSessionPlayer(db);
  const player = me ? await linkTelegram(db, me.id, user) : await findOrCreateTelegramPlayer(db, user);
  await setSessionPlayer(player.id);
  dest.searchParams.set("telegram", "linked");
  return NextResponse.redirect(dest, { status: 303 });
}
