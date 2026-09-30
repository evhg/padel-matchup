import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { events } from "@/db/schema";
import { createMatch, NO_SIDE_EFFECTS } from "@/lib/api/operations";
import { matchToPublic } from "@/lib/api/serialize";
import { buildFeed, buildIcs, googleCalendarUrl, type CalendarEvent } from "@/lib/calendar";
import { materialKey } from "@/lib/channels/cards";
import { clubBusy } from "@/lib/domain/courts";
import { createEvent, duplicateEvent, updateEvent } from "@/lib/domain/events";
import { autoCreateGroupMatches, createGroup, updateGroup } from "@/lib/domain/groups";
import { DEFAULT_MATCH_LENGTH, DEFAULT_TOURNAMENT_LENGTH, defaultLength, durationMs, eventEnd, isOver, MATCH_LENGTHS, parseMatchLength } from "@/lib/domain/matchLength";
import { getEventByCode } from "@/lib/domain/queries";
import { pastPartners } from "@/lib/domain/refill";
import { findScoreRemindersDue, isScoreReminderDue, shouldBePast, transitionPastEvents } from "@/lib/domain/reminders";
import { autoCreateSeriesEditions, createSeriesFromEvent, nextEdition } from "@/lib/domain/series";
import { joinEvent } from "@/lib/domain/slots";
import { notifyEventUpdated } from "@/lib/notify";
import { renderCard, whenLine } from "@/lib/telegram/card";
import { freezeClock } from "./helpers/clock";
import { createTestDb, DAY, HOUR, makePlayer } from "./helpers/db";

/**
 * How long a match lasts. Erik, 25 September 2026, from his match page: "is the game 60min or 90min?
 * I can't tell. The calendar invite sent out is 2h I think, but I think the booking app shows 90min".
 * Every event ended two hours after its start. The owner decided on 30 September 2026: the organiser
 * picks 60, 90 or 120 minutes, 90 by default, and the page, the cards and the invitation all say it.
 * These are the rule, the places that say it, and every reader that asks "is it over?".
 */
const NOW = new Date("2026-09-30T09:00:00.000Z");
freezeClock(NOW);
const MIN = 60_000;
/** Saturday 3 October 2026, 09:30 in Phuket (02:30 UTC). */
const SAT = new Date("2026-10-03T02:30:00.000Z");
const TZ = "Asia/Bangkok";

describe("the rule", () => {
  it("takes 60, 90 and 120, as numbers or as their digits, and refuses everything else", () => {
    expect(MATCH_LENGTHS).toEqual([60, 90, 120]);
    for (const m of MATCH_LENGTHS) {
      expect(parseMatchLength(m)).toBe(m);
      expect(parseMatchLength(String(m))).toBe(m);
    }
    // Refused, never rounded: an organiser who asked for 75 hears no rather than finding 90 on the page.
    for (const bad of [0, 30, 45, 59, 61, 75, 89, 91, 100, 119, 121, 150, 180, 90.5, -90, Number.NaN, Number.POSITIVE_INFINITY, "90min", "ninety", "9 0", "", null, undefined, {}, [90], true]) {
      expect(parseMatchLength(bad), String(bad)).toBeNull();
    }
  });

  it("gives a match 90 minutes and a tournament 120 when nobody says", () => {
    expect(DEFAULT_MATCH_LENGTH).toBe(90);
    expect(DEFAULT_TOURNAMENT_LENGTH).toBe(120);
    expect(defaultLength("match")).toBe(90);
    expect(defaultLength("tournament")).toBe(120);
  });

  it("ends a match its own length after the start, and the end itself is over", () => {
    const ends = { 60: "2026-10-03T03:30:00.000Z", 90: "2026-10-03T04:00:00.000Z", 120: "2026-10-03T04:30:00.000Z" } as const;
    for (const m of MATCH_LENGTHS) {
      const ev = { startsAt: SAT, durationMinutes: m };
      expect(durationMs(ev)).toBe(m * MIN);
      expect(eventEnd(ev).toISOString()).toBe(ends[m]);
      expect(isOver(ev, new Date(eventEnd(ev).getTime() - 1))).toBe(false);
      expect(isOver(ev, eventEnd(ev))).toBe(true);
    }
  });
});

