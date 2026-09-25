import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events, scores, slots, telegramCards, telegramChats, type Player } from "@/db/schema";
import { closeScoreNudges } from "@/lib/afterMatch";
import { matchToPublic } from "@/lib/api/serialize";
import { postResult, resultSummary, syncCards } from "@/lib/channels";
import { telegramChannel } from "@/lib/channels/telegram";
import { renderDiscordCard } from "@/lib/discord/card";
import { countLateExits, firstName, isLateExit, LATE_MS, lastLateExit, lateExitFor, lateExitLine, plainLine, setBanter, streakLine, streakOf, winStreakFor } from "@/lib/domain/banter";
import { createEvent } from "@/lib/domain/events";
import { winStreak } from "@/lib/domain/milestones";
import { getEventByCode } from "@/lib/domain/queries";
import { joinEvent, leaveEvent } from "@/lib/domain/slots";
import { cardVersion } from "@/lib/resultCard";
import { freezeClock } from "./helpers/clock";
import { createTestDb, DAY, HOUR, makePlayer } from "./helpers/db";

/**
 * Banter (`src/lib/domain/banter.ts`): the owner, 25 September 2026, option A. Facts only, from the
 * players' own matches, in the crew's own card and chat and on the result card picture, never on a
 * public page; the organiser switches it off with one tap.
 */

/** Wednesday 10 June 2026, 16:00 in Bangkok. Every date below is counted from here. */
const NOW = new Date("2026-06-10T09:00:00Z");
freezeClock(NOW);
const at = (ms: number) => new Date(NOW.getTime() + ms);

