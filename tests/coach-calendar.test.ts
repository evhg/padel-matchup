import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { coachBlocks, coaches, lessons } from "@/db/schema";
import { eventSpan, isOurs, KICKSMASH_TAG } from "@/lib/coach/gcal";
import { parseIcsBusy } from "@/lib/coach/ical";
import { syncGoogleCalendar, syncIcal } from "@/lib/coach/sync";
import { addStudentByName, availableSlots, bookLesson, createCoach, presetHours } from "@/lib/domain/coaching";
import { createTestDb, makePlayer, DAY, HOUR } from "./helpers/db";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: "sa@test.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) });
});
afterAll(async () => close());

const TZ = "Asia/Bangkok";
const monday07 = new Date("2026-09-14T00:00:00.000Z");

describe("iCal busy time", () => {
  it("reads single and weekly events inside the window, in named zones and UTC", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:a",
      "SUMMARY:Dentist",
      "DTSTART;TZID=Asia/Bangkok:20260915T100000",
      "DTEND;TZID=Asia/Bangkok:20260915T110000",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:b",
      "SUMMARY:Club meeting",
      "DTSTART:20260916T020000Z",
      "DURATION:PT1H30M",
      "RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=3",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:c",
      "SUMMARY:Old",
      "DTSTART:20260101T020000Z",
      "DTEND:20260101T030000Z",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:d",
      "SUMMARY:Free",
      "TRANSP:TRANSPARENT",
      "DTSTART:20260917T020000Z",
      "DTEND:20260917T030000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const busy = parseIcsBusy(ics, monday07, new Date(monday07.getTime() + 30 * DAY));
    expect(busy.find((b) => b.summary === "Dentist")?.start.toISOString()).toBe("2026-09-15T03:00:00.000Z");
    expect(busy.filter((b) => b.summary === "Club meeting").map((b) => b.start.toISOString())).toEqual(["2026-09-16T02:00:00.000Z", "2026-09-23T02:00:00.000Z", "2026-09-30T02:00:00.000Z"]);
    expect(busy.find((b) => b.summary === "Club meeting")?.end.toISOString()).toBe("2026-09-16T03:30:00.000Z");
    expect(busy.some((b) => b.summary === "Old")).toBe(false);
    expect(busy.some((b) => b.summary === "Free")).toBe(false);
  });

  it("reads Google event spans and our own tag", () => {
    expect(eventSpan({ id: "1", start: { dateTime: "2026-09-15T03:00:00Z" }, end: { dateTime: "2026-09-15T04:00:00Z" } })?.end.toISOString()).toBe("2026-09-15T04:00:00.000Z");
    expect(eventSpan({ id: "2", start: { date: "2026-09-15" }, end: { date: "2026-09-16" } })?.start.toISOString()).toBe("2026-09-15T00:00:00.000Z");
    expect(eventSpan({ id: "3", start: { dateTime: "x" } })).toBeNull();
    expect(isOurs({ id: "4", extendedProperties: { private: { [KICKSMASH_TAG]: "lesson-1" } } })).toBe("lesson-1");
    expect(isOurs({ id: "5" })).toBeNull();
  });
});

