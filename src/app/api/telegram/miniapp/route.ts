import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getSessionPlayer, setSessionPlayer } from "@/lib/session";
import { initDataUser, telegramEnabled, verifyInitData } from "@/lib/telegram/api";
import { findOrCreateTelegramPlayer, linkTelegram } from "@/lib/telegram/bot";
import { miniAppNext } from "@/lib/telegram/login";

export const dynamic = "force-dynamic";

/**
 * The Mini App's sign-in: Telegram hands the page signed initData, the page
 * posts it here, and the player behind that Telegram account gets the session
 * (created on first contact, linked when someone is already signed in).
 */
export async function POST(req: Request) {
  if (!telegramEnabled()) return NextResponse.json({ ok: false, error: "telegram_disabled" }, { status: 503 });
  const body = (await req.json().catch(() => null)) as { initData?: string; startParam?: string } | null;
  const fields = body?.initData ? verifyInitData(body.initData) : null;
  const user = fields ? initDataUser(fields) : null;
  if (!fields || !user) return NextResponse.json({ ok: false, error: "invalid" }, { status: 401 });
  const db = await getDb();
  const me = await getSessionPlayer(db);
  const player = me ? await linkTelegram(db, me.id, user) : await findOrCreateTelegramPlayer(db, user);
  await setSessionPlayer(player.id);
  return NextResponse.json({ ok: true, next: miniAppNext(body?.startParam ?? fields.start_param) });
}
