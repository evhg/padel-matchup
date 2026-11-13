import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { feedback } from "@/db/schema";
import { operatorAuthorized } from "@/lib/api/secret";
import { telegramFileBytes } from "@/lib/telegram/api";
import { PHOTO_MARK } from "@/lib/telegram/handlers/feedback";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/feedback/photo?file=<file_id>  (Authorization: Bearer <operator secret>)
 *
 * A picture a player sent the bot, which the note keeps as Telegram's reference (`📷 [tg-file:<id>]`):
 * the hourly check opens it here. Only a reference that some note holds is fetched, so the door is
 * never a general proxy to Telegram. The picture is not stored by Kicksmash; Telegram keeps it.
 */
export async function GET(req: Request) {
  if (!(await operatorAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const file = new URL(req.url).searchParams.get("file") ?? "";
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(file)) return NextResponse.json({ error: "file required" }, { status: 400 });
  const db = await getDb();
  const [held] = await db.select({ id: feedback.id }).from(feedback).where(sql`strpos(${feedback.text}, ${PHOTO_MARK + file}) > 0`).limit(1);
  if (!held) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const got = await telegramFileBytes(file);
  if (!got) return NextResponse.json({ error: "telegram_unavailable" }, { status: 502 });
  return new Response(got.bytes, { headers: { "content-type": got.contentType, "cache-control": "no-store" } });
}
