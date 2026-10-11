import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events, facts, groups, notices, scores, slots, tournamentMatches, tournamentRounds, type Event, type Player } from "@/db/schema";
import { NO_SIDE_EFFECTS, joinAsPlayer } from "@/lib/api/operations";
import { anonymizePlayer } from "@/lib/domain/anonymize";
import { createEvent, duplicateEvent, nextWeekAfter, type CreateEventInput } from "@/lib/domain/events";
import { autoCreateGroupMatches, createGroup, weeklyGroupFromEvent } from "@/lib/domain/groups";
import { joinWithPolicy } from "@/lib/domain/joining";
import { waivedByPlay } from "@/lib/domain/levels";
import { saveNoticeSettings } from "@/lib/domain/notices";
import { admissionAt, claimPlayAgainRound, playAgainDefault, playAgainRecipients, playAgainRoundOf, playAgainStart, playedWithOrganiser, sameNextGame, PLAY_AGAIN_FACT, PLAY_AGAIN_AHEAD_DAYS } from "@/lib/domain/playAgain";
import { getEventByCode } from "@/lib/domain/queries";
import { joinEvent, reserveNames } from "@/lib/domain/slots";
import { notifyPlayAgain } from "@/lib/notify";
import { createTestDb, makePlayer, DAY, HOUR } from "./helpers/db";
import { freezeClock } from "./helpers/clock";

/**
 * "Play again", the owner's decision of 11 October 2026 (option A, "Make the one working group repeat
 * itself"): the organiser picks the day and the time, everything else carries over, the new match is
 * the crew's when the old one was, and each player of the last match hears once, "I'm in?". With it,
 * a player who already played a finished, scored match with the organiser is not held to that
 * organiser's level range.
 *
 * The clock: Sunday 11 October 2026, 12:00 in Phuket (05:00 UTC). The last game was Saturday 10
 * October at 18:00 Phuket (11:00 UTC), 90 minutes, scored. A week on is Saturday 17 October, 18:00.
 */
const NOW = new Date("2026-10-11T05:00:00.000Z");
freezeClock(NOW);
const TZ = "Asia/Bangkok";
const LAST = new Date("2026-10-10T11:00:00.000Z");

