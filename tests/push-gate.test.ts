import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { clubs, competitionCategories, competitionMatches, competitionPairs, competitions, discordCards, discordChannels, events, lessonRequests, lessons, lessonWaitlist, lineCards, lineRooms, metricsDaily, telegramCards, telegramChats, telegramInlineCards } from "@/db/schema";
import type { AvailabilityAdapter, ScrapeResult } from "@/lib/booking/adapters";
import { anyPlatformHost, SCRAPE, scrapeIfDue } from "@/lib/booking/scrape";
import { AVAILABILITY_KINDS } from "@/lib/booking/availability";
import { PLATFORMS } from "@/lib/booking/platforms";
import { LISTED_SOURCES } from "@/lib/domain/clubs";
import { ALL_CHANNELS } from "@/lib/channels";
import { telegramChannel } from "@/lib/channels/telegram";
import { expireRequests, lessonRemindersDue, REMIND_HOURS_BEFORE, tickWaitlist } from "@/lib/coach/chains";
import { createCoach, presetHours } from "@/lib/domain/coaching";
import { COURTS, matchRemindersDue } from "@/lib/domain/competitionSchedule";
import { createEvent } from "@/lib/domain/events";
import { setMetric } from "@/lib/domain/metrics";
import { findPushRemindersDue, PUSH_REMINDER_LEAD_MS } from "@/lib/domain/push";
import { PUSH_GATE } from "@/lib/ops/cronJobs";
import { createTestDb, makePlayer } from "./helpers/db";
import { freezeClock } from "./helpers/clock";

/**
 * The push job's gate (migration 0104; the owner's decision of 7 November 2026, "Start the push job
 * only when something is due"). pg_cron asks `kicksmash_push_due(at)` every five minutes and calls
 * `/api/cron/push` only on a yes, so a no where the route would have worked is a reminder that never
 * goes. The function must be a superset of the route: these tests build each kind of work the route
 * does, run the route's own due functions on a frozen clock, and hold the function to them.
 *
 * The function under test is the migration's own text: the part of drizzle/0104_push_job_gate.sql
 * before its first statement breakpoint, run again here over what the migrator made.
 *
 * AT is Saturday 10 October 2026, 05:00 UTC: 12:00 in Bangkok, 13:00 in Singapore, the clubs' day.
 * NIGHT is 18:00 UTC the same day: 01:00 in Bangkok, 02:00 in Singapore.
 */
const AT = new Date("2026-10-10T05:00:00.000Z");
const NIGHT = new Date("2026-10-10T18:00:00.000Z");
freezeClock(AT);
const MIN = 60_000;
const at = (min: number, base = AT) => new Date(base.getTime() + min * MIN);

const MIGRATION = readFileSync("drizzle/0104_push_job_gate.sql", "utf8");
const FUNCTION_TEXT = MIGRATION.split("--> statement-breakpoint")[0];

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] }).rows ?? [])) as T[];

let db: Db;
let gate: (when?: Date) => Promise<boolean>;
beforeAll(async () => {
  ({ db } = await createTestDb());
  await db.execute(sql.raw(FUNCTION_TEXT));
  gate = async (when = AT) => rowsOf<{ yes: boolean }>(await db.execute(sql`select ${sql.raw(`public.${PUSH_GATE}`)}(${when.toISOString()}::timestamptz) as yes`))[0].yes;
});