describe("calendar sync", () => {
  it("turns the coach's Google events into busy time, pushes lessons, and cancels here what was deleted there", async () => {
    const cp = await makePlayer(db, "Cal");
    const coach0 = await createCoach(db, { playerId: cp.id, displayName: "Cal", tz: TZ, hours: presetHours("mornings") });
    await db.update(coaches).set({ gcalId: "cal@example.com" }).where(eq(coaches.id, coach0.id));
    const [coach] = await db.select().from(coaches).where(eq(coaches.id, coach0.id));
    const anna = await addStudentByName(db, coach.id, "Anna", "en");
    const now = new Date(monday07.getTime() - 2 * DAY);
    const booked = await bookLesson(db, { coach, studentPlayerId: anna.id, startsAt: new Date(monday07.getTime() + 2 * HOUR), byCoach: true }, now);
    const deletedThere = await bookLesson(db, { coach, studentPlayerId: anna.id, startsAt: new Date(monday07.getTime() + 3 * HOUR), byCoach: true }, now);
    await db.update(lessons).set({ externalId: "gone" }).where(eq(lessons.id, deletedThere.lesson.id));

    let inserted = 0;
    const fake: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
      if (url.includes("/events?")) {
        const items = [
          { id: "dentist", summary: "Dentist", start: { dateTime: new Date(monday07.getTime() + 1 * HOUR).toISOString() }, end: { dateTime: new Date(monday07.getTime() + 2 * HOUR).toISOString() } },
          { id: "gone", status: "cancelled", extendedProperties: { private: { [KICKSMASH_TAG]: deletedThere.lesson.id } } },
          { id: "away", summary: "Holiday", start: { date: "2026-09-20" }, end: { date: "2026-09-22" } },
        ];
        return new Response(JSON.stringify({ items }), { status: 200 });
      }
      if (url.endsWith("/events") && init?.method === "POST") {
        inserted++;
        const body = JSON.parse(String(init.body)) as { extendedProperties: { private: Record<string, string> } };
        expect(body.extendedProperties.private[KICKSMASH_TAG]).toBe(booked.lesson.id);
        return new Response(JSON.stringify({ id: `ev-${inserted}` }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    };
    const r = await syncGoogleCalendar(db, coach, now, fake);
    expect(r.error).toBeNull();
    expect(r.busy).toBe(2);
    expect(r.pushed).toBe(1);
    expect(r.cancelledHere).toBe(1);
    const blocks = await db.select().from(coachBlocks).where(and(eq(coachBlocks.coachId, coach.id), eq(coachBlocks.source, "gcal")));
    expect(blocks.map((b) => b.reason).sort()).toEqual(["Dentist", "Holiday"]);
    const [pushed] = await db.select().from(lessons).where(eq(lessons.id, booked.lesson.id));
    expect(pushed.externalId).toBe("ev-1");
    const [cancelled] = await db.select().from(lessons).where(eq(lessons.id, deletedThere.lesson.id));
    expect(cancelled.status).toBe("cancelled");
    // The dentist hour is no longer offered.
    const slots = await availableSlots(db, { ...coach, minNoticeHours: 0 }, monday07, new Date(monday07.getTime() + 6 * HOUR), now);
    expect(slots.map((s) => s.toISOString())).not.toContain(new Date(monday07.getTime() + 1 * HOUR).toISOString());
    // A second pass is idempotent: same blocks, nothing pushed twice.
    const again = await syncGoogleCalendar(db, coach, now, fake);
    expect(again.busy).toBe(2);
    expect(again.pushed).toBe(0);
    expect((await db.select().from(coachBlocks).where(and(eq(coachBlocks.coachId, coach.id), eq(coachBlocks.source, "gcal")))).length).toBe(2);
  });

  it("reads an iCal address into busy time and records an unreadable one", async () => {
    const cp = await makePlayer(db, "Ida");
    const coach0 = await createCoach(db, { playerId: cp.id, displayName: "Ida", tz: TZ });
    await db.update(coaches).set({ icalUrl: "https://example.com/secret.ics" }).where(eq(coaches.id, coach0.id));
    const [coach] = await db.select().from(coaches).where(eq(coaches.id, coach0.id));
    const now = new Date(monday07.getTime() - DAY);
    const ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nSUMMARY:School run\r\nDTSTART:20260914T010000Z\r\nDTEND:20260914T020000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    const ok: typeof fetch = async () => new Response(ics, { status: 200 });
    const r = await syncIcal(db, coach, now, ok);
    expect(r.busy).toBe(1);
    const bad: typeof fetch = async () => new Response("nope", { status: 500 });
    const r2 = await syncIcal(db, coach, now, bad);
    expect(r2.error).toBe("HTTP 500");
    const [row] = await db.select().from(coaches).where(eq(coaches.id, coach.id));
    expect(row.calendarError).toBe("HTTP 500");
  });
});
