import { getDb } from "@/db";
import { baseUrl } from "@/lib/config";
import { takeRate } from "@/lib/domain/ratelimit";
import { exportPlayerData } from "@/lib/domain/profile";
import { deletionRefusal } from "@/lib/domain/thatsMe";
import { getSessionPlayer, signedInByName } from "@/lib/session";

export const dynamic = "force-dynamic";

/** What a session by name hears instead of the file: the account deletion's "prove it first", for a download. */
const EXPORT_PROOF_MESSAGE = "You came in by tapping your name, so this browser cannot download the data. First prove it is yours: confirm your email with a code or link Telegram on My matches. Then download it.";

/**
 * One file with everything we hold about the signed-in player. Tokens and manage links stay out: this file
 * gets shared. A session by name that proved nothing (DECIDING rule 34) gets no file, the owner's
 * decision of 9 November 2026 ("Name-only session: no export"): the file holds the record's phone and email,
 * and a name on a line-up proves nobody is that person. The rule and the refusal are the account deletion's
 * (`deletionRefusal`, `proof_required`), and they come before the counter, so a refused tap spends none of the ten.
 */
export async function GET() {
  const db = await getDb();
  const me = await getSessionPlayer(db);
  if (!me) return Response.json({ error: { code: "no_identity", message: "Open My matches first; the export is for the signed-in player." } }, { status: 401 });
  if (deletionRefusal(await signedInByName(me.id), me)) return Response.json({ error: { code: "proof_required", message: EXPORT_PROOF_MESSAGE } }, { status: 403, headers: { "cache-control": "no-store" } });
  if (!(await takeRate(db, "export", me.id, 10, "day"))) return Response.json({ error: { code: "too_many", message: "Ten exports a day is plenty. Try again tomorrow." } }, { status: 429 });
  const data = await exportPlayerData(db, me, baseUrl());
  return new Response(JSON.stringify(data, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="kicksmash-${me.displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "player"}.json"`, "cache-control": "no-store" },
  });
}