/** The shells every scenario hangs off: a player, a coach, a tournament, a chat of each kind. */
let shell: { playerId: string; coachId: string; competitionId: string; categoryId: string; pairA: string; pairB: string };
beforeEach(async () => {
  ({ db } = await createTestDb());
  delete process.env.SCRAPE_DISABLED;
  delete process.env.SCRAPE_QUIET_HOURS;
  delete process.env.TELEGRAM_BOT_TOKEN;
  const p = await makePlayer(db, "Pat");
  const q = await makePlayer(db, "Quinn");
  const coach = await createCoach(db, { playerId: (await makePlayer(db, "Coach")).id, displayName: "Coach", tz: "Asia/Bangkok", hours: presetHours("both") });
  const [comp] = await db.insert(competitions).values({ slug: "gate-cup", name: "Gate Cup", organizerPlayerId: p.id, tz: "Asia/Bangkok", startsOn: "2026-10-10", endsOn: "2026-10-11" }).returning();
  const [cat] = await db.insert(competitionCategories).values({ competitionId: comp.id, name: "Open" }).returning();
  const [a] = await db.insert(competitionPairs).values({ categoryId: cat.id, competitionId: comp.id, p1PlayerId: p.id, p2PlayerId: q.id, position: 1 }).returning();
  const [b] = await db.insert(competitionPairs).values({ categoryId: cat.id, competitionId: comp.id, p1PlayerId: q.id, p2PlayerId: p.id, position: 2 }).returning();
  await db.insert(telegramChats).values({ chatId: -100777, type: "supergroup" });
  await db.insert(discordChannels).values({ channelId: "d-1", guildId: "g-1" });
  await db.insert(lineRooms).values({ roomId: "l-1", type: "group" });
  shell = { playerId: p.id, coachId: coach.id, competitionId: comp.id, categoryId: cat.id, pairA: a.id, pairB: b.id };
});

/** Leaves the shells and removes every piece of work, so each scenario stands alone. */
async function clearWork() {
  await db.delete(events);
  await db.delete(lessons);
  await db.delete(lessonWaitlist);
  await db.delete(lessonRequests);
  await db.delete(competitionMatches);
  await db.delete(clubs);
  await db.delete(metricsDaily);
}

// ---------------------------------------------------------------- the kinds of work

type Card = "none" | "telegram" | "telegram_result" | "telegram_inline" | "discord" | "line";
/** `rendered`: when the card was last rendered, ten minutes before the start (the default) or a minute after it. */
type EventCase = { kind: "event"; min: number; type: "match" | "tournament"; status: "open" | "full" | "past" | "cancelled"; card: Card; reminded: "none" | "push" | "all"; locked: boolean; rendered?: "before" | "after" };
type LessonCase = { kind: "lesson"; min: number; status: "booked" | "cancelled"; reminded: boolean };
type OfferCase = { kind: "offer"; min: number; status: "offered" | "waiting" | "expired"; slot: boolean };
type RequestCase = { kind: "request"; min: number; status: "open" | "declined" };
type CompetitionCase = { kind: "competition"; min: number; status: "pending" | "done" | "walkover"; reminded: boolean; pairs: boolean };
/**
 * A club for the court reader. `link`: a booking link on a platform, a website on a platform, a website on
 * the club's own domain, a booking link on its own domain (as Book & Go clubs have), or none. `source`:
 * the directory's row (the default), a player's, or a claim; `approved`; `feed`: a feed of its own.
 */
type ClubCase = { kind: "club"; base: Date; lastRunMin: number | null; tz: string | null; link: "booking" | "website" | "own" | "own_booking" | "none"; rejected: boolean; source?: "directory" | "player" | "claim"; approved?: boolean; feed?: boolean };
type Case = EventCase | LessonCase | OfferCase | RequestCase | CompetitionCase | ClubCase;

