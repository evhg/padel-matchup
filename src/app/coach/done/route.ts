import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { COACH_COOKIE, coachCookieOptions } from "@/lib/coachCookie";
import { isCoachActor } from "@/lib/domain/coaching";
import { getSessionPlayerId } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * The last step of the setup walk: the browser gets the coach hint in the same
 * response that opens the welcome, so the header's way back to the assistant
 * is there from the first page after setup, not only after a page has rendered
 * and hydrated. A visitor who is not a coach just lands on /coach. The hop is
 * built on the request's own origin (a preview host stays on itself) and a
 * database hiccup still lands on /coach: the page's own hint catches up later.
 */
export async function GET(req: Request) {
  let coach = false;
  try {
    const me = await getSessionPlayerId();
    coach = me ? await isCoachActor(await getDb(), me) : false;
  } catch (e) {
    console.warn("[coach] could not read the coach for the hint", e);
  }
  if (coach) (await cookies()).set(COACH_COOKIE, "1", coachCookieOptions());
  return NextResponse.redirect(new URL(coach ? "/coach?welcome=1" : "/coach", req.url), { status: 302, headers: { "Cache-Control": "private, no-store" } });
}