describe("the rules, pure", () => {
  it("a late exit is one within 24 hours before the start, and never after it", () => {
    const start = at(10 * HOUR);
    expect(isLateExit(at(0), start)).toBe(true);
    expect(isLateExit(new Date(start.getTime() - LATE_MS), start)).toBe(true);
    expect(isLateExit(new Date(start.getTime() - LATE_MS - 1), start)).toBe(false);
    expect(isLateExit(start, start)).toBe(false);
  });

  it("counts late exits in the 90 days up to this one: not the one on day 91, not an early one, not one from the waitlist", () => {
    const late = (daysAgo: number) => ({ at: at(-daysAgo * DAY), startsAt: at(-daysAgo * DAY + 2 * HOUR) });
    const three = [late(0), late(30), late(60)];
    expect(countLateExits(three, NOW)).toBe(3);
    expect(countLateExits([...three, late(91)], NOW), "the day-91 exit is outside the window").toBe(3);
    expect(countLateExits([late(0), late(30), late(91)], NOW)).toBe(2);
    const early = { at: at(-20 * DAY), startsAt: at(-20 * DAY + 25 * HOUR) };
    expect(countLateExits([late(0), late(30), early], NOW), "left 25 hours before the start is not late").toBe(2);
    expect(countLateExits([late(0), late(30), { ...late(10), waitlist: true }], NOW), "a waitlist exit opened no spot").toBe(2);
  });

  it("a streak is the wins in a row at the top of the history; a loss breaks it, an unscored match or a draw does not", () => {
    expect(winStreak(["won", "won", "won", "lost", "won"])).toBe(3);
    expect(winStreak(["won", null, "draw", "won", "lost"])).toBe(2);
    expect(winStreak(["lost", "won", "won", "won"])).toBe(0);
    const history = new Map([
      ["e", ["won", "won", "won", "won"] as const],
      ["b", ["won", "won", "won", "won"] as const],
      ["c", ["won", "won", "lost"] as const],
    ]);
    const h = new Map([...history].map(([k, v]) => [k, [...v]]));
    expect(streakOf([{ id: "e", name: "Erik Svensson" }, { id: "b", name: "Bo" }], h)).toEqual({ names: ["Erik", "Bo"], count: 4 });
    expect(streakOf([{ id: "c", name: "Cy" }], h)).toBeNull();
  });

  it("calls out an exit only while it is the last change to the seats and the spot it opened is still open", () => {
    const start = at(5 * HOUR);
    const seat = (position: number, playerId: string | null) => ({ position, playerId, status: playerId ? "joined" : "empty" });
    const row = (verb: string, actorPlayerId: string, createdAt: Date, meta: Record<string, number> | null = null) => ({ verb, actorPlayerId, createdAt, meta, actor: { displayName: actorPlayerId === "bo" ? "Bo Larsson" : "X" } });
    const detail = (roster: ReturnType<typeof seat>[], activity: ReturnType<typeof row>[], banter = true) =>
      ({ event: { status: "open", capacity: 4, startsAt: start }, creator: { banter }, roster, waitlist: [], activity }) as unknown as Parameters<typeof lastLateExit>[0];
    const threeIn = [seat(1, "ana"), seat(2, "cy"), seat(3, "di"), seat(4, null)];
    const left = row("left", "bo", NOW);
    expect(lastLateExit(detail(threeIn, [left, row("joined", "bo", at(-DAY))]), NOW)).toEqual({ playerId: "bo", name: "Bo Larsson", at: NOW });
    expect(lastLateExit(detail(threeIn, [left], false), NOW), "banter off").toBeNull();
    expect(lastLateExit(detail(threeIn, [left]), start), "the match has started").toBeNull();
    // Bo's exit sorts last, but somebody holds the seat: a promotion logged on the database's clock can sort before it.
    expect(lastLateExit(detail([...threeIn.slice(0, 3), seat(4, "wes")], [left, row("promoted", "wes", at(-1000))]), NOW), "no spot open").toBeNull();
    expect(lastLateExit(detail(threeIn, [row("removed", "ana", at(60_000)), left]), NOW), "a later change to the seats").toBeNull();
    expect(lastLateExit(detail(threeIn, [row("updated", "ana", at(60_000)), left]), NOW), "an edit is not a change to the seats").not.toBeNull();
    expect(lastLateExit(detail(threeIn, [row("left", "eve", at(60_000), { waitlist: 1 }), left]), NOW), "a waitlist exit changes no seat").not.toBeNull();
    expect(lastLateExit(detail(threeIn, [row("left", "bo", at(-2 * DAY))]), NOW), "an early exit").toBeNull();
    expect(lastLateExit(detail([...threeIn.slice(0, 3), seat(4, null), seat(5, "bo")], [left]), NOW), "Bo is back in").toBeNull();
  });

  it("chooses the line by the match code, in the reader's language, with first names and the right grammar", () => {
    const s = { names: ["Erik"], count: 3 };
    expect(streakLine("en", "ab12", s)).toBe(streakLine("en", "ab12", s));
    const codes = ["ab12", "cd34", "ef56", "gh78", "ij90", "kl11", "mn22", "op33"];
    expect(new Set(codes.map((c) => streakLine("en", c, s))).size, "several lines, not one").toBeGreaterThan(1);
    for (const c of codes) {
      expect(streakLine("en", c, s)).toContain("Erik");
      expect(streakLine("en", c, s)).toContain("3");
      expect(streakLine("es", c, s)).toContain("Erik");
      expect(lateExitLine("ru", c, { name: "Bo", count: 4 })).toMatch(/^Bo[: ]/);
    }
    // Russian counts: 3 победы, 5 побед, 21 победа; the name stays in the nominative, first.
    const ru = (n: number) => codes.map((c) => streakLine("ru", c, { names: ["Эрик"], count: n })).join(" ");
    expect(ru(3)).toMatch(/3 победы(?![а-я])/);
    expect(ru(5)).toMatch(/5 побед(?![а-я])/);
    expect(ru(21)).toMatch(/21 победа(?![а-я])/);
    expect(codes.map((c) => lateExitLine("en", c, { name: "Bo", count: 3 })).join(" ")).toContain("3rd");
    expect(codes.map((c) => lateExitLine("en", c, { name: "Bo", count: 11 })).join(" ")).toContain("11th");
    expect(firstName("  Bo  Larsson ")).toBe("Bo");
    // The picture draws no emoji: it would fetch each one from a CDN on every render.
    expect(plainLine("3 wins in a row for Erik. Somebody stop this 🔥")).toBe("3 wins in a row for Erik. Somebody stop this");
  });
});

// ---------------------------------------------------------------------------------------------

