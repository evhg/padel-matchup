import { and, eq, like } from "drizzle-orm";
import type { Logger } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, type Db } from "@/db";
import { deviceHints, events, groupMembers, groups, metricsDaily, passkeys, players, type Player } from "@/db/schema";
import { deviceHintAction, deviceHintNotMeAction, deviceHintYesAction } from "@/actions/deviceHints";
import { clientKey } from "@/actions/shared";
import { askKeyOf, hintKey } from "@/lib/deviceHint";
import {
  anyHintAmong,
  HINT_CANDIDATES_READ,
  HINT_FRESH_DAYS,
  hintAnswerOf,
  hintCandidates,
  hintCounters,
  hintMatch,
  hintOpen,
  hintOutcomeOf,
  hintPick,
  hintScopeIds,
  readHint,
  type HintCandidate,
  type HintMatch,
} from "@/lib/domain/deviceHintAsk";
import { HINT_KEEP_DAYS, saveDeviceHint } from "@/lib/domain/deviceHints";
import { createEvent } from "@/lib/domain/events";
import { canonicalSignals, cleanSignals, type SignalsWire } from "@/lib/domain/hintSignals";
import { dayKey } from "@/lib/domain/metrics";
import { getEventByCode } from "@/lib/domain/queries";
import { LIMITS, takeRate } from "@/lib/domain/ratelimit";
import { joinEvent, reserveNames } from "@/lib/domain/slots";
import { unreachedHereOf, unreachedRecords } from "@/lib/domain/unreached";
import { PLAYER_COOKIE, sealPlayerId } from "@/lib/session";
import { asAction } from "./helpers/action";
import { freezeClock } from "./helpers/clock";
import { createTestDb, DAY, makePlayer } from "./helpers/db";

/**
 * "Welcome back, Tim?", the device hint's question (design B, part 2; the owner's decision of 28 October
 * 2026: "I like A, obviously the fingerprint needs to include more than just iphone model… is it really
 * just the iphone model? Then it should be B."). A browser that knows nobody sends its values once; the
 * server looks for the key only among the records the page already shows such a browser (a seat, a
 * waiting place, a held place that keeps a record), and answers a first name for exactly one of them:
 * "It's me" for a record with nothing to prove, the record's own doors for one that can prove itself.
 *
 * The rule's reads run on PGlite, and on a real Postgres when TEST_DATABASE_URL is set (`createTestDb`).
 * The actions run on the app's own database (`getDb`), as a browser calls them (`asAction`).
 */
const NOW = new Date(Date.UTC(2026, 9, 28, 5, 0));
freezeClock(NOW);
const at = (days: number) => new Date(NOW.getTime() + days * DAY);
const RUNS = { email: true, telegram: true };

/** Tim's iPhone in Phuket, as `readDeviceSignals` sends it, and the key the server makes from it. */
const PHONE: SignalsWire = { w: 390, h: 844, dpr: 3, langs: ["en-US"], tz: "Asia/Bangkok", platform: "iphone", touch: 5, text: 17, motion: false };
const keyOf = (v: SignalsWire) => hintKey(canonicalSignals(cleanSignals(v)!));

// ------------------------------------------------------------------ pure

