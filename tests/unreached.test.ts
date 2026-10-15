import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events, passkeys, pushSubscriptions, type Event, type Player } from "@/db/schema";
import { createEvent } from "@/lib/domain/events";
import { pastPartners, refillAudience, type RefillReach } from "@/lib/domain/refill";
import { joinEvent } from "@/lib/domain/slots";
import { firstName, unreachedCandidates, unreachedDue, unreachedLine, unreachedNames, unreachedPartners, UNREACHED_SHOWN, type PartnerRow, type UnreachedHere } from "@/lib/domain/unreached";
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
 * Erik. The line names Tim and Adrian, and only them: the offer's own past partners (`partnersQuery`,
 * matches that ended in the last 60 days, never an americano or a match still being played) and the
 * same two tests the offer makes (`admits`, `channelOf`).
 */

// A fixed clock (rule 11).
const NOW = new Date(Date.UTC(2026, 9, 15, 4, 0));
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

describe("whom the line may name: the offer's past partners, not here, one record and one first name", () => {
  const row = (id: string, name: string): PartnerRow => ({ id, name, level: null, telegramId: null, phone: null, email: null, emailNotifications: true, push: false });
  const here = (o: Partial<UnreachedHere> = {}): UnreachedHere => ({ ids: new Set(), names: [], gone: new Set(), ...o });
  const tim = row("tim", "Tim");
  const TABLE: [string, PartnerRow[], UnreachedHere, string[]][] = [
    ["Tim, a past partner", [tim], here(), ["tim"]],
    ["Tim holds a row in this match", [tim], here({ ids: new Set(["tim"]) }), []],
    ["a place here is held for the name Tim", [tim], here({ names: ["Tim"] }), []],
    ["Tim just left this match, or was taken out", [tim], here({ gone: new Set(["tim"]) }), []],
    ["two records called Tim: nobody the organiser can tell apart", [tim, row("tim2", "tim")], here(), []],
    ["Tim Smith and Tim Jones: the line shows first names, so \"Tim and Tim\" is nobody either", [row("ts", "Tim Smith"), row("tj", "Tim Jones"), row("a", "Adrian")], here(), ["a"]],
    ["one of the two Tims is in this match: the other is the only Tim the line can mean", [row("ts", "Tim Smith"), row("tj", "Tim Jones")], here({ ids: new Set(["ts"]) }), ["tj"]],
    ["a deleted account is nobody", [row("d", "Deleted player")], here(), []],
    ["a record with no name is nobody", [row("x", "  ")], here(), []],
  ];
  it.each(TABLE)("%s", (_why, rows, h, ids) => {
    expect(unreachedCandidates(rows, h).map((c) => c.id)).toEqual(ids);
  });

  it("two Tims with different last names, one reachable: neither is named, because the organiser cannot tell which Tim", () => {
    const rows = [{ ...row("ts", "Tim Smith"), email: "tim@example.com" }, row("tj", "Tim Jones")];
    expect(unreachedNames(rows, here(), ALL, { levelMin: null, levelMax: null })).toEqual([]);
  });
});

