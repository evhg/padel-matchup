import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events, matchStats, players } from "@/db/schema";
import { anonymizePlayer } from "@/lib/domain/anonymize";
import { createEvent } from "@/lib/domain/events";
import { DomainError } from "@/lib/domain/errors";
import { matchNumbers, playerNumbers, recordMatchStats, setShareHeartRate, venueRecords } from "@/lib/domain/matchStats";
import { joinEvent } from "@/lib/domain/slots";
import { createTestDb, makePlayer, HOUR, DAY } from "./helpers/db";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

type P = Awaited<ReturnType<typeof makePlayer>>;
/** A match that was played `ago` before now at one venue, with four seated players. */
async function played(four: P[], venueName: string, ago = 3 * HOUR) {
  const e = await createEvent(db, { creatorPlayerId: four[0].id, type: "match", startsAt: new Date(Date.now() + 2 * HOUR), tz: "UTC", venueName, whenFull: "closed" });
  for (const p of four) await joinEvent(db, { eventId: e.id, playerId: p.id }).catch(() => undefined);
  await db.update(events).set({ startsAt: new Date(Date.now() - ago), status: "past" }).where(eq(events.id, e.id));
  return (await db.select().from(events).where(eq(events.id, e.id)))[0];
}
const four = async (tag: string, extra: Partial<typeof players.$inferInsert> = {}) => [await makePlayer(db, `Ana ${tag}`, extra), await makePlayer(db, `Bo ${tag}`, extra), await makePlayer(db, `Cy ${tag}`, extra), await makePlayer(db, `Di ${tag}`, extra)];

describe("keeping the numbers of a match", () => {
  it("keeps a player's number by first name, and a pair's number as one row for each of the two", async () => {
    const [ana, bo, cy, di] = await four("one");
    const ev = await played([ana, bo, cy, di], "Numbers Club One");
    const res = await recordMatchStats(db, {
      code: ev.code,
      stats: [
        { player: "ana", kind: "fastestShot", value: 84.2, margin: 0.1 },
        { player: cy.id, partner: "Di", kind: "gamesInRow", value: 8 },
        { player: "Bo", kind: "servePointsWon", value: 68 },
      ],
    });
    expect(res).toEqual({ saved: 4, refused: [] });
    const rows = await db.select().from(matchStats).where(eq(matchStats.eventId, ev.id));
    expect(rows.filter((r) => r.kind === "gamesInRow").map((r) => [r.playerId, r.partnerId]).sort()).toEqual([[cy.id, di.id], [di.id, cy.id]].sort());
    expect(rows.every((r) => r.venueSlug === ev.venueSlug && ev.venueSlug)).toBeTruthy();

    // The match page: a pair once, first names only, in the order of the kinds.
    const shown = await matchNumbers(db, ev.id);
    expect(shown.map((r) => r.kind)).toEqual(["gamesInRow", "servePointsWon", "fastestShot"]);
    expect(shown.find((r) => r.kind === "fastestShot")).toMatchObject({ name: "Ana", partnerName: null, value: 84.2, margin: 0.1 });
    const pair = shown.find((r) => r.kind === "gamesInRow")!;
    expect([pair.name, pair.partnerName].sort()).toEqual(["Cy", "Di"]);
  });

  it("refuses an entry by itself and saves the rest, and says why", async () => {
    const [ana, bo, cy, di] = await four("two");
    const twin = await makePlayer(db, "Ana other");
    const ev = await played([ana, bo, cy, di], "Numbers Club Two");
    await joinEvent(db, { eventId: ev.id, playerId: twin.id }).catch(() => undefined);
    const res = await recordMatchStats(db, {
      code: ev.code,
      stats: [
        { player: "Bo", kind: "fastestShot", value: 73, margin: 0.2 },
        { player: "Bo", kind: "aces", value: 3 },
        { player: "Zed", kind: "fastestShot", value: 60 },
        { player: "Bo", kind: "gamesInRow", value: 4 },
        { player: "Bo", partner: "Bo", kind: "gamesInRow", value: 4 },
        { player: "Bo", kind: "heartRateMax", value: 157 },
        "not an entry",
        { player: "Bo", kind: "fastestShot", value: 52 },
      ],
    });
    expect(res.saved).toBe(1);
    expect(res.refused).toEqual([
      { index: 0, why: "bad_margin" },
      { index: 1, why: "unknown_kind" },
      { index: 2, why: "unknown_player" },
      { index: 3, why: "needs_partner" },
      { index: 4, why: "unknown_player" },
      { index: 5, why: "needs_yes" },
      { index: 6, why: "not_an_entry" },
    ]);
  });

  it("replaces a number that is sent again", async () => {
    const f = await four("three");
    const ev = await played(f, "Numbers Club Three");
    await recordMatchStats(db, { code: ev.code, stats: [{ player: "Ana", kind: "fastestShot", value: 73 }] });
    await recordMatchStats(db, { code: ev.code, stats: [{ player: "Ana", kind: "fastestShot", value: 52, margin: 0.08 }] });
    expect((await matchNumbers(db, ev.id)).map((r) => [r.value, r.margin])).toEqual([[52, 0.08]]);
  });

  it("refuses a match it does not know and a list that is not a list", async () => {
    await expect(recordMatchStats(db, { code: "zzzz", stats: [{ player: "Ana", kind: "fastestShot", value: 60 }] })).rejects.toMatchObject({ code: "not_found" });
    const f = await four("four");
    const ev = await played(f, "Numbers Club Four");
    for (const stats of [null, [], "x", Array.from({ length: 61 }, () => ({}))]) await expect(recordMatchStats(db, { code: ev.code, stats })).rejects.toBeInstanceOf(DomainError);
  });

  it("takes no number for a match that is still to come or was called off", async () => {
    const f = await four("nine");
    const ev = await played(f, "Numbers Club Nine");
    const one = [{ player: "Ana", kind: "fastestShot", value: 60 }];
    await expect(recordMatchStats(db, { code: ev.code, stats: one, now: new Date(ev.startsAt.getTime() - HOUR) })).rejects.toMatchObject({ code: "invalid", message: "not_played" });
    await db.update(events).set({ status: "cancelled" }).where(eq(events.id, ev.id));
    await expect(recordMatchStats(db, { code: ev.code, stats: one })).rejects.toMatchObject({ code: "invalid", message: "not_played" });
  });
});

