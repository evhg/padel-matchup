import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { Db } from "@/db";
import { coaches, demandSignals, feedback, lessons, players, venues } from "@/db/schema";
import { DISPOSABLE_AFTER_DAYS, findDisposablePlayers, removeDisposableDaily, removeDisposablePlayers } from "@/lib/domain/disposable";
import { createEvent } from "@/lib/domain/events";
import { joinEvent } from "@/lib/domain/slots";
import { createTestDb, DAY, makePlayer } from "./helpers/db";

/**
 * The owner, 24 September 2026: "any user without any contact, without any match, is a one-time
 * disposable user or a test. Both can be removed safely without upsetting anyone." The 21 September
 * walks had left 25 such rows on production, and they counted as players in every number the owner
 * read. A daily job removes a row after fourteen days when nothing ties it to a person; each case
 * below is one thing that does, and the rows that must stay are the point of the test.
 */
// A fixed clock (rule 11). Rows are made "old" by moving their created_at back from NOW.
const NOW = new Date(Date.UTC(2026, 8, 24, 4, 0));
const old = new Date(NOW.getTime() - (DISPOSABLE_AFTER_DAYS + 1) * DAY);
const young = new Date(NOW.getTime() - (DISPOSABLE_AFTER_DAYS - 1) * DAY);

describe("disposable player rows", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  const row = async (name: string, extra: Partial<typeof players.$inferInsert> = {}, createdAt = old) => {
    const p = await makePlayer(db, name, extra);
    await db.update(players).set({ createdAt }).where(eq(players.id, p.id));
    return p;
  };
  const coach = (playerId: string, handle: string) => db.insert(coaches).values({ playerId, handle, displayName: handle, tz: "Asia/Bangkok", clubNames: [], clubSlugs: [], hours: {} }).returning().then((r) => r[0]);

  it("removes what nothing ties to a person, and keeps every row that something does", async () => {
    const gone = {
      bare: await row("jakob2"),
      savedClub: await row("jakob3"),
      emptyCoach: await row("Coach Test"),
    };
    await db.insert(venues).values({ creatorPlayerId: gone.savedClub.id, name: "Rawai Padel" });
    const empty = await coach(gone.emptyCoach.id, "coach-test");

    const organiser = await row("Org", { email: "org@example.com" });
    const kept = {
      young: await row("new visitor", {}, young),
      email: await row("with email", { email: "a@example.com" }),
      recovery: await row("with recovery", { recoveryEmail: "r@example.com" }),
      phone: await row("with phone", { phone: "+66800000000" }),
      telegram: await row("with telegram", { telegramId: 424242 }),
      publicProfile: await row("public", { publicProfile: true }),
      player: await row("played"),
      note: await row("wrote a note"),
      want: await row("wants a game"),
      teacher: await row("Coach With Lesson"),
      verifier: await row("confirmed a level"),
    };
    const ev = await createEvent(db, { creatorPlayerId: organiser.id, type: "match", startsAt: new Date(NOW.getTime() + DAY), tz: "Asia/Bangkok", whenFull: "closed" });
    await joinEvent(db, { eventId: ev.id, playerId: kept.player.id, now: NOW });
    await db.insert(feedback).values({ source: "web", playerId: kept.note.id, text: "The score form is hard to find" });
    await db.insert(demandSignals).values({ playerId: kept.want.id, weekday: 2, fromTime: "14:00", toTime: "16:00", expiresAt: new Date(NOW.getTime() + 30 * DAY) });
    const teaching = await coach(kept.teacher.id, "coach-lesson");
    // Any lesson, even a cancelled one: a real student once booked this coach.
    await db.insert(lessons).values({ coachId: teaching.id, studentPlayerId: organiser.id, startsAt: new Date(NOW.getTime() - 3 * DAY), minutes: 60, status: "cancelled", amount: 800 });
    await db.update(players).set({ levelVerifiedBy: kept.verifier.id }).where(eq(players.id, organiser.id));

    const preview = await findDisposablePlayers(db, NOW);
    expect(preview.map((p) => p.displayName).sort()).toEqual(["Coach Test", "jakob2", "jakob3"]);

    const removed = await removeDisposablePlayers(db, NOW);
    expect(removed.map((p) => p.id).sort()).toEqual(Object.values(gone).map((p) => p.id).sort());
    // Their own belongings went with them: the saved club and the coach page nobody ever booked.
    expect(await db.select().from(venues).where(eq(venues.creatorPlayerId, gone.savedClub.id))).toHaveLength(0);
    expect(await db.select().from(coaches).where(eq(coaches.id, empty.id))).toHaveLength(0);

    const left = await db.select({ id: players.id }).from(players).where(inArray(players.id, [organiser.id, ...Object.values(kept).map((p) => p.id)]));
    expect(left).toHaveLength(Object.keys(kept).length + 1);
    // A second run finds nothing more: the job is safe to repeat.
    expect(await removeDisposablePlayers(db, NOW)).toEqual([]);
  });

  it("runs once a day, from the first hourly run after 03:00 UTC", async () => {
    // 01:00 and 03:30 UTC on 25 September; the rows were made old against NOW, a day earlier.
    const night = new Date(Date.UTC(2026, 8, 25, 1, 0));
    const morning = new Date(Date.UTC(2026, 8, 25, 3, 30));
    const p = await row("jakob9");
    expect(await removeDisposableDaily(db, night)).toBeNull();
    expect((await removeDisposableDaily(db, morning))?.map((x) => x.id)).toEqual([p.id]);
    await row("jakob10");
    expect(await removeDisposableDaily(db, new Date(morning.getTime() + 3600 * 1000)), "the second run that day does nothing").toBeNull();
  });
});
