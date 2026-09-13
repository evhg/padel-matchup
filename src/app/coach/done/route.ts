import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { isCoachActor } from "@/lib/domain/coaching";
import { getSessionPlayerId } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * The last step of the setup walk: open the welcome. The header reads the role
 * set on the server, so there is no hint to plant here any more — a book that
 * exists is a door on the very next render. A visitor who is not a coach just
 * lands on /coach. The hop is built on the request's own origin (a preview host
 * stays on itself) and a database hiccup still lands on /coach.
 */
export async function GET(req: Request) {
  let coach = false;
  try {
    const me = await getSessionPlayerId();
    coach = me ? await isCoachActor(await getDb(), me) : false;
  } catch (e) {
    console.warn("[coach] could not read the coach for the welcome", e);
  }
  return NextResponse.redirect(new URL(coach ? "/coach?welcome=1" : "/coach", req.url), { status: 302, headers: { "Cache-Control": "private, no-store" } });
}
