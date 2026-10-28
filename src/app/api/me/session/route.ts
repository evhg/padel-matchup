import { getDb } from "@/db";
import { countAfter } from "@/lib/countLater";
import { getPlayer } from "@/lib/domain/players";
import { isDeletedPlayer } from "@/lib/domain/result";
import { clearSessionPlayer, getSessionPlayerId, renewSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * The one place a page's visit sets a cookie, because a page cannot (`IdentitySync` asks it, only when
 * the root layout saw it due):
 *
 * - `?do=renew`: a full sign-in gets a new year, at most once in 30 days (`renewSession`, the owner,
 *   28 October 2026). No read: the cookies alone decide. Counted as `session_renewed` when it renewed.
 *   The 30 days hold for an honest browser only: the day is in `km_has_id`, which a script can write, so
 *   a script with a valid session can renew, and count, on every call (docs/OPERATING.md).
 * - `?do=dead`: a signed session cookie whose record is gone is ended here and counted once as
 *   `session_dead`; the browser then holds no cookie to be counted again. A record goes in a merge, which
 *   folds it into another, or in the daily clean-up of a disposable record (a name with no match and no
 *   way to reach it, `disposable.ts`), while the browser that made it still holds its cookie. A deleted
 *   account ("Delete my account" in another browser) counts as gone too: its row stays, anonymous, and a
 *   renewal would otherwise keep that session for as long as the browser visits. One read, of that
 *   record, only for such a browser.
 *
 * A route and not a server action, because an action that changes a cookie renders the page again, which
 * would read the whole page once more for nothing. A cross-site request carries no session cookie
 * (SameSite=Lax), so another site can renew or end nothing.
 */
export async function POST(req: Request) {
  const what = new URL(req.url).searchParams.get("do");
  if (what === "renew") {
    if (await renewSession()) await countAfter(await getDb(), ["session_renewed"]);
    return new Response(null, { status: 204 });
  }
  if (what === "dead") {
    const id = await getSessionPlayerId();
    if (id) {
      const db = await getDb();
      const p = await getPlayer(db, id);
      if (!p || isDeletedPlayer(p)) {
        await clearSessionPlayer();
        await countAfter(db, ["session_dead"]);
      }
    }
    return new Response(null, { status: 204 });
  }
  return new Response(null, { status: 400 });
}
