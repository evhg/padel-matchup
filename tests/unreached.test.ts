import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events, passkeys, pushSubscriptions, type Event, type Player } from "@/db/schema";
import { createEvent } from "@/lib/domain/events";
import { pastPlayerRows, type PastPlayer } from "@/lib/domain/heldRecord";
import { refillAudience, PARTNER_WINDOW_MS, type RefillReach } from "@/lib/domain/refill";
import { joinEvent } from "@/lib/domain/slots";
import { firstName, unreachedCandidates, unreachedDue, unreachedLine, unreachedNames, unreachedPartners, UNREACHED_SHOWN, type ReachRow, type UnreachedHere } from "@/lib/domain/unreached";
import { freezeClock } from "./helpers/clock";
import { createTestDb, DAY, HOUR, makePlayer } from "./helpers/db";

/**
 * The owner's decision of 15 October 2026 (D1, DECIDING rule 7). The question: "May the organiser's
 * match page name the past partners that Kicksmash cannot reach (no email, Telegram or push), so the
 * organiser sends them the link?" The answer: "Name them (Recommended)": "Only the organiser sees it,
 * only while a place is open, only partners from the last 60 days. Pro: you know whom to message (Tim,
 * Adrian). Con: it shows that a named person gave Kicksmash no contact."
 *
 * For TDsv the free-seat offer reached Micky and Nicolai and not Tim or Adrian, who both played with
 * Erik. The line names Tim and Adrian, and only them: the same two tests the offer makes (`admits`,
 * `channelOf`), over the organiser's past players the page reads already.
 */

// A fixed clock (rule 11).
const NOW = new Date(Date.UTC(2026, 9, 15, 4, 0));
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
freezeClock(NOW);

const ALL: RefillReach = { telegram: true, whatsapp: true, email: true, push: true };
const NONE: RefillReach = { telegram: false, whatsapp: false, email: false, push: false };

// ------------------------------------------------------------------ the rules, as tables

describe("when the line may stand", () => {
  const match: Pick<Event, "type" | "status" | "startsAt"> = { type: "match", status: "open", startsAt: new Date(NOW.getTime() + 2 * DAY) };
  const TABLE: [string, Partial<typeof match>, number, Date, boolean, boolean][] = [
    ["the organiser, on a match to come with a seat open", {}, 1, NOW, true, true],
    ["a viewer who is not the organiser: never, whatever the match", {}, 1, NOW, false, false],
    ["a full match", {}, 0, NOW, true, false],
    ["a match called off", { status: "cancelled" }, 1, NOW, true, false],
    ["a match the sweep marked past", { status: "past" }, 1, NOW, true, false],
    ["a match that started", {}, 1, new Date(match.startsAt.getTime() + HOUR), true, false],
    ["the very minute it starts", {}, 1, match.startsAt, true, false],
    ["a tournament: the offer reaches no partners there, so the line names none", { type: "tournament" }, 1, NOW, true, false],
  ];
  it.each(TABLE)("%s", (_why, over, seats, now, organiser, expected) => {
    expect(unreachedDue({ ...match, ...over }, seats, now, organiser)).toBe(expected);
  });
});

describe("who the offer would want: the organiser's past players of the last 60 days, not here", () => {
  const p = (id: string, name: string, daysAgo: number): PastPlayer => ({ id, name, last: ago(daysAgo), club: "Warehaus", tz: "Asia/Bangkok" });
  const here = (o: Partial<UnreachedHere> = {}): UnreachedHere => ({ ids: new Set(), names: [], gone: new Set(), ...o });
  const tim = p("tim", "Tim", 10);
  const TABLE: [string, PastPlayer[], UnreachedHere, string[]][] = [
    ["Tim, who played with the organiser ten days ago", [tim], here(), ["tim"]],
    ["sixty days ago to the minute counts", [p("tim", "Tim", PARTNER_WINDOW_MS / DAY)], here(), ["tim"]],
    ["a minute more than sixty days does not", [{ ...tim, last: new Date(NOW.getTime() - PARTNER_WINDOW_MS - 60_000) }], here(), []],
    ["Tim holds a row in this match", [tim], here({ ids: new Set(["tim"]) }), []],
    ["a place here is held for the name Tim", [tim], here({ names: ["Tim"] }), []],
    ["Tim just left this match, or was taken out", [tim], here({ gone: new Set(["tim"]) }), []],
    ["two records called Tim: nobody the organiser can tell apart", [tim, p("tim2", "tim", 20)], here(), []],
  ];
  it.each(TABLE)("%s", (_why, list, h, ids) => {
    expect(unreachedCandidates(list, h, NOW).map((c) => c.id)).toEqual(ids);
  });
});