async function seed(c: Case) {
  if (c.kind === "event") {
    const ev = await createEvent(db, { creatorPlayerId: shell.playerId, type: c.type, startsAt: at(60 * 24 * 3), tz: "Asia/Bangkok", venueName: "Gate Padel", whenFull: "waitlist" });
    const sent = (on: boolean) => (on ? at(-1) : null);
    await db
      .update(events)
      .set({ startsAt: at(c.min), status: c.status, scoreLockedByCreator: c.locked, pushReminderSentAt: sent(c.reminded !== "none"), telegramReminderSentAt: sent(c.reminded === "all"), discordReminderSentAt: sent(c.reminded === "all"), lineReminderSentAt: sent(c.reminded === "all") })
      .where(sql`${events.id} = ${ev.id}`);
    const updatedAt = at(c.min + (c.rendered === "after" ? 1 : -10));
    if (c.card === "telegram" || c.card === "telegram_result") await db.insert(telegramCards).values({ eventId: ev.id, chatId: -100777, messageId: 5, kind: c.card === "telegram" ? "card" : "result", rendered: "stale", updatedAt });
    if (c.card === "telegram_inline") await db.insert(telegramInlineCards).values({ inlineMessageId: `in-${ev.id}`, eventId: ev.id, rendered: "stale", updatedAt });
    if (c.card === "discord") await db.insert(discordCards).values({ eventId: ev.id, channelId: "d-1", messageId: "m-1", rendered: "stale" });
    if (c.card === "line") await db.insert(lineCards).values({ eventId: ev.id, roomId: "l-1", messageId: "m-1", rendered: "stale" });
  } else if (c.kind === "lesson") {
    await db.insert(lessons).values({ coachId: shell.coachId, studentPlayerId: shell.playerId, startsAt: at(c.min), minutes: 60, status: c.status, remindedAt: c.reminded ? at(-1) : null, createdAt: at(-7 * 24 * 60) });
  } else if (c.kind === "offer") {
    await db.insert(lessonWaitlist).values({ coachId: shell.coachId, studentPlayerId: shell.playerId, slotStartsAt: c.slot ? at(3 * 24 * 60) : null, weekStart: c.slot ? null : "2026-10-12", status: c.status, offeredAt: at(c.min - 30), offerExpiresAt: at(c.min) });
  } else if (c.kind === "request") {
    await db.insert(lessonRequests).values({ coachId: shell.coachId, studentPlayerId: shell.playerId, startsAt: at(c.min), minutes: 60, status: c.status });
  } else if (c.kind === "competition") {
    await db.insert(competitionMatches).values({ categoryId: shell.categoryId, competitionId: shell.competitionId, phase: "group", round: 1, position: 1, pairAId: c.pairs ? shell.pairA : null, pairBId: c.pairs ? shell.pairB : null, scheduledAt: at(c.min), status: c.status, remindedAt: c.reminded ? at(-1) : null });
  } else {
    const slug = `club-${Math.random().toString(36).slice(2, 8)}`;
    const own = `https://${slug}.example/book`;
    await db.insert(clubs).values({
      slug,
      name: slug,
      manageToken: `tok-${slug}-0123456789abcdef`,
      source: c.source ?? "directory",
      approvedAt: c.approved ? at(-60 * 24) : null,
      tz: c.tz,
      bookingUrl: c.link === "booking" ? `https://playtomic.io/${slug}` : c.link === "own_booking" ? own : null,
      bookingPlatform: c.link === "booking" ? "playtomic" : c.link === "own_booking" ? "bookandgo" : null,
      website: c.link === "website" ? `https://playtomic.io/${slug}` : c.link === "own" ? own : null,
      availabilityUrl: c.feed ? `https://${slug}.example/free.json` : null,
      availabilityKind: c.feed ? "json_free" : null,
      rejectedAt: c.rejected ? at(-60 * 24) : null,
    });
    if (c.lastRunMin !== null) await setMetric(db, "cron_scrape_at", Math.floor(at(c.lastRunMin, c.base).getTime() / 1000), at(c.lastRunMin, c.base).toISOString().slice(0, 10));
  }
}

/** The test's reader: one request, a clean page with no courts. */
const reader: AvailabilityAdapter = {
  platform: "playtomic",
  matches: (url) => url.includes("playtomic."),
  async scrape(target, fetchImpl): Promise<ScrapeResult> {
    await fetchImpl(target.bookingUrl);
    return { ok: true, slots: [], requests: 1 };
  },
};
const fakeFetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
const fakeClock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
};

/** refreshStarted's own read, counted: a proxy that adds up the rows its `selectDistinct` returns. */
function counting(base: Db) {
  const found = { rows: 0 };
  const proxy = new Proxy(base, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (key !== "selectDistinct") return value;
      return (...args: unknown[]) => {
        const builder = (value as (...a: unknown[]) => { from: (...f: unknown[]) => PromiseLike<unknown[]> }).apply(target, args);
        const from = builder.from.bind(builder);
        builder.from = (...f: unknown[]) => {
          type Then = (ok?: (rows: unknown[]) => unknown, err?: (e: unknown) => unknown) => PromiseLike<unknown>;
          const query = from(...f) as unknown as { then: Then };
          const then = query.then.bind(query);
          query.then = (ok, err) => then((rows) => ((found.rows += rows.length), ok ? ok(rows) : rows), err);
          return query as unknown as PromiseLike<unknown[]>;
        };
        return builder;
      };
    },
  });
  return { db: proxy as Db, found };
}

