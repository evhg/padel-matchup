import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { isValidShareCode } from "@/lib/codes";
import { baseUrl } from "@/lib/config";
import { findPlayerByPersonalToken } from "@/lib/domain/identity";
import { getSessionPlayerId, setSessionPlayer } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Private event link (the one saved in calendar entries and emails):
 * signs this device in as the token's player, then opens the match page.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string; code: string }> }) {
  const { token, code } = await params;
  const target = new URL(isValidShareCode(code) ? `/${code}` : "/", baseUrl());
  try {
    const db = await getDb();
    const player = await findPlayerByPersonalToken(db, token);
    if (player && (await getSessionPlayerId()) !== player.id) await setSessionPlayer(player.id);
  } catch (e) {
    console.warn("[personal] could not adopt token", e);
  }
  return NextResponse.redirect(target, { status: 302, headers: { "Cache-Control": "private, no-store" } });
}
