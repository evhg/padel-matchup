import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, asc, eq, lte } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { duplicateEventAction } from "@/actions/events";
import { events, metricsDaily, notices, scores, slots, type Event, type Player } from "@/db/schema";
import { anonymizePlayer } from "@/lib/domain/anonymize";
import { createEvent, type CreateEventInput } from "@/lib/domain/events";
import { createGroup } from "@/lib/domain/groups";
import { dayKey } from "@/lib/domain/metrics";
import { playAgainRoundOf, playAgainStart, playAgainTap } from "@/lib/domain/playAgain";
import { LIMITS, takeRate } from "@/lib/domain/ratelimit";
import { joinEvent } from "@/lib/domain/slots";
import { PLAYER_COOKIE, sealPlayerId } from "@/lib/session";
import { asAction } from "./helpers/action";
import { freezeClock } from "./helpers/clock";
import { DAY, HOUR, makePlayer } from "./helpers/db";

/**
 * The owner's report of 9 November 2026: "when erik clicked play again, he had to add the players
 * again". Erik tapped "Play again" on hirx at 04:56:04 UTC; the new match RcEy had only Erik, and Erik
 * held Jakob, Nicolai and Tim one at a time at 04:56:30, :34 and :37. None of the three has a channel,
 * so the "Are you in?" messages reached nobody. Rule 37's goal is "Make the one working group repeat
 * itself", so the tap now holds a place for each player of the last match, each keeping its record, as
 * a "Played with you" pick does (DECIDING rules 34 and 37).
 *
 * The clock: Monday 9 November 2026, 04:56 UTC (11:56 in Phuket). The last game was Sunday 8 November
 * at 18:00 in Phuket (11:00 UTC), scored. A week on is Sunday 15 November, 18:00.
 */
const NOW = new Date("2026-11-09T04:56:04.000Z");
freezeClock(NOW);
const TZ = "Asia/Bangkok";
const LAST = new Date("2026-11-08T11:00:00.000Z");

