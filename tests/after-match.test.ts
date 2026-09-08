import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events, feedback, groups } from "@/db/schema";
import { nudgeForScore } from "@/lib/afterMatch";
import { createEvent } from "@/lib/domain/events";
import { weeklyGroupFromEvent } from "@/lib/domain/groups";
import { praiseLine } from "@/lib/domain/praise";
import { joinEvent } from "@/lib/domain/slots";
import { appendFeedbackReply, createFeedback, findNoteForReply, markAcknowledged } from "@/lib/feedback/store";
import { createTestDb, makePlayer, HOUR } from "./helpers/db";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

describe("praise for the winners", () => {
  it("is the same line for the same match in each language, and names the winners", () => {
    const en = praiseLine("en", "AB12", "Anna & Ben");
    expect(praiseLine("en-GB", "AB12", "Anna & Ben")).toBe(en);
    expect(en).toContain("Anna & Ben");
    expect(praiseLine("ru", "AB12", "Анна и Бен")).toContain("Анна и Бен");
    expect(praiseLine("es", "AB12", "Ana y Ben")).toContain("Ana y Ben");
    const seeds = ["AB12", "CD34", "EF56", "GH78", "IJ90", "KL11", "MN22", "OP33", "QR44", "ST55"];
    expect(new Set(seeds.map((c) => praiseLine("en", c, "X"))).size).toBeGreaterThan(3);
  });
});

describe("same time next week", () => {
  it("turns the match's crew into a group with the match's own weekly slot, once", async () => {
    const org = await makePlayer(db, "Org");
    const p2 = await makePlayer(db, "Two");
    const startsAt = new Date("2026-09-10T12:00:00.000Z"); // Thursday 19:00 in Bangkok
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt, tz: "Asia/Bangkok", venueName: "Rawai", whenFull: "closed" });
    await joinEvent(db, { eventId: ev.id, playerId: p2.id });
    const first = await weeklyGroupFromEvent(db, { eventId: ev.id, actorPlayerId: p2.id, fallbackName: "Thursday crew" });
    expect(first.created).toBe(true);
    expect(first.group.recurDow).toBe(4);
    expect(first.group.recurTime).toBe("19:00");
    expect(first.group.tz).toBe("Asia/Bangkok");
    const again = await weeklyGroupFromEvent(db, { eventId: ev.id, actorPlayerId: org.id, fallbackName: "x" });
    expect(again.created).toBe(false);
    expect(again.group.id).toBe(first.group.id);
    const [row] = await db.select().from(groups).where(eq(groups.id, first.group.id));
    expect(row.recurDow).toBe(4);
  });

  it("refuses a stranger", async () => {
    const org = await makePlayer(db, "Org2");
    const stranger = await makePlayer(db, "Stranger");
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(Date.now() - HOUR), tz: "UTC", whenFull: "closed" });
    await expect(weeklyGroupFromEvent(db, { eventId: ev.id, actorPlayerId: stranger.id, fallbackName: "x" })).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("replies to the thank-you", () => {
  it("find the person's latest note and join it, reopening a decided one", async () => {
    const now = new Date("2026-09-08T10:00:00.000Z");
    const note = await createFeedback(db, { source: "telegram", text: "the reminder should come two hours before", locale: "en", name: "Ivan", telegramChatId: 424242, telegramUserId: 424242 }, now);
    await markAcknowledged(db, note.id, "Thanks, Ivan.", now);
    const found = await findNoteForReply(db, { telegramUserId: 424242, telegramChatId: 424242 }, new Date(now.getTime() + HOUR));
    expect(found?.id).toBe(note.id);
    // Decided since, then the person writes back: the note is back on the desk with the reply inside.
    await db.update(feedback).set({ status: "declined", verdict: "decline" }).where(eq(feedback.id, note.id));
    const updated = await appendFeedbackReply(db, note.id, "one hour is too late for me", new Date(now.getTime() + 2 * HOUR));
    expect(updated?.status).toBe("acknowledged");
    expect(updated?.verdict).toBeNull();
    expect(updated?.text).toContain("the reminder should come two hours before");
    expect(updated?.text).toContain("[reply 2026-09-08 12:00] one hour is too late for me");
    // Nothing from a stranger, nothing after two weeks, nothing for an insult closed as not-feedback.
    expect(await findNoteForReply(db, { telegramUserId: 999999 }, now)).toBeNull();
    expect(await findNoteForReply(db, { telegramUserId: 424242 }, new Date(now.getTime() + 20 * 24 * HOUR))).toBeNull();
    const spam = await createFeedback(db, { source: "email", text: "buy followers now", locale: "en", email: "spam@example.com" }, now);
    await db.update(feedback).set({ status: "declined", verdict: "not_feedback" }).where(eq(feedback.id, spam.id));
    expect(await findNoteForReply(db, { email: "spam@example.com" }, now)).toBeNull();
    const byMail = await createFeedback(db, { source: "email", text: "love the card", locale: "en", email: "Anna@Example.com" }, now);
    expect((await findNoteForReply(db, { email: "anna@example.com" }, now))?.id).toBe(byMail.id);
  });
});

describe("the score nudge", () => {
  it("counts every player and sends nothing when nobody has a channel", async () => {
    const org = await makePlayer(db, "Quiet");
    const p2 = await makePlayer(db, "Quieter");
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(Date.now() + HOUR), tz: "UTC", whenFull: "closed" });
    for (const p of [org, p2]) await joinEvent(db, { eventId: ev.id, playerId: p.id });
    // The match is over by the time the hourly job looks.
    const [past] = await db.update(events).set({ startsAt: new Date(Date.now() - 3 * HOUR), status: "past" }).where(eq(events.id, ev.id)).returning();
    const r = await nudgeForScore(db, past);
    expect(r.players).toBe(2);
    expect(r.telegram + r.push + r.email).toBe(0);
  });
});