describe("Play again", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  /** A match these people played, the first organising, scored unless told otherwise. */
  const played = async (together: Player[], over: Partial<CreateEventInput> = {}, o: { scored?: boolean; startsAt?: Date } = {}) => {
    const startsAt = o.startsAt ?? LAST;
    const ev = await createEvent(db, { creatorPlayerId: together[0].id, type: "match", startsAt, tz: TZ, whenFull: "waitlist", venueName: "Warehaus", ...over });
    for (const p of together) await joinEvent(db, { eventId: ev.id, playerId: p.id, now: new Date(startsAt.getTime() - HOUR) });
    if (o.scored !== false) await db.insert(scores).values([{ eventId: ev.id, setNumber: 1, sideA: 6, sideB: 4 }]);
    return ev;
  };

  describe("the day and the time", () => {
    it("defaults to the last game's day and time a week on, in the match's own zone", () => {
      expect(playAgainDefault({ startsAt: LAST, tz: TZ }, NOW)).toEqual({ date: "2026-10-17", time: "18:00" });
      expect(playAgainStart({ startsAt: LAST, tz: TZ }, null, NOW).toISOString()).toBe(nextWeekAfter(LAST, NOW).toISOString());
      // An empty pick is no pick.
      expect(playAgainStart({ startsAt: LAST, tz: TZ }, { date: "", time: "" }, NOW).toISOString()).toBe("2026-10-17T11:00:00.000Z");
    });

    it("counts the weeks from the last game however long ago it was", () => {
      // Three weeks and a day before the last game: the default is still the first Saturday after now.
      expect(playAgainDefault({ startsAt: new Date(LAST.getTime() - 21 * DAY), tz: TZ }, NOW)).toEqual({ date: "2026-10-17", time: "18:00" });
    });

    it("keeps the wall-clock time across a change of clocks", () => {
      // Madrid: Saturday 24 October 18:00 CEST (16:00 UTC). The clocks go back on Sunday 25 October, so
      // a week on is 18:00 CET, 17:00 UTC, and not 17:00 on the wall as seven times 24 hours would make it.
      const madrid = { startsAt: new Date("2026-10-24T16:00:00.000Z"), tz: "Europe/Madrid" };
      const sunday = new Date("2026-10-25T10:00:00.000Z");
      expect(playAgainDefault(madrid, sunday)).toEqual({ date: "2026-10-31", time: "18:00" });
      expect(playAgainStart(madrid, null, sunday).toISOString()).toBe("2026-10-31T17:00:00.000Z");
    });

    it("takes the day and the time the organiser picked, as a wall clock where the match is", () => {
      expect(playAgainStart({ startsAt: LAST, tz: TZ }, { date: "2026-10-15", time: "19:30" }, NOW).toISOString()).toBe("2026-10-15T12:30:00.000Z");
    });

    it("refuses a time already gone, one too far ahead, and anything that is not a day and a time", () => {
      const src = { startsAt: LAST, tz: TZ };
      expect(() => playAgainStart(src, { date: "2026-10-11", time: "11:59" }, NOW)).toThrow();
      expect(() => playAgainStart(src, { date: "2026-10-11", time: "12:00" }, NOW)).toThrow();
      const last = new Date(NOW.getTime() + PLAY_AGAIN_AHEAD_DAYS * DAY);
      expect(() => playAgainStart(src, { date: "2027-01-31", time: "12:00" }, NOW)).toThrow();
      expect(playAgainStart(src, { date: "2026-10-11", time: "12:01" }, NOW).getTime()).toBeLessThan(last.getTime());
      expect(() => playAgainStart(src, { date: "17/10/2026", time: "18:00" }, NOW)).toThrow();
      expect(() => playAgainStart(src, { date: "2026-10-17", time: "6pm" }, NOW)).toThrow();
    });
  });

  it("carries everything over to the day picked, and the crew's match stays the crew's", async () => {
    const ana = await makePlayer(db, "Ana");
    const crew = await createGroup(db, { name: "Saturday crew", creatorPlayerId: ana.id, tz: TZ });
    const old = await played([ana], { groupId: crew.id, durationMinutes: 120, court: "3", levelMin: 2.5, levelMax: 3.5, cost: "400 THB", category: "mixed", capacity: 4 });
    const startsAt = playAgainStart(old, { date: "2026-10-15", time: "19:30" }, NOW);
    const next = await duplicateEvent(db, { sourceEventId: old.id, creatorPlayerId: ana.id, startsAt, now: NOW });
    expect(next.startsAt.toISOString()).toBe("2026-10-15T12:30:00.000Z");
    expect(next.groupId).toBe(crew.id);
    expect({ venue: next.venueName, court: next.court, length: next.durationMinutes, min: next.levelMin, max: next.levelMax, cost: next.cost, category: next.category, capacity: next.capacity }).toEqual({ venue: "Warehaus", court: "3", length: 120, min: 2.5, max: 3.5, cost: "400 THB", category: "mixed", capacity: 4 });
    // No pick, no change from before: a week on.
    const plain = await duplicateEvent(db, { sourceEventId: old.id, creatorPlayerId: ana.id, now: NOW });
    expect(plain.startsAt.toISOString()).toBe("2026-10-17T11:00:00.000Z");
  });

  it("is heard by each player who sat in the last match, and by nobody else", async () => {
    const ana = await makePlayer(db, "Ana");
    const [ben, cy, dee, eve] = [await makePlayer(db, "Ben"), await makePlayer(db, "Cy"), await makePlayer(db, "Dee"), await makePlayer(db, "Eve")];
    const old = await played([ana, ben, cy, dee]);
    // Eve is on the waiting list; a name the organiser held is nobody's inbox.
    await joinEvent(db, { eventId: old.id, playerId: eve.id, now: new Date(LAST.getTime() - HOUR) });
    const people = await playAgainRecipients(db, old, cy.id);
    // Cy tapped "Play again": Cy is not told. Ana organised and played: Ana is told.
    expect(people.map((p) => p.displayName).sort()).toEqual(["Ana", "Ben", "Dee"]);
  });

  it("leaves out a seat held for a name, and a player who deleted their account", async () => {
    const ana = await makePlayer(db, "Ana");
    const [ben, gone] = [await makePlayer(db, "Ben"), await makePlayer(db, "Gone")];
    const old = await played([ana, ben, gone]);
    await reserveNames(db, { eventId: old.id, actorPlayerId: ana.id, names: ["Held"], now: new Date(LAST.getTime() - HOUR) });
    await anonymizePlayer(db, gone.id, NOW);
    const people = await playAgainRecipients(db, old, ana.id);
    expect(people.map((p) => p.displayName)).toEqual(["Ben"]);
  });

  it("claims one round per old match, whoever taps and however often", async () => {
    const ana = await makePlayer(db, "Ana");
    const ben = await makePlayer(db, "Ben");
    const old = await played([ana, ben]);
    const next = await duplicateEvent(db, { sourceEventId: old.id, creatorPlayerId: ana.id, now: NOW });
    const again = await duplicateEvent(db, { sourceEventId: old.id, creatorPlayerId: ben.id, now: NOW });
    const taps = await Promise.all([claimPlayAgainRound(db, old, next, ana.id, NOW), claimPlayAgainRound(db, old, again, ben.id, NOW)]);
    expect(taps.filter(Boolean)).toHaveLength(1);
    expect(await claimPlayAgainRound(db, old, next, ana.id, NOW)).toBe(false);
    const rows = await db.select().from(facts).where(and(eq(facts.kind, PLAY_AGAIN_FACT), eq(facts.subjectId, old.id)));
    expect(rows).toHaveLength(1);
  });

  // PGlite has one connection, so it queues the second transaction and passes with the lock removed:
  // a pass there proves nothing. The test runs where the race is real, on Postgres (CI, or TEST_DATABASE_URL).
  it.skipIf(!process.env.TEST_DATABASE_URL)("makes a second tap wait while the first is still writing, then send nothing", async () => {
    const ana = await makePlayer(db, "Ana");
    const ben = await makePlayer(db, "Ben");
    const old = await played([ana, ben]);
    const next = await duplicateEvent(db, { sourceEventId: old.id, creatorPlayerId: ana.id, now: NOW });
    // The first tap, held open between its write and its commit: the old match locked, its record written.
    // The second tap starts inside that window. A frozen clock and a fast fake hide this race, so the
    // window is made by hand (real Postgres is where it bites: TEST_DATABASE_URL).
    let second: Promise<boolean> | null = null;
    await db.transaction(async (tx) => {
      await tx.select({ id: events.id }).from(events).where(eq(events.id, old.id)).for("update");
      await tx.insert(facts).values({ kind: PLAY_AGAIN_FACT, channel: "web", actorPlayerId: ana.id, subjectType: "match", subjectId: old.id, code: old.code, data: { next: next.code } });
      second = claimPlayAgainRound(db, old, next, ben.id, NOW);
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(await second!).toBe(false);
  });

  it("hands a second tap at the same day and time the game the round already announced", async () => {
    const ana = await makePlayer(db, "Ana");
    const ben = await makePlayer(db, "Ben");
    const old = await played([ana, ben]);
    const next = await duplicateEvent(db, { sourceEventId: old.id, creatorPlayerId: ana.id, startsAt: playAgainStart(old, null, NOW), now: NOW });
    // No round yet: nothing to hand on, and the help line still promises the message.
    expect(await playAgainRoundOf(db, old.id)).toBeNull();
    expect(await sameNextGame(db, old.id, next.startsAt)).toBeNull();
    expect(await claimPlayAgainRound(db, old, next, ana.id, NOW)).toBe(true);
    expect(await playAgainRoundOf(db, old.id)).toEqual({ nextCode: next.code });
    // Ben taps the default too: he lands on Ana's game, the one his message is about.
    expect(await sameNextGame(db, old.id, next.startsAt)).toBe(next.code);
    // Another day is another game.
    expect(await sameNextGame(db, old.id, new Date(next.startsAt.getTime() + DAY))).toBeNull();
    // A game that was called off is not handed on.
    await db.update(events).set({ status: "cancelled" }).where(eq(events.id, next.id));
    expect(await sameNextGame(db, old.id, next.startsAt)).toBeNull();
  });

  describe("the message", () => {
    let calls: { method: string; body: Record<string, unknown> }[] = [];
    beforeEach(() => {
      process.env.TELEGRAM_BOT_TOKEN = "123456:TESTTOKEN";
      calls = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string | URL, init?: RequestInit) => {
          const method = String(url).split("/").pop()!;
          const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          calls.push({ method, body });
          const result = method === "sendMessage" ? { message_id: 900 + calls.length, chat: { id: body.chat_id } } : true;
          return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "content-type": "application/json" } });
        }),
      );
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });
    const dms = (chatId: number) => calls.filter((c) => c.method === "sendMessage" && c.body.chat_id === chatId);

    let tg = 7100;
    const round = async () => {
      const ana = await makePlayer(db, "Ana Ortiz");
      const ben = await makePlayer(db, "Ben", { telegramId: ++tg });
      const cy = await makePlayer(db, "Cy", { telegramId: ++tg });
      const dee = await makePlayer(db, "Dee", { telegramId: ++tg });
      const old = await played([ana, ben, cy, dee]);
      const next = await duplicateEvent(db, { sourceEventId: old.id, creatorPlayerId: ana.id, now: NOW });
      await joinEvent(db, { eventId: next.id, playerId: ana.id });
      return { ana, ben, cy, dee, old, next };
    };

    it("goes once to each player, through the gate in one insert, with the card's one-tap join and the public link", async () => {
      const { ana, ben, cy, dee, old, next } = await round();
      // Dee switched "Your crew" off: the inbox keeps it, nothing is delivered.
      await saveNoticeSettings(db, dee.id, { kinds: { crew: false }, quietFrom: null, quietTo: null, quietTz: null });
      const insert = vi.spyOn(db, "insert");
      const told = await notifyPlayAgain(db, old, next, ana, NOW);
      const noticeInserts = insert.mock.calls.filter(([table]) => table === notices);
      insert.mockRestore();
      expect(noticeInserts).toHaveLength(1);
      expect(told).toBe(3);

      const [dm] = dms(Number(ben.telegramId));
      const text = String(dm.body.text);
      expect(text).toContain("Ana made the next game: Sat, Oct 17 18:00 at Warehaus. I'm in?");
      expect(text).not.toContain("Ortiz");
      const buttons = (dm.body.reply_markup as { inline_keyboard: { text: string; callback_data?: string; url?: string }[][] }).inline_keyboard.flat();
      expect(buttons).toContainEqual({ text: "✅ I'm in", callback_data: `j:${next.code}` });
      // A forwarded message keeps its buttons: the public link, never a personal one.
      for (const b of buttons) expect(b.url ?? "").not.toContain("/p/");
      expect(dms(Number(cy.telegramId))).toHaveLength(1);
      expect(dms(Number(dee.telegramId))).toHaveLength(0);

      const rows = await db.select().from(notices).where(eq(notices.eventId, next.id));
      expect(rows.map((r) => r.playerId).sort()).toEqual([ben.id, cy.id, dee.id].sort());
      expect(new Set(rows.map((r) => `${r.kind}:${r.key}`))).toEqual(new Set(["crew:noticeItem.playAgain"]));
      expect(rows.find((r) => r.playerId === dee.id)?.deliveredAt).toBeNull();

      // The second tap on the same old match sends nothing and writes nothing.
      calls = [];
      expect(await notifyPlayAgain(db, old, next, ana, NOW)).toBe(0);
      expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(0);
      expect(await db.select().from(notices).where(eq(notices.eventId, next.id))).toHaveLength(3);
    });

    it("sends nothing for a match nobody has played yet, and keeps its round for after the game", async () => {
      // Zed, a stranger, takes the free seat of Ana's match three days ahead and taps "Play again".
      const ana = await makePlayer(db, "Ana");
      const [ben, cy, zed] = [await makePlayer(db, "Ben", { telegramId: ++tg }), await makePlayer(db, "Cy", { telegramId: ++tg }), await makePlayer(db, "Zed")];
      const start = new Date(NOW.getTime() + 3 * DAY);
      const ahead = await played([ana, ben, cy], {}, { scored: false, startsAt: start });
      await joinEvent(db, { eventId: ahead.id, playerId: zed.id, now: NOW });
      const next = await duplicateEvent(db, { sourceEventId: ahead.id, creatorPlayerId: zed.id, now: NOW });
      expect(await notifyPlayAgain(db, ahead, next, zed, NOW)).toBe(0);
      // A score typed in before the start does not make it played.
      await db.insert(scores).values([{ eventId: ahead.id, setNumber: 1, sideA: 6, sideB: 1 }]);
      expect(await notifyPlayAgain(db, ahead, next, zed, NOW)).toBe(0);
      expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(0);
      expect(await playAgainRoundOf(db, ahead.id)).toBeNull();
      // After the game, with its score, Ana's tap still has the one round.
      const after = new Date(start.getTime() + 2 * HOUR);
      const real = await duplicateEvent(db, { sourceEventId: ahead.id, creatorPlayerId: ana.id, now: after });
      expect(await notifyPlayAgain(db, ahead, real, ana, after)).toBe(3);
    });

    it("sends nothing for a match that was called off, even with a score", async () => {
      const { ana, old, next } = await round();
      await db.update(events).set({ status: "cancelled" }).where(eq(events.id, old.id));
      expect(await notifyPlayAgain(db, old, next, ana, NOW)).toBe(0);
      expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(0);
    });

    it("by email carries the public match link and no link that binds or signs anybody in", async () => {
      const sinkFile = path.join(mkdtempSync(path.join(tmpdir(), "play-again-")), "mail.jsonl");
      process.env.RESEND_API_KEY = "re_test_only";
      process.env.EMAIL_SINK_FILE = sinkFile;
      process.env.TELEGRAM_BOT_USERNAME = "kicksmash_test_bot";
      const ana = await makePlayer(db, "Ana");
      // Fay has an address and no Telegram: the email is her channel, the one a "get this on Telegram" line would ride on.
      const fay = await makePlayer(db, "Fay", { email: "fay@example.com" });
      const old = await played([ana, fay]);
      const next = await duplicateEvent(db, { sourceEventId: old.id, creatorPlayerId: ana.id, now: NOW });
      expect(await notifyPlayAgain(db, old, next, ana, NOW)).toBe(1);
      const [mail] = readFileSync(sinkFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { to: string; subject: string; text: string });
      expect(mail.to).toBe("fay@example.com");
      expect(mail.subject).toContain("Ana made the next game");
      expect(mail.text).toContain(`/${next.code}`);
      // Forwarded to a friend, it must not hand the friend Fay's account.
      expect(mail.text).not.toContain("start=p_");
      expect(mail.text).not.toContain("t.me/");
      expect(mail.text).not.toContain("/p/");
    });

    it("lets the player in with the one tap", async () => {
      const { ben, next } = await round();
      const { handleTelegramUpdate } = await import("@/lib/telegram/bot");
      const tap = await handleTelegramUpdate(db, { update_id: 1, callback_query: { id: "cb1", from: { id: Number(ben.telegramId), first_name: "Ben", language_code: "en" }, message: { message_id: 901, date: 0, chat: { id: Number(ben.telegramId), type: "private" } }, data: `j:${next.code}` } }, NO_SIDE_EFFECTS);
      expect(tap).toBe("join:joined");
    });
  });

  describe("the level range, for somebody the organiser played with", () => {
    const ranged = (org: Player, over: Partial<CreateEventInput> = {}) => createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() + 6 * DAY), tz: TZ, whenFull: "waitlist", levelMin: 3, levelMax: 3.5, ...over });
    const join = async (ev: Event, p: Player) => joinWithPolicy(db, (await getEventByCode(db, ev.code))!, p, p.level);

    it("is the pure rule: only a range that would hold the request is waived, never a missing level", () => {
      expect(waivedByPlay("below", true)).toBe("ok");
      expect(waivedByPlay("above", true)).toBe("ok");
      expect(waivedByPlay("unverified", true)).toBe("ok");
      expect(waivedByPlay("unknown", true)).toBe("unknown");
      expect(waivedByPlay("below", false)).toBe("below");
      expect(waivedByPlay("ok", false)).toBe("ok");
    });

    it("lets a player who sat in a finished, scored match with the organiser straight in", async () => {
      const org = await makePlayer(db, "Org", { level: 3.25 });
      const pal = await makePlayer(db, "Pal", { level: 2 });
      await played([org, pal]);
      expect(await playedWithOrganiser(db, org.id, pal.id, NOW)).toBe(true);
      const ev = await ranged(org);
      expect(await join(ev, pal)).toMatchObject({ kind: "joined", result: { outcome: "joined" } });
    });

    it("lets them in through the chat's one tap and the API too", async () => {
      const org = await makePlayer(db, "Org", { level: 3.25 });
      const pal = await makePlayer(db, "Pal", { level: 5 });
      await played([org, pal]);
      const ev = await ranged(org);
      const r = await joinAsPlayer(db, (await getEventByCode(db, ev.code))!, pal, NO_SIDE_EFFECTS);
      expect(r.outcome).toBe("joined");
    });

    it("takes a confirmed-levels-only match as well", async () => {
      const org = await makePlayer(db, "Org", { level: 3.25 });
      const pal = await makePlayer(db, "Pal", { level: 3.25 });
      await played([org, pal]);
      const ev = await ranged(org, { levelVerifiedOnly: true });
      expect(await admissionAt(db, ev, pal, NOW)).toBe("ok");
      expect(await join(ev, pal)).toMatchObject({ kind: "joined" });
    });

    it("still holds a player whose match with the organiser has no score", async () => {
      const org = await makePlayer(db, "Org", { level: 3.25 });
      const pal = await makePlayer(db, "Pal", { level: 2 });
      await played([org, pal], {}, { scored: false });
      expect(await playedWithOrganiser(db, org.id, pal.id, NOW)).toBe(false);
      expect(await join(await ranged(org), pal)).toEqual({ kind: "requested" });
    });

    it("counts a match scored at the court, before its booked length is over", async () => {
      const org = await makePlayer(db, "Org", { level: 3.25 });
      const pal = await makePlayer(db, "Pal", { level: 2 });
      // Started 75 minutes ago and booked for 90: the score is in, so the game is finished in practice,
      // and Pal's "I'm in" on the next game must not turn into a request for the last quarter of an hour.
      await played([org, pal], {}, { startsAt: new Date(NOW.getTime() - 75 * 60_000) });
      expect(await playedWithOrganiser(db, org.id, pal.id, NOW)).toBe(true);
      expect(await join(await ranged(org), pal)).toMatchObject({ kind: "joined" });
    });

    it("does not count a score on a match that has not started", async () => {
      const org = await makePlayer(db, "Org", { level: 3.25 });
      const pal = await makePlayer(db, "Pal", { level: 2 });
      await played([org, pal], {}, { startsAt: new Date(NOW.getTime() + HOUR) });
      expect(await playedWithOrganiser(db, org.id, pal.id, NOW)).toBe(false);
    });

    it("still holds a player whose scored match with the organiser was then called off", async () => {
      const org = await makePlayer(db, "Org", { level: 3.25 });
      const pal = await makePlayer(db, "Pal", { level: 2 });
      const ev = await played([org, pal]);
      await db.update(events).set({ status: "cancelled" }).where(eq(events.id, ev.id));
      expect(await playedWithOrganiser(db, org.id, pal.id, NOW)).toBe(false);
      expect(await join(await ranged(org), pal)).toEqual({ kind: "requested" });
    });

    it("still holds a player when the organiser only waited on the list, or declined the seat", async () => {
      const org = await makePlayer(db, "Org", { level: 3.25 });
      const pal = await makePlayer(db, "Pal", { level: 2 });
      // Org made a full match and sat on its waiting list: Pal held a seat, Org never played with Pal.
      const [x, y, z] = [await makePlayer(db, "X"), await makePlayer(db, "Y"), await makePlayer(db, "Z")];
      const full = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: LAST, tz: TZ, whenFull: "waitlist", capacity: 4 });
      for (const p of [pal, x, y, z, org]) await joinEvent(db, { eventId: full.id, playerId: p.id, now: new Date(LAST.getTime() - HOUR) });
      await db.insert(scores).values([{ eventId: full.id, setNumber: 1, sideA: 6, sideB: 3 }]);
      expect(await playedWithOrganiser(db, org.id, pal.id, NOW)).toBe(false);
      expect(await join(await ranged(org), pal)).toEqual({ kind: "requested" });
      // Org's seat inside the line-up, but declined: not a taken seat either.
      const other = await makePlayer(db, "Pat", { level: 2 });
      const ev = await played([org, other]);
      await db.update(slots).set({ status: "declined" }).where(and(eq(slots.eventId, ev.id), eq(slots.playerId, org.id)));
      expect(await playedWithOrganiser(db, org.id, other.id, NOW)).toBe(false);
    });

    it("counts a scored americano with the organiser, and not one with no score", async () => {
      const org = await makePlayer(db, "Org", { level: 3.25 });
      const pal = await makePlayer(db, "Pal", { level: 2 });
      const [x, y] = [await makePlayer(db, "X"), await makePlayer(db, "Y")];
      const night = await played([org, pal, x, y], { type: "tournament", capacity: 4 }, { scored: false });
      expect(await playedWithOrganiser(db, org.id, pal.id, NOW)).toBe(false);
      const [r] = await db.insert(tournamentRounds).values({ eventId: night.id, roundNumber: 1 }).returning();
      await db.insert(tournamentMatches).values({ roundId: r.id, court: 1, a1: org.id, a2: pal.id, b1: x.id, b2: y.id });
      // A round drawn but not scored is not a game played.
      expect(await playedWithOrganiser(db, org.id, pal.id, NOW)).toBe(false);
      await db.update(tournamentMatches).set({ sideA: 16, sideB: 8 }).where(eq(tournamentMatches.roundId, r.id));
      expect(await playedWithOrganiser(db, org.id, pal.id, NOW)).toBe(true);
    });

    it("still holds a player who played with somebody else, or on the organiser's waiting list", async () => {
      const org = await makePlayer(db, "Org", { level: 3.25 });
      const other = await makePlayer(db, "Other", { level: 3 });
      const pal = await makePlayer(db, "Pal", { level: 2 });
      // Organised by Org, but Org did not sit in it: Org never saw Pal play.
      const ev0 = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: LAST, tz: TZ, whenFull: "waitlist" });
      for (const p of [other, pal]) await joinEvent(db, { eventId: ev0.id, playerId: p.id, now: new Date(LAST.getTime() - HOUR) });
      await db.insert(scores).values([{ eventId: ev0.id, setNumber: 1, sideA: 6, sideB: 2 }]);
      expect(await playedWithOrganiser(db, org.id, pal.id, NOW)).toBe(false);
      // A full match where Pal only waited.
      const full = await played([org, other, await makePlayer(db, "X"), await makePlayer(db, "Y")]);
      await joinEvent(db, { eventId: full.id, playerId: pal.id, now: new Date(LAST.getTime() - HOUR) });
      expect(await playedWithOrganiser(db, org.id, pal.id, NOW)).toBe(false);
      expect(await join(await ranged(org), pal)).toEqual({ kind: "requested" });
    });

    it("still asks a player with no level for one: nothing else about levels changes", async () => {
      const org = await makePlayer(db, "Org", { level: 3.25 });
      const pal = await makePlayer(db, "Pal");
      await played([org, pal]);
      expect(await join(await ranged(org), pal)).toEqual({ kind: "level_required" });
    });

    it("is the organiser's own range only: another organiser's match still holds them", async () => {
      const org = await makePlayer(db, "Org", { level: 3.25 });
      const host = await makePlayer(db, "Host", { level: 3.25 });
      const pal = await makePlayer(db, "Pal", { level: 2 });
      await played([org, pal]);
      expect(await join(await ranged(host), pal)).toEqual({ kind: "requested" });
    });

    it("reads nothing for a player the range lets in anyway", async () => {
      const org = await makePlayer(db, "Org", { level: 3.25 });
      const fits = await makePlayer(db, "Fits", { level: 3.25 });
      const ev = await ranged(org);
      const select = vi.spyOn(db, "select");
      expect(await admissionAt(db, ev, fits, NOW)).toBe("ok");
      expect(select).not.toHaveBeenCalled();
      select.mockRestore();
    });
  });

  describe("the weekly slot beside it", () => {
    // The hourly run on Tuesday 13 October, inside the slot's five days of lead time before Saturday 17 October.
    const TUESDAY = new Date("2026-10-13T05:00:00.000Z");
    const groupRow = async (id: string) => (await db.select().from(groups).where(eq(groups.id, id)))[0];
    const inSlot = async (groupId: string, at: Date) => db.select().from(events).where(and(eq(events.groupId, groupId), eq(events.startsAt, at)));

    it("never makes a second match for the hour \"Play again\" already took (the weekly slot first)", async () => {
      const ana = await makePlayer(db, "Ana");
      const old = await played([ana, await makePlayer(db, "Ben")]);
      const { group } = await weeklyGroupFromEvent(db, { eventId: old.id, actorPlayerId: ana.id, fallbackName: "Crew" });
      const [fresh] = await db.select().from(events).where(eq(events.id, old.id));
      const next = await duplicateEvent(db, { sourceEventId: old.id, creatorPlayerId: ana.id, startsAt: playAgainStart(fresh, null, NOW), now: NOW });
      expect(next.groupId).toBe(group.id);
      expect((await autoCreateGroupMatches(db, TUESDAY)).filter((c) => c.group.id === group.id)).toHaveLength(0);
      expect(await inSlot(group.id, next.startsAt)).toHaveLength(1);
      // The slot counts as made, so the next hour does not look at it again.
      expect((await groupRow(group.id)).recurLastCreatedFor?.toISOString()).toBe(next.startsAt.toISOString());
    });

    it("takes the game \"Play again\" made into the crew, so the slot sees it (\"Play again\" first)", async () => {
      const ana = await makePlayer(db, "Ana");
      const old = await played([ana, await makePlayer(db, "Ben")]);
      const next = await duplicateEvent(db, { sourceEventId: old.id, creatorPlayerId: ana.id, startsAt: playAgainStart(old, null, NOW), now: NOW });
      expect(await claimPlayAgainRound(db, old, next, ana.id, NOW)).toBe(true);
      const { group } = await weeklyGroupFromEvent(db, { eventId: old.id, actorPlayerId: ana.id, fallbackName: "Crew" });
      expect((await getEventByCode(db, next.code))!.event.groupId).toBe(group.id);
      expect((await autoCreateGroupMatches(db, TUESDAY)).filter((c) => c.group.id === group.id)).toHaveLength(0);
      expect(await inSlot(group.id, next.startsAt)).toHaveLength(1);
    });

    it("still makes the slot's match when the game at that hour was called off", async () => {
      const ana = await makePlayer(db, "Ana");
      const old = await played([ana, await makePlayer(db, "Ben")]);
      const { group } = await weeklyGroupFromEvent(db, { eventId: old.id, actorPlayerId: ana.id, fallbackName: "Crew" });
      const [fresh] = await db.select().from(events).where(eq(events.id, old.id));
      const next = await duplicateEvent(db, { sourceEventId: old.id, creatorPlayerId: ana.id, startsAt: playAgainStart(fresh, null, NOW), now: NOW });
      await db.update(events).set({ status: "cancelled" }).where(eq(events.id, next.id));
      expect((await autoCreateGroupMatches(db, TUESDAY)).filter((c) => c.group.id === group.id)).toHaveLength(1);
    });
  });

  it("keeps the old match untouched", async () => {
    const ana = await makePlayer(db, "Ana");
    const old = await played([ana]);
    await duplicateEvent(db, { sourceEventId: old.id, creatorPlayerId: ana.id, startsAt: playAgainStart(old, { date: "2026-10-20", time: "07:00" }, NOW), now: NOW });
    const [row] = await db.select().from(events).where(eq(events.id, old.id));
    expect(row.startsAt.toISOString()).toBe(LAST.toISOString());
  });
});
