import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { operatorAuthorized } from "@/lib/api/secret";
import { DomainError } from "@/lib/domain/errors";
import { fillPlayedMatch, recordPlayedMatch, renameUnclaimed } from "@/lib/domain/playedMatch";

export const dynamic = "force-dynamic";

/**
 * A match that was played with no match page, written as it was. Bearer CRON_SECRET.
 *
 *   POST /api/admin/played-match
 *   { "startsAt": "2026-11-18T04:00:00Z", "tz": "Asia/Bangkok", "durationMinutes": 90,
 *     "venue": "Rawai Padel Club",
 *     "teamA": ["<player id>", "<player id>"], "teamB": ["<player id>", "Dana"],
 *     "sets": [[3, 6], [2, 6]] }
 *
 * A player is the id of a record, or a name: a name makes a new record, so only somebody with no
 * record is sent by name. The first player of `teamA` is the organiser, and a set is [pair A, pair B].
 * The answer has the match code and the four players. Nothing is announced to anybody. The same
 * organiser and the same start is the same match: a second call answers `existed: true` and writes
 * nothing. `src/lib/domain/playedMatch.ts` says why this door exists; `/api/admin/match-stats` then
 * takes the numbers of the match.
 *
 * A match that has its page but no score: send its `code` with `teamA`, `teamB` and `sets` (no start,
 * zone or venue). The four take the places they have, the places held for them, or open places, and the
 * organiser, who must be one of the four by id, confirms the score (`fillPlayedMatch`). With
 * `"replace": true` the score and the pairs of a match whose four are seated are saved again.
 * `"rename": { "<player id>": "Name" }` first renames records nobody has signed in to (`renameUnclaimed`).
 */
export async function POST(req: Request) {
  if (!(await operatorAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const startsAt = typeof body?.startsAt === "string" ? new Date(body.startsAt) : new Date(Number.NaN);
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const sets = Array.isArray(body?.sets) ? body.sets.map((s) => (Array.isArray(s) ? { sideA: Number(s[0]), sideB: Number(s[1]) } : { sideA: Number.NaN, sideB: Number.NaN })) : [];
  try {
    if (typeof body?.code === "string") {
      const db = await getDb();
      const rename = body?.rename && typeof body.rename === "object" ? Object.entries(body.rename as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string") : [];
      const renamed = [];
      for (const [id, name] of rename) renamed.push(await renameUnclaimed(db, id, name));
      const filled = await fillPlayedMatch(db, { code: body.code, teamA: strings(body?.teamA), teamB: strings(body?.teamB), sets, replace: body?.replace === true });
      if (renamed.length) revalidatePath("/", "layout");
      if (!filled.existed) revalidatePath("/", "layout");
      return NextResponse.json({ ok: true, ...filled, renamed });
    }
    const res = await recordPlayedMatch(await getDb(), {
      startsAt,
      tz: typeof body?.tz === "string" ? body.tz : "",
      durationMinutes: typeof body?.durationMinutes === "number" ? body.durationMinutes : null,
      venueName: typeof body?.venue === "string" ? body.venue : null,
      teamA: strings(body?.teamA),
      teamB: strings(body?.teamB),
      sets,
    });
    if (!res.existed) revalidatePath("/", "layout");
    return NextResponse.json({ ok: true, ...res });
  } catch (e) {
    if (e instanceof DomainError && e.code === "not_found") return NextResponse.json({ error: "not_found", hint: "A player id in teamA or teamB is not a record." }, { status: 404 });
    if (e instanceof DomainError) return NextResponse.json({ error: e.code, detail: e.message, hint: "startsAt (ISO, in the past), tz (IANA), teamA and teamB (two players each, four different), sets ([[a, b], …])" }, { status: 400 });
    throw e;
  }
}