describe("the scope and the answer, pure", () => {
  it("the scope is what the page shows a browser that knows nobody: seats, waiting places, held places that keep a record", () => {
    const ids = hintScopeIds([
      { playerId: "seat", status: "joined" },
      { playerId: "confirmed", status: "confirmed" },
      { playerId: "held-record", status: "invited" },
      { playerId: null, status: "invited" },
      { playerId: "declined", status: "declined" },
      { playerId: null, status: "empty" },
      { playerId: "seat", status: "joined" },
    ]);
    expect(ids).toEqual(["seat", "confirmed", "held-record"]);
  });

  it("asks only on a match that is not called off, not past and not started", () => {
    expect(hintOpen({ status: "open", startsAt: at(1) }, NOW)).toBe(true);
    expect(hintOpen({ status: "full", startsAt: at(1) }, NOW)).toBe(true);
    expect(hintOpen({ status: "cancelled", startsAt: at(1) }, NOW)).toBe(false);
    expect(hintOpen({ status: "past", startsAt: at(1) }, NOW)).toBe(false);
    expect(hintOpen({ status: "open", startsAt: NOW }, NOW)).toBe(false);
    expect(hintOpen({ status: "open", startsAt: at(-1) }, NOW)).toBe(false);
  });

  const tim: HintCandidate = { id: "tim-id", name: "Tim Smith", email: null, recoveryEmail: null, telegramId: null, passkey: false, freshLone: false };

  it("exactly one record: none and two give nothing, and the second Tim is refused", () => {
    expect(hintPick([])).toEqual({ kind: "none" });
    expect(hintPick([tim, { ...tim, id: "other" }])).toEqual({ kind: "ambiguous" });
    expect(hintPick([{ ...tim, freshLone: true }])).toEqual({ kind: "fresh" });
    expect(hintPick([tim])).toEqual({ kind: "one", candidate: tim });
  });

  it("\"That's me\" signs it in: ask; else its own doors; else nothing", () => {
    expect(hintOutcomeOf(tim, { ok: true, id: "tim-id", fold: false }, RUNS)).toEqual({ kind: "ask", id: "tim-id", name: "Tim Smith" });
    // A verdict about another record is no yes for this one.
    expect(hintOutcomeOf(tim, { ok: true, id: "other", fold: false }, RUNS).kind).toBe("closed");
    expect(hintOutcomeOf({ ...tim, email: "tim@example.com" }, { ok: false, reason: "email" }, RUNS)).toEqual({ kind: "doors", id: "tim-id", name: "Tim Smith", doors: { email: true, telegram: false, passkey: false } });
    expect(hintOutcomeOf({ ...tim, recoveryEmail: "t@example.com", telegramId: "77", passkey: true }, { ok: false, reason: "telegram" }, RUNS)).toMatchObject({ doors: { email: true, telegram: true, passkey: true } });
    // A door this deployment does not run is no door.
    expect(hintOutcomeOf({ ...tim, email: "tim@example.com" }, { ok: false, reason: "email" }, { email: false, telegram: false }).kind).toBe("closed");
    // Refused for another reason, with no door (an organiser, a namesake): nothing.
    expect(hintOutcomeOf(tim, { ok: false, reason: "organises_matches" }, RUNS).kind).toBe("closed");
  });

  it("the answer is a first name and the doors, never an id or the whole name", () => {
    const ask = hintAnswerOf({ kind: "ask", id: "tim-id", name: "Tim Smith" });
    expect(ask).toEqual({ name: "Tim", doors: null });
    const doors = hintAnswerOf({ kind: "doors", id: "tim-id", name: "Tim Smith", doors: { email: true, telegram: false, passkey: false } });
    expect(doors).toEqual({ name: "Tim", doors: { email: true, telegram: false, passkey: false } });
    expect(JSON.stringify([ask, doors])).not.toMatch(/tim-id|Smith/);
    for (const kind of ["none", "ambiguous", "fresh", "closed"] as const) expect(hintAnswerOf({ kind })).toBeNull();
  });

  it("each outcome moves its own counters", () => {
    expect(hintCounters({ kind: "ask", id: "x", name: "Tim" })).toEqual(["hint_asked"]);
    expect(hintCounters({ kind: "doors", id: "x", name: "Tim", doors: { email: true, telegram: false, passkey: false } })).toEqual(["hint_asked", "hint_doors"]);
    expect(hintCounters({ kind: "ambiguous" })).toEqual(["hint_ambiguous"]);
    expect(hintCounters({ kind: "fresh" })).toEqual(["hint_fresh"]);
    expect(hintCounters({ kind: "none" })).toEqual([]);
    expect(hintCounters({ kind: "closed" })).toEqual([]);
  });
});

// ------------------------------------------------------------------ the reads