describe("the heart rate is the player's own yes", () => {
  it("is written only after the yes, shown only while it stands, and deleted with the no", async () => {
    const [ana, bo, cy, di] = await four("five");
    const ev = await played([ana, bo, cy, di], "Numbers Club Five");
    const send = () => recordMatchStats(db, { code: ev.code, stats: [{ player: "Ana", kind: "heartRateMax", value: 157 }, { player: "Ana", kind: "fastestShot", value: 84 }] });
    expect(await send()).toEqual({ saved: 1, refused: [{ index: 0, why: "needs_yes" }] });
    await setShareHeartRate(db, ana.id, true);
    expect(await send()).toEqual({ saved: 2, refused: [] });
    expect((await playerNumbers(db, ana.id)).map((r) => r.kind).sort()).toEqual(["fastestShot", "heartRateMax"]);
    expect((await matchNumbers(db, ev.id)).map((r) => r.kind)).toContain("heartRateMax");

    await setShareHeartRate(db, ana.id, false);
    expect((await playerNumbers(db, ana.id)).map((r) => r.kind)).toEqual(["fastestShot"]);
    expect((await db.select().from(matchStats).where(eq(matchStats.playerId, ana.id))).map((r) => r.kind)).toEqual(["fastestShot"]);
    expect((await db.select().from(players).where(eq(players.id, ana.id)))[0].shareHeartRate).toBe(false);
  });
});

describe("when a player deletes their account", () => {
  it("removes their numbers, and leaves the partner the pair's number with no name beside it", async () => {
    const [ana, bo, cy, di] = await four("ten");
    await setShareHeartRate(db, ana.id, true);
    const ev = await played([ana, bo, cy, di], "Numbers Club Ten");
    await recordMatchStats(db, { code: ev.code, stats: [{ player: "Ana", kind: "heartRateMax", value: 157 }, { player: "Ana", partner: "Bo", kind: "gamesInRow", value: 8 }] });
    await anonymizePlayer(db, ana.id);
    expect(await playerNumbers(db, ana.id)).toEqual([]);
    expect((await playerNumbers(db, bo.id)).map((r) => [r.kind, r.partnerName])).toEqual([["gamesInRow", null]]);
    expect((await matchNumbers(db, ev.id)).map((r) => [r.kind, r.name, r.partnerName])).toEqual([["gamesInRow", "Bo", null]]);
    expect((await db.select().from(players).where(eq(players.id, ana.id)))[0].shareHeartRate).toBe(false);
  });
});