describe("the calendar entry ends when the match does", () => {
  const ev = (durationMinutes: number): CalendarEvent => ({ id: "11111111-1111-1111-1111-111111111111", code: "LEN1", title: "Saturday padel", startsAt: SAT, durationMinutes, venueName: "Rawai Padel", venueMapUrl: null, court: null, note: null, type: "match", icsSequence: 0, status: "open" });
  const line = (ics: string, name: string) => ics.split("\r\n").find((l) => l.startsWith(`${name}:`));
  const ENDS = { 60: "20261003T033000Z", 90: "20261003T040000Z", 120: "20261003T043000Z" } as const;

  it("in the emailed invitation, for 60, 90 and 120 minutes", () => {
    for (const m of MATCH_LENGTHS) {
      const ics = buildIcs({ event: ev(m), title: "Saturday padel", url: "https://kicksma.sh/LEN1", organizer: { name: "Org", email: "org@example.com" }, method: "REQUEST", domain: "kicksma.sh" });
      expect(line(ics, "DTSTART")).toBe("DTSTART:20261003T023000Z");
      expect(line(ics, "DTEND")).toBe(`DTEND:${ENDS[m]}`);
    }
  });

  it("in the player's feed, for 60, 90 and 120 minutes", () => {
    const feed = buildFeed({ name: "Mine", domain: "kicksma.sh", entries: MATCH_LENGTHS.map((m, i) => ({ event: { ...ev(m), id: `${i}1111111-1111-1111-1111-111111111111` }, title: `${m}`, url: "https://kicksma.sh/LEN1" })) });
    expect(feed.split("\r\n").filter((l) => l.startsWith("DTEND:"))).toEqual(MATCH_LENGTHS.map((m) => `DTEND:${ENDS[m]}`));
  });

  it("in the Google Calendar link", () => {
    const url = new URL(googleCalendarUrl(ev(60), { title: "x", url: "https://kicksma.sh/LEN1", tz: TZ }));
    expect(url.searchParams.get("dates")).toBe("20261003T023000Z/20261003T033000Z");
  });
});