/** What the four tables the route's coach and tournament steps write look like: any change is work done. */
const snapshot = async () =>
  rowsOf<{ s: string }>(
    await db.execute(sql`select concat_ws('|',
      (select string_agg(row_to_json(t)::text, ',' order by t.id) from ${lessons} t),
      (select string_agg(row_to_json(t)::text, ',' order by t.id) from ${lessonWaitlist} t),
      (select string_agg(row_to_json(t)::text, ',' order by t.id) from ${lessonRequests} t),
      (select string_agg(row_to_json(t)::text, ',' order by t.id) from ${competitionMatches} t)) as s`),
  )[0].s;

/** What the route would do at `when`, by its own functions: each kind of work it found. */
async function routeWork(when: Date): Promise<string[]> {
  const work: string[] = [];
  if ((await findPushRemindersDue(db, when)).length) work.push("push");
  for (const ch of ALL_CHANNELS) if ((await ch.remindersDue(db, when, new Date(when.getTime() + 90 * MIN))).length) work.push(`${ch.name} reminder`);
  const c = counting(db);
  await telegramChannel.refreshStarted!(c.db, when);
  if (c.found.rows) work.push("refresh started");
  const before = await snapshot();
  const tick = await tickWaitlist(db, when);
  const reminded = await lessonRemindersDue(db, when);
  const expired = await expireRequests(db, when);
  const matches = await matchRemindersDue(db, when);
  if (tick.lapsed.length || tick.offers.length || reminded.length || expired || matches.length || (await snapshot()) !== before) work.push("coach or tournament");
  const run = await scrapeIfDue(db, when, { adapters: [reader], fetchImpl: fakeFetch, clock: fakeClock() });
  if ("clubs" in run) work.push("court reader");
  return work;
}

/** A small generator with a seed, so every run builds the same scenarios. */
function random(seed: number) {
  let x = seed >>> 0;
  return <T>(items: readonly T[]): T => {
    x = (Math.imul(x ^ (x >>> 15), 2246822507) + 0x9e3779b9) >>> 0;
    x = (x ^ (x >>> 13)) >>> 0;
    return items[x % items.length];
  };
}

// ---------------------------------------------------------------- the tests

