import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { baseUrl } from "@/lib/config";
import { findPlayerByPersonalToken } from "@/lib/domain/identity";
import { safeNext } from "@/lib/personal";
import { getSessionPlayerId, setSessionPlayer } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * The personal link's hand-off: signs this device in as the token's player and
 * sends it on to an internal path (the bot's /coach, a match code) in one
 * server round trip, without JavaScript and without a history entry to fall
 * back into. The personal page redirects here when the device lacks the
 * cookie; an unknown token or an unsafe destination lands on the page itself.
 */
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const next = safeNext(new URL(req.url).searchParams.get("next"));
  const target = new URL(next ?? `/p/${token}`, baseUrl());
  try {
    const db = await getDb();
    const player = await findPlayerByPersonalToken(db, token);
    if (player && (await getSessionPlayerId()) !== player.id) await setSessionPlayer(player.id);
  } catch (e) {
    console.warn("[personal] could not adopt token", e);
  }
  return NextResponse.redirect(target, { status: 302, headers: { "Cache-Control": "private, no-store" } });
}