let db: Db;
const mailKey = process.env.RESEND_API_KEY;
beforeAll(async () => {
  db = await getDb();
  // No mail goes out in these tests: the machine's own key never sends a test's notice.
  delete process.env.RESEND_API_KEY;
});
afterAll(() => {
  if (mailKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = mailKey;
});

let n = 0;
/** A match these people played, in this seat order, the first organising, scored unless told otherwise. */
const played = async (together: Player[], over: Partial<CreateEventInput> = {}, o: { scored?: boolean } = {}) => {
  const ev = await createEvent(db, { creatorPlayerId: together[0].id, type: "match", startsAt: LAST, tz: TZ, whenFull: "waitlist", venueName: `Warehaus ${++n}`, ...over });
  for (const p of together) await joinEvent(db, { eventId: ev.id, playerId: p.id, now: new Date(LAST.getTime() - HOUR) });
  if (o.scored !== false) await db.insert(scores).values([{ eventId: ev.id, setNumber: 1, sideA: 6, sideB: 4 }]);
  const [fresh] = await db.select().from(events).where(eq(events.id, ev.id));
  return fresh;
};
/** The line-up inside the capacity, in seat order: name, record, status. */
const lineup = async (ev: Pick<Event, "id" | "capacity">) =>
  (await db.select().from(slots).where(and(eq(slots.eventId, ev.id), lte(slots.position, ev.capacity))).orderBy(asc(slots.position)))
    .filter((s) => s.status !== "empty")
    .map((s) => [s.invitedName ?? "(seat)", s.playerId, s.status]);
const metric = async (key: string) => Number((await db.select().from(metricsDaily).where(and(eq(metricsDaily.day, dayKey(NOW)), eq(metricsDaily.key, key))))[0]?.value ?? 0);
const tap = (old: Event, by: Player, o: { startsAt?: Date; records?: boolean } = {}) =>
  playAgainTap(db, old, { creatorPlayerId: by.id, startsAt: o.startsAt ?? playAgainStart(old, null, NOW), now: NOW, records: o.records ?? true });
const eriksCrew = async (extra: Partial<typeof import("@/db/schema").players.$inferInsert> = {}) => {
  // Made in another order than they sat, so the seat order, not the age of a record, decides.
  const tim = await makePlayer(db, "Tim", extra);
  const nicolai = await makePlayer(db, "Nicolai");
  const jakob = await makePlayer(db, "Jakob");
  const erik = await makePlayer(db, `Erik ${n}`);
  return { erik, jakob, nicolai, tim };
};

describe("\"Play again\" holds the last players' places", () => {
  it("the owner's case: three players hold three places, each with its record, in seat order, in one transaction with the game", async () => {
    const { erik, jakob, nicolai, tim } = await eriksCrew();
    const hirx = await played([erik, jakob, nicolai, tim]);
    const t = await tap(hirx, erik);
    expect(t).toMatchObject({ made: true, joined: true, claimed: true, held: [jakob.id, nicolai.id, tim.id] });
    expect(await lineup(t.event)).toEqual([
      ["(seat)", erik.id, "joined"],
      ["Jakob", jakob.id, "invited"],
      ["Nicolai", nicolai.id, "invited"],
      ["Tim", tim.id, "invited"],
    ]);
    // Each place is a held place, as a "Played with you" pick makes it: no typed email, no phone.
    const held = await db.select().from(slots).where(and(eq(slots.eventId, t.event.id), eq(slots.kind, "reserved")));
    expect(held.map((s) => [s.invitedEmail, s.invitedPhone, Boolean(s.inviteCode)])).toEqual([
      [null, null, true],
      [null, null, true],
      [null, null, true],
    ]);
    // One rate check, counting the three places against the organiser's daily limit for held places.
    expect(await metric(`rl:reserve:${erik.id}`)).toBe(3);
    expect(await playAgainRoundOf(db, hirx.id)).toEqual({ nextCode: t.event.code });
  });

  it("holds nothing for a deleted player, a player past the capacity, the waiting list or the tapper", async () => {
    const { erik, jakob, tim } = await eriksCrew();
    const [gone, pia, wes] = [await makePlayer(db, "Gone"), await makePlayer(db, "Pia"), await makePlayer(db, "Wes")];
    // Four seats, then Pia and Wes on the waiting list. Pia's row is then a taken seat past the capacity,
    // as an americano's first round leaves one when it shrinks the field.
    const old = await played([erik, jakob, gone, tim, pia, wes]);
    expect(old.capacity).toBe(4);
    await db.update(slots).set({ status: "joined" }).where(and(eq(slots.eventId, old.id), eq(slots.playerId, pia.id)));
    await anonymizePlayer(db, gone.id, NOW);
    // Jakob, who sat in the line-up, taps: Jakob organises the next game and takes its first seat.
    const t = await tap(old, jakob);
    expect(t.held).toEqual([erik.id, tim.id]);
    expect(await lineup(t.event)).toEqual([
      ["(seat)", jakob.id, "joined"],
      [erik.displayName, erik.id, "invited"],
      ["Tim", tim.id, "invited"],
    ]);
  });

  it("holds only what fits a smaller game, in seat order, and never a second place for a player already in it", async () => {
    const erik = await makePlayer(db, `Erik ${n}`);
    const [ana, bo, cy, di, ed] = [await makePlayer(db, "Ana"), await makePlayer(db, "Bo"), await makePlayer(db, "Cy"), await makePlayer(db, "Di"), await makePlayer(db, "Ed")];
    // An americano night of eight, six of them in.
    const old = await played([erik, ana, bo, cy, di, ed], { type: "tournament", capacity: 8 });
    // Erik made the week's night for four by hand at the same club, and Bo took a seat in it.
    const startsAt = new Date(LAST.getTime() + 7 * DAY);
    const week = await createEvent(db, { creatorPlayerId: erik.id, type: "tournament", startsAt, tz: TZ, whenFull: "waitlist", venueName: old.venueName!, capacity: 4 });
    for (const p of [erik, bo]) await joinEvent(db, { eventId: week.id, playerId: p.id, now: NOW });
    const t = await tap(old, erik, { startsAt });
    expect(t).toMatchObject({ made: false, claimed: true, event: { code: week.code } });
    // Two places were open: Ana and Cy, by the old seat order; Bo is in already; Di and Ed find no place.
    expect(t.held).toEqual([ana.id, cy.id]);
    expect(await lineup(week)).toEqual([
      ["(seat)", erik.id, "joined"],
      ["(seat)", bo.id, "joined"],
      ["Ana", ana.id, "invited"],
      ["Cy", cy.id, "invited"],
    ]);
    expect(await metric(`rl:reserve:${erik.id}`), "the rate counts the places held, not the players asked").toBe(2);
  });

  it("holds nothing in a game that another player organises", async () => {
    const { erik, jakob, nicolai, tim } = await eriksCrew();
    const old = await played([erik, jakob, nicolai, tim]);
    const startsAt = new Date(LAST.getTime() + 7 * DAY);
    const week = await createEvent(db, { creatorPlayerId: erik.id, type: "match", startsAt, tz: TZ, whenFull: "waitlist", venueName: old.venueName! });
    await joinEvent(db, { eventId: week.id, playerId: erik.id, now: NOW });
    // Jakob taps at that day and time: the tap lands on Erik's game. Only its organiser holds places there.
    const t = await tap(old, jakob, { startsAt });
    expect(t).toMatchObject({ made: false, claimed: true, held: [], event: { code: week.code } });
    expect(await lineup(week)).toEqual([["(seat)", erik.id, "joined"]]);
  });

  it("holds by name only, with no record, for a session by name", async () => {
    const { erik, jakob, nicolai, tim } = await eriksCrew();
    const t = await tap(await played([erik, jakob, nicolai, tim]), erik, { records: false });
    expect(t.held).toEqual([jakob.id, nicolai.id, tim.id]);
    expect(await lineup(t.event)).toEqual([
      ["(seat)", erik.id, "joined"],
      ["Jakob", null, "invited"],
      ["Nicolai", null, "invited"],
      ["Tim", null, "invited"],
    ]);
  });

  it("holds nothing on a second tap on the same old match, at the same time or another", async () => {
    const { erik, jakob, nicolai, tim } = await eriksCrew();
    const old = await played([erik, jakob, nicolai, tim]);
    const first = await tap(old, erik);
    const before = await lineup(first.event);
    const again = await tap(old, jakob);
    expect(again).toMatchObject({ made: false, claimed: false, held: [], event: { code: first.event.code } });
    expect(await lineup(first.event)).toEqual(before);
    // Another day is another game, and the one round is spent: nobody is held twice.
    const other = await tap(old, erik, { startsAt: new Date(playAgainStart(old, null, NOW).getTime() + DAY) });
    expect(other).toMatchObject({ made: true, claimed: false, held: [] });
    expect(await lineup(other.event)).toEqual([["(seat)", erik.id, "joined"]]);
  });

  it("holds nothing for a match nobody has played yet, and keeps the round for after the game", async () => {
    const { erik, jakob, nicolai, tim } = await eriksCrew();
    const old = await played([erik, jakob, nicolai, tim], {}, { scored: false });
    expect(await tap(old, erik)).toMatchObject({ made: true, claimed: false, held: [] });
    expect(await playAgainRoundOf(db, old.id)).toBeNull();
  });

  it("keeps a crew's game the crew's, with the places held", async () => {
    const { erik, jakob, nicolai, tim } = await eriksCrew();
    const crew = await createGroup(db, { name: `Sunday crew ${n}`, creatorPlayerId: erik.id, tz: TZ });
    const t = await tap(await played([erik, jakob, nicolai, tim], { groupId: crew.id }), erik);
    expect(t.event.groupId).toBe(crew.id);
    expect(t.held).toEqual([jakob.id, nicolai.id, tim.id]);
  });

  it("holds nothing on a fixed-pairs night: the pairs sign up again", async () => {
    const { erik, jakob, nicolai, tim } = await eriksCrew();
    const old = await played([erik, jakob, nicolai, tim], { type: "tournament", fixedPairs: true, capacity: 4 });
    expect(old.fixedPairs).toBe(true);
    const t = await tap(old, erik);
    expect(t).toMatchObject({ made: true, claimed: true, held: [], event: { fixedPairs: true } });
  });

  it("holds nothing past the organiser's daily limit for held places, and the game and its round still go", async () => {
    const { erik, jakob, nicolai, tim } = await eriksCrew();
    const old = await played([erik, jakob, nicolai, tim]);
    await takeRate(db, "reserve", erik.id, LIMITS.reservesPerOrganizerPerDay, "day", NOW, LIMITS.reservesPerOrganizerPerDay - 2);
    const t = await tap(old, erik);
    expect(t).toMatchObject({ made: true, joined: true, claimed: true, held: [] });
    expect(await lineup(t.event)).toEqual([["(seat)", erik.id, "joined"]]);
  });
});

describe("\"Play again\" from the browser", () => {
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
  const as = (p: Player): Record<string, string> => ({ [PLAYER_COOKIE]: sealPlayerId(p.id) });
  const byName = (p: Player): Record<string, string> => ({ [PLAYER_COOKIE]: sealPlayerId(p.id, { byName: true }) });
  /** The tap as the page sends it; the answer is a redirect, read from its digest. */
  const playAgain = async (jar: Record<string, string>, code: string) => {
    const { result } = await asAction(jar, () => duplicateEventAction(code, null).catch((e: unknown) => e));
    const to = String((result as { digest?: string })?.digest ?? "").match(/;(\/[^;]+);/)?.[1];
    expect(to, JSON.stringify(result)).toBeTruthy();
    return to!;
  };
  let tg = 9100;
  const dms = (chatId: number) => calls.filter((c) => c.method === "sendMessage" && c.body.chat_id === chatId);

  it("lands the organiser on the new match with the places held, and tells a held player with a channel once that a place is held", async () => {
    const { erik, jakob, nicolai, tim } = await eriksCrew({ telegramId: ++tg });
    const hirx = await played([erik, jakob, nicolai, tim]);
    const counted = await metric("play_again_held");
    const to = await playAgain(as(erik), hirx.code);
    // The match page, where the line-up shows the held places and the one message for them; not the share page.
    expect(to).toMatch(/^\/[^/]+$/);
    const [rcey] = await db.select().from(events).where(eq(events.code, to.slice(1)));
    expect(await lineup(rcey)).toEqual([
      ["(seat)", erik.id, "joined"],
      ["Jakob", jakob.id, "invited"],
      ["Nicolai", nicolai.id, "invited"],
      ["Tim", tim.id, "invited"],
    ]);
    expect(await metric("play_again_held")).toBe(counted + 3);
    // Each of the three has the message in the inbox, marked held; Tim, who has Telegram, hears it once.
    const rows = await db.select().from(notices).where(eq(notices.eventId, rcey.id));
    expect(rows.map((r) => [r.playerId, r.key, (r.params as { what?: string }).what]).sort()).toEqual(
      [
        [jakob.id, "noticeItem.playAgain", "held"],
        [nicolai.id, "noticeItem.playAgain", "held"],
        [tim.id, "noticeItem.playAgain", "held"],
      ].sort(),
    );
    const [dm, ...more] = dms(Number(tim.telegramId));
    expect(more).toHaveLength(0);
    expect(String(dm.body.text)).toContain(`${erik.displayName.split(" ")[0]} made the next game: Sun, Nov 15 18:00 at ${hirx.venueName}. A place is held for you. Are you in?`);

    // The second tap, at the same day and time: the same game, and nothing new.
    calls = [];
    expect(await playAgain(as(erik), hirx.code)).toBe(to);
    expect(await lineup(rcey)).toEqual([
      ["(seat)", erik.id, "joined"],
      ["Jakob", jakob.id, "invited"],
      ["Nicolai", nicolai.id, "invited"],
      ["Tim", tim.id, "invited"],
    ]);
    expect(await db.select().from(notices).where(eq(notices.eventId, rcey.id))).toHaveLength(3);
    expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(0);
    expect(await metric("play_again_held")).toBe(counted + 3);
  });

  it("tells a player it could not hold a place for the plain question, with no held line", async () => {
    const erik = await makePlayer(db, `Erik ${++n}`);
    const [ana, bo, cy] = [await makePlayer(db, "Ana"), await makePlayer(db, "Bo"), await makePlayer(db, "Cy", { telegramId: ++tg })];
    const old = await played([erik, ana, bo, cy]);
    // Erik's next game has Sam already, so Cy, last in the seat order, finds no place.
    const startsAt = playAgainStart(old, null, NOW);
    const week = await createEvent(db, { creatorPlayerId: erik.id, type: "match", startsAt, tz: TZ, whenFull: "waitlist", venueName: old.venueName! });
    for (const p of [erik, await makePlayer(db, "Sam")]) await joinEvent(db, { eventId: week.id, playerId: p.id, now: NOW });
    expect(await playAgain(as(erik), old.code)).toBe(`/${week.code}`);
    const rows = await db.select().from(notices).where(eq(notices.eventId, week.id));
    expect(Object.fromEntries(rows.map((r) => [r.playerId, (r.params as { what?: string }).what]))).toEqual({ [ana.id]: "held", [bo.id]: "held", [cy.id]: "other" });
    const [dm] = dms(Number(cy.telegramId));
    expect(String(dm.body.text)).toContain("Are you in?");
    expect(String(dm.body.text)).not.toContain("held");
  });

  it("holds by name only for an organiser whose session is by name", async () => {
    const { erik, jakob, nicolai, tim } = await eriksCrew();
    const to = await playAgain(byName(erik), (await played([erik, jakob, nicolai, tim])).code);
    const [rcey] = await db.select().from(events).where(eq(events.code, to.slice(1)));
    expect(await lineup(rcey)).toEqual([
      ["(seat)", erik.id, "joined"],
      ["Jakob", null, "invited"],
      ["Nicolai", null, "invited"],
      ["Tim", null, "invited"],
    ]);
  });

  it("lands on the share page, as before, when it holds nobody", async () => {
    const erik = await makePlayer(db, `Erik ${++n}`);
    expect(await playAgain(as(erik), (await played([erik])).code)).toMatch(/^\/[^/]+\/share$/);
  });
});
