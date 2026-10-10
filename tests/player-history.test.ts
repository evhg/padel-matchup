import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { events, slots, type Player } from "@/db/schema";
import { createEvent } from "@/lib/domain/events";
import { getPlayerHistory, playerHistoryReads } from "@/lib/domain/queries";
import { freezeClock } from "./helpers/clock";
import { createTestDb, HOUR, makePlayer } from "./helpers/db";

/**
 * A player's history: the matches they made or played, newest first. It feeds the usual times on the
 * create form, and the usual clubs and times of the best times on /play and in the chat, so it runs on
 * public pages. It is two reads, each driven by an index on the player (the matches they made, the
 * seats they held), so its cost is the player's own matches, never the whole table.
 *
 * NOW is Saturday 10 October 2026, 05:00 UTC.
 */
const NOW = new Date("2026-10-10T05:00:00Z");
freezeClock(NOW);
const TZ = "Asia/Bangkok";
const DAY = 24 * HOUR;

describe("getPlayerHistory", () => {
  let db: Db;
  let close: () => Promise<void>;
  let nok: Player;
  let someone: Player;
  const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
  const seat = (eventId: string, position: number, status: "joined" | "confirmed" | "invited") => db.update(slots).set({ playerId: nok.id, status }).where(and(eq(slots.eventId, eventId), eq(slots.position, position)));

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    nok = await makePlayer(db, "Nok");
    someone = await makePlayer(db, "Someone");
    // Somebody else's 3,000 matches, with a seat each for somebody else: what a busy table looks like.
    await db.execute(
      sql.raw(
        `insert into events (code, type, starts_at, tz, venue_name, capacity, creator_player_id, manage_code, status) select lpad(upper(to_hex(g)), 4, '0'), 'match', timestamptz '2025-01-01T00:00:00Z' + g * interval '3 hours', 'Asia/Bangkok', 'Somewhere', 4, '${someone.id}', lpad(to_hex(g), 10, 'x'), 'open' from generate_series(1, 3000) g`,
      ),
    );
    await db.execute(sql.raw(`insert into slots (event_id, player_id, status, position) select id, '${someone.id}', 'joined', 1 from events where creator_player_id = '${someone.id}'`));
    // Nok made one match (10 days ago, 60 minutes), played in one of somebody's (5 days ago), was
    // invited to another and never answered (3 days ago), and made one she then cancelled (1 day ago).
    await createEvent(db, { creatorPlayerId: nok.id, type: "match", startsAt: ago(10), tz: TZ, venueName: "Rawai Padel Club", durationMinutes: 60, whenFull: "waitlist" });
    const played = await createEvent(db, { creatorPlayerId: someone.id, type: "match", startsAt: ago(5), tz: TZ, venueName: "Chalong Padel Club", whenFull: "waitlist" });
    await seat(played.id, 2, "joined");
    const invited = await createEvent(db, { creatorPlayerId: someone.id, type: "match", startsAt: ago(3), tz: TZ, venueName: "Kata Padel Club", whenFull: "waitlist" });
    await seat(invited.id, 3, "invited");
    const cancelled = await createEvent(db, { creatorPlayerId: nok.id, type: "match", startsAt: ago(1), tz: TZ, venueName: "Rawai Padel Club", whenFull: "waitlist" });
    await db.update(events).set({ status: "cancelled" }).where(eq(events.id, cancelled.id));
    await db.execute(sql`analyze`);
  });
  afterAll(() => close());

  it("the matches a player made or held a seat in, newest first, without a cancelled one or an invitation never answered", async () => {
    const rows = await getPlayerHistory(db, nok.id);
    expect(rows.map((r) => [r.startsAt.toISOString(), r.durationMinutes])).toEqual([
      [ago(5).toISOString(), 90],
      [ago(10).toISOString(), 60],
    ]);
  });

  it("a match the player made and also holds a seat in counts once, and the limit holds", async () => {
    const own = await createEvent(db, { creatorPlayerId: nok.id, type: "match", startsAt: ago(2), tz: TZ, venueName: "Rawai Padel Club", whenFull: "waitlist" });
    await seat(own.id, 2, "confirmed");
    expect((await getPlayerHistory(db, nok.id)).map((r) => r.startsAt.toISOString())).toEqual([ago(2), ago(5), ago(10)].map((d) => d.toISOString()));
    expect((await getPlayerHistory(db, nok.id, 2)).map((r) => r.startsAt.toISOString())).toEqual([ago(2), ago(5)].map((d) => d.toISOString()));
    expect(await getPlayerHistory(db, someone.id, 5)).toHaveLength(5);
  });

  it("each read starts from the player's own rows: the plan never walks the 3,000 matches of somebody else", async () => {
    const [made, played] = playerHistoryReads(db, nok.id, 60);
    for (const [q, index] of [
      [made, "events_creator_idx"],
      [played, "slots_player_idx"],
    ] as const) {
      const { sql: text0, params } = q.toSQL();
      const text = params.reduce<string>((t, p, i) => t.replace(new RegExp(`\\$${i + 1}(?!\\d)`, "g"), `'${String(p)}'`), text0);
      const plan = ((await db.execute(sql.raw(`explain (analyze, costs off, timing off) ${text}`))) as unknown as { rows: Record<string, string>[] }).rows.map((r) => Object.values(r)[0]).join("\n");
      const touched = [...plan.matchAll(/actual rows=(\d+)/g)].map((m) => Number(m[1]));
      const removed = [...plan.matchAll(/Rows Removed by Filter: (\d+)/g)].map((m) => Number(m[1]));
      expect(plan).toContain(`Index Scan using ${index}`);
      expect(Math.max(...touched), plan).toBeLessThan(50);
      expect(Math.max(0, ...removed), plan).toBeLessThan(50);
    }
  });
});
