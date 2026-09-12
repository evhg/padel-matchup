import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freezeClock } from "./helpers/clock";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events, type Series } from "@/db/schema";
import { cityBySlug } from "@/lib/domain/cities";
import { createEvent } from "@/lib/domain/events";
import { autoCreateSeriesEditions, createSeriesFromEvent, listSeries, nextEdition, nextEditionAt, nthWeekdayOf, seriesDue, seriesPage, seriesSlugBase, setSeriesActive } from "@/lib/domain/series";
import { joinEvent, reserveSlot } from "@/lib/domain/slots";
import { createTestDb, DAY, HOUR, makePlayer } from "./helpers/db";

const TZ = "Asia/Bangkok";
/** Tuesday 8 September 2026, 16:00 in Phuket. */
const NOW = new Date("2026-09-08T09:00:00Z");
freezeClock(NOW);
/** Saturday 5 September 2026, 09:00 in Phuket. */
const SAT_5 = new Date("2026-09-05T02:00:00Z");
const week = { dow: 6, time: "09:00", every: "week" as const, nth: null, tz: TZ, anchorAt: SAT_5 };

describe("the rhythm of a series", () => {
  it("knows which weekday of the month a date is, with 5 for the last one", () => {
    expect(nthWeekdayOf(new Date("2026-09-05T02:00:00Z"), TZ)).toBe(1);
    expect(nthWeekdayOf(new Date("2026-09-19T02:00:00Z"), TZ)).toBe(3);
    expect(nthWeekdayOf(new Date("2026-09-26T02:00:00Z"), TZ)).toBe(5); // fourth and last Saturday of September
    expect(nthWeekdayOf(new Date("2026-10-24T02:00:00Z"), TZ)).toBe(4); // October has a fifth Saturday
    expect(nthWeekdayOf(new Date("2026-10-31T02:00:00Z"), TZ)).toBe(5);
  });

  it("finds the next edition every week, every other week and once a month", () => {
    expect(nextEditionAt(week, NOW).toISOString()).toBe("2026-09-12T02:00:00.000Z");
    const fortnight = { ...week, every: "fortnight" as const };
    expect(nextEditionAt(fortnight, NOW).toISOString()).toBe("2026-09-19T02:00:00.000Z");
    expect(nextEditionAt(fortnight, new Date("2026-09-13T09:00:00Z")).toISOString()).toBe("2026-09-19T02:00:00.000Z");
    expect(nextEditionAt(fortnight, new Date("2026-09-20T09:00:00Z")).toISOString()).toBe("2026-10-03T02:00:00.000Z");
    const firstSat = { ...week, every: "month" as const, nth: 1 };
    expect(nextEditionAt(firstSat, NOW).toISOString()).toBe("2026-10-03T02:00:00.000Z");
    const lastSat = { ...week, every: "month" as const, nth: 5, anchorAt: new Date("2026-09-26T02:00:00Z") };
    expect(nextEditionAt(lastSat, NOW).toISOString()).toBe("2026-09-26T02:00:00.000Z");
    expect(nextEditionAt(lastSat, new Date("2026-09-27T09:00:00Z")).toISOString()).toBe("2026-10-31T02:00:00.000Z");
    // Half an hour before the start it is no longer "next".
    expect(nextEditionAt(week, new Date("2026-09-12T01:45:00Z")).toISOString()).toBe("2026-09-19T02:00:00.000Z");
  });

  it("is due inside the lead days, once, and never while paused", () => {
    const s = { ...week, active: true, leadDays: 6, lastCreatedFor: null };
    expect(seriesDue(s, NOW)?.toISOString()).toBe("2026-09-12T02:00:00.000Z");
    expect(seriesDue(s, new Date("2026-09-05T03:00:00Z"))).toBeNull(); // the 12th is seven days away
    expect(seriesDue({ ...s, lastCreatedFor: new Date("2026-09-12T02:00:00Z") }, NOW)).toBeNull();
    expect(seriesDue({ ...s, active: false }, NOW)).toBeNull();
  });
});

