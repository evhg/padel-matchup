import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { events } from "@/db/schema";
import { isValidManageCode, isValidShareCode } from "@/lib/codes";
import { grantManageAccess } from "@/lib/session";

/**
 * /{code}/manage/{manageCode}: proves organizer access, stores it in an
 * httpOnly cookie scoped to /{code}, and lands on the event page.
 *
 * A code that does not match (an old link, a link cut short in a chat) lands on the page with
 * `?manage=wrong`, and the page says the organizer link did not work. It used to land on the plain page
 * with no word, and the organiser could not tell why the tools were missing (review, 9 November 2026).
 * The page says the same for any code, so nothing tells a guess how close it came.
 */
export async function GET(req: Request, { params }: { params: Promise<{ code: string; manage: string }> }) {
  const { code, manage } = await params;
  const dest = new URL(`/${encodeURIComponent(code)}`, req.url);
  if (!isValidShareCode(code)) return NextResponse.redirect(dest);
  const wrong = new URL(`/${encodeURIComponent(code)}?manage=wrong`, req.url);
  if (!isValidManageCode(manage)) return NextResponse.redirect(wrong, { status: 303 });
  const db = await getDb();
  const [ev] = await db.select({ manageCode: events.manageCode }).from(events).where(eq(events.code, code)).limit(1);
  if (!ev || ev.manageCode !== manage) return NextResponse.redirect(wrong, { status: 303 });
  await grantManageAccess(code, manage);
  return NextResponse.redirect(dest, { status: 303 });
}
