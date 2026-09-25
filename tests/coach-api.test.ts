import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { coaches, players } from "@/db/schema";
import { bookLessonApi, cancelLessonApi, coachSlots, requestCoach } from "@/lib/api/coachOps";
import { fail } from "@/lib/api/http";
import { getOrCreatePersonalToken } from "@/lib/domain/identity";
import { coachToPublic } from "@/lib/api/serialize";
import { coachesAtClub, createCoach, listPublicCoaches, presetHours, setStudentStatus } from "@/lib/domain/coaching";
import { createTestDb, makePlayer } from "./helpers/db";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

describe("coaches for assistants", () => {
  it("lists only coaches who chose to be listed, by city and by club, without anything private", async () => {
    const p1 = await makePlayer(db, "Olga");
    const p2 = await makePlayer(db, "Hidden");
    const p3 = await makePlayer(db, "Sergio");
    const olga = await createCoach(db, { playerId: p1.id, displayName: "Olga", tz: "Asia/Bangkok", clubNames: "Warehaus, DPC", hours: presetHours("both") });
    const hidden = await createCoach(db, { playerId: p2.id, displayName: "Hidden", tz: "Asia/Bangkok", clubNames: "Warehaus" });
    await db.update(coaches).set({ isPublic: false }).where(eq(coaches.id, hidden.id));
    const sergio = await createCoach(db, { playerId: p3.id, displayName: "Sergio", tz: "Asia/Singapore" });
    await db.update(coaches).set({ isPublic: true, promptpayId: "0899999999", whatsapp: "66899999999", bio: "Ten years on court." }).where(eq(coaches.id, olga.id));
    await db.update(coaches).set({ isPublic: true }).where(eq(coaches.id, sergio.id));
    expect((await listPublicCoaches(db)).map((c) => c.displayName)).toEqual(["Olga", "Sergio"]);
    expect((await listPublicCoaches(db, "Asia/Bangkok")).map((c) => c.displayName)).toEqual(["Olga"]);
    expect((await coachesAtClub(db, "warehaus")).map((c) => c.displayName)).toEqual(["Olga"]);
    expect(await coachesAtClub(db, "Nowhere")).toEqual([]);
    const pub = JSON.stringify(coachToPublic((await listPublicCoaches(db, "Asia/Bangkok"))[0], "https://kicksma.sh", { city: "Phuket" }));
    expect(pub).not.toContain("0899999999");
    expect(pub).not.toContain("66899999999");
    expect(pub).toContain("Ten years on court.");
    expect(JSON.parse(pub).rules.cutoffHours).toBe(12);
  });

  it("walks the whole path: slots, ask, accept, book, cancel", async () => {
    // An address, so the agent's ask reaches the coach: a coach nobody can reach takes no asks at all.
    const cp = await makePlayer(db, "Coach Api", { email: "api.coach@example.com" });
    const coach0 = await createCoach(db, { playerId: cp.id, displayName: "Api", tz: "Asia/Bangkok", hours: presetHours("both") });
    await db.update(coaches).set({ isPublic: true }).where(eq(coaches.id, coach0.id));
    const slots = await coachSlots(db, { handle: coach0.handle, days: 7 });
    expect(slots.slots.length).toBeGreaterThan(5);
    expect(slots.days).toBe(7);
    // A stranger asks by name and gets a token; booking before acceptance is refused with a hint.
    const asked = await requestCoach(db, { handle: coach0.handle, name: "Agent Ann" });
    expect(asked.status).toBe("requested");
    expect(asked.student.personalToken.length).toBeGreaterThan(8);
    await expect(bookLessonApi(db, { handle: coach0.handle, token: asked.student.personalToken, startsAt: slots.slots[3] })).rejects.toMatchObject({ status: 403, code: "not_student" });
    // The coach accepts; the same token books; the same token cancels in time.
    const students = await db.query.coachStudents.findMany({ where: (t, { eq }) => eq(t.coachId, coach0.id) });
    await setStudentStatus(db, coach0.id, students[0].playerId, "accepted");
    const again = await requestCoach(db, { handle: coach0.handle, token: asked.student.personalToken });
    expect(again.status).toBe("accepted");
    const booked = await bookLessonApi(db, { handle: coach0.handle, token: asked.student.personalToken, startsAt: slots.slots[3] });
    expect(booked.lesson.startsAt).toBe(slots.slots[3]);
    expect(booked.package).toBeNull();
    await expect(bookLessonApi(db, { handle: coach0.handle, token: asked.student.personalToken, startsAt: slots.slots[3] })).rejects.toMatchObject({ status: 409, code: "slot_taken" });
    const cancelled = await cancelLessonApi(db, { lessonId: booked.lesson.id, token: asked.student.personalToken });
    expect(cancelled.outcome).toBe("none");
    await expect(cancelLessonApi(db, { lessonId: booked.lesson.id, token: asked.student.personalToken })).rejects.toMatchObject({ status: 409 });
    await expect(bookLessonApi(db, { handle: "nobody", token: asked.student.personalToken, startsAt: slots.slots[3] })).rejects.toMatchObject({ status: 404 });
  });

  // ricardo, 24 September 2026: listed, open to anybody, and no Telegram, no email, no push device.
  // An assistant could ask and book on his page, and nobody would ever have heard it.
  it("refuses an assistant's ask and booking for a coach nobody can reach, and says why", async () => {
    const cp = await makePlayer(db, "Coach Quiet");
    const quiet = await createCoach(db, { playerId: cp.id, displayName: "Quiet", tz: "Asia/Bangkok", hours: presetHours("both") });
    await db.update(coaches).set({ isPublic: true, openBooking: true }).where(eq(coaches.id, quiet.id));
    const slots = await coachSlots(db, { handle: quiet.handle, days: 7 });
    const playersBefore = (await db.select().from(players)).length;
    const refused = await requestCoach(db, { handle: quiet.handle, name: "Agent Bea" }).catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: "not_taking_bookings" });
    // The refusal leaves no stranger's row behind, and reaches the agent as a 403 with the reason.
    expect((await db.select().from(players)).length).toBe(playersBefore);
    const res = fail(refused);
    expect(res.status).toBe(403);
    expect((await res.json()).error.hint).toMatch(/no way to be reached/);
    // With a token of its own, the open door still says no rather than making a student of them.
    const bea = await makePlayer(db, "Bea");
    const token = await getOrCreatePersonalToken(db, bea.id);
    await expect(bookLessonApi(db, { handle: quiet.handle, token, startsAt: slots.slots[3] })).rejects.toMatchObject({ code: "not_taking_bookings" });
    await expect(requestCoach(db, { handle: quiet.handle, token })).rejects.toMatchObject({ code: "not_taking_bookings" });
    // An address on the coach is the whole difference: the same token now books.
    await db.update(players).set({ email: "quiet.coach@example.com" }).where(eq(players.id, cp.id));
    const booked = await bookLessonApi(db, { handle: quiet.handle, token, startsAt: slots.slots[3] });
    expect(booked.lesson.startsAt).toBe(slots.slots[3]);
  });
});
