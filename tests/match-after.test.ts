import { beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { duplicateEventAction } from "@/actions/events";
import { saveScoreAction } from "@/actions/scores";
import { events, scores, type Event, type Player } from "@/db/schema";
import { afterMatchView, SHARE_CARD_AFTER_MATCH, STRANGER_FIX_DOOR, THATS_ME_DOOR } from "@/lib/domain/afterMatch";
import { createEvent } from "@/lib/domain/events";
import { saveMatchScore } from "@/lib/domain/scores";
import { joinEvent } from "@/lib/domain/slots";
import { PLAYER_COOKIE, sealPlayerId } from "@/lib/session";
import { asAction } from "./helpers/action";
import { freezeClock } from "./helpers/clock";
import { HOUR, makePlayer } from "./helpers/db";

/**
 * The match page after a match (the owner, 26 November 2026): "since this is a public page that people can
 * share, I guess after someone clicks edit score they need to be logged in as only players and organizer can
 * change it", and "All the organizer tools, 4/4 players, confirm levels sections, make sure these are hidden
 * except to any of the players or organizer". The page hides them (`afterMatchView`); the two actions behind
 * "Edit score" and "Play again" refuse anybody else on their own, because a server action is a public
 * endpoint and a rule the screen holds is not a rule.
 */
const NOW = new Date("2026-11-26T05:00:00.000Z");
freezeClock(NOW);

describe("who sees what after a match", () => {
  const base = { over: true, organiser: false, member: false, signedIn: false, fixDoor: false, thatsMeDoor: false };

  it("shows the organiser and a player everything, and a visitor none of it", () => {
    expect(afterMatchView({ ...base, organiser: true })).toEqual({ inside: true, lineup: true, scoreReason: true });
    expect(afterMatchView({ ...base, member: true, signedIn: true })).toEqual({ inside: true, lineup: true, scoreReason: true });
    // A signed-out visitor: no line-up, no "Only players can enter the score", no sign-in prompt in its place.
    expect(afterMatchView(base)).toEqual({ inside: false, lineup: false, scoreReason: false });
    // Signed in with no seat, and the seven days to put the line-up right are over.
    expect(afterMatchView({ ...base, signedIn: true })).toEqual({ inside: false, lineup: false, scoreReason: false });
  });

  it("keeps the line-up for a signed-in viewer the line-up fix lets in, while that door is on", () => {
    expect(afterMatchView({ ...base, signedIn: true, fixDoor: true }).lineup).toBe(STRANGER_FIX_DOOR);
    // The door is for somebody signed in: a signed-out visitor never gets it.
    expect(afterMatchView({ ...base, fixDoor: true }).lineup).toBe(false);
  });

  it("keeps the line-up for a browser that knows nobody only where That's me is its door, and never the score's line", () => {
    expect(afterMatchView({ ...base, thatsMeDoor: true })).toEqual({ inside: false, lineup: THATS_ME_DOOR, scoreReason: false });
    // A signed-in browser has no "That's me" to use: the flag alone opens nothing.
    expect(afterMatchView({ ...base, signedIn: true, thatsMeDoor: true }).lineup).toBe(false);
  });

  it("changes nothing before the end: the line-up is where a stranger joins", () => {
    expect(afterMatchView({ ...base, over: false })).toEqual({ inside: false, lineup: true, scoreReason: true });
  });

  it("keeps the share card after the match off for now, behind its constant", () => {
    expect(SHARE_CARD_AFTER_MATCH).toBe(false);
  });
});

describe("the actions behind Edit score and Play again, called by somebody outside the match", () => {
  let db: Db;
  let ana: Player;
  let bo: Player;
  let zed: Player;
  let played: Event;
  const LAST = new Date(NOW.getTime() - 3 * HOUR);

  beforeAll(async () => {
    db = await getDb();
    ana = await makePlayer(db, "Ana");
    bo = await makePlayer(db, "Bo");
    zed = await makePlayer(db, "Zed");
    const ev = await createEvent(db, { creatorPlayerId: ana.id, type: "match", startsAt: LAST, tz: "Asia/Bangkok", whenFull: "closed", venueName: "Rawai Padel Club" });
    for (const p of [ana, bo]) await joinEvent(db, { eventId: ev.id, playerId: p.id, now: new Date(LAST.getTime() - HOUR) });
    await db.insert(scores).values([{ eventId: ev.id, setNumber: 1, sideA: 6, sideB: 4, enteredByPlayerId: ana.id }]);
    [played] = await db.select().from(events).where(eq(events.id, ev.id));
  });

  const scoreNow = async () => (await db.select({ a: scores.sideA, b: scores.sideB }).from(scores).where(eq(scores.eventId, played.id)).orderBy(asc(scores.setNumber))).map((s) => `${s.a}-${s.b}`).join(" ");
  const gamesOf = async (p: Player) => (await db.select({ id: events.id }).from(events).where(eq(events.creatorPlayerId, p.id))).length;

  it("Edit score refuses a signed-in stranger and a browser that knows nobody, and keeps the score", async () => {
    const stranger = await asAction({ [PLAYER_COOKIE]: sealPlayerId(zed.id) }, () => saveScoreAction(played.code, [{ setNumber: 1, sideA: 0, sideB: 6 }]));
    expect(stranger.result).toMatchObject({ ok: false, error: "not_participant" });
    // A browser that knows nobody: the action reads the request's language for a viewer with no record
    // (`getLocale`), which next-intl answers only inside a page Next.js renders, so under this harness it stops
    // there, refused. The rule it would meet next is the domain's, called here as the action calls it.
    const nobody = await asAction({}, () => saveScoreAction(played.code, [{ setNumber: 1, sideA: 0, sideB: 6 }]));
    expect(nobody.result).toMatchObject({ ok: false });
    await expect(saveMatchScore(db, { eventId: played.id, playerId: null, isCreator: false, sets: [{ setNumber: 1, sideA: 0, sideB: 6 }] })).rejects.toMatchObject({ code: "not_participant" });
    expect(await scoreNow()).toBe("6-4");
  });

  it("Edit score lets a player of the match save, so the refusals above are the seat's alone", async () => {
    const player = await asAction({ [PLAYER_COOKIE]: sealPlayerId(bo.id) }, () => saveScoreAction(played.code, [{ setNumber: 1, sideA: 6, sideB: 3 }]));
    expect(player.result).toEqual({ ok: true, data: null });
    expect(await scoreNow()).toBe("6-3");
  });

  it("Play again refuses a signed-in stranger and a browser that knows nobody, and makes no game", async () => {
    const before = { ana: await gamesOf(ana), zed: await gamesOf(zed) };
    const stranger = await asAction({ [PLAYER_COOKIE]: sealPlayerId(zed.id) }, () => duplicateEventAction(played.code, null));
    expect(stranger.result).toMatchObject({ ok: false, error: "forbidden" });
    const nobody = await asAction({}, () => duplicateEventAction(played.code, null));
    expect(nobody.result).toMatchObject({ ok: false, error: "forbidden" });
    expect({ ana: await gamesOf(ana), zed: await gamesOf(zed) }).toEqual(before);
  });
});