describe("the organiser's choice, and every reader of it", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await createTestDb()));
  afterAll(() => close());

  const match = (creatorPlayerId: string, startsAt: Date, durationMinutes?: number, venueName = "Rawai Padel") => createEvent(db, { creatorPlayerId, type: "match", startsAt, durationMinutes, tz: TZ, venueName, whenFull: "waitlist" });

  it("creates with the length picked, 90 for a match and 120 for a tournament when none is, and refuses a length that is not one of the three", async () => {
    const org = await makePlayer(db, "Org");
    expect((await match(org.id, SAT)).durationMinutes).toBe(90);
    expect((await match(org.id, SAT, 60)).durationMinutes).toBe(60);
    expect((await match(org.id, SAT, 120)).durationMinutes).toBe(120);
    expect((await createEvent(db, { creatorPlayerId: org.id, type: "tournament", startsAt: SAT, tz: TZ, capacity: 8, whenFull: "waitlist" })).durationMinutes).toBe(120);
    expect((await createEvent(db, { creatorPlayerId: org.id, type: "tournament", startsAt: SAT, durationMinutes: 90, tz: TZ, capacity: 8, whenFull: "waitlist" })).durationMinutes).toBe(90);
    await expect(match(org.id, SAT, 75)).rejects.toMatchObject({ code: "invalid" });
  });

  it("takes the length through the API and gives it back on the match object, with the end", async () => {
    const r = await createMatch(db, { startsAt: "2026-10-03T09:30", tz: TZ, durationMinutes: 60, venue: "Rawai Padel", organizer: { name: "Ana" } }, NO_SIDE_EFFECTS);
    expect(r.match.durationMinutes).toBe(60);
    expect(r.match.startsAt).toBe("2026-10-03T02:30:00.000Z");
    expect(r.match.endsAt).toBe("2026-10-03T03:30:00.000Z");
    const plain = await createMatch(db, { startsAt: "2026-10-03T09:30", tz: TZ, organizer: { name: "Bo" } }, NO_SIDE_EFFECTS);
    expect(plain.match.durationMinutes).toBe(90);
    expect(plain.match.endsAt).toBe("2026-10-03T04:00:00.000Z");
    await expect(createMatch(db, { startsAt: "2026-10-03T09:30", tz: TZ, durationMinutes: 75, organizer: { name: "Cy" } }, NO_SIDE_EFFECTS)).rejects.toThrow();
    const detail = (await getEventByCode(db, r.match.code))!;
    expect(matchToPublic(detail, "https://kicksma.sh")).toMatchObject({ durationMinutes: 60, endsAt: "2026-10-03T03:30:00.000Z" });
  });

  it("a change of length alone bumps SEQUENCE and sends the updated invitation, as a time change does", async () => {
    const sinkFile = path.join(mkdtempSync(path.join(tmpdir(), "length-")), "mail.jsonl");
    process.env.RESEND_API_KEY = "re_test_only";
    process.env.EMAIL_SINK_FILE = sinkFile;
    const org = await makePlayer(db, "Erik");
    const eva = await makePlayer(db, "Eva", { email: "eva@example.com" });
    const ev = await match(org.id, SAT);
    await joinEvent(db, { eventId: ev.id, playerId: eva.id });
    const before = (await db.select().from(events).where(eq(events.id, ev.id)))[0];

    const changed = await updateEvent(db, ev.id, org.id, { durationMinutes: 60 });
    expect(changed.calendarChanged).toBe(true);
    expect(changed.event.durationMinutes).toBe(60);
    expect(changed.event.icsSequence).toBe(before.icsSequence + 1);
    expect(changed.event.startsAt.toISOString()).toBe(SAT.toISOString());

    await notifyEventUpdated(db, changed.event);
    const mails = readFileSync(sinkFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { to: string; ics: { method: string; content: string } | null });
    const toEva = mails.find((m) => m.to === "eva@example.com");
    expect(toEva?.ics?.method).toBe("REQUEST");
    const ics = toEva!.ics!.content;
    expect(ics).toContain(`SEQUENCE:${before.icsSequence + 1}`);
    expect(ics).toContain("DTSTART:20261003T023000Z");
    expect(ics).toContain("DTEND:20261003T033000Z");

    // The same length again changes nothing and sends nothing; a length that is not one of the three is refused.
    const same = await updateEvent(db, ev.id, org.id, { durationMinutes: 60 });
    expect(same.calendarChanged).toBe(false);
    expect(same.event.icsSequence).toBe(before.icsSequence + 1);
    await expect(updateEvent(db, ev.id, org.id, { durationMinutes: 45 })).rejects.toMatchObject({ code: "invalid" });
  });

  it("says the end on the cards: the when-line and the Telegram card read 09:30–10:30 for an hour", async () => {
    const org = await makePlayer(db, "Card");
    const ev = await match(org.id, SAT, 60);
    const detail = (await getEventByCode(db, ev.code))!;
    expect(whenLine(detail, "en")).toMatch(/ · 09:30–10:30$/);
    expect(renderCard(detail, "https://kicksma.sh", "en", NOW).text).toContain("09:30–10:30");
  });

  it("keeps the key of every LINE card already sent, and changes it when the length leaves the default", async () => {
    const org = await makePlayer(db, "Line");
    const ev = await match(org.id, SAT);
    const detail = (await getEventByCode(db, ev.code))!;
    // The key as it was before lengths existed: a card sent then must not be pushed again for nothing.
    const old = createHash("sha256").update([ev.status, ev.startsAt.toISOString(), ev.venueSlug ?? "", ev.capacity, 0, 0].join("|")).digest("hex");
    expect(materialKey(detail)).toBe(old);
    expect(materialKey({ ...detail, event: { ...detail.event, durationMinutes: 60 } })).not.toBe(old);
  });

  it("finishes a match, and asks for its score, when its own length runs out", async () => {
    const org = await makePlayer(db, "Past", { email: "past@example.com" });
    // All three started seventy minutes ago.
    const started = new Date(NOW.getTime() - 70 * MIN);
    const hour = await match(org.id, started, 60);
    const ninety = await match(org.id, started, 90);
    const two = await match(org.id, started, 120);
    expect(shouldBePast(hour, NOW)).toBe(true);
    expect(shouldBePast(ninety, NOW)).toBe(false);
    expect(isScoreReminderDue({ ...hour, scoreReminderSent: false }, false, NOW)).toBe(true);
    expect(isScoreReminderDue({ ...ninety, scoreReminderSent: false }, false, NOW)).toBe(false);

    const due = (await findScoreRemindersDue(db, NOW)).map((d) => d.event.id);
    expect(due).toContain(hour.id);
    expect(due).not.toContain(ninety.id);
    expect(due).not.toContain(two.id);
    // Twenty-five minutes on, the 90-minute match is over too; the two-hour one is still being played.
    const later = (await findScoreRemindersDue(db, new Date(NOW.getTime() + 25 * MIN))).map((d) => d.event.id);
    expect(later).toContain(ninety.id);
    expect(later).not.toContain(two.id);

    await transitionPastEvents(db, NOW);
    const status = async (id: string) => (await db.select({ s: events.status }).from(events).where(eq(events.id, id)))[0].s;
    expect(await status(hour.id)).toBe("past");
    expect(await status(ninety.id)).toBe("open");
    expect(await status(two.id)).toBe("open");
  });

  it("takes a join until the match's own length has run out", async () => {
    const org = await makePlayer(db, "Joins");
    const late = await makePlayer(db, "Late");
    const started = new Date(NOW.getTime() - 61 * MIN);
    const hour = await match(org.id, started, 60);
    const two = await match(org.id, started, 120);
    await expect(joinEvent(db, { eventId: hour.id, playerId: late.id, now: NOW })).rejects.toMatchObject({ code: "past" });
    expect((await joinEvent(db, { eventId: two.id, playerId: late.id, now: NOW })).outcome).toBe("joined");
  });

  it("makes past partners of a match once its own length has run out, not two hours after it started", async () => {
    const [ana, bo, cy, di] = await Promise.all(["Ana P", "Bo P", "Cy P", "Di P"].map((n) => makePlayer(db, n)));
    const started = new Date(NOW.getTime() - 70 * MIN);
    const seat = async (evId: string, ...ps: { id: string }[]) => {
      for (const p of ps) await joinEvent(db, { eventId: evId, playerId: p.id, now: new Date(started.getTime() - HOUR) });
    };
    // Ana and Bo played an hour, which is over; Cy and Di booked two, and are still on court.
    await seat((await match(ana.id, started, 60)).id, ana, bo);
    await seat((await match(cy.id, started, 120)).id, cy, di);
    const next = await match(ana.id, new Date(NOW.getTime() + DAY));
    await seat(next.id, ana, cy);
    expect(await pastPartners(db, next, NOW)).toEqual([bo.id]);
  });

  it("holds a club's court for the length the match booked", async () => {
    const org = await makePlayer(db, "Court");
    await match(org.id, SAT, 60, "Length Club");
    const busy = await clubBusy(db, "length-club", new Date(SAT.getTime() - HOUR), new Date(SAT.getTime() + HOUR));
    expect(busy.map((b) => b.minutes)).toEqual([60]);
  });

  it("plays again for as long as before", async () => {
    const org = await makePlayer(db, "Again");
    const ev = await match(org.id, SAT, 60);
    expect((await duplicateEvent(db, { sourceEventId: ev.id, creatorPlayerId: org.id, now: NOW })).durationMinutes).toBe(60);
  });

  it("gives a group's next match the length of its latest one", async () => {
    const admin = await makePlayer(db, "Weekly length");
    const g0 = await createGroup(db, { name: "Hour on Thursdays", creatorPlayerId: admin.id, tz: "UTC", venueName: "Court 9" });
    const g = await updateGroup(db, g0.id, admin.id, { recurDow: 4, recurTime: "19:00", recurLeadDays: 5 });
    const monday = new Date("2026-10-05T10:00:00Z");
    const [first] = (await autoCreateGroupMatches(db, monday)).filter((c) => c.group.id === g.id);
    expect(first.event.durationMinutes).toBe(90);
    await updateEvent(db, first.event.id, admin.id, { durationMinutes: 60 });
    const [second] = (await autoCreateGroupMatches(db, new Date(monday.getTime() + 7 * DAY))).filter((c) => c.group.id === g.id);
    expect(second.event.durationMinutes).toBe(60);
  });

  it("runs a series' editions as long as the one before, and an edition is current while its own length lasts", async () => {
    const org = await makePlayer(db, "Open org", { level: 4 });
    const ids = [org.id, ...(await Promise.all(["Ed", "Fi", "Gus", "Hal"].map((n) => makePlayer(db, n, { level: 3.5 })))).map((p) => p.id)];
    /** Saturday 26 September 2026, 09:00 in Phuket: a finished 90-minute americano. */
    const sat26 = new Date("2026-09-26T02:00:00Z");
    const source = await createEvent(db, { creatorPlayerId: org.id, type: "tournament", startsAt: sat26, durationMinutes: 90, tz: TZ, venueName: "Series Club", capacity: 8, whenFull: "waitlist", format: "americano" });
    for (const id of ids) await joinEvent(db, { eventId: source.id, playerId: id, now: new Date(sat26.getTime() - DAY) });
    await db.update(events).set({ scoreLockedByCreator: true, standings: ids.slice(0, 4), status: "past" }).where(eq(events.id, source.id));

    const { series: s, next } = await createSeriesFromEvent(db, { eventId: source.id, organizerPlayerId: org.id, name: "Length Open", every: "week", now: NOW });
    expect(next.startsAt.toISOString()).toBe("2026-10-03T02:00:00.000Z");
    expect(next.durationMinutes).toBe(90);
    // Eighty minutes in it is still the current edition; ninety-five minutes in it is over, even though two hours have not passed.
    expect((await nextEdition(db, s.id, new Date(next.startsAt.getTime() + 80 * MIN)))?.id).toBe(next.id);
    expect(await nextEdition(db, s.id, new Date(next.startsAt.getTime() + 95 * MIN))).toBeNull();

    // The organiser makes the coming one an hour; the edition after it follows.
    await updateEvent(db, next.id, org.id, { durationMinutes: 60 });
    const made = await autoCreateSeriesEditions(db, new Date("2026-10-04T03:00:00Z"));
    const edition = made.find((m) => m.series.id === s.id)?.event;
    expect(edition?.startsAt.toISOString()).toBe("2026-10-10T02:00:00.000Z");
    expect(edition?.durationMinutes).toBe(60);
  });
});