const TOKEN = "123456:TESTTOKEN";
type Call = { method: string; body: Record<string, unknown> };
let calls: Call[] = [];
let nextMessageId = 700;
const stub = () => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const method = String(url).split("/").pop()!;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ method, body });
      const result = method === "sendMessage" || method === "sendPhoto" ? { message_id: nextMessageId++, chat: { id: body.chat_id } } : true;
      return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
};
const sent = (method: string) => calls.filter((c) => c.method === method);

describe("the facts, from the rows", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await createTestDb()));
  afterAll(() => close());
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = TOKEN;
    stub();
  });

  /** A match played at `when` by two pairs, scored as given (side A first). Joined a day ahead, as in real life. */
  async function played(org: Player, a: Player[], b: Player[], when: Date, sets: [number, number][]) {
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: when, tz: "Asia/Bangkok", venueName: "Rawai Padel Club", whenFull: "closed" });
    for (const p of [...a, ...b]) await joinEvent(db, { eventId: ev.id, playerId: p.id, now: new Date(when.getTime() - DAY) });
    for (const [team, side] of [["a", a], ["b", b]] as const) for (const p of side) await db.update(slots).set({ team }).where(and(eq(slots.eventId, ev.id), eq(slots.playerId, p.id)));
    await db.insert(scores).values(sets.map(([x, y], i) => ({ eventId: ev.id, setNumber: i + 1, sideA: x, sideB: y, enteredByPlayerId: org.id })));
    await db.update(events).set({ status: "past" }).where(eq(events.id, ev.id));
    return ev;
  }

  it("three wins in a row, counting the match just scored; two is not a streak, and a loss breaks it", async () => {
    const [erik, bo, cy, di] = await Promise.all(["Erik Svensson", "Bo", "Cy", "Di"].map((n) => makePlayer(db, n)));
    const m1 = await played(erik, [erik, bo], [cy, di], at(-10 * DAY), [[3, 6], [4, 6]]);
    const m2 = await played(erik, [erik, bo], [cy, di], at(-7 * DAY), [[6, 3], [6, 4]]);
    const m3 = await played(erik, [cy, di], [erik, bo], at(-4 * DAY), [[2, 6], [3, 6]]);
    const m4 = await played(erik, [erik, bo], [cy, di], at(-1 * DAY), [[6, 1], [6, 2]]);
    const detail = async (code: string) => (await getEventByCode(db, code))!;
    expect(await winStreakFor(db, await detail(m1.code)), "the winners of m1 had never won before").toBeNull();
    expect(await winStreakFor(db, await detail(m3.code)), "two in a row is not yet a streak").toBeNull();
    expect(await winStreakFor(db, await detail(m4.code))).toEqual({ names: ["Erik", "Bo"], count: 3 });
    void m2;
    // Cy and Di win the next one: their streak is one, and Erik's three are broken.
    const m5 = await played(erik, [cy, di], [erik, bo], at(-3 * HOUR), [[6, 4], [6, 4]]);
    expect(await winStreakFor(db, await detail(m5.code))).toBeNull();
    const m6 = await played(erik, [erik, bo], [cy, di], at(-1 * HOUR), [[6, 0], [6, 0]]);
    expect(await winStreakFor(db, await detail(m6.code)), "the loss in m5 broke the streak").toBeNull();
    // The card of m4 still tells the streak as it stood then.
    expect(await winStreakFor(db, await detail(m4.code))).toEqual({ names: ["Erik", "Bo"], count: 3 });

    // The group's result post and the result card in each player's chat carry the line; the public shape does not.
    const d4 = await detail(m4.code);
    const line = streakLine("en", m4.code, { names: ["Erik", "Bo"], count: 3 });
    await db.insert(telegramChats).values([
      { chatId: -5001, type: "group", locale: "en" },
      { chatId: 5002, type: "private", locale: "en" },
    ]);
    await db.insert(telegramCards).values([
      { eventId: m4.id, chatId: -5001, messageId: 11, kind: "card", rendered: "x" },
      { eventId: m4.id, chatId: 5002, messageId: 12, kind: "nudge", rendered: "the waiting picture" },
    ]);
    expect(await postResult(telegramChannel, db, m4.code)).toBe(1);
    const post = sent("sendPhoto").at(-1)!;
    expect(post.body.chat_id).toBe(-5001);
    expect(String(post.body.caption)).toContain(line.replace(/&/g, "&amp;"));
    expect(await closeScoreNudges(db, m4.code)).toBe(1);
    const media = sent("editMessageMedia").at(-1)!.body.media as { caption: string };
    expect(media.caption).toContain(line.replace(/&/g, "&amp;"));
    expect(JSON.stringify(matchToPublic(d4, "https://kicksma.sh")), "the public API carries no banter").not.toContain(line);
    expect(JSON.stringify(matchToPublic(d4, "https://kicksma.sh"))).not.toMatch(/in a row|straight wins|on the trot|Win number/);

    // The organiser switches it off: no line anywhere, and the picture changes its version so no cache serves the old one.
    const before = cardVersion(d4, null);
    await setBanter(db, erik.id, false);
    const off = await detail(m4.code);
    expect(await winStreakFor(db, off)).toBeNull();
    expect(resultSummary(off, "en", "https://kicksma.sh", await winStreakFor(db, off))?.banter).toBeNull();
    expect(cardVersion(off, null)).toBe(`${before}-q`);
    calls = [];
    expect(await closeScoreNudges(db, m4.code), "the result card in the chat drops the line by an edit").toBe(1);
    expect((sent("editMessageMedia").at(-1)!.body.media as { caption: string }).caption).not.toContain(line.replace(/&/g, "&amp;"));
    await setBanter(db, erik.id, true);
    expect(await winStreakFor(db, await detail(m4.code))).toEqual({ names: ["Erik", "Bo"], count: 3 });
  });

  it("a third late pull-out in 90 days is on the crew's card while the spot is open, and gone once it is filled", async () => {
    const org = await makePlayer(db, "Olga");
    const bo = await makePlayer(db, "Bo Larsson");
    const others = await Promise.all(["Ana", "Cy", "Di", "Eve"].map((n) => makePlayer(db, n)));
    /** Bo joins a match starting at `start` three days ahead, and leaves it `before` the start. */
    const exit = async (start: Date, before: number, o: { full?: boolean } = {}) => {
      const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: start, tz: "Asia/Bangkok", whenFull: "waitlist" });
      if (o.full) for (const p of others) await joinEvent(db, { eventId: ev.id, playerId: p.id, now: new Date(start.getTime() - 4 * DAY) });
      await joinEvent(db, { eventId: ev.id, playerId: bo.id, now: new Date(start.getTime() - 3 * DAY) });
      await leaveEvent(db, { eventId: ev.id, playerId: bo.id, now: new Date(start.getTime() - before) });
      return ev;
    };
    await exit(at(-91 * DAY), 2 * HOUR); // late, but on day 91: outside the window
    await exit(at(-60 * DAY), 3 * HOUR); // late
    await exit(at(-30 * DAY), 20 * HOUR); // late
    await exit(at(-20 * DAY), 25 * HOUR); // early: more than 24 hours ahead
    await exit(at(-10 * DAY), 1 * HOUR, { full: true }); // from the waitlist: it opened no spot

    // Today's match: Ana, Cy and Di are in, Bo pulls out five hours before the start.
    const today = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: at(5 * HOUR), tz: "Asia/Bangkok", venueName: "Rawai Padel Club", whenFull: "waitlist" });
    for (const p of [...others.slice(0, 3), bo]) await joinEvent(db, { eventId: today.id, playerId: p.id, now: at(-2 * DAY) });
    await db.insert(telegramChats).values({ chatId: -6001, type: "group", locale: "en" });
    await db.insert(telegramCards).values({ eventId: today.id, chatId: -6001, messageId: 21, kind: "card", rendered: "before" });
    await leaveEvent(db, { eventId: today.id, playerId: bo.id, now: NOW });

    const detail = (await getEventByCode(db, today.code))!;
    expect(await lateExitFor(db, detail, NOW)).toEqual({ name: "Bo", count: 3 });
    const line = lateExitLine("en", today.code, { name: "Bo", count: 3 });
    // The card in the crew's chat carries it, by an edit and never a new message (rule 5).
    calls = [];
    expect(await syncCards(telegramChannel, db, today.code, NOW)).toBe(1);
    expect(sent("sendMessage")).toHaveLength(0);
    expect(String(sent("editMessageText").at(-1)!.body.text)).toContain(line);
    expect(renderDiscordCard({ ...detail, lateExit: { name: "Bo", count: 3 } }, "https://kicksma.sh", "en").embeds[0].fields?.[0].value).toContain("Bo");
    // The public shape and the match itself say nothing about it.
    expect(JSON.stringify(matchToPublic(detail, "https://kicksma.sh"))).not.toContain(line);

    // Eve takes the spot: the line goes with the next edit.
    await joinEvent(db, { eventId: today.id, playerId: others[3].id, now: at(10 * 60 * 1000) });
    calls = [];
    expect(await syncCards(telegramChannel, db, today.code, at(10 * 60 * 1000))).toBe(1);
    expect(String(sent("editMessageText").at(-1)!.body.text)).not.toContain(line);
    expect(await lateExitFor(db, (await getEventByCode(db, today.code))!, at(10 * 60 * 1000))).toBeNull();
  });

  it("an early exit, or the organiser's switch, leaves the card alone", async () => {
    const org = await makePlayer(db, "Oscar");
    const bo = await makePlayer(db, "Bo");
    const ana = await makePlayer(db, "Ana");
    const past = async (daysAgo: number) => {
      const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: at(-daysAgo * DAY), tz: "UTC", whenFull: "waitlist" });
      await joinEvent(db, { eventId: ev.id, playerId: bo.id, now: at(-daysAgo * DAY - 3 * DAY) });
      await leaveEvent(db, { eventId: ev.id, playerId: bo.id, now: at(-daysAgo * DAY - 2 * HOUR) });
    };
    await past(40);
    await past(20);
    // Two late exits already; this one is thirty hours ahead of the start, so it is not the third.
    const early = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: at(30 * HOUR), tz: "UTC", whenFull: "waitlist" });
    for (const p of [ana, bo]) await joinEvent(db, { eventId: early.id, playerId: p.id, now: at(-DAY) });
    await leaveEvent(db, { eventId: early.id, playerId: bo.id, now: NOW });
    expect(await lateExitFor(db, (await getEventByCode(db, early.code))!, NOW)).toBeNull();
    // A late one is the third, unless the organiser switched banter off.
    const late = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: at(3 * HOUR), tz: "UTC", whenFull: "waitlist" });
    for (const p of [ana, bo]) await joinEvent(db, { eventId: late.id, playerId: p.id, now: at(-DAY) });
    await leaveEvent(db, { eventId: late.id, playerId: bo.id, now: at(60 * 1000) });
    expect(await lateExitFor(db, (await getEventByCode(db, late.code))!, at(2 * 60 * 1000))).toEqual({ name: "Bo", count: 3 });
    await setBanter(db, org.id, false);
    expect(await lateExitFor(db, (await getEventByCode(db, late.code))!, at(2 * 60 * 1000))).toBeNull();
  });
});

describe("banter stays where the crew looks", () => {
  /**
   * Option A: the crew's own card and chat and the result card picture, never a public page. The
   * module is imported by exactly these files; a profile, a board, a ranking, /built, the API or the
   * MCP reaching for it fails here before it reaches a review.
   */
  it("only the crew's surfaces import it", () => {
    const root = path.resolve(process.cwd(), "src");
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(dir, e.name)] : []));
    const importers = files(root)
      .filter((f) => /["'][^"'\s]*\/banter["']/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(root, f).split(path.sep).join("/"))
      .sort();
    expect(importers).toEqual(
      [
        "actions/events.ts",
        "app/[code]/card/opengraph-image.tsx",
        "app/[code]/card/page.tsx",
        "lib/afterMatch.ts",
        "lib/channels/cards.ts",
        "lib/discord/card.ts",
        "lib/line/card.ts",
        "lib/telegram/card.ts",
      ].sort(),
    );
  });
});
