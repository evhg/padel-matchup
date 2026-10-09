import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getSessionPlayer, setSessionPlayer } from "@/lib/session";
import { telegramEnabled, verifyLoginWidget } from "@/lib/telegram/api";
import { findOrCreateTelegramPlayer, linkTelegram } from "@/lib/telegram/bot";
import { loginNext } from "@/lib/telegram/login";

export const dynamic = "force-dynamic";

/**
 * Telegram Login Widget callback: the widget redirects here with signed
 * fields. Signed-in players get their Telegram account linked; everyone else
 * is signed in as the player behind that account (created on first contact).
 * A good sign-in goes back to the page it started from (`?next=`, which
 * `loginNext` holds to a path on this site), else to My matches; a bad one
 * always goes to My matches, which says what went wrong.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const home = new URL("/me", url.origin);
  if (!telegramEnabled()) return NextResponse.redirect(home);
  // `next` is ours, not Telegram's: it stays out of the fields the signature covers.
  const fields: Record<string, string> = {};
  for (const [k, v] of url.searchParams) if (k !== "next") fields[k] = v;
  if (!verifyLoginWidget(fields)) {
    home.searchParams.set("telegram", "invalid");
    return NextResponse.redirect(home);
  }
  const user = { id: Number(fields.id), first_name: fields.first_name ?? "Player", last_name: fields.last_name, username: fields.username };
  const db = await getDb();
  const me = await getSessionPlayer(db);
  const player = me ? await linkTelegram(db, me.id, user) : await findOrCreateTelegramPlayer(db, user);
  await setSessionPlayer(player.id);
  const dest = new URL(loginNext(url.searchParams.get("next")), url.origin);
  // My matches says "Telegram linked"; any other page shows it by being signed in.
  if (dest.pathname === "/me") dest.searchParams.set("telegram", "linked");
  return NextResponse.redirect(dest, { status: 303 });
}