describe("the reads", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  /** Every statement drizzle sends while `fn` runs: the session's own logger, for the length of `fn`. */
  const counted = async <T>(fn: () => Promise<T>): Promise<{ value: T; statements: string[] }> => {
    const session = (db as unknown as { session: { logger: Logger } }).session;
    const before = session.logger;
    const statements: string[] = [];
    session.logger = { logQuery: (q) => void statements.push(q) };
    try {
      return { value: await fn(), statements };
    } finally {
      session.logger = before;
    }
  };

  let n = 0;
  /** An organiser with an address (never a record "That's me" signs in), and her match in two days. */
  const matchOf = async (o: { days?: number; groupId?: string } = {}) => {
    const org = await makePlayer(db, `Org ${++n}`, { email: `org-${n}@example.com`, createdAt: at(-90) });
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: at(o.days ?? 2), tz: "Asia/Bangkok", venueName: "Rawai Padel", whenFull: "waitlist", groupId: o.groupId });
    return { org, ev, m: (await hintMatch(db, ev.code))! };
  };
  /** A record made two months ago: no second Tim. */
  const old = (name: string, extra: Partial<Player> = {}) => makePlayer(db, name, { createdAt: at(-60), ...extra });
  const remember = (playerId: string, key: string, days = -1) => saveDeviceHint(db, { playerId, key, label: "iPhone", now: at(days) });
  const seat = (eventId: string, playerId: string) => joinEvent(db, { eventId, playerId, now: NOW });

  it("finds a seated record, a waiting one and a held place that keeps a record, in one statement", async () => {
    const { org, ev, m } = await matchOf();
    const tim = await old("Tim");
    await seat(ev.id, tim.id);
    await remember(tim.id, "k-seat");
    const { value, statements } = await counted(() => hintCandidates(db, m, "k-seat", NOW));
    expect(value.map((c) => c.name)).toEqual(["Tim"]);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/limit/i);
    expect(HINT_CANDIDATES_READ).toBe(2);

    // The waiting list: the match is full with four, the fifth waits.
    for (const name of ["Ann", "Bea"]) await seat(ev.id, (await old(name)).id);
    await seat(ev.id, org.id);
    const wes = await old("Wes");
    expect((await seat(ev.id, wes.id)).outcome).toBe("waitlisted");
    await remember(wes.id, "k-wait");
    expect((await hintCandidates(db, m, "k-wait", NOW)).map((c) => c.name)).toEqual(["Wes"]);

    // A held place that keeps a past player's record.
    const { ev: ev2, m: m2, org: org2 } = await matchOf();
    const hal = await old("Hal");
    await reserveNames(db, { eventId: ev2.id, actorPlayerId: org2.id, names: ["Hal"], records: new Map([["hal", hal.id]]), now: NOW });
    await remember(hal.id, "k-held");
    expect((await hintCandidates(db, m2, "k-held", NOW)).map((c) => c.name)).toEqual(["Hal"]);
  });

  it("never the organiser's unreached list, and never a crew member who is not on the page", async () => {
    // Rosa's match ten days ago with Uma, over now; then Rosa's next match with Rosa and Bo in it.
    const rosa = await makePlayer(db, "Rosa", { email: "rosa@example.com", createdAt: at(-90) });
    const uma = await old("Uma");
    const past = await createEvent(db, { creatorPlayerId: rosa.id, type: "match", startsAt: at(1), tz: "Asia/Bangkok", whenFull: "waitlist", venueName: "Warehaus" });
    for (const p of [rosa, uma]) await seat(past.id, p.id);
    await db.update(events).set({ startsAt: at(-10), status: "past" }).where(eq(events.id, past.id));
    const [crew] = await db.insert(groups).values({ code: "HINT01", name: "Rosa's crew", creatorPlayerId: rosa.id, tz: "Asia/Bangkok" }).returning();
    const cora = await old("Cora");
    await db.insert(groupMembers).values({ groupId: crew.id, playerId: cora.id, role: "member" });
    const ev = await createEvent(db, { creatorPlayerId: rosa.id, type: "match", startsAt: at(2), tz: "Asia/Bangkok", whenFull: "waitlist", venueName: "Warehaus", groupId: crew.id });
    const bo = await old("Bo");
    for (const p of [rosa, bo]) await seat(ev.id, p.id);
    // Uma is on Rosa's unreached list for this match: the list the browser never gets (DECIDING rule 34).
    const detail = (await getEventByCode(db, ev.code))!;
    expect((await unreachedRecords(db, detail.event, unreachedHereOf(detail), { telegram: false, whatsapp: false, email: true, push: false }, NOW)).map((r) => r.name)).toEqual(["Uma"]);
    await remember(uma.id, "k-list");
    await remember(cora.id, "k-list");
    const m = (await hintMatch(db, ev.code))!;
    expect(await hintCandidates(db, m, "k-list", NOW)).toEqual([]);
    expect(await readHint(db, m, "k-list", RUNS, NOW)).toEqual({ kind: "none" });
    // Bo, on the page, with the same key: the one record asked about.
    await remember(bo.id, "k-list");
    expect(await readHint(db, m, "k-list", RUNS, NOW)).toEqual({ kind: "ask", id: bo.id, name: "Bo" });
  });

  it("exactly one: two records of the key give nothing, and a key outside the match does not count", async () => {
    const { ev, m } = await matchOf();
    const tim = await old("Tim");
    const ben = await old("Ben");
    const far = await old("Far");
    for (const p of [tim, ben]) await seat(ev.id, p.id);
    await remember(far.id, "k-two");
    await remember(tim.id, "k-two");
    expect(await readHint(db, m, "k-two", RUNS, NOW)).toEqual({ kind: "ask", id: tim.id, name: "Tim" });
    await remember(ben.id, "k-two");
    expect(await readHint(db, m, "k-two", RUNS, NOW)).toEqual({ kind: "ambiguous" });
    expect(await readHint(db, m, "k-nobody", RUNS, NOW)).toEqual({ kind: "none" });
  });

  it("reads only rows seen within 365 days, on the page's read too", async () => {
    const { ev, m } = await matchOf();
    const tim = await old("Tim");
    await seat(ev.id, tim.id);
    await remember(tim.id, "k-year", -(HINT_KEEP_DAYS + 1));
    expect(await readHint(db, m, "k-year", RUNS, NOW)).toEqual({ kind: "none" });
    expect(await anyHintAmong(db, [tim.id], NOW)).toBe(false);
    await remember(tim.id, "k-year", -(HINT_KEEP_DAYS - 1));
    expect(await readHint(db, m, "k-year", RUNS, NOW)).toMatchObject({ kind: "ask" });
    expect(await anyHintAmong(db, [tim.id], NOW)).toBe(true);
  });

  it("never a record under \"Don't recognise my phones\", even with a row that a save racing the switch kept", async () => {
    // The objection stops the use of the key, not only its storage (DECIDING rule 40). The row goes in by
    // hand, as a save that started in the same instant as the switch can leave it: `saveDeviceHint` itself
    // refuses a marked player. Tim is seated, his row is a day old: only the mark stands between him and the question.
    const { ev, m } = await matchOf();
    const tim = await old("Tim");
    const ben = await old("Ben");
    for (const p of [tim, ben]) await seat(ev.id, p.id);
    await db.insert(deviceHints).values({ playerId: tim.id, key: "k-objected", label: "iPhone", createdAt: at(-1), lastSeenAt: at(-1) });
    expect(await readHint(db, m, "k-objected", RUNS, NOW)).toEqual({ kind: "ask", id: tim.id, name: "Tim" });
    await db.update(players).set({ hintsOff: at(-1) }).where(eq(players.id, tim.id));
    expect(await hintCandidates(db, m, "k-objected", NOW)).toEqual([]);
    expect(await readHint(db, m, "k-objected", RUNS, NOW)).toEqual({ kind: "none" });
    // Ben's phone gives the same key: Tim's row no longer makes it two, so Ben alone is asked.
    await remember(ben.id, "k-objected");
    expect(await readHint(db, m, "k-objected", RUNS, NOW)).toEqual({ kind: "ask", id: ben.id, name: "Ben" });
  });

  it("the page's read is one bounded statement, and none with nobody in scope", async () => {
    const lone = await old("Lone");
    const none = await counted(() => anyHintAmong(db, [], NOW));
    expect(none).toEqual({ value: false, statements: [] });
    const one = await counted(() => anyHintAmong(db, [lone.id], NOW));
    expect(one.value).toBe(false);
    expect(one.statements).toHaveLength(1);
    expect(one.statements[0]).toMatch(/limit/i);
  });

  it("the second Tim: a record younger than a week with no earlier match shared with anybody is never offered", async () => {
    expect(HINT_FRESH_DAYS).toBe(7);
    const { ev, m, org } = await matchOf({ days: 3 });
    const tim = await makePlayer(db, "Tim", { createdAt: at(-3) });
    await seat(ev.id, tim.id);
    await remember(tim.id, "k-fresh");
    expect(await readHint(db, m, "k-fresh", RUNS, NOW)).toEqual({ kind: "fresh" });

    // A match he made and sat in alone, five days ago, is no shared match; nor is a match with somebody that was called off.
    const alone = await createEvent(db, { creatorPlayerId: tim.id, type: "match", startsAt: at(1), tz: "Asia/Bangkok", venueName: "Kata Padel", whenFull: "waitlist" });
    await seat(alone.id, tim.id);
    await db.update(events).set({ startsAt: at(-5), status: "past" }).where(eq(events.id, alone.id));
    const off = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: at(1), tz: "Asia/Bangkok", venueName: "Kata Padel", whenFull: "waitlist" });
    await seat(off.id, tim.id);
    await db.update(events).set({ status: "cancelled" }).where(eq(events.id, off.id));
    // A match with somebody that is still to come is no past, whether it starts before this one or after it.
    for (const days of [1, 5]) {
      const soon = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: at(days), tz: "Asia/Bangkok", venueName: "Kata Padel", whenFull: "waitlist" });
      await seat(soon.id, (await old(`Mate ${days}`)).id);
      await seat(soon.id, tim.id);
    }
    expect(await readHint(db, m, "k-fresh", RUNS, NOW)).toEqual({ kind: "fresh" });

    // Somebody sat in his own earlier match: shared, so offered.
    await db.update(events).set({ status: "open" }).where(eq(events.id, alone.id));
    await joinEvent(db, { eventId: alone.id, playerId: (await old("Pal")).id, now: at(-6) });
    await db.update(events).set({ status: "past" }).where(eq(events.id, alone.id));
    expect(await readHint(db, m, "k-fresh", RUNS, NOW)).toEqual({ kind: "ask", id: tim.id, name: "Tim" });
  });

  it("the second Tim's rule reads a seat beside somebody in a match that has started, and the record's age", async () => {
    // The newcomer who joins two of an organiser's posted matches today (review, 28 October 2026): a match
    // still to come is no past, even one that starts before this one, and an organiser with no seat is
    // nobody she played with. Each case below has only that one thing between Tia and "ask".
    const { ev, m, org } = await matchOf({ days: 3 });
    const tia = await makePlayer(db, "Tia", { createdAt: at(-2) });
    await seat(ev.id, tia.id);
    await remember(tia.id, "k-tia");
    expect(await readHint(db, m, "k-tia", RUNS, NOW)).toEqual({ kind: "fresh" });
    // Org's match tomorrow, before this one, Tia beside a seated Kai: still to come, so no past.
    const soon = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: at(1), tz: "Asia/Bangkok", venueName: "Kata Padel", whenFull: "waitlist" });
    await seat(soon.id, (await old("Kai")).id);
    await seat(soon.id, tia.id);
    expect(await readHint(db, m, "k-tia", RUNS, NOW)).toEqual({ kind: "fresh" });
    // Org's match yesterday, Tia alone in a seat and Org with none: nobody to share it with.
    const alone = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: at(1), tz: "Asia/Bangkok", venueName: "Kata Padel", whenFull: "waitlist" });
    await seat(alone.id, tia.id);
    await db.update(events).set({ startsAt: at(-1), status: "past" }).where(eq(events.id, alone.id));
    expect(await readHint(db, m, "k-tia", RUNS, NOW)).toEqual({ kind: "fresh" });
    // The match with Kai once it has started (an hour ago, not yet swept to the past): shared, so offered.
    await db.update(events).set({ startsAt: at(-1 / 24) }).where(eq(events.id, soon.id));
    expect(await readHint(db, m, "k-tia", RUNS, NOW)).toMatchObject({ kind: "ask" });

    // A record older than a week needs no shared match.
    const { ev: ev2, m: m2 } = await matchOf();
    const tom = await makePlayer(db, "Tom", { createdAt: at(-(HINT_FRESH_DAYS + 1)) });
    await seat(ev2.id, tom.id);
    await remember(tom.id, "k-tom");
    expect(await readHint(db, m2, "k-tom", RUNS, NOW)).toMatchObject({ kind: "ask" });
  });

  it("a record that can prove itself gets its own doors and only them; a refused record with none gets nothing", async () => {
    const { ev, m, org } = await matchOf();
    const tim = await old("Tim", { email: "tim@example.com" });
    await seat(ev.id, tim.id);
    await remember(tim.id, "k-doors");
    expect(await readHint(db, m, "k-doors", RUNS, NOW)).toEqual({ kind: "doors", id: tim.id, name: "Tim", doors: { email: true, telegram: false, passkey: false } });
    await db.insert(passkeys).values({ id: "cred-tim", playerId: tim.id, publicKey: "pk", deviceType: "multiDevice" });
    expect(await readHint(db, m, "k-doors", RUNS, NOW)).toMatchObject({ kind: "doors", doors: { email: true, telegram: false, passkey: true } });
    // Without mail on this deployment the email code is no door.
    expect(await readHint(db, m, "k-doors", { email: false, telegram: false }, NOW)).toMatchObject({ kind: "doors", doors: { email: false, telegram: false, passkey: true } });

    // The organiser, seated, with an address: her doors. With none, nothing, as the seated question.
    await seat(ev.id, org.id);
    await remember(org.id, "k-org");
    expect(await readHint(db, m, "k-org", RUNS, NOW)).toMatchObject({ kind: "doors", doors: { email: true } });
    expect(await readHint(db, m, "k-org", { email: false, telegram: false }, NOW)).toEqual({ kind: "closed" });
  });

  it("a namesake in the crew, off the page, refuses \"It's me\" as \"That's me\" does", async () => {
    const lead = await makePlayer(db, "Lead", { email: "lead@example.com" });
    const [crew] = await db.insert(groups).values({ code: "HINT02", name: "Lead's crew", creatorPlayerId: lead.id, tz: "Asia/Bangkok" }).returning();
    const { ev, m } = await matchOf({ groupId: crew.id });
    const tim = await old("Tim");
    const otherTim = await old("Tim");
    await db.insert(groupMembers).values({ groupId: crew.id, playerId: otherTim.id, role: "member" });
    await seat(ev.id, tim.id);
    await remember(tim.id, "k-namesake");
    expect(await readHint(db, m, "k-namesake", RUNS, NOW)).toEqual({ kind: "closed" });
  });

  it("the whole decision is at most two statements", async () => {
    const { ev, m } = await matchOf();
    const tim = await old("Tim");
    await seat(ev.id, tim.id);
    await remember(tim.id, "k-cost");
    const { statements } = await counted(() => readHint(db, m, "k-cost", RUNS, NOW));
    expect(statements.length).toBeLessThanOrEqual(2);
    const nobody = await counted(() => readHint(db, m, "k-none", RUNS, NOW));
    expect(nobody.statements).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ the actions

describe("the actions, as a browser calls them", () => {
  let db: Db;
  const switchBefore = process.env.DEVICE_HINTS;
  beforeAll(async () => {
    db = await getDb();
  });
  beforeEach(async () => {
    delete process.env.DEVICE_HINTS;
    // Each test starts with no rate taken today: the rows are the limits' own, nothing else reads them.
    await db.delete(metricsDaily).where(like(metricsDaily.key, "rl:%"));
  });
  afterAll(() => {
    if (switchBefore === undefined) delete process.env.DEVICE_HINTS;
    else process.env.DEVICE_HINTS = switchBefore;
  });

  const metric = async (key: string) => Number((await db.select({ v: metricsDaily.value }).from(metricsDaily).where(and(eq(metricsDaily.day, dayKey(NOW)), eq(metricsDaily.key, key))))[0]?.v ?? 0);
  const hintsOf = (playerId: string) => db.select().from(deviceHints).where(eq(deviceHints.playerId, playerId));
  /** The address the actions see under `asAction`, as the rates key it. */
  const address = async () => (await asAction({}, () => clientKey())).result;
  /** How much of one rate the address (or the match) took today. */
  const rate = async (scope: string, id: string) => metric(`rl:${scope}:${id}`);
  /** Every statement drizzle sends to the app's database while `fn` runs. */
  const counted = async <T>(fn: () => Promise<T>): Promise<{ value: T; statements: string[] }> => {
    const session = (db as unknown as { session: { logger: Logger } }).session;
    const before = session.logger;
    const statements: string[] = [];
    session.logger = { logQuery: (q) => void statements.push(q) };
    try {
      return { value: await fn(), statements };
    } finally {
      session.logger = before;
    }
  };

  let n = 0;
  /** Kai's match in two days (Kai has an address), with a "Tim" made two months ago in a seat and his phone remembered. */
  const timsMatch = async (name = "Tim") => {
    const kai = await makePlayer(db, `Kai ${++n}`, { email: `kai-${n}@example.com`, createdAt: at(-90) });
    const ev = await createEvent(db, { creatorPlayerId: kai.id, type: "match", startsAt: at(2), tz: "Asia/Bangkok", venueName: "Rawai Padel", whenFull: "waitlist" });
    const tim = await makePlayer(db, `${name} ${n}`, { createdAt: at(-60) });
    await joinEvent(db, { eventId: ev.id, playerId: tim.id, now: NOW });
    await saveDeviceHint(db, { playerId: tim.id, key: keyOf(PHONE), label: "iPhone", now: at(-1) });
    return { kai, ev, tim };
  };

  it("asks a browser that knows nobody, with good values outside Europe and the switch at ask; nothing else", async () => {
    const { ev, tim, kai } = await timsMatch();
    const asked = await metric("hint_asked");
    const r = await asAction({}, () => deviceHintAction(ev.code, PHONE));
    expect(r.result).toEqual({ ok: true, data: { name: "Tim", doors: null } });
    // Never an id, the key or which value matched.
    expect(JSON.stringify(r.result)).not.toContain(tim.id);
    expect(JSON.stringify(r.result)).not.toContain(keyOf(PHONE));
    expect(r.cookies[PLAYER_COOKIE]).toBeUndefined();
    expect((await metric("hint_asked")) - asked).toBe(1);

    for (const values of [{ ...PHONE, tz: "Europe/Madrid" }, { ...PHONE, w: -1 }, null, "x"]) expect((await asAction({}, () => deviceHintAction(ev.code, values))).result, JSON.stringify(values)).toEqual({ ok: true, data: null });
    // Another phone: another key, nobody.
    expect((await asAction({}, () => deviceHintAction(ev.code, { ...PHONE, w: 393, h: 852 }))).result).toEqual({ ok: true, data: null });
    // A browser that knows somebody is never asked.
    expect((await asAction({ [PLAYER_COOKIE]: sealPlayerId(kai.id) }, () => deviceHintAction(ev.code, PHONE))).result).toEqual({ ok: true, data: null });
    // The switch: save keeps hints and asks nothing; off asks nothing.
    for (const mode of ["save", "off"]) {
      process.env.DEVICE_HINTS = mode;
      expect((await asAction({}, () => deviceHintAction(ev.code, PHONE))).result, mode).toEqual({ ok: true, data: null });
    }
    delete process.env.DEVICE_HINTS;
    expect(askKeyOf(PHONE)).toBe(keyOf(PHONE));
  });

  it("asks nothing on a match that started or was called off", async () => {
    const { ev } = await timsMatch();
    await db.update(events).set({ startsAt: at(-1 / 24) }).where(eq(events.id, ev.id));
    expect((await asAction({}, () => deviceHintAction(ev.code, PHONE))).result).toEqual({ ok: true, data: null });
    await db.update(events).set({ startsAt: at(2), status: "cancelled" }).where(eq(events.id, ev.id));
    expect((await asAction({}, () => deviceHintAction(ev.code, PHONE))).result).toEqual({ ok: true, data: null });
  });

  it("\"It's me\" signs in exactly as \"That's me\" does: the record, a session by name, the counters", async () => {
    const { ev, tim } = await timsMatch();
    const yes = await metric("hint_yes");
    const signins = await metric("signin_thats_me");
    const r = await asAction({}, () => deviceHintYesAction(ev.code, PHONE));
    expect(r.result).toEqual({ ok: true, data: { name: tim.displayName } });
    expect(r.cookies[PLAYER_COOKIE]).toBe(sealPlayerId(tim.id, { byName: true }));
    expect((await metric("hint_yes")) - yes).toBe(1);
    expect((await metric("signin_thats_me")) - signins).toBe(1);
    // The key is seen again, for the same record, and no second row.
    expect((await hintsOf(tim.id)).map((h) => h.lastSeenAt.toISOString())).toEqual([NOW.toISOString()]);
  });

  it("\"It's me\" takes the record's \"That's me\" rate: three sign-ins by name into one record a day", async () => {
    const { ev, tim } = await timsMatch();
    for (let i = 0; i < LIMITS.thatsMePerRecordPerDay; i++) expect((await asAction({}, () => deviceHintYesAction(ev.code, PHONE))).result, `tap ${i}`).toMatchObject({ ok: true });
    const r = await asAction({}, () => deviceHintYesAction(ev.code, PHONE));
    expect(r.result).toEqual({ ok: false, error: "too_many" });
    expect(r.cookies[PLAYER_COOKIE]).toBeUndefined();
    expect(await hintsOf(tim.id)).toHaveLength(1);
  });

  it("\"It's me\" with no question standing signs nobody in, and costs a \"That's me\" attempt", async () => {
    process.env.RESEND_API_KEY = "re_test_only";
    const { ev, tim } = await timsMatch();
    const ip = await address();
    // Tim gave an address since: "That's me" refuses him, and so does "It's me".
    await db.update(players).set({ email: "tim@example.com" }).where(eq(players.id, tim.id));
    const r = await asAction({}, () => deviceHintYesAction(ev.code, PHONE));
    expect(r.result).toEqual({ ok: false, error: "invalid" });
    expect(r.cookies[PLAYER_COOKIE]).toBeUndefined();
    expect(await rate("thatsme", ip)).toBe(1);
    // The doors stand instead.
    expect((await asAction({}, () => deviceHintAction(ev.code, PHONE))).result).toEqual({ ok: true, data: { name: "Tim", doors: { email: true, telegram: false, passkey: false } } });
    // Twenty "That's me" attempts of any kind a day from one address: the twentieth is taken here, so the
    // next tap is refused by that rate alone, while the question's rate still has room.
    await takeRate(db, "thatsme", ip, LIMITS.thatsMePerIpPerDay, "day", NOW, LIMITS.thatsMePerIpPerDay - 1);
    expect((await asAction({}, () => deviceHintYesAction(ev.code, PHONE))).result).toEqual({ ok: false, error: "too_many" });
    expect(await rate("hint", ip)).toBeLessThan(LIMITS.hintAsksPerIpPerDay);
  });

  it("\"It's me\" takes the question's rates first: twenty a day for one address before any read, and the match's cap", async () => {
    // A tap is a question too (review, 28 October 2026): a script that tries values on "It's me" meets the
    // bounds of one that asks, and spends no "That's me" attempt and no read once they are spent.
    const { ev, tim } = await timsMatch();
    const ip = await address();
    await takeRate(db, "hint", ip, LIMITS.hintAsksPerIpPerDay, "day", NOW, LIMITS.hintAsksPerIpPerDay);
    const spent = await counted(() => asAction({}, () => deviceHintYesAction(ev.code, PHONE)));
    expect(spent.value.result).toEqual({ ok: false, error: "too_many" });
    expect(spent.value.cookies[PLAYER_COOKIE]).toBeUndefined();
    // The rate's own upsert, and nothing read.
    expect(spent.statements).toHaveLength(1);
    expect(await rate("thatsme", ip)).toBe(0);

    // A fresh address, and the match's cap spent today by everybody else: refused before the candidates' read.
    await db.delete(metricsDaily).where(like(metricsDaily.key, "rl:%"));
    await takeRate(db, "hint_match", ev.id, LIMITS.hintAsksPerMatchPerDay, "day", NOW, LIMITS.hintAsksPerMatchPerDay);
    const capped = await asAction({}, () => deviceHintYesAction(ev.code, PHONE));
    expect(capped.result).toEqual({ ok: false, error: "too_many" });
    expect(capped.cookies[PLAYER_COOKIE]).toBeUndefined();
    expect(await rate("thatsme", ip)).toBe(0);
    expect(await rate("hint", ip)).toBe(1);

    // With room in both, the same tap signs Tim in, and takes one of each.
    await db.delete(metricsDaily).where(like(metricsDaily.key, "rl:%"));
    const yes = await asAction({}, () => deviceHintYesAction(ev.code, PHONE));
    expect(yes.result).toEqual({ ok: true, data: { name: tim.displayName } });
    expect([await rate("hint", ip), await rate("hint_match", ev.id)]).toEqual([1, 1]);
  });

  it("\"Not me\" deletes that record's row of this key, counts it, and the phone is not asked while the record does nothing new", async () => {
    const { ev, tim } = await timsMatch();
    const other = keyOf({ ...PHONE, w: 393, h: 852 });
    await saveDeviceHint(db, { playerId: tim.id, key: other, label: "iPhone", now: at(-2) });
    const no = await metric("hint_no");
    expect((await asAction({}, () => deviceHintNotMeAction(ev.code, PHONE))).result).toEqual({ ok: true, data: null });
    expect((await hintsOf(tim.id)).map((h) => h.key)).toEqual([other]);
    expect((await metric("hint_no")) - no).toBe(1);
    expect((await asAction({}, () => deviceHintAction(ev.code, PHONE))).result).toEqual({ ok: true, data: null });
    // With no question standing, "Not me" deletes nothing and counts nothing.
    expect((await asAction({}, () => deviceHintNotMeAction(ev.code, { ...PHONE, w: 393, h: 852, langs: ["th-th"] }))).result).toEqual({ ok: true, data: null });
    expect(await hintsOf(tim.id)).toHaveLength(1);
    expect((await metric("hint_no")) - no).toBe(1);
  });

  it("\"Not me\" is no lasting no: the record's next act from a phone with the same key brings the question back", async () => {
    // The limit the docs state (DECIDING rule 40; the review of 28 October 2026, option B): "Not me" deletes
    // the row, and the record's own next join or sign-in from a phone that gives the same key (Tim's own
    // iPhone of the same model) keeps it again. A lasting refusal is the owner's decision.
    const { ev, tim } = await timsMatch();
    expect((await asAction({}, () => deviceHintNotMeAction(ev.code, PHONE))).result).toEqual({ ok: true, data: null });
    expect(await hintsOf(tim.id)).toHaveLength(0);
    expect((await asAction({}, () => deviceHintAction(ev.code, PHONE))).result).toEqual({ ok: true, data: null });
    await saveDeviceHint(db, { playerId: tim.id, key: keyOf(PHONE), label: "iPhone", now: NOW });
    expect((await asAction({}, () => deviceHintAction(ev.code, PHONE))).result).toEqual({ ok: true, data: { name: "Tim", doors: null } });
  });

  it("\"Not me\" with no question standing deletes nothing: two records of the key, or the second Tim", async () => {
    const { ev, tim } = await timsMatch();
    const twin = await makePlayer(db, `Twin ${n}`, { createdAt: at(-60) });
    await joinEvent(db, { eventId: ev.id, playerId: twin.id, now: NOW });
    await saveDeviceHint(db, { playerId: twin.id, key: keyOf(PHONE), label: "iPhone", now: at(-1) });
    const no = await metric("hint_no");
    expect((await asAction({}, () => deviceHintNotMeAction(ev.code, PHONE))).result).toEqual({ ok: true, data: null });
    expect(await hintsOf(tim.id)).toHaveLength(1);
    expect(await hintsOf(twin.id)).toHaveLength(1);
    const { ev: ev2, tim: fresh } = await timsMatch("Newt");
    await db.update(players).set({ createdAt: at(-2) }).where(eq(players.id, fresh.id));
    expect((await asAction({}, () => deviceHintAction(ev2.code, PHONE))).result).toEqual({ ok: true, data: null });
    expect((await asAction({}, () => deviceHintNotMeAction(ev2.code, PHONE))).result).toEqual({ ok: true, data: null });
    expect(await hintsOf(fresh.id)).toHaveLength(1);
    expect((await metric("hint_no")) - no).toBe(0);
  });

  it("twenty questions a day for one address, \"Not me\" among them; a cap a day for one match", async () => {
    const { ev } = await timsMatch();
    for (let i = 0; i < LIMITS.hintAsksPerIpPerDay - 1; i++) await asAction({}, () => deviceHintAction(ev.code, PHONE));
    expect((await asAction({}, () => deviceHintNotMeAction(ev.code, { ...PHONE, w: 400 }))).result).toEqual({ ok: true, data: null });
    expect((await asAction({}, () => deviceHintAction(ev.code, PHONE))).result).toEqual({ ok: false, error: "too_many" });
    expect((await asAction({}, () => deviceHintNotMeAction(ev.code, PHONE))).result).toEqual({ ok: false, error: "too_many" });

    // Another match, its cap spent today by everybody else: no answer, and nothing read for it.
    await db.delete(metricsDaily).where(like(metricsDaily.key, "rl:%"));
    const { ev: ev2 } = await timsMatch("Tam");
    expect(await takeRate(db, "hint_match", ev2.id, LIMITS.hintAsksPerMatchPerDay, "day", NOW, LIMITS.hintAsksPerMatchPerDay)).toBe(true);
    const asked = await metric("hint_asked");
    expect((await asAction({}, () => deviceHintAction(ev2.code, PHONE))).result).toEqual({ ok: true, data: null });
    expect((await metric("hint_asked")) - asked).toBe(0);
    expect(LIMITS.hintAsksPerIpPerDay).toBe(20);
  });
});
