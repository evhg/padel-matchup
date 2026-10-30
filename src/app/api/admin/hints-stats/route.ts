import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { operatorAuthorized } from "@/lib/api/secret";
import { hintKeyStats } from "@/lib/domain/deviceHints";
import { HINT_LABEL_LIST, hintLabelOf } from "@/lib/domain/hintSignals";

export const dynamic = "force-dynamic";

/**
 * How well the device keys tell phones apart, as counts only (the owner, 30 October 2026: "check the
 * digital footprints for all current users, how many uniques and how many are indistinguishable?").
 *
 *   GET /api/admin/hints-stats            every key
 *   GET /api/admin/hints-stats?label=iPhone   the keys of one label (iPhone, iPad, Android phone, other)
 *   Authorization: Bearer $CRON_SECRET
 *
 * The operator's token, checked as /api/admin/sql checks it. Then one statement with the app's own role
 * (`hintKeyStats`): /api/admin/sql cannot answer this, because its read-only role never sees
 * `device_hints.key`, and it should not, because a key there would leave in the answer. Here the keys stay
 * inside the statement: the answer is numbers and the label it was asked for. Never a key, a label for one
 * player, a player id or a name (tests/hints-stats.test.ts). An unknown label is refused, never echoed.
 *
 * The limit of that promise: the counts are exact, and the read-only door shows each row's label and
 * player. With few keys, these counts and that door together show which named players share a key (two
 * names under "iPad" there, and here `shared: 1` for "iPad"). So never join this answer with names from
 * /api/admin/sql. Whether small groups should be hidden is the owner's decision (DECIDING rule 40).
 */
export async function GET(req: Request) {
  if (!(await operatorAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const asked = new URL(req.url).searchParams.get("label") ?? "";
  const label = asked === "" ? null : hintLabelOf(asked);
  if (asked !== "" && label === null) return NextResponse.json({ error: "unknown label", labels: HINT_LABEL_LIST }, { status: 400 });
  const stats = await hintKeyStats(await getDb(), label);
  return NextResponse.json({ ok: true, label, ...stats });
}