describe("whom no channel reaches: the offer's own test, channel by channel", () => {
  const bare: ReachRow = { id: "tim", level: null, telegramId: null, phone: null, email: null, emailNotifications: true, push: false };
  const TABLE: [string, Partial<ReachRow>, RefillReach, { levelMin: number | null; levelMax: number | null }, boolean][] = [
    ["nothing at all: unreached", {}, ALL, { levelMin: null, levelMax: null }, true],
    ["a Telegram account, with the bot on", { telegramId: 77 }, ALL, { levelMin: null, levelMax: null }, false],
    ["a Telegram account on a deployment with no bot", { telegramId: 77 }, { ...ALL, telegram: false }, { levelMin: null, levelMax: null }, true],
    ["a WhatsApp number, with the templates on", { phone: "+66810000000" }, ALL, { levelMin: null, levelMax: null }, false],
    ["a WhatsApp number on a deployment with no templates", { phone: "+66810000000" }, { ...ALL, whatsapp: false }, { levelMin: null, levelMax: null }, true],
    ["an email with activity mail on", { email: "tim@example.com" }, ALL, { levelMin: null, levelMax: null }, false],
    ["an email the player muted: the offer sends it nothing", { email: "tim@example.com", emailNotifications: false }, ALL, { levelMin: null, levelMax: null }, true],
    ["a device with push on", { push: true }, ALL, { levelMin: null, levelMax: null }, false],
    ["every channel off on this deployment", { telegramId: 77, email: "tim@example.com", push: true }, NONE, { levelMin: null, levelMax: null }, true],
    ["outside the match's range: the offer would not want him", { level: 2 }, ALL, { levelMin: 3, levelMax: 4 }, false],
    ["no level on a ranged match: the offer does not chase him", {}, ALL, { levelMin: 3, levelMax: 4 }, false],
    ["inside the range, unreached", { level: 3.5 }, ALL, { levelMin: 3, levelMax: 4 }, true],
  ];
  it.each(TABLE)("%s", (_why, over, reach, range, named) => {
    expect(unreachedNames([{ id: "tim", name: "Tim Berg" }], [{ ...bare, ...over }], reach, range)).toEqual(named ? ["Tim"] : []);
  });

  it("names first names only, in the order given, and nobody without a row", () => {
    expect(unreachedNames([{ id: "a", name: "Adrian  Kowalski" }, { id: "gone", name: "Ghost" }, { id: "t", name: " Tim " }], [{ ...bare, id: "a" }, { ...bare, id: "t" }], ALL, { levelMin: null, levelMax: null })).toEqual(["Adrian", "Tim"]);
    expect(firstName("  Tim  Berg ")).toBe("Tim");
  });

  it("shows five names at most, then how many more", () => {
    const names = ["Tim", "Adrian", "Bo", "Cy", "Di", "Ed", "Flo"];
    expect(unreachedLine(names)).toEqual({ shown: names.slice(0, UNREACHED_SHOWN), more: 2 });
    expect(unreachedLine(["Tim", "Adrian"])).toEqual({ shown: ["Tim", "Adrian"], more: 0 });
    expect(unreachedLine([])).toEqual({ shown: [], more: 0 });
  });
});

// ------------------------------------------------------------------ TDsv, on a real database