describe("my stats", () => {
  it("lists a player's numbers with their match, the newest match first", async () => {
    const f = await four("six");
    const old = await played(f, "Numbers Club Six", 9 * DAY);
    const fresh = await played(f, "Numbers Club Six", 2 * HOUR);
    await recordMatchStats(db, { code: old.code, stats: [{ player: "Ana", kind: "fastestShot", value: 60 }] });
    await recordMatchStats(db, { code: fresh.code, stats: [{ player: "Ana", kind: "fastestShot", value: 84 }, { player: "Ana", partner: "Bo", kind: "breaks", value: 2 }] });
    const mine = await playerNumbers(db, f[0].id);
    expect(mine.map((r) => r.code)).toEqual([fresh.code, fresh.code, old.code]);
    expect(mine.find((r) => r.kind === "breaks")).toMatchObject({ name: "Ana", partnerName: "Bo", venueName: "Numbers Club Six" });
    // Bo has the pair's number too, and nothing of Ana's own.
    expect((await playerNumbers(db, f[1].id)).map((r) => [r.kind, r.partnerName])).toEqual([["breaks", "Ana"]]);
  });
});

describe("the club's records", () => {
  it("lists only players who said \"Show me in rankings\", the highest first, three of a kind at most", async () => {
    const [ana, bo, cy, di] = await four("seven");
    const quiet = await makePlayer(db, "Quinn seven");
    const ev = await played([ana, bo, cy, di], "Records Club");
    const ev2 = await played([ana, bo, cy, quiet], "Records Club", 5 * HOUR);
    await recordMatchStats(db, { code: ev.code, stats: [
      { player: "Ana", kind: "fastestShot", value: 84 }, { player: "Bo", kind: "fastestShot", value: 75 },
      { player: "Cy", kind: "fastestShot", value: 52 }, { player: "Di", kind: "fastestShot", value: 50 },
      { player: "Ana", partner: "Bo", kind: "gamesInRow", value: 8 },
    ] });
    await recordMatchStats(db, { code: ev2.code, stats: [{ player: "Quinn", kind: "fastestShot", value: 99 }, { player: "Cy", partner: "Quinn", kind: "gamesInRow", value: 5 }] });
    expect((await venueRecords(db, ev.venueSlug!)).size).toBe(0);

    for (const p of [ana, bo, cy, di]) await db.update(players).set({ rankingOptIn: true }).where(eq(players.id, p.id));
    const board = await venueRecords(db, ev.venueSlug!);
    expect(board.get("fastestShot")!.map((r) => [r.name, r.value])).toEqual([["Ana", 84], ["Bo", 75], ["Cy", 52]]);
    const rows = board.get("gamesInRow")!;
    expect(rows.map((r) => r.value)).toEqual([8, 5]);
    expect([rows[0].name, rows[0].partnerName].sort()).toEqual(["Ana", "Bo"]);
    // Quinn did not opt in: the pair's number shows with Cy alone, and Quinn's 99 km/h is on no board.
    expect([rows[1].name, rows[1].partnerName]).toEqual(["Cy", null]);
    expect([...board.keys()]).toEqual(["gamesInRow", "fastestShot"]);
    expect((await venueRecords(db, "no-such-club")).size).toBe(0);
  });

  it("leaves out a match that was called off", async () => {
    const f = await four("eight", { rankingOptIn: true });
    const ev = await played(f, "Records Club Off");
    await recordMatchStats(db, { code: ev.code, stats: [{ player: "Ana", kind: "fastestShot", value: 84 }] });
    expect((await venueRecords(db, ev.venueSlug!)).get("fastestShot")).toHaveLength(1);
    await db.update(events).set({ status: "cancelled" }).where(eq(events.id, ev.id));
    expect((await venueRecords(db, ev.venueSlug!)).size).toBe(0);
  });
});
