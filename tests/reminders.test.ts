import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events } from "@/db/schema";
import { createEvent } from "@/lib/domain/events";
import { reserveSlot, confirmInvite } from "@/lib/domain/slots";
import {
  findInviteRemindersDue,
  findScoreRemindersDue,
  isInviteReminderDue,
  isScoreReminderDue,
  markInviteReminded,
  markScoreReminderSent,
  shouldBePast,
  transitionPastEvents,
} from "@/lib/domain/reminders";
import { createTestDb, makePlayer, DAY, HOUR } from "./helpers/db";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

const now = new Date("2026-05-10T12:00:00Z");
const ev = { status: "open" as const, startsAt: new Date(now.getTime() + 3 * DAY) };

describe("invite reminder eligibility (pure)", () => {
  const slot = (o: Partial<{ status: "invited" | "confirmed" | "declined" | "empty" | "joined"; invitedEmail: string | null; invitedAt: Date | null; lastRemindedAt: Date | null }>) => ({
    status: "invited" as const,
    invitedEmail: "a@b.c",
    invitedAt: new Date(now.getTime() - 25 * HOUR),
    lastRemindedAt: null,
    ...o,
  });
  it("is due 24h after invitation when never reminded", () => {
    expect(isInviteReminderDue(slot({}), ev, now)).toBe(true);
    expect(isInviteReminderDue(slot({ invitedAt: new Date(now.getTime() - 23 * HOUR) }), ev, now)).toBe(false);
  });
  it("re-arms 24h after the last reminder", () => {
    expect(isInviteReminderDue(slot({ lastRemindedAt: new Date(now.getTime() - 2 * HOUR) }), ev, now)).toBe(false);
    expect(isInviteReminderDue(slot({ lastRemindedAt: new Date(now.getTime() - 25 * HOUR) }), ev, now)).toBe(true);
  });
  it("never emails invitees without an email, or after they responded", () => {
    expect(isInviteReminderDue(slot({ invitedEmail: null }), ev, now)).toBe(false);
    expect(isInviteReminderDue(slot({ status: "confirmed" }), ev, now)).toBe(false);
    expect(isInviteReminderDue(slot({ status: "declined" }), ev, now)).toBe(false);
  });
  it("stops at event start and for cancelled events", () => {
    expect(isInviteReminderDue(slot({}), { status: "open", startsAt: new Date(now.getTime() - 1) }, now)).toBe(false);
    expect(isInviteReminderDue(slot({}), { status: "cancelled", startsAt: ev.startsAt }, now)).toBe(false);
  });
});

describe("score reminder eligibility (pure)", () => {
  const e = (o: Partial<{ status: "open" | "full" | "cancelled" | "past"; startsAt: Date; scoreReminderSent: boolean; standings: string[] | null; type: "match" | "tournament" }>) => ({
    status: "past" as const,
    startsAt: new Date(now.getTime() - 3 * HOUR),
    scoreReminderSent: false,
    standings: null,
    type: "match" as const,
    ...o,
  });
  it("fires once, 2h after start, only when no score exists", () => {
    expect(isScoreReminderDue(e({}), false, now)).toBe(true);
    expect(isScoreReminderDue(e({ startsAt: new Date(now.getTime() - 1 * HOUR) }), false, now)).toBe(false);
    expect(isScoreReminderDue(e({}), true, now)).toBe(false);
    expect(isScoreReminderDue(e({ scoreReminderSent: true }), false, now)).toBe(false);
    expect(isScoreReminderDue(e({ status: "cancelled" }), false, now)).toBe(false);
    expect(isScoreReminderDue(e({ type: "tournament", standings: ["x"] }), false, now)).toBe(false);
  });
});

describe("cron queries (db)", () => {
  it("finds due invite reminders and marks them", async () => {
    const creator = await makePlayer(db, "Org");
    const event = await createEvent(db, { creatorPlayerId: creator.id, type: "match", startsAt: new Date(Date.now() + 3 * DAY), tz: "UTC", venueName: "V", whenFull: "waitlist" });
    const invitedAt = new Date(Date.now() - 30 * HOUR);
    const withEmail = await reserveSlot(db, { eventId: event.id, actorPlayerId: creator.id, name: "Em", email: "em@x.io", now: invitedAt });
    await reserveSlot(db, { eventId: event.id, actorPlayerId: creator.id, name: "NoMail", now: invitedAt });
    const confirmedOne = await reserveSlot(db, { eventId: event.id, actorPlayerId: creator.id, name: "Conf", email: "conf@x.io", now: invitedAt });
    const conf = await makePlayer(db, "Conf");
    await confirmInvite(db, { inviteCode: confirmedOne.slot.inviteCode!, playerId: conf.id });

    const due = await findInviteRemindersDue(db);
    expect(due.map((d) => d.slot.id)).toEqual([withEmail.slot.id]);
    expect(due[0].creator.id).toBe(creator.id);

    await markInviteReminded(db, withEmail.slot.id);
    expect(await findInviteRemindersDue(db)).toHaveLength(0);
  });

  it("finds due score reminders exactly once and transitions events to past", async () => {
    const creator = await makePlayer(db, "Org2", { email: "org@x.io" });
    const done = await createEvent(db, { creatorPlayerId: creator.id, type: "match", startsAt: new Date(Date.now() - 3 * HOUR), tz: "UTC", venueName: "V", whenFull: "waitlist" });
    const soon = await createEvent(db, { creatorPlayerId: creator.id, type: "match", startsAt: new Date(Date.now() - 1 * HOUR), tz: "UTC", venueName: "V", whenFull: "waitlist" });

    const due = await findScoreRemindersDue(db);
    expect(due.map((d) => d.event.id)).toContain(done.id);
    expect(due.map((d) => d.event.id)).not.toContain(soon.id);

    await markScoreReminderSent(db, done.id);
    expect((await findScoreRemindersDue(db)).map((d) => d.event.id)).not.toContain(done.id);

    expect(shouldBePast(done, new Date())).toBe(true);
    expect(shouldBePast(soon, new Date())).toBe(false);
    const n = await transitionPastEvents(db);
    expect(n).toBeGreaterThanOrEqual(1);
    const [fresh] = await db.select().from(events).where(eq(events.id, done.id));
    expect(fresh.status).toBe("past");
    const [freshSoon] = await db.select().from(events).where(eq(events.id, soon.id));
    expect(freshSoon.status).toBe("open");
  });
});
