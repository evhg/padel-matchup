import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { emitMatchEvent } from "@/lib/api/webhooks";
import { cityOf } from "@/lib/domain/cities";
import { bookLesson, cancelLesson, createCoach, presetHours } from "@/lib/domain/coaching";
import { createEvent } from "@/lib/domain/events";
import { channelOf, factsSince, recordFact } from "@/lib/domain/facts";
import { freezeClock } from "./helpers/clock";
import { createTestDb, DAY, HOUR, makePlayer } from "./helpers/db";

/** Tuesday 8 September 2026, 16:00 in Phuket. */
const NOW = new Date("2026-09-08T09:00:00Z");
freezeClock(NOW);
const since = new Date(NOW.getTime() - HOUR);

describe("the fact log", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await createTestDb()));
  afterAll(() => close());

  it("a match event becomes a fact with its channel, city and venue, and never a name", async () => {
    const org = await makePlayer(db, "Orgname", { email: "orgname@example.com" });
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() + 2 * DAY), tz: "Asia/Bangkok", venueName: "Rawai Padel Club", whenFull: "waitlist" });
    await emitMatchEvent(db, "match.joined", ev.code, { player: { name: "Orgname", level: 3.5 }, outcome: "joined" }, { channel: "telegram", actorPlayerId: org.id });
    const [f] = await factsSince(db, since, { kinds: ["match.joined"] });
    expect(f).toMatchObject({ kind: "match.joined", channel: "telegram", actorPlayerId: org.id, subjectType: "match", subjectId: ev.id, code: ev.code, city: cityOf("Asia/Bangkok", ev.venueSlug)?.slug ?? null, venueSlug: ev.venueSlug, data: { outcome: "joined", level: 3.5 } });
    expect(JSON.stringify(f)).not.toContain("Orgname");
    // An automatic match, no origin given, is the cron's; a plain call is the web's.
    await emitMatchEvent(db, "match.created", ev.code, { automatic: true });
    await emitMatchEvent(db, "match.updated", ev.code, { calendarChanged: true });
    const kinds = Object.fromEntries((await factsSince(db, since)).map((x) => [x.kind, x.channel]));
    expect(kinds).toMatchObject({ "match.created": "cron", "match.updated": "web", "match.joined": "telegram" });
  });

  it("a lesson booked and cancelled leaves two facts with the channel the booking named", async () => {
    const coachPlayer = await makePlayer(db, "Coachname");
    const coach = await createCoach(db, { playerId: coachPlayer.id, displayName: "Coachname", clubNames: "Rawai Padel Club", tz: "Asia/Bangkok", hours: presetHours("both") });
    const student = await makePlayer(db, "Studentname");
    const { lesson } = await bookLesson(db, { coach, studentPlayerId: student.id, startsAt: new Date(NOW.getTime() + DAY), byCoach: true, source: "telegram", createdByPlayerId: coachPlayer.id }, NOW);
    await cancelLesson(db, { lessonId: lesson.id, by: "coach", coach, actorPlayerId: coachPlayer.id, source: "gcal" }, NOW);
    // Both facts land in the same second, so the order is by kind here, not by time.
    const lessonFacts = (await factsSince(db, since, { kinds: ["lesson.booked", "lesson.cancelled"] })).sort((a, b) => a.kind.localeCompare(b.kind));
    expect(lessonFacts.map((x) => [x.kind, x.channel, x.actorPlayerId, x.subjectId, x.code])).toEqual([
      ["lesson.booked", "telegram", coachPlayer.id, lesson.id, coach.handle],
      ["lesson.cancelled", "calendar", coachPlayer.id, lesson.id, coach.handle],
    ]);
    expect(lessonFacts[0].data).toMatchObject({ byCoach: true, minutes: 60, packaged: false });
    expect(lessonFacts[1].data).toMatchObject({ by: "coach", outcome: "none", status: "cancelled" });
    expect(JSON.stringify(lessonFacts)).not.toMatch(/Coachname|Studentname/);
  });

  it("sources map onto channels, and a record that cannot be written never throws", async () => {
    expect(["web", "telegram", "discord", "api", "mcp", "gcal", "ical", "counter", "waitlist", undefined].map(channelOf)).toEqual(["web", "telegram", "discord", "api", "mcp", "calendar", "calendar", "web", "web", "web"]);
    expect(await recordFact(db, { kind: "test.bad", subject: { type: "match", id: "not-a-uuid" } })).toBe(false);
    expect(await recordFact(db, { kind: "test.good", subject: { type: "player", id: "00000000-0000-4000-8000-000000000001" }, at: new Date(NOW.getTime() - 2 * HOUR) })).toBe(true);
    expect((await factsSince(db, since, { kinds: ["test.good", "test.bad"] })).length).toBe(0);
    expect((await factsSince(db, new Date(NOW.getTime() - 3 * HOUR), { kinds: ["test.good"] })).length).toBe(1);
  });
});