describe("TDsv: Erik's match, a seat open, four past partners", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  /** Erik's played match ten days ago with Micky (email), Nicolai (push), Tim (nothing), and Adrian's two weeks ago, Adrian with a passkey and nothing else; then TDsv, Erik and Bo in it. */
  const tdsv = async () => {
    const erik = await makePlayer(db, "Erik", { email: "erik-tdsv@example.com" });
    const micky = await makePlayer(db, "Micky", { email: "micky@example.com" });
    const nicolai = await makePlayer(db, "Nicolai");
    await db.insert(pushSubscriptions).values({ playerId: nicolai.id, endpoint: `https://push.example/${nicolai.id}`, p256dh: "key", auth: "auth" });
    const tim = await makePlayer(db, "Tim");
    const adrian = await makePlayer(db, "Adrian Kowalski");
    await db.insert(passkeys).values({ id: `cred-${adrian.id}`, playerId: adrian.id, publicKey: "pk", deviceType: "multiDevice" });
    const old = await makePlayer(db, "Olaf");
    const played = async (daysAgo: number, who: Player[]) => {
      const ev = await createEvent(db, { creatorPlayerId: erik.id, type: "match", startsAt: new Date(NOW.getTime() + DAY), tz: "Asia/Bangkok", whenFull: "waitlist", venueName: "Warehaus" });
      for (const p of [erik, ...who]) await joinEvent(db, { eventId: ev.id, playerId: p.id, now: NOW });
      await db.update(events).set({ startsAt: ago(daysAgo), status: "past" }).where(eq(events.id, ev.id));
    };
    await played(10, [micky, nicolai, tim]);
    await played(14, [adrian]);
    // Olaf played with Erik ninety days ago: outside the sixty days, as he is for the offer.
    await played(90, [old]);
    const bo = await makePlayer(db, "Bo");
    const ev = await createEvent(db, { creatorPlayerId: erik.id, type: "match", startsAt: new Date(NOW.getTime() + 6 * HOUR), tz: "Asia/Bangkok", whenFull: "waitlist", venueName: "Warehaus" });
    for (const p of [erik, bo]) await joinEvent(db, { eventId: ev.id, playerId: p.id, now: NOW });
    const [row] = await db.select().from(events).where(eq(events.id, ev.id));
    return { erik, micky, nicolai, tim, adrian, ev: row };
  };
  const here = (ids: string[]): UnreachedHere => ({ ids: new Set(ids), names: [], gone: new Set() });

  it("names Tim and Adrian, the two the offer cannot reach, and never Micky or Nicolai, whom it does: exactly the offer's split", async () => {
    const { erik, ev } = await tdsv();
    const reach: RefillReach = { telegram: true, whatsapp: false, email: true, push: true };
    const list = await pastPlayerRows(db, erik.id, NOW);
    const names = await unreachedPartners(db, ev, list, here([erik.id]), reach, NOW);
    expect(names.sort()).toEqual(["Adrian", "Tim"]);
    // The offer itself, on the same match: it reaches the other two, and none of the named.
    const audience = (await refillAudience(db, ev, NOW, reach)).map((p) => p.displayName).sort();
    expect(audience).toEqual(["Micky", "Nicolai"]);
  });

  it("reads nothing when nobody is a candidate", async () => {
    const throwing = new Proxy({} as Db, {
      get() {
        throw new Error("a read with nothing to read");
      },
    });
    expect(await unreachedPartners(throwing, { levelMin: null, levelMax: null }, [], here([]), ALL, NOW)).toEqual([]);
  });

  it("on a deployment with no channel at all, every partner of the sixty days is unreached", async () => {
    const { erik, ev } = await tdsv();
    const list = await pastPlayerRows(db, erik.id, NOW);
    expect((await unreachedPartners(db, ev, list, here([erik.id]), NONE, NOW)).sort()).toEqual(["Adrian", "Micky", "Nicolai", "Tim"]);
  });
});
