import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { COACH_COOKIE, coachCookieOptions } from "@/lib/coachCookie";
import { baseUrl } from "@/lib/config";
import { getCoachForActor } from "@/lib/domain/coaching";
import { getSessionPlayer } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * The last step of the setup walk: the browser gets the coach hint in the same
 * response that opens the welcome, so the header's way back to the assistant
 * is there from the first page after setup, not only after a page has rendered
 * and hydrated. A visitor who is not a coach just lands on /coach.
 */
export async function GET() {
  const db = await getDb();
  const me = await getSessionPlayer(db);
  const coach = me ? await getCoachForActor(db, me.id) : null;
  if (coach) (await cookies()).set(COACH_COOKIE, "1", coachCookieOptions());
  return NextResponse.redirect(new URL(coach ? "/coach?welcome=1" : "/coach", baseUrl()), { status: 302, headers: { "Cache-Control": "private, no-store" } });
}
