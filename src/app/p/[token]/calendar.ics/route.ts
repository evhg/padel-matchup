import { getDb } from "@/db";
import { personalFeed, playerForFeedKey } from "@/lib/calendarFeed";

export const dynamic = "force-dynamic";

/**
 * The player's own feed, which a calendar subscribes to (src/lib/calendarFeed.ts). The segment holds
 * the feed's key, not the personal token: the address can sit in a chat and in somebody's calendar
 * settings without being a way to sign in. Private: every address is one person's matches.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token: key } = await params;
  const db = await getDb();
  const player = await playerForFeedKey(db, key);
  const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };
  if (!player) return new Response("Not found", { status: 404, headers });
  const body = await personalFeed(db, player);
  return new Response(body, { headers: { ...headers, "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": 'inline; filename="kicksmash.ics"' } });
}
