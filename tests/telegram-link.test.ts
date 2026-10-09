import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { players, scores, slots } from "@/db/schema";
import { createEvent } from "@/lib/domain/events";
import { recordToKeep, recordWeights } from "@/lib/domain/merge";
import { joinEvent } from "@/lib/domain/slots";
import { findOrCreateTelegramPlayer, linkTelegram } from "@/lib/telegram/identity";
import { createTestDb, DAY, makePlayer } from "./helpers/db";
import { freezeClock } from "./helpers/clock";

/**
 * The owner, 9 October 2026 (decision 2A): when a Telegram account links to a signed-in player, keep
 * the record with more history. The owner met the other case herself: a WhatsApp link opened in a
 * browser with no cookie, she tapped Join (a new, nearly empty record) and signed in with Telegram
 * there. Her real record, with the matches and the personal link her home-screen icon opens, was
 * merged into the new one and deleted.
 */
const NOW = new Date("2026-10-09T09:00:00.000Z");
freezeClock(NOW);
const at = (days: number) => new Date(NOW.getTime() + days * DAY);
const tg = (id: number, first_name: string) => ({ id, is_bot: false, first_name, username: `${first_name.toLowerCase()}_tg`, language_code: "en" });

describe("linking Telegram keeps the record with more history", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  const match = async (organiser: { id: string }, days: number, ...seated: { id: string }[]) => {
    const ev = await createEvent(db, { creatorPlayerId: organiser.id, type: "match", startsAt: at(days), tz: "Asia/Bangkok", whenFull: "waitlist", venueName: "Rawai Padel Club" });
    for (const p of seated) await joinEvent(db, { eventId: ev.id, playerId: p.id, now: NOW });
    return ev;
  };
  const exists = async (id: string) => (await db.select({ id: players.id }).from(players).where(eq(players.id, id))).length === 1;
  const seatsOf = async (id: string) => (await db.select().from(slots).where(eq(slots.playerId, id))).length;

  it("folds the empty record the bot made into the real web record", async () => {
    const org = await makePlayer(db, "Org One", { email: "org1@example.com" });
    const web = await makePlayer(db, "Nina", { createdAt: new Date("2026-09-01T09:00:00.000Z") });
    await match(org, 1, web);
    await match(org, 2, web);
    // First contact with the bot, a month before the web record: empty, and older. Only the history
    // can make the web record win, so this test proves that rule and not the tie.
    const bot = await findOrCreateTelegramPlayer(db, tg(7001, "Nina"));
    await db.update(players).set({ createdAt: new Date("2026-08-01T09:00:00.000Z") }).where(eq(players.id, bot.id));
    expect(bot.id).not.toBe(web.id);

    const linked = await linkTelegram(db, web.id, tg(7001, "Nina"));
    expect(linked.id).toBe(web.id);
    expect(linked.telegramId).toBe(7001);
    expect(await exists(bot.id)).toBe(false);
    expect(await seatsOf(web.id)).toBe(2);
  });

  it("keeps the real record that holds Telegram when a new, nearly empty web record links it", async () => {
    const org = await makePlayer(db, "Org Two", { email: "org2@example.com" });
    // The real record: two seats, a match of her own, the personal link on her home screen.
    const real = await makePlayer(db, "Kate", { personalToken: "Kt4kLm5nPq6r", telegramId: 7002, telegramUsername: "kate_tg", createdAt: new Date("2026-08-01T09:00:00.000Z") });
    await match(org, 1, real);
    await match(org, 2, real);
    const own = await match(real, 3);
    await db.insert(scores).values([1, 2].map((setNumber) => ({ eventId: own.id, setNumber, sideA: 6, sideB: 4, enteredByPlayerId: real.id, updatedAt: NOW })));
    // A WhatsApp link in a browser with no cookie: a new record, and Join takes one seat.
    const fresh = await makePlayer(db, "Kate", { personalToken: "Kt4kLm5nPq7s" });
    const joined = await match(org, 4, fresh);

    // Two seats, one match created and one score (two sets, one match), against one seat.
    const weights = new Map((await recordWeights(db, [real.id, fresh.id])).map((w) => [w.id, w.history]));
    expect([weights.get(real.id), weights.get(fresh.id)]).toEqual([4, 1]);

    const linked = await linkTelegram(db, fresh.id, tg(7002, "Kate"));
    expect(linked.id, "the returned player is the real one, so the caller signs this browser in as her").toBe(real.id);
    expect(linked.personalToken, "the home-screen icon still opens her personal link").toBe("Kt4kLm5nPq6r");
    expect(linked.telegramId).toBe(7002);
    expect(await exists(fresh.id)).toBe(false);
    const seated = (await db.select().from(slots).where(eq(slots.eventId, joined.id))).map((s) => s.playerId);
    expect(seated, "the new record's seat moved to the real one").toContain(real.id);
    expect(await seatsOf(real.id)).toBe(3);
  });

  it("keeps the older record when both have the same history", async () => {
    const org = await makePlayer(db, "Org Three", { email: "org3@example.com" });
    // One seat each. The record that holds Telegram is the older one, so it wins although it is not signed in.
    const old = await makePlayer(db, "Lev", { telegramId: 7003, createdAt: new Date("2026-09-01T09:00:00.000Z") });
    const signedIn = await makePlayer(db, "Lev", { createdAt: new Date("2026-10-01T09:00:00.000Z") });
    await match(org, 1, old);
    await match(org, 2, signedIn);
    const linked = await linkTelegram(db, signedIn.id, tg(7003, "Lev"));
    expect(linked.id).toBe(old.id);
    expect(await exists(signedIn.id)).toBe(false);
    expect(await seatsOf(old.id)).toBe(2);

    // The other way round: the signed-in record is the older one, so it wins.
    const older = await makePlayer(db, "Mia", { createdAt: new Date("2026-09-01T09:00:00.000Z") });
    const newer = await makePlayer(db, "Mia", { telegramId: 7004, createdAt: new Date("2026-10-01T09:00:00.000Z") });
    const linked2 = await linkTelegram(db, older.id, tg(7004, "Mia"));
    expect(linked2.id).toBe(older.id);
    expect(linked2.telegramId).toBe(7004);
    expect(await exists(newer.id)).toBe(false);
  });

  it("the rule alone: more history first, then the older record, then the first one given", () => {
    const a = { id: "a", history: 2, createdAt: new Date("2026-10-01T00:00:00.000Z") };
    const b = { id: "b", history: 1, createdAt: new Date("2026-09-01T00:00:00.000Z") };
    expect(recordToKeep(a, b)).toBe("a");
    expect(recordToKeep(b, a)).toBe("a");
    expect(recordToKeep({ ...a, history: 1 }, b)).toBe("b");
    expect(recordToKeep({ ...b, id: "c" }, b)).toBe("c");
  });
});