describe("a series from a finished tournament", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await createTestDb()));
  afterAll(() => close());

  async function finishedTournament(organizerId: string, playerIds: string[], startsAt = SAT_5, venueName = "Rawai Padel") {
    const ev = await createEvent(db, { creatorPlayerId: organizerId, type: "tournament", title: null, startsAt, tz: TZ, venueName, capacity: 8, whenFull: "waitlist", format: "americano", levelMin: 3, levelMax: 4.5, cost: "400 ฿", publicListing: false });
    for (const id of playerIds) await joinEvent(db, { eventId: ev.id, playerId: id, now: new Date(startsAt.getTime() - DAY) });
    await db.update(events).set({ scoreLockedByCreator: true, standings: playerIds.slice(0, 4), status: "past" }).where(eq(events.id, ev.id));
    return ev;
  }

  it("copies the template, marks the source, creates the next edition at once and lists the podium", async () => {
    const org = await makePlayer(db, "Org", { level: 4 });
    const names = ["Ana", "Bo", "Cy", "Di"];
    const ids = [org.id, ...(await Promise.all(names.map((n) => makePlayer(db, n, { level: 3.5 })))).map((p) => p.id)];
    const source = await finishedTournament(org.id, ids);

    const { series: s, next } = await createSeriesFromEvent(db, { eventId: source.id, organizerPlayerId: org.id, name: "  Rawai Saturday Open ", every: "week", now: NOW });
    expect(s).toMatchObject({ slug: "rawai-saturday-open", name: "Rawai Saturday Open", dow: 6, time: "09:00", every: "week", nth: null, leadDays: 6, venueName: "Rawai Padel", venueSlug: "rawai-padel", capacity: 8, levelMin: 3, levelMax: 4.5, cost: "400 ฿", active: true });
    expect(s.anchorAt.toISOString()).toBe(SAT_5.toISOString());
    expect(next).toMatchObject({ type: "tournament", title: "Rawai Saturday Open", publicListing: true, seriesId: s.id, capacity: 8, venueName: "Rawai Padel", cost: "400 ฿" });
    expect(next.startsAt.toISOString()).toBe("2026-09-12T02:00:00.000Z");
    const [src] = await db.select().from(events).where(eq(events.id, source.id));
    expect(src.seriesId).toBe(s.id);

    const page = await seriesPage(db, s, NOW);
    expect(page.organizerName).toBe("Org");
    expect(page.editions).toBe(2);
    expect(page.next?.event.id).toBe(next.id);
    expect(page.next?.spotsLeft).toBe(8); // nobody is seated by default; the organizer signs up like everyone else
    expect(page.past.map((e) => e.event.id)).toEqual([source.id]);
    expect(page.past[0].podium.map((p) => `${p.rank} ${p.name}`)).toEqual(["1 Org", "2 Ana", "3 Bo"]);

    // The same tournament cannot start a second series; someone else cannot start one from it; a match cannot either.
    await expect(createSeriesFromEvent(db, { eventId: source.id, organizerPlayerId: org.id, name: "Again", every: "week", now: NOW })).rejects.toThrow("already_a_series");
    const other = await makePlayer(db, "Other");
    const theirs = await finishedTournament(org.id, ids, new Date("2026-09-06T02:00:00Z"));
    await expect(createSeriesFromEvent(db, { eventId: theirs.id, organizerPlayerId: other.id, name: "Mine", every: "week", now: NOW })).rejects.toThrow("organizer");
    const match = await createEvent(db, { creatorPlayerId: org.id, type: "match", title: null, startsAt: SAT_5, tz: TZ, venueName: "Rawai Padel", capacity: 4, whenFull: "waitlist" });
    await expect(createSeriesFromEvent(db, { eventId: match.id, organizerPlayerId: org.id, name: "Nope", every: "week", now: NOW })).rejects.toThrow("not_a_tournament");
    await expect(createSeriesFromEvent(db, { eventId: theirs.id, organizerPlayerId: org.id, name: "X", every: "week", now: NOW })).rejects.toThrow("name");

    // A second series with the same name gets the next slug.
    const { series: s2 } = await createSeriesFromEvent(db, { eventId: theirs.id, organizerPlayerId: org.id, name: "Rawai Saturday Open", every: "month", now: NOW });
    expect(s2.slug).toBe("rawai-saturday-open-2");
    expect(s2).toMatchObject({ every: "month", nth: 1, leadDays: 21, dow: 0 });

    // The organizer sets the field size for the editions; a size that is not in fours is refused.
    const third = await finishedTournament(org.id, ids, new Date("2026-09-07T02:00:00Z"));
    const { series: s3, next: n3 } = await createSeriesFromEvent(db, { eventId: third.id, organizerPlayerId: org.id, name: "Big Monday", every: "week", capacity: 12, now: NOW });
    expect(s3.capacity).toBe(12);
    expect(n3.capacity).toBe(12);
    const fourth = await finishedTournament(org.id, ids, new Date("2026-09-08T02:00:00Z"));
    await expect(createSeriesFromEvent(db, { eventId: fourth.id, organizerPlayerId: org.id, name: "Odd", every: "week", capacity: 10, now: NOW })).rejects.toThrow();

    // Only a finished tournament: no standings, or cancelled, is refused on the server, not only hidden on the page.
    const unfinished = await createEvent(db, { creatorPlayerId: org.id, type: "tournament", title: null, startsAt: SAT_5, tz: TZ, venueName: "Rawai Padel", capacity: 8, whenFull: "waitlist" });
    await expect(createSeriesFromEvent(db, { eventId: unfinished.id, organizerPlayerId: org.id, name: "Too soon", every: "week", now: NOW })).rejects.toThrow("not_finished");
    await db.update(events).set({ standings: [org.id], status: "cancelled" }).where(eq(events.id, unfinished.id));
    await expect(createSeriesFromEvent(db, { eventId: unfinished.id, organizerPlayerId: org.id, name: "Too late", every: "week", now: NOW })).rejects.toThrow("not_finished");
  });

  it("counts reserved names as taken, keeps a running edition current, and transliterates a Russian name", async () => {
    const org = await makePlayer(db, "Seat", { level: 4 });
    const ids = [org.id, ...(await Promise.all(["Hal", "Ira", "Jo"].map((n) => makePlayer(db, n)))).map((p) => p.id)];
    const source = await finishedTournament(org.id, ids, SAT_5, "Kata Padel");
    const { series: s, next } = await createSeriesFromEvent(db, { eventId: source.id, organizerPlayerId: org.id, name: "Открытый турнир Ката", every: "week", now: NOW });
    expect(s.slug).toBe("otkrytyy-turnir-kata");
    expect(s.lastCreatedFor?.toISOString()).toBe(next.startsAt.toISOString());
    // Two reserved names and one join: the board and the series page agree on five seats left of eight.
    await reserveSlot(db, { eventId: next.id, actorPlayerId: org.id, name: "Kim", now: NOW });
    await reserveSlot(db, { eventId: next.id, actorPlayerId: org.id, name: "Lou", now: NOW });
    await joinEvent(db, { eventId: next.id, playerId: ids[1], now: NOW });
    expect((await seriesPage(db, s, NOW)).next?.spotsLeft).toBe(5);
    // Half an hour into the edition it is still the current one, not a past one without a podium.
    const running = new Date(next.startsAt.getTime() + 30 * 60_000);
    const page = await seriesPage(db, s, running);
    expect(page.next?.event.id).toBe(next.id);
    expect(page.past.map((e) => e.event.id)).toEqual([source.id]);
    expect((await nextEdition(db, s.id, running))?.id).toBe(next.id);
    expect((await listSeries(db, null, running)).find((r) => r.series.id === s.id)?.next?.id).toBe(next.id);
    // A finalized edition is over even inside its two hours: the source, finished an hour ago, sits under past.
    const early = await createEvent(db, { creatorPlayerId: org.id, type: "tournament", title: null, startsAt: new Date(NOW.getTime() - HOUR), tz: TZ, venueName: "Kata Padel", capacity: 8, whenFull: "waitlist" });
    await db.update(events).set({ scoreLockedByCreator: true, standings: [org.id] }).where(eq(events.id, early.id));
    const { series: fresh, next: freshNext } = await createSeriesFromEvent(db, { eventId: early.id, organizerPlayerId: org.id, name: "Fresh", every: "week", now: NOW });
    const freshPage = await seriesPage(db, fresh, NOW);
    expect(freshPage.next?.event.id).toBe(freshNext.id);
    expect(freshPage.past.map((e) => e.event.id)).toEqual([early.id]);
    expect((await nextEdition(db, fresh.id, NOW))?.id).toBe(freshNext.id);
    // Three hours later it is over: no current edition until the job makes the next one.
    const over = new Date(next.startsAt.getTime() + 3 * HOUR);
    expect((await seriesPage(db, s, over)).next).toBeNull();
    expect(seriesSlugBase("!!!", { venueName: "Kata Padel", startsAt: SAT_5, tz: TZ })).toBe("kata-padel-saturday-open");
  });

  it("holds five per organizer, on creation and on resume, and lists paused series for the sitemap only", async () => {
    const org = await makePlayer(db, "Busy", { level: 4 });
    const ids = [org.id, ...(await Promise.all(["Mo", "Ned", "Oz"].map((n) => makePlayer(db, n)))).map((p) => p.id)];
    const made: Series[] = [];
    for (let i = 0; i < 5; i++) {
      const src = await finishedTournament(org.id, ids, new Date(SAT_5.getTime() + i * HOUR), `Court ${i}`);
      made.push((await createSeriesFromEvent(db, { eventId: src.id, organizerPlayerId: org.id, name: `Series ${i}`, every: "week", now: NOW })).series);
    }
    const sixth = await finishedTournament(org.id, ids, new Date(SAT_5.getTime() + 6 * HOUR), "Court 6");
    await expect(createSeriesFromEvent(db, { eventId: sixth.id, organizerPlayerId: org.id, name: "Series 6", every: "week", now: NOW })).rejects.toThrow("too_many");
    await setSeriesActive(db, { slug: made[0].slug, organizerPlayerId: org.id, active: false });
    await createSeriesFromEvent(db, { eventId: sixth.id, organizerPlayerId: org.id, name: "Series 6", every: "week", now: NOW });
    await expect(setSeriesActive(db, { slug: made[0].slug, organizerPlayerId: org.id, active: true })).rejects.toThrow("too_many");
    const listed = await listSeries(db, null, NOW);
    expect(listed.some((r) => r.series.id === made[0].id)).toBe(false);
    expect((await listSeries(db, null, NOW, { includePaused: true })).some((r) => r.series.id === made[0].id)).toBe(true);
  });

  it("makes the following editions from the hourly job, once each, not while paused, and lists by city", async () => {
    const org = await makePlayer(db, "Cron", { level: 4 });
    const ids = [org.id, ...(await Promise.all(["Ed", "Fay", "Gus"].map((n) => makePlayer(db, n)))).map((p) => p.id)];
    const source = await finishedTournament(org.id, ids, SAT_5, "Chalong Arena");
    const { series: s, next } = await createSeriesFromEvent(db, { eventId: source.id, organizerPlayerId: org.id, name: "Chalong Weekly", every: "week", now: NOW });
    expect(next.startsAt.toISOString()).toBe("2026-09-12T02:00:00.000Z");

    // Nothing more is due today: the 12th exists.
    expect((await autoCreateSeriesEditions(db, NOW)).filter((r) => r.series.id === s.id)).toHaveLength(0);
    // The day after the 12th, the 19th is six days away: one edition, and only one.
    const later = new Date("2026-09-13T09:00:00Z");
    const made = (await autoCreateSeriesEditions(db, later)).filter((r) => r.series.id === s.id);
    expect(made).toHaveLength(1);
    expect(made[0].event.startsAt.toISOString()).toBe("2026-09-19T02:00:00.000Z");
    expect(made[0].event).toMatchObject({ publicListing: true, seriesId: s.id, title: "Chalong Weekly" });
    expect((await autoCreateSeriesEditions(db, new Date(later.getTime() + HOUR))).filter((r) => r.series.id === s.id)).toHaveLength(0);

    // Paused: the week after, nothing; resumed, the job catches up.
    await setSeriesActive(db, { slug: s.slug, organizerPlayerId: org.id, active: false });
    const weekAfter = new Date("2026-09-20T09:00:00Z");
    expect((await autoCreateSeriesEditions(db, weekAfter)).filter((r) => r.series.id === s.id)).toHaveLength(0);
    await expect(setSeriesActive(db, { slug: s.slug, organizerPlayerId: ids[1], active: true })).rejects.toThrow("organizer");
    await setSeriesActive(db, { slug: s.slug, organizerPlayerId: org.id, active: true });
    const caughtUp = (await autoCreateSeriesEditions(db, weekAfter)).filter((r) => r.series.id === s.id);
    expect(caughtUp.map((r) => r.event.startsAt.toISOString())).toEqual(["2026-09-26T02:00:00.000Z"]);

    // The city list carries Phuket series with their next edition; a Madrid series stays out.
    const phuket = cityBySlug("phuket")!;
    const listed = await listSeries(db, phuket, weekAfter);
    const mine = listed.find((r) => r.series.id === s.id);
    expect(mine?.next?.startsAt.toISOString()).toBe("2026-09-26T02:00:00.000Z");
    const far = await makePlayer(db, "Far");
    const farEv = await createEvent(db, { creatorPlayerId: far.id, type: "tournament", title: null, startsAt: new Date("2026-09-05T07:00:00Z"), tz: "Europe/Madrid", venueName: "Club Norte", capacity: 8, whenFull: "waitlist" });
    await db.update(events).set({ standings: [far.id], status: "past" }).where(eq(events.id, farEv.id));
    const { series: madrid } = await createSeriesFromEvent(db, { eventId: farEv.id, organizerPlayerId: far.id, name: "Norte Open", every: "fortnight", now: NOW });
    expect((await listSeries(db, phuket, weekAfter)).some((r) => r.series.id === madrid.id)).toBe(false);
    expect((await listSeries(db, null, weekAfter)).some((r) => r.series.id === madrid.id)).toBe(true);
  });
});
