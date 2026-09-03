import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { events } from "@/db/schema";
import { isValidManageCode, isValidShareCode } from "@/lib/codes";
import { grantManageAccess } from "@/lib/session";

/**
 * /{code}/manage/{manageCode}: proves organizer access, stores it in an
 * httpOnly cookie scoped to /{code}, and lands on the event page.
 */
export async function GET(req: Request, { params }: { params: Promise<{ code: string; manage: string }> }) {
  const { code, manage } = await params;
  const dest = new URL(`/${encodeURIComponent(code)}`, req.url);
  if (!isValidShareCode(code) || !isValidManageCode(manage)) return NextResponse.redirect(dest);
  const db = await getDb();
  const [ev] = await db.select({ manageCode: events.manageCode }).from(events).where(eq(events.code, code)).limit(1);
  if (ev && ev.manageCode === manage) {
    await grantManageAccess(code, manage);
  }
  return NextResponse.redirect(dest, { status: 303 });
}