describe("whom no channel reaches: the offer's own test, channel by channel", () => {
  const bare: PartnerRow = { id: "tim", name: "Tim Berg", level: null, telegramId: null, phone: null, email: null, emailNotifications: true, push: false };
  const nobody: UnreachedHere = { ids: new Set(), names: [], gone: new Set() };
  const TABLE: [string, Partial<PartnerRow>, RefillReach, { levelMin: number | null; levelMax: number | null }, boolean][] = [
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
    expect(unreachedNames([{ ...bare, ...over }], nobody, reach, range)).toEqual(named ? ["Tim"] : []);
  });

  it("names first names only, in the order given", () => {
    expect(unreachedNames([{ ...bare, id: "a", name: "Adrian  Kowalski" }, { ...bare, id: "t", name: " Tim " }], nobody, ALL, { levelMin: null, levelMax: null })).toEqual(["Adrian", "Tim"]);
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

describe("TDsv: Erik's match, a seat open, the offer's past partners", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  /** An event Erik made, with these players seated, that started `minutesAgo` before NOW: a match that ended unless it is still being played. */
  const playedBy = async (organiser: Player, seated: Player[], minutesAgo: number, o: { type?: "match" | "tournament"; status?: "past" | "open" } = {}) => {
    const type = o.type ?? "match";
    const ev = await createEvent(db, { creatorPlayerId: organiser.id, type, ...(type === "tournament" ? { capacity: 8 } : {}), startsAt: new Date(NOW.getTime() + DAY), tz: "Asia/Bangkok", whenFull: "waitlist", venueName: "Warehaus" });
    for (const p of seated) await joinEvent(db, { eventId: ev.id, playerId: p.id, now: NOW });
    await db.update(events).set({ startsAt: new Date(NOW.getTime() - minutesAgo * 60_000), status: o.status ?? "past" }).where(eq(events.id, ev.id));
    return ev;
  };
  /** The match to come, six hours on, with these players seated. */
  const nextMatch = async (organiser: Player, seated: Player[]) => {
    const ev = await createEvent(db, { creatorPlayerId: organiser.id, type: "match", startsAt: new Date(NOW.getTime() + 6 * HOUR), tz: "Asia/Bangkok", whenFull: "waitlist", venueName: "Warehaus" });
    for (const p of seated) await joinEvent(db, { eventId: ev.id, playerId: p.id, now: NOW });
    const [row] = await db.select().from(events).where(eq(events.id, ev.id));
    return row;
  };
  const DAYS = 24 * 60;

  /** Erik's played match ten days ago with Micky (email), Nicolai (push), Tim (nothing), and Adrian's two weeks ago, Adrian with a passkey and nothing else; then TDsv, Erik and Bo in it. */
  const tdsv = async () => {
    const erik = await makePlayer(db, "Erik", { email: `erik-${crypto.randomUUID()}@example.com` });
    const micky = await makePlayer(db, "Micky", { email: `micky-${crypto.randomUUID()}@example.com` });
    const nicolai = await makePlayer(db, "Nicolai");
    await db.insert(pushSubscriptions).values({ playerId: nicolai.id, endpoint: `https://push.example/${nicolai.id}`, p256dh: "key", auth: "auth" });
    const tim = await makePlayer(db, "Tim");
    const adrian = await makePlayer(db, "Adrian Kowalski");
    await db.insert(passkeys).values({ id: `cred-${adrian.id}`, playerId: adrian.id, publicKey: "pk", deviceType: "multiDevice" });
    const old = await makePlayer(db, "Olaf");
    await playedBy(erik, [erik, micky, nicolai, tim], 10 * DAYS);
    await playedBy(erik, [erik, adrian], 14 * DAYS);
    // Olaf played with Erik sixty-one days ago: outside the sixty days, as he is for the offer.
    await playedBy(erik, [erik, old], 61 * DAYS);
    const bo = await makePlayer(db, "Bo");
    const ev = await nextMatch(erik, [erik, bo]);
    return { erik, bo, ev };
  };
  const here = (ids: string[]): UnreachedHere => ({ ids: new Set(ids), names: [], gone: new Set() });

  it("names Tim and Adrian, the two the offer cannot reach, and never Micky or Nicolai, whom it does: exactly the offer's split", async () => {
    const { erik, bo, ev } = await tdsv();
    const reach: RefillReach = { telegram: true, whatsapp: false, email: true, push: true };
    const names = await unreachedPartners(db, ev, here([erik.id, bo.id]), reach, NOW);
    expect(names.sort()).toEqual(["Adrian", "Tim"]);
    // The offer itself, on the same match: it reaches the other two, and none of the named.
    const audience = (await refillAudience(db, ev, NOW, reach)).map((p) => p.displayName).sort();
    expect(audience).toEqual(["Micky", "Nicolai"]);
  });

  it("on a deployment with no channel at all, the line names every partner the offer would want: its own partners of the sixty days", async () => {
    const { erik, bo, ev } = await tdsv();
    const names = await unreachedPartners(db, ev, here([erik.id, bo.id]), NONE, NOW);
    expect(names.sort()).toEqual(["Adrian", "Micky", "Nicolai", "Tim"]);
    const partners = await pastPartners(db, ev, NOW);
    expect(partners).toHaveLength(4);
  });

  it("an americano, a match Erik made and did not play, and a match still being played make no partners, for the offer or the line", async () => {
    const erik = await makePlayer(db, "Erik");
    const pat = await makePlayer(db, "Pat");
    const zoe = await makePlayer(db, "Zoe");
    const zed = await makePlayer(db, "Zed");
    const yuri = await makePlayer(db, "Yuri");
    const ivo = await makePlayer(db, "Ivo");
    // Pat played a match with Erik ten days ago: the one partner.
    await playedBy(erik, [erik, pat], 10 * DAYS);
    // Zed played an americano with Erik five days ago, and Zoe one that Erik organised and did not play in.
    await playedBy(erik, [erik, zed], 5 * DAYS, { type: "tournament" });
    await playedBy(erik, [zoe], 5 * DAYS, { type: "tournament" });
    // Erik made a match for Yuri three days ago and did not sit in it.
    await playedBy(erik, [yuri], 3 * DAYS);
    // Erik and Ivo started a match half an hour ago: a 90-minute match has not ended.
    await playedBy(erik, [erik, ivo], 30, { status: "open" });
    const ev = await nextMatch(erik, [erik]);
    expect(await unreachedPartners(db, ev, here([erik.id]), NONE, NOW)).toEqual(["Pat"]);
    expect(await pastPartners(db, ev, NOW)).toEqual([pat.id]);
  });

  it("a partner of another seated player is the offer's partner too, and the organiser, seated or not, never names themself", async () => {
    const erik = await makePlayer(db, "Erik");
    const bo = await makePlayer(db, "Bo");
    const xena = await makePlayer(db, "Xena");
    // Bo played with Xena, and with Erik, in matches that ended.
    await playedBy(bo, [bo, xena], 5 * DAYS);
    await playedBy(erik, [erik, bo], 7 * DAYS);
    // Erik's next match seats Bo and not Erik himself.
    const ev = await nextMatch(erik, [bo]);
    expect((await pastPartners(db, ev, NOW)).sort()).toEqual([erik.id, xena.id].sort());
    expect(await unreachedPartners(db, ev, here([bo.id]), NONE, NOW)).toEqual(["Xena"]);
  });

  it("two partners called Tim, with different last names: the line names neither", async () => {
    const erik = await makePlayer(db, "Erik");
    const smith = await makePlayer(db, "Tim Smith");
    const jones = await makePlayer(db, "Tim Jones");
    const adrian = await makePlayer(db, "Adrian");
    await playedBy(erik, [erik, smith, jones, adrian], 4 * DAYS);
    const ev = await nextMatch(erik, [erik]);
    expect(await unreachedPartners(db, ev, here([erik.id]), NONE, NOW)).toEqual(["Adrian"]);
  });

  it("reads nothing for a tournament: the offer has no partners there", async () => {
    const throwing = new Proxy({} as Db, {
      get() {
        throw new Error("a read for a tournament");
      },
    });
    const ev = { id: "x", type: "tournament", capacity: 8, creatorPlayerId: "y", levelMin: null, levelMax: null } as const;
    expect(await unreachedPartners(throwing, ev, here([]), ALL, NOW)).toEqual([]);
  });
});