describe("kicksmash_push_due: the push job's gate", () => {
  it("says no on an empty database, by day and by night", async () => {
    expect(await gate(AT)).toBe(false);
    expect(await gate(NIGHT)).toBe(false);
  });

  it("each clause alone says yes, and the same row out of reach says no", async () => {
    const cases: [string, Case, Case][] = [
      ["a push reminder within the hour", { kind: "event", min: 45, type: "match", status: "open", card: "none", reminded: "none", locked: false }, { kind: "event", min: 70, type: "match", status: "open", card: "none", reminded: "none", locked: false }],
      ["a Telegram card's reminder within 90 minutes", { kind: "event", min: 80, type: "tournament", status: "full", card: "telegram", reminded: "push", locked: false }, { kind: "event", min: 100, type: "tournament", status: "full", card: "telegram", reminded: "push", locked: false }],
      ["a Discord card's reminder", { kind: "event", min: 80, type: "match", status: "open", card: "discord", reminded: "push", locked: false }, { kind: "event", min: 80, type: "match", status: "open", card: "discord", reminded: "all", locked: false }],
      ["a LINE card's reminder", { kind: "event", min: 80, type: "match", status: "open", card: "line", reminded: "push", locked: false }, { kind: "event", min: 80, type: "match", status: "cancelled", card: "line", reminded: "push", locked: false }],
      ["a started match's Telegram card", { kind: "event", min: -120, type: "match", status: "past", card: "telegram", reminded: "all", locked: false }, { kind: "event", min: -120, type: "match", status: "past", card: "telegram", reminded: "all", locked: true }],
      ["a started match's inline card", { kind: "event", min: -23 * 60, type: "match", status: "full", card: "telegram_inline", reminded: "all", locked: false }, { kind: "event", min: -25 * 60, type: "match", status: "full", card: "telegram_inline", reminded: "all", locked: false }],
      ["a lapsed waitlist offer", { kind: "offer", min: -1, status: "offered", slot: true }, { kind: "offer", min: 30, status: "offered", slot: true }],
      ["an open lesson request whose time came", { kind: "request", min: -1, status: "open" }, { kind: "request", min: 60, status: "open" }],
      ["a lesson reminder", { kind: "lesson", min: 19 * 60, status: "booked", reminded: false }, { kind: "lesson", min: 21 * 60, status: "booked", reminded: false }],
      ["a tournament match within 15 minutes", { kind: "competition", min: 10, status: "pending", reminded: false, pairs: true }, { kind: "competition", min: 30, status: "pending", reminded: false, pairs: true }],
      ["the court reader's turn, a Bangkok club by day", { kind: "club", base: AT, lastRunMin: -15, tz: "Asia/Bangkok", link: "booking", rejected: false }, { kind: "club", base: AT, lastRunMin: -5, tz: "Asia/Bangkok", link: "booking", rejected: false }],
      ["the court reader's turn, never run, a website on a platform", { kind: "club", base: AT, lastRunMin: null, tz: "Asia/Singapore", link: "website", rejected: false }, { kind: "club", base: AT, lastRunMin: null, tz: "Asia/Singapore", link: "none", rejected: false }],
      // The club a lane may pick, and no other (`anyClubAwake`): a claim nobody approved, a club with its
      // own feed, and a website on the club's own domain are never read.
      ["the court reader's turn, a player's club", { kind: "club", base: AT, lastRunMin: null, tz: "Asia/Bangkok", link: "booking", rejected: false, source: "player" }, { kind: "club", base: AT, lastRunMin: null, tz: "Asia/Bangkok", link: "booking", rejected: false, source: "claim" }],
      ["the court reader's turn, an approved claim", { kind: "club", base: AT, lastRunMin: null, tz: "Asia/Bangkok", link: "website", rejected: false, source: "claim", approved: true }, { kind: "club", base: AT, lastRunMin: null, tz: "Asia/Bangkok", link: "website", rejected: false, feed: true }],
      ["the court reader's turn, a booking link on the club's own domain", { kind: "club", base: AT, lastRunMin: null, tz: "Asia/Bangkok", link: "own_booking", rejected: false }, { kind: "club", base: AT, lastRunMin: null, tz: "Asia/Bangkok", link: "own", rejected: false }],
      // A club in Madrid is in its day hours during the Bangkok night: the app reads it then, so the gate wakes.
      ["the court reader's turn, a far club in its own day", { kind: "club", base: NIGHT, lastRunMin: -15, tz: "Europe/Madrid", link: "booking", rejected: false }, { kind: "club", base: NIGHT, lastRunMin: -15, tz: "Asia/Bangkok", link: "booking", rejected: false }],
      // A started match's card that was already rendered after the start: refreshStarted takes it no more.
      ["a started match's card rendered before the start", { kind: "event", min: -30, type: "match", status: "open", card: "telegram", reminded: "all", locked: false, rendered: "before" }, { kind: "event", min: -30, type: "match", status: "open", card: "telegram", reminded: "all", locked: false, rendered: "after" }],
      ["a started match's inline card rendered before the start", { kind: "event", min: -30, type: "match", status: "open", card: "telegram_inline", reminded: "all", locked: false, rendered: "before" }, { kind: "event", min: -30, type: "match", status: "open", card: "telegram_inline", reminded: "all", locked: false, rendered: "after" }],
    ];
    for (const [what, yes, no] of cases) {
      await clearWork();
      await seed(yes);
      expect([what, await gate(yes.kind === "club" ? yes.base : AT)]).toEqual([what, true]);
      await clearWork();
      await seed(no);
      expect([what, "out of reach", await gate(no.kind === "club" ? no.base : AT)]).toEqual([what, "out of reach", false]);
    }
  });

  it("the court reader's turn waits for the clubs' day hours, in each club's own zone", async () => {
    // On 10 October 2026, a read due since the evening:
    //   14:59 UTC  Singapore 22:59: yes          15:00 UTC  Singapore 23:00: no
    //   21:57 UTC  Singapore 05:57: no           21:58 UTC  05:58, two minutes before 06:00: yes
    // A club with no zone (null or empty) keeps Bangkok's hours (23:00 is 16:00 UTC).
    const asks: [string | null, string, boolean][] = [
      ["Asia/Singapore", "2026-10-10T14:59:00Z", true],
      ["Asia/Singapore", "2026-10-10T15:00:00Z", false],
      ["Asia/Singapore", "2026-10-10T21:57:00Z", false],
      ["Asia/Singapore", "2026-10-10T21:58:00Z", true],
      ["Asia/Bangkok", "2026-10-10T15:59:00Z", true],
      ["Asia/Bangkok", "2026-10-10T16:00:00Z", false],
      ["Asia/Bangkok", "2026-10-10T22:57:00Z", false],
      ["Asia/Bangkok", "2026-10-10T23:00:00Z", true],
      [null, "2026-10-10T16:00:00Z", false],
      [null, "2026-10-10T15:59:00Z", true],
      ["", "2026-10-10T16:00:00Z", false],
      ["", "2026-10-10T15:59:00Z", true],
    ];
    for (const [tz, when, yes] of asks) {
      await clearWork();
      await seed({ kind: "club", base: new Date(when), lastRunMin: -6 * 60, tz, link: "booking", rejected: false });
      expect([tz, when, await gate(new Date(when))]).toEqual([tz, when, yes]);
    }
  });

  it("says yes on any error of its own: a fault costs function time, never a reminder", async () => {
    // The function's own text in a database that has none of the tables it reads.
    const { PGlite } = await import("@electric-sql/pglite");
    const bare = new PGlite();
    await bare.exec(FUNCTION_TEXT);
    expect((await bare.query<{ yes: boolean }>(`select public.${PUSH_GATE}('2026-10-10T05:00:00Z') as yes`)).rows[0].yes).toBe(true);
    await bare.close();
  });

  it("never writes: it is stable, runs as its caller, and its body holds no insert, update or delete", () => {
    expect(FUNCTION_TEXT).toMatch(/\bstable\b/);
    expect(FUNCTION_TEXT).toMatch(/\bsecurity invoker\b/);
    const body = FUNCTION_TEXT.slice(FUNCTION_TEXT.indexOf("$gate$")).replace(/--.*$/gm, "");
    expect(body).not.toMatch(/\b(insert|update|delete|truncate|drop|alter)\b/i);
  });

  it("keeps every number in step with the code it covers", () => {
    const minutes = (re: RegExp) => Number(re.exec(FUNCTION_TEXT)![1]);
    const cards = readFileSync("src/lib/channels/cards.ts", "utf8");
    const channelLeadMin = Number(/const soon = new Date\(now\.getTime\(\) \+ (\d+) \* 60 \* 1000\)/.exec(cards)![1]);
    // A reminder's window, with slack: push, then the card channels.
    expect(minutes(/e\.starts_at <= t \+ interval '(\d+) minutes'\n\s+and \(\(e\.push_reminder_sent_at/)).toBeGreaterThanOrEqual(PUSH_REMINDER_LEAD_MS / MIN);
    expect(minutes(/e\.starts_at > t and e\.starts_at <= t \+ interval '(\d+) minutes'/)).toBeGreaterThanOrEqual(channelLeadMin);
    // The card channels the clause names are the channels the code has, and Telegram alone refreshes.
    expect(ALL_CHANNELS.map((c) => c.name)).toEqual(["telegram", "discord", "line"]);
    expect(ALL_CHANNELS.filter((c) => c.refreshStarted).map((c) => c.name)).toEqual(["telegram"]);
    // The lesson reminder, the tournament's 15 minutes, the court reader's due time and its hours.
    expect(Number(/interval '(\d+) hours 10 minutes'/.exec(FUNCTION_TEXT)![1])).toBeGreaterThanOrEqual(REMIND_HOURS_BEFORE);
    expect(minutes(/m\.scheduled_at <= t \+ interval '(\d+) minutes'/)).toBeGreaterThanOrEqual(COURTS.remindMinutes);
    expect(Number(/floor\(extract\(epoch from t\)\) - (\d+) \* 60/.exec(FUNCTION_TEXT)![1]) * MIN).toBeLessThanOrEqual(SCRAPE.dueMs);
    const hours = [...FUNCTION_TEXT.matchAll(/between (\d+) and (\d+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(hours).toEqual([
      [SCRAPE.dayFrom, SCRAPE.dayTo - 1],
      [SCRAPE.dayFrom, SCRAPE.dayTo - 1],
    ]);
    expect(FUNCTION_TEXT).toContain(`coalesce(nullif(c.tz, ''), '${SCRAPE.nightTz}')`);
    // The club a lane may pick: the sources a listed club comes from, the feeds that win over a read, and
    // every platform's hosts, as the code has them. A change to any of them needs a new migration.
    const list = (re: RegExp) => [...re.exec(FUNCTION_TEXT)![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(list(/c\.source in \(([^)]*)\)/)).toEqual([...LISTED_SOURCES]);
    expect(list(/c\.availability_kind not in \(([^)]*)\)/)).toEqual([...AVAILABILITY_KINDS]);
    expect(/c\.website ~\* '([^']+)'/.exec(FUNCTION_TEXT)![1]).toBe(anyPlatformHost);
    expect(anyPlatformHost).toContain(PLATFORMS.flatMap((p) => p.hosts.map((h) => h.replace(/\./g, "\\."))).join("|"));
  });

  /**
   * The property itself. Each scenario holds one piece of work, built from the kinds above with values
   * on both sides of every edge. For each, the gate answers first; then the route's own due functions
   * run on the frozen clock (the ones that write go last). Whenever they find anything, the gate must
   * have said yes. The count of yes with nothing found is how loose the gate is, and only that.
   */
  it("is a superset of the route: whenever the route's own due functions find work, it said yes", async () => {
    const pick = random(20261107);
    const eventMinutes = [-25 * 60, -23 * 60, -60, -6, -1, 1, 30, 59, 61, 64, 66, 89, 91, 94, 96, 180];
    const scenarios: Case[] = [];
    for (let i = 0; i < 120; i++)
      scenarios.push({ kind: "event", min: pick(eventMinutes), type: pick(["match", "tournament"] as const), status: pick(["open", "full", "past", "cancelled"] as const), card: pick(["none", "telegram", "telegram_result", "telegram_inline", "discord", "line"] as const), reminded: pick(["none", "push", "all"] as const), locked: pick([false, true]) });
    for (const min of [-60, -1, 1, 60, 19 * 60, 20 * 60 - 1, 20 * 60 + 1, 20 * 60 + 9, 20 * 60 + 11]) for (const status of ["booked", "cancelled"] as const) for (const reminded of [false, true]) scenarios.push({ kind: "lesson", min, status, reminded });
    for (const min of [-30, -1, 1, 5, 7, 40]) for (const status of ["offered", "waiting", "expired"] as const) scenarios.push({ kind: "offer", min, status, slot: pick([true, false]) });
    for (const min of [-30, -1, 1, 5, 7, 60]) for (const status of ["open", "declined"] as const) scenarios.push({ kind: "request", min, status });
    for (const min of [-5, 1, 14, 16, 20, 22, 60]) for (const status of ["pending", "done", "walkover"] as const) scenarios.push({ kind: "competition", min, status, reminded: pick([false, true]), pairs: pick([true, true, false]) });
    for (const base of [AT, NIGHT, new Date("2026-10-10T22:00:00Z"), new Date("2026-10-10T15:00:00Z")])
      for (const lastRunMin of [null, -5, -13, -15, -60 * 8])
        for (const tz of ["Asia/Bangkok", "Asia/Singapore", "Europe/Madrid", null] as const)
          scenarios.push({ kind: "club", base, lastRunMin, tz, link: pick(["booking", "website", "own", "own_booking", "none"] as const), rejected: pick([false, false, false, true]), source: pick(["directory", "directory", "player", "claim"] as const), approved: pick([false, false, true]), feed: pick([false, false, false, true]) });
    for (let i = 0; i < 30; i++) scenarios.push({ kind: "event", min: pick([-23 * 60, -60, -6, -1]), type: "match", status: pick(["open", "full", "past"] as const), card: pick(["telegram", "telegram_inline"] as const), reminded: "all", locked: false, rendered: pick(["before", "after"] as const) });

    const missed: string[] = [];
    let found = 0;
    let loose = 0;
    const byKind = new Set<string>();
    const readerLoose: string[] = [];
    for (const c of scenarios) {
      await clearWork();
      await seed(c);
      const when = c.kind === "club" ? c.base : AT;
      const yes = await gate(when);
      const work = await routeWork(when);
      if (work.length) found++;
      for (const w of work) byKind.add(w);
      if (work.length && !yes) missed.push(`${JSON.stringify(c)} → ${work.join(", ")}`);
      if (!work.length && yes) loose++;
      // The court reader's clause is the app's own predicate: it wakes the job for nothing only in its two
      // minutes of slack (a run 12 or 13 minutes old), never all night for a club the app would not read.
      if (c.kind === "club" && yes && !work.length && c.lastRunMin !== -13) readerLoose.push(JSON.stringify(c));
    }
    expect(missed).toEqual([]);
    expect(readerLoose).toEqual([]);
    // The scenarios reach every kind of work, and the gate says no to most of what holds none.
    expect([...byKind].sort()).toEqual(["coach or tournament", "court reader", "discord reminder", "line reminder", "push", "refresh started", "telegram reminder"]);
    expect(found).toBeGreaterThan(30);
    expect(loose).toBeLessThan(scenarios.length - found);
  }, 120_000);
});

/** The Result button: a Telegram card is refreshed once after its match starts, and then nothing reads it again. */
describe("refreshStarted reads a started match's card once", () => {
  it("takes a card rendered before the start, never one rendered after it", async () => {
    const rows = async () => {
      const c = counting(db);
      await telegramChannel.refreshStarted!(c.db, AT);
      return c.found.rows;
    };
    for (const card of ["telegram", "telegram_inline"] as const) {
      await clearWork();
      await seed({ kind: "event", min: -30, type: "match", status: "open", card, reminded: "all", locked: false, rendered: "before" });
      expect([card, "before", await rows(), await gate()]).toEqual([card, "before", 1, true]);
      await clearWork();
      await seed({ kind: "event", min: -30, type: "match", status: "open", card, reminded: "all", locked: false, rendered: "after" });
      expect([card, "after", await rows(), await gate()]).toEqual([card, "after", 0, false]);
    }
  });
});

/** A reader switched off with SCRAPE_DISABLED=all writes no run; its skip counts as one, so the job does not wake on every tick. */
describe("a reader switched off", () => {
  it("wakes the job once in 12 minutes, not on every tick", async () => {
    await seed({ kind: "club", base: AT, lastRunMin: null, tz: "Asia/Bangkok", link: "booking", rejected: false });
    expect(await gate(AT)).toBe(true);
    expect(await scrapeIfDue(db, AT, { adapters: [reader], disabled: "all" })).toEqual({ skipped: "off" });
    expect(await gate(at(5))).toBe(false);
    expect(await gate(at(10))).toBe(false);
    expect(await gate(at(12))).toBe(true);
  });
});

/** The night itself: nothing due, then the reader's morning turn. */
describe("a night with nothing due", () => {
  it("says no all night for clubs that sleep, and yes on the first tick of their morning", async () => {
    await seed({ kind: "club", base: NIGHT, lastRunMin: null, tz: "Asia/Bangkok", link: "booking", rejected: false });
    await setMetric(db, "cron_scrape_at", Math.floor(new Date("2026-10-10T15:45:00Z").getTime() / 1000), "2026-10-10");
    // A tick every 15 minutes from 16:00 UTC (23:00 Bangkok) to 22:45 UTC (05:45), and the last one at 05:55: no.
    const yes: string[] = [];
    for (const i of [...Array.from({ length: 28 }, (_, k) => k * 3), 83]) {
      const tick = new Date(Date.parse("2026-10-10T16:00:00Z") + i * 5 * MIN);
      if (await gate(tick)) yes.push(tick.toISOString());
    }
    expect(yes).toEqual([]);
    expect(await gate(new Date("2026-10-10T23:00:00Z"))).toBe(true);
  });
});
