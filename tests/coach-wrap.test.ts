import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { clubs, coaches, lessons, type Player } from "@/db/schema";
import { clubWrap, coachWrap, monthlyWraps, previousMonth, wrapDue, type WrapNote } from "@/lib/coach/wrap";
import { claimClub, decideClub } from "@/lib/domain/clubs";
import { addStudentByName, createCoach, createPackage, presetHours } from "@/lib/domain/coaching";
import { createEvent } from "@/lib/domain/events";
import { joinEvent } from "@/lib/domain/slots";
import { createTestDb, HOUR, makePlayer } from "./helpers/db";

/** 1 October 2026, 09:30 in Bangkok: the morning the September wrap goes out. */
const FIRST = new Date("2026-10-01T02:30:00Z");
const SEP = (day: number, hour: number) => new Date(Date.UTC(2026, 8, day, hour - 7, 0, 0));

// A translator that keeps the numbers visible, so the sums can be read off the text.
const translate = async (locale: string | null | undefined) => ({ t: (key: string, values?: Record<string, unknown>) => `${key} ${JSON.stringify(values ?? {})}`, locale: locale ?? "en" });

describe("the monthly wrap", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await createTestDb()));
  afterAll(() => close());

  it("is due from nine on the 1st, with two days to catch up, and names the previous month", () => {
    expect(wrapDue("Asia/Bangkok", FIRST)).toBe(true);
    expect(wrapDue("Asia/Bangkok", new Date("2026-10-01T01:30:00Z"))).toBe(false); // 08:30 local, too early
    expect(wrapDue("Asia/Bangkok", new Date("2026-10-01T06:30:00Z"))).toBe(true); // 13:30 local: a missed morning is caught up
    expect(wrapDue("Asia/Bangkok", new Date("2026-10-03T02:30:00Z"))).toBe(true); // the 3rd still counts
    expect(wrapDue("Asia/Bangkok", new Date("2026-10-04T02:30:00Z"))).toBe(false);
    expect(wrapDue("Europe/Madrid", FIRST)).toBe(false); // 04:30 in Madrid
    const m = previousMonth("Asia/Bangkok", FIRST);
    expect(m.label).toBe("2026-09");
    expect(m.from.toISOString()).toBe("2026-08-31T17:00:00.000Z");
    expect(m.to.toISOString()).toBe("2026-09-30T17:00:00.000Z");
  });

  it("counts a coach's month and a club's month the way they would, and sends each once", async () => {
    const anaPlayer = await makePlayer(db, "Ana", { email: "ana@example.com" });
    const ana = await createCoach(db, { playerId: anaPlayer.id, displayName: "Ana", clubNames: "Wrap Club", lessonMinutes: 60, hours: presetHours("both"), tz: "Asia/Bangkok" });
    const mia = await addStudentByName(db, ana.id, "Mia", "en");
    const leo = await addStudentByName(db, ana.id, "Leo", "en");
    await createPackage(db, { coachId: ana.id, studentPlayerId: mia.id, size: 10, validDays: 90 }, SEP(2, 10));
    const rows = [
      ...[3, 5, 10, 12, 17, 19, 24, 26].map((d) => ({ coachId: ana.id, studentPlayerId: mia.id, startsAt: SEP(d, 15), minutes: 60, status: "done" as const })),
      { coachId: ana.id, studentPlayerId: leo.id, startsAt: SEP(3, 9), minutes: 60, status: "done" as const },
      { coachId: ana.id, studentPlayerId: leo.id, startsAt: SEP(15, 9), minutes: 60, status: "no_show" as const },
      { coachId: ana.id, studentPlayerId: leo.id, startsAt: new Date("2026-10-03T08:00:00Z"), minutes: 60, status: "booked" as const },
    ];
    await db.insert(lessons).values(rows.map((r) => ({ ...r, source: "test" })));
    const month = previousMonth("Asia/Bangkok", FIRST);
    const w = await coachWrap(db, ana, month.from, month.to, "en", FIRST);
    expect(w).toMatchObject({ done: 9, noShows: 1, students: 2, packagesStarted: 1, lessonsLeft: 10 });
    expect(w.busiestDay).toBe("Thursday");

    const nok = await makePlayer(db, "Nok", { email: "nok@example.com" });
    const club = await claimClub(db, { name: "Wrap Club", playerId: nok.id, tz: "Asia/Bangkok" });
    await decideClub(db, club.slug, true, SEP(1, 9));
    const org = await makePlayer(db, "Org");
    for (const d of [4, 11, 18]) {
      const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: SEP(d, 19), tz: "Asia/Bangkok", venueName: "Wrap Club", whenFull: "waitlist", publicListing: true });
      for (const n of ["A", "B", "C"]) await joinEvent(db, { eventId: ev.id, playerId: (await makePlayer(db, `${n}${d}`)).id, now: SEP(d, 10) });
    }
    await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: SEP(25, 19), tz: "Asia/Bangkok", venueName: "Wrap Club", whenFull: "waitlist", publicListing: false });
    const c = await clubWrap(db, club, month.from, month.to, "en");
    expect(c).toMatchObject({ matches: 3, seats: 12, filled: 9, players: 9 });
    expect(c.busiest).toBe("Friday 19:00");

    const delivered: { to: Player; note: WrapNote }[] = [];
    const deps = { deliver: async (to: Player, note: WrapNote) => void delivered.push({ to, note }), translate, baseUrl: "https://kicksma.sh", appName: "Kicksmash" };
    // Too early in the day: nothing goes.
    expect(await monthlyWraps(db, new Date("2026-09-30T20:00:00Z"), deps)).toEqual({ coaches: 0, clubs: 0, skipped: 0, errors: [] });
    const sent = await monthlyWraps(db, FIRST, deps);
    expect(sent.coaches).toBe(1);
    expect(sent.clubs).toBe(1);
    const toAna = delivered.find((d) => d.to.id === anaPlayer.id)!;
    expect(toAna.note.body).toContain('"done":9');
    expect(toAna.note.body).toContain('"students":2');
    expect(toAna.note.body).toContain('"left":10');
    // Nine lessons earned the invitation line.
    expect(toAna.note.body).toContain("wrap.coachInvite");
    expect(toAna.note.body).toContain("/coaches?s=wrap");
    expect(toAna.note.url).toBe("https://kicksma.sh/coach");
    const toNok = delivered.find((d) => d.to.id === nok.id)!;
    expect(toNok.note.body).toContain('"filled":9');
    expect(toNok.note.body).toContain('"rate":75');
    expect(toNok.note.url).toContain(`/v/${club.slug}/manage/`);
    // The same morning again: already sent, nothing more.
    expect(await monthlyWraps(db, new Date(FIRST.getTime() + HOUR), deps)).toEqual({ coaches: 0, clubs: 0, skipped: 0, errors: [] });
    expect((await db.select().from(coaches).where(eq(coaches.id, ana.id)))[0].wrapSentFor).toBe("2026-09");
    expect((await db.select().from(clubs).where(eq(clubs.slug, club.slug)))[0].wrapSentFor).toBe("2026-09");
  });

  it("says nothing for an empty month but still counts it as sent, and a coach under eight lessons gets no invitation", async () => {
    const quietPlayer = await makePlayer(db, "Quiet", { email: "q@example.com" });
    await createCoach(db, { playerId: quietPlayer.id, displayName: "Quiet", clubNames: "Elsewhere", lessonMinutes: 60, hours: presetHours("both"), tz: "Asia/Bangkok" });
    const fewPlayer = await makePlayer(db, "Few", { email: "f@example.com" });
    const few = await createCoach(db, { playerId: fewPlayer.id, displayName: "Few", clubNames: "Elsewhere", lessonMinutes: 60, hours: presetHours("both"), tz: "Asia/Bangkok" });
    const s = await addStudentByName(db, few.id, "Sam", "en");
    await db.insert(lessons).values([1, 2].map((d) => ({ coachId: few.id, studentPlayerId: s.id, startsAt: SEP(d, 15), minutes: 60, status: "done" as const, source: "test" })));
    const delivered: { to: Player; note: WrapNote }[] = [];
    const deps = { deliver: async (to: Player, note: WrapNote) => void delivered.push({ to, note }), translate, baseUrl: "https://kicksma.sh", appName: "Kicksmash" };
    const sent = await monthlyWraps(db, FIRST, deps);
    expect(sent.skipped).toBeGreaterThanOrEqual(1);
    expect(delivered.some((d) => d.to.id === quietPlayer.id)).toBe(false);
    const toFew = delivered.find((d) => d.to.id === fewPlayer.id)!;
    expect(toFew.note.body).toContain('"done":2');
    expect(toFew.note.body).not.toContain("wrap.coachInvite");
    expect((await db.select().from(coaches).where(eq(coaches.playerId, quietPlayer.id)))[0].wrapSentFor).toBe("2026-09");
  });
});
