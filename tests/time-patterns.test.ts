import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { slots, type Player } from "@/db/schema";
import { zonedTimeToUtc } from "@/lib/dates";
import { createEvent } from "@/lib/domain/events";
import { getPlayerTimePatterns } from "@/lib/domain/queries";
import { freezeClock } from "./helpers/clock";
import { createTestDb, makePlayer } from "./helpers/db";

/**
 * The create form's usual times, and so its default time, come from matches that people played: two or
 * more taken seats. Erik's form opened on Fri 18:00, from three Friday matches nobody joined, while
 * every match he played started between 09:30 and 11:30 (15 October 2026).
 *
 * NOW is Thursday 15 October 2026, 14:44 UTC (21:44 in Phuket). Every match is in Asia/Bangkok, in
 * September and October 2026 (25 Sep and 2, 9 Oct are Fridays; 10 Oct is a Saturday).
 */
const NOW = new Date("2026-10-15T14:44:00Z");
freezeClock(NOW);
const TZ = "Asia/Bangkok";
const at = (date: string, time: string) => zonedTimeToUtc(date, time, TZ);

describe("getPlayerTimePatterns", () => {
  let db: Db;
  let close: () => Promise<void>;
  let erik: Player;
  let micky: Player;
  let nok: Player;

  /** A match as production makes it: the organiser seated at 1, each other name at the next place. */
  const match = async (creator: Player, startsAt: Date, seats: { player?: Player; status: "joined" | "confirmed" | "invited"; name?: string }[]) => {
    const ev = await createEvent(db, { creatorPlayerId: creator.id, type: "match", startsAt, tz: TZ, venueName: "Kross Padel", whenFull: "waitlist" });
    for (const [i, s] of seats.entries()) {
      await db
        .update(slots)
        .set({ playerId: s.player?.id ?? null, status: s.status, kind: s.player ? "open" : "reserved", invitedName: s.name ?? null, joinedAt: s.status === "invited" ? null : startsAt })
        .where(and(eq(slots.eventId, ev.id), eq(slots.position, i + 1)));
    }
    return ev;
  };

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    erik = await makePlayer(db, "Erik");
    micky = await makePlayer(db, "Micky");
    nok = await makePlayer(db, "Nok");
    // Three Fri 18:00 try-outs that nobody joined; one held a place for Danny, who never took it.
    await match(erik, at("2026-09-25", "18:00"), [{ player: erik, status: "joined" }]);
    await match(erik, at("2026-10-02", "18:00"), [{ player: erik, status: "joined" }, { status: "invited", name: "Danny" }]);
    await match(erik, at("2026-10-09", "18:00"), [{ player: erik, status: "joined" }]);
    // Five matches people played, one at each time, the Saturday the most recent.
    await match(erik, at("2026-09-28", "09:30"), [{ player: erik, status: "joined" }, { player: micky, status: "confirmed" }]);
    await match(erik, at("2026-09-29", "10:00"), [{ player: erik, status: "joined" }, { player: micky, status: "joined" }]);
    await match(micky, at("2026-10-06", "11:30"), [{ player: micky, status: "joined" }, { player: erik, status: "joined" }]);
    await match(erik, at("2026-10-09", "11:00"), [{ player: erik, status: "joined" }, { player: micky, status: "joined" }]);
    await match(erik, at("2026-10-10", "11:00"), [{ player: erik, status: "joined" }, { player: micky, status: "joined" }]);
    // A new organiser: two Wednesday try-outs, nobody joined yet.
    await match(nok, at("2026-10-07", "19:00"), [{ player: nok, status: "joined" }]);
    await match(nok, at("2026-10-14", "19:00"), [{ player: nok, status: "joined" }]);
  });
  afterAll(() => close());

  it("Erik's usual times are the ones he played: Sat 11:00 first, and no Fri 18:00 among the chips", async () => {
    const patterns = await getPlayerTimePatterns(db, erik.id);
    expect(patterns.map((p) => `${p.dow} ${p.time}`)).toEqual(["6 11:00", "5 11:00", "2 11:30", "2 10:00"]);
    expect(patterns.some((p) => p.dow === 5 && p.time === "18:00")).toBe(false);
  });

  it("a new organiser whose matches nobody joined yet keeps the chips of the whole history", async () => {
    const patterns = await getPlayerTimePatterns(db, nok.id);
    expect(patterns.map((p) => `${p.dow} ${p.time} ×${p.count}`)).toEqual(["3 19:00 ×2"]);
  });

  it("a player with no history gets no chips", async () => {
    const nobody = await makePlayer(db, "Nobody");
    expect(await getPlayerTimePatterns(db, nobody.id)).toEqual([]);
  });
});
