import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events, facts, notices, scores, type Event, type Player } from "@/db/schema";
import { NO_SIDE_EFFECTS, joinAsPlayer } from "@/lib/api/operations";
import { anonymizePlayer } from "@/lib/domain/anonymize";
import { createEvent, duplicateEvent, nextWeekAfter, type CreateEventInput } from "@/lib/domain/events";
import { createGroup } from "@/lib/domain/groups";
import { joinWithPolicy } from "@/lib/domain/joining";
import { waivedByPlay } from "@/lib/domain/levels";
import { saveNoticeSettings } from "@/lib/domain/notices";
import { admissionAt, claimPlayAgainRound, playAgainDefault, playAgainRecipients, playAgainStart, playedWithOrganiser, PLAY_AGAIN_FACT, PLAY_AGAIN_AHEAD_DAYS } from "@/lib/domain/playAgain";
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
    const taps = await Promise.all([claimPlayAgainRound(db, old, next, ana.id), claimPlayAgainRound(db, old, again, ben.id)]);
    expect(taps.filter(Boolean)).toHaveLength(1);
    expect(await claimPlayAgainRound(db, old, next, ana.id)).toBe(false);
    const rows = await db.select().from(facts).where(and(eq(facts.kind, PLAY_AGAIN_FACT), eq(facts.subjectId, old.id)));
    expect(rows).toHaveLength(1);
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

    it("still holds a player whose scored match is not over yet", async () => {
      const org = await makePlayer(db, "Org", { level: 3.25 });
      const pal = await makePlayer(db, "Pal", { level: 2 });
      // Started half an hour ago: a 90-minute match is still on, even with a score typed in.
      await played([org, pal], {}, { startsAt: new Date(NOW.getTime() - HOUR / 2) });
      expect(await playedWithOrganiser(db, org.id, pal.id, NOW)).toBe(false);
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

  it("keeps the old match untouched", async () => {
    const ana = await makePlayer(db, "Ana");
    const old = await played([ana]);
    await duplicateEvent(db, { sourceEventId: old.id, creatorPlayerId: ana.id, startsAt: playAgainStart(old, { date: "2026-10-20", time: "07:00" }, NOW), now: NOW });
    const [row] = await db.select().from(events).where(eq(events.id, old.id));
    expect(row.startsAt.toISOString()).toBe(LAST.toISOString());
  });
});
