import { readFileSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { createTranslator } from "next-intl";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { activity, clubSlots, events, series as seriesTable } from "@/db/schema";
import { fail } from "@/lib/api/http";
import { createMatch, NO_SIDE_EFFECTS } from "@/lib/api/operations";
import { boardToPublic, matchToPublic, seriesToPublic } from "@/lib/api/serialize";
import { renderDiscordCard } from "@/lib/discord/card";
import { claimClub, decideClub } from "@/lib/domain/clubs";
import { addClubSlot, autoCreateClubEvents, updateClubSlot } from "@/lib/domain/clubWeek";
import { createEvent, duplicateEvent, updateEvent } from "@/lib/domain/events";
import { AGE_MINS, cleanAgeMin, cleanCategory, EVENT_CATEGORIES, hasTag, tagParts } from "@/lib/domain/eventTags";
import { autoCreateGroupMatches, createGroup, updateGroup } from "@/lib/domain/groups";
import { getEventByCode } from "@/lib/domain/queries";
import { autoCreateSeriesEditions, createSeriesFromEvent } from "@/lib/domain/series";
import { joinEvent } from "@/lib/domain/slots";
import { getVenueBoard } from "@/lib/domain/venueBoard";
import { tagChip } from "@/lib/levelText";
import { renderLineCard } from "@/lib/line/card";
import { levelLine, renderCard } from "@/lib/telegram/card";
import { freezeClock } from "./helpers/clock";
import { createTestDb, DAY, makePlayer } from "./helpers/db";

/**
 * Who a match is for. The owner decided on 9 October 2026 (decision G1): an event can carry a category
 * (men, women, mixed) and an age tag (35+, 45+, 55+). The tag is on the event, never on the player:
 * nothing about a person's gender or age is stored, and nothing is checked when somebody joins. It is
 * information that helps the right players find the game.
 */

/** Friday 9 October 2026, 16:00 in Phuket: the day the owner decided. */
const NOW = new Date("2026-10-09T09:00:00.000Z");
freezeClock(NOW);
const TZ = "Asia/Bangkok";
/** Saturday 17 October 2026, 09:30 in Phuket (02:30 UTC). */
const SAT = new Date("2026-10-17T02:30:00.000Z");
const BASE = "https://kicksma.sh";

describe("the rule", () => {
  it("knows three categories and three ages, and nothing else", () => {
    expect(EVENT_CATEGORIES).toEqual(["men", "women", "mixed"]);
    expect(AGE_MINS).toEqual([35, 45, 55]);
  });

  it.each([
    ["men", "men"],
    ["women", "women"],
    ["mixed", "mixed"],
    // A request or a form may send the word as a person writes it.
    ["Women", "women"],
    ["  MIXED ", "mixed"],
    // Everything else is no category, never an error.
    ["woman", null],
    ["ladies", null],
    ["female", null],
    ["", null],
    ["   ", null],
    ["men,women", null],
    [null, null],
    [undefined, null],
    [0, null],
    [1, null],
    [true, null],
    [{}, null],
    [["women"], null],
    [{ toString: () => "women" }, null],
  ])("cleans the category %j to %j", (input, want) => {
    expect(cleanCategory(input)).toBe(want);
  });

  it.each([
    [35, 35],
    [45, 45],
    [55, 55],
    ["45", 45],
    [" 55 ", 55],
    // An age that is not one of the three is no age: never rounded to the nearest one.
    [40, null],
    [50, null],
    [45.5, null],
    [0, null],
    [-45, null],
    [450, null],
    ["45+", null],
    ["4 5", null],
    ["", null],
    [Number.NaN, null],
    [Number.POSITIVE_INFINITY, null],
    [null, null],
    [undefined, null],
    [true, null],
    [[45], null],
    [{}, null],
  ])("cleans the age %j to %j", (input, want) => {
    expect(cleanAgeMin(input)).toBe(want);
  });

  it("never throws, whatever it is handed", () => {
    const odd: unknown[] = [Symbol("x"), BigInt(45), () => "women", new Date(), Object.create(null)];
    for (const v of odd) {
      expect(() => cleanCategory(v)).not.toThrow();
      expect(() => cleanAgeMin(v)).not.toThrow();
      expect(cleanCategory(v)).toBeNull();
      expect(cleanAgeMin(v)).toBeNull();
    }
  });
});

describe("what every screen says", () => {
  it.each([
    [{ category: "women", ageMin: null }, [{ key: "level.tagWomen" }]],
    [{ category: "men", ageMin: null }, [{ key: "level.tagMen" }]],
    [{ category: "mixed", ageMin: 45 }, [{ key: "level.tagMixed" }, { key: "level.tagAge", values: { age: 45 } }]],
    [{ category: null, ageMin: 35 }, [{ key: "level.tagAge", values: { age: 35 } }]],
    [{ category: "women", ageMin: 55 }, [{ key: "level.tagWomen" }, { key: "level.tagAge", values: { age: 55 } }]],
    // An untagged event, or a row holding something the rule does not know, says nothing at all.
    [{ category: null, ageMin: null }, []],
    [{ category: "ladies", ageMin: 40 }, []],
    [{}, []],
    [null, []],
    [undefined, []],
  ])("reads %j as %j", (tag, want) => {
    expect(tagParts(tag)).toEqual(want);
    expect(hasTag(tag)).toBe(want.length > 0);
  });

  it("puts the category before the age, so it reads 'Mixed · 45+' everywhere", () => {
    expect(tagParts({ ageMin: 45, category: "mixed" }).map((p) => p.key)).toEqual(["level.tagMixed", "level.tagAge"]);
  });
});

describe("the words, in three languages", () => {
  type Locale = "en" | "ru" | "es";
  const messages = (l: Locale) => JSON.parse(readFileSync(path.resolve(process.cwd(), "messages", `${l}.json`), "utf8"));
  const t = (l: Locale) => createTranslator({ locale: l, messages: messages(l), onError: () => undefined }) as unknown as (key: string, values?: Record<string, unknown>) => string;

  it("reads the chip the same way on every screen", () => {
    expect(tagChip(t("en"), { category: "women", ageMin: null })).toBe("Women");
    expect(tagChip(t("en"), { category: "mixed", ageMin: 45 })).toBe("Mixed · 45+");
    expect(tagChip(t("en"), { category: null, ageMin: 35 })).toBe("35+");
    expect(tagChip(t("ru"), { category: "mixed", ageMin: 45 })).toBe("Микст · 45+");
    expect(tagChip(t("ru"), { category: "men", ageMin: null })).toBe("Мужчины");
    expect(tagChip(t("es"), { category: "women", ageMin: 55 })).toBe("Mujeres · 55+");
    expect(tagChip(t("en"), { category: null, ageMin: null })).toBeNull();
    expect(tagChip(t("en"), null)).toBeNull();
  });

  it("says it in the chats as the web does, on the level's line, and leaves an untagged card exactly as it was", () => {
    expect(levelLine({ levelMin: null, levelMax: null, category: "women", ageMin: 45 }, "en")).toBe("🎚 Women · 45+");
    expect(levelLine({ levelMin: 3, levelMax: 4.5, category: "mixed", ageMin: 35 }, "en")).toBe("🎚 Level 3.0–4.5 · Mixed · 35+");
    expect(levelLine({ levelMin: 3, levelMax: 4.5, category: "mixed", ageMin: 35 }, "ru")).toBe("🎚 Уровень 3.0–4.5 · Микст · 35+");
    expect(levelLine({ levelMin: null, levelMax: null, category: "men", ageMin: null }, "es")).toBe("🎚 Hombres");
    // The line every ranged card already carries: the same text, so no card is edited for nothing.
    expect(levelLine({ levelMin: 3, levelMax: 4.5, category: null, ageMin: null }, "en")).toBe("🎚 Level 3.0–4.5");
    expect(levelLine({ levelMin: null, levelMax: null, category: null, ageMin: null }, "en")).toBeNull();
  });
});

describe("every path that writes a match keeps the tag", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await createTestDb()));
  afterAll(() => close());

  const match = (creatorPlayerId: string, o: { category?: unknown; ageMin?: unknown; venueName?: string; levelMin?: number; levelMax?: number } = {}) =>
    createEvent(db, { creatorPlayerId, type: "match", startsAt: SAT, tz: TZ, whenFull: "waitlist", venueName: o.venueName ?? "Tag Padel", category: o.category as never, ageMin: o.ageMin as never, levelMin: o.levelMin, levelMax: o.levelMax });

  it("creates with the tag, without one, and stores what it does not know as none", async () => {
    const org = await makePlayer(db, "Olga");
    expect(await match(org.id, { category: "women", ageMin: 45 })).toMatchObject({ category: "women", ageMin: 45 });
    expect(await match(org.id)).toMatchObject({ category: null, ageMin: null });
    expect(await match(org.id, { category: "Mixed", ageMin: "35" })).toMatchObject({ category: "mixed", ageMin: 35 });
    expect(await match(org.id, { category: "ladies", ageMin: 40 })).toMatchObject({ category: null, ageMin: null });
  });

  it("sets, keeps and clears it on an edit, writes only what changed, and sends no calendar", async () => {
    const org = await makePlayer(db, "Edith");
    const ev = await match(org.id);
    const updates = async () => (await db.select().from(activity).where(and(eq(activity.eventId, ev.id), eq(activity.verb, "updated")))).length;

    const set = await updateEvent(db, ev.id, org.id, { category: "women" });
    expect(set.event).toMatchObject({ category: "women", ageMin: null });
    // Information, not a time or a place: nobody's calendar entry changes.
    expect(set.calendarChanged).toBe(false);
    expect(set.event.icsSequence).toBe(ev.icsSequence);

    // The other half alone leaves the first where it was.
    expect((await updateEvent(db, ev.id, org.id, { ageMin: 45 })).event).toMatchObject({ category: "women", ageMin: 45 });
    expect((await updateEvent(db, ev.id, org.id, { title: "Thursday social" })).event).toMatchObject({ category: "women", ageMin: 45 });
    expect(await updates()).toBe(3);

    // The same tag again is no change: nothing written, no "updated" line in the feed.
    await updateEvent(db, ev.id, org.id, { category: "women", ageMin: 45 });
    expect(await updates()).toBe(3);

    // Null takes it off, one half at a time.
    expect((await updateEvent(db, ev.id, org.id, { category: null })).event).toMatchObject({ category: null, ageMin: 45 });
    expect((await updateEvent(db, ev.id, org.id, { ageMin: null })).event).toMatchObject({ category: null, ageMin: null });
  });

  it("plays again with the same tag", async () => {
    const org = await makePlayer(db, "Again");
    const ev = await match(org.id, { category: "mixed", ageMin: 55 });
    expect(await duplicateEvent(db, { sourceEventId: ev.id, creatorPlayerId: org.id, now: NOW })).toMatchObject({ category: "mixed", ageMin: 55 });
  });

  it("gives a ladies' night series its tag, and every edition after it", async () => {
    const org = await makePlayer(db, "Nina", { level: 3.5 });
    const ids = [org.id, ...(await Promise.all(["Ana", "Bea", "Cleo", "Dina"].map((n) => makePlayer(db, n, { level: 3.5 })))).map((p) => p.id)];
    /** Saturday 3 October 2026, 09:00 in Phuket: a finished americano tagged for women. */
    const sat3 = new Date("2026-10-03T02:00:00.000Z");
    const source = await createEvent(db, { creatorPlayerId: org.id, type: "tournament", startsAt: sat3, tz: TZ, venueName: "Ladies Club", capacity: 8, whenFull: "waitlist", format: "americano", category: "women", ageMin: 35 });
    for (const id of ids) await joinEvent(db, { eventId: source.id, playerId: id, now: new Date(sat3.getTime() - DAY) });
    await db.update(events).set({ scoreLockedByCreator: true, standings: ids.slice(0, 4), status: "past" }).where(eq(events.id, source.id));

    const { series: s, next } = await createSeriesFromEvent(db, { eventId: source.id, organizerPlayerId: org.id, name: "Ladies Night", every: "week", now: NOW });
    expect(s).toMatchObject({ category: "women", ageMin: 35 });
    expect(next).toMatchObject({ category: "women", ageMin: 35 });
    expect(next.startsAt.toISOString()).toBe("2026-10-10T02:00:00.000Z");

    // The organiser takes the tag off the coming edition only; the series still says what the night is.
    await updateEvent(db, next.id, org.id, { category: null, ageMin: null });
    const made = (await autoCreateSeriesEditions(db, new Date("2026-10-11T03:00:00.000Z"))).find((m) => m.series.id === s.id)?.event;
    expect(made?.startsAt.toISOString()).toBe("2026-10-17T02:00:00.000Z");
    expect(made).toMatchObject({ category: "women", ageMin: 35 });

    const [row] = await db.select().from(seriesTable).where(eq(seriesTable.id, s.id));
    expect(seriesToPublic(row, made ?? null, BASE)).toMatchObject({ category: "women", ageMin: 35 });
  });

  it("carries a club slot's tag onto every match it makes, through a pause and a resume", async () => {
    const nok = await makePlayer(db, "Nok");
    const club = await claimClub(db, { name: "Social Tag Club", playerId: nok.id, tz: TZ });
    await decideClub(db, club.slug, true, NOW);
    // Tuesday 18:00 in Phuket, every week: the club's "Ladies social".
    const slot = await addClubSlot(db, club.slug, { dow: 2, time: "18:00", title: "Ladies social", category: "women", ageMin: 35 });
    expect(slot).toMatchObject({ category: "women", ageMin: 35 });
    // What the slot does not know, it stores as none.
    expect(await addClubSlot(db, club.slug, { dow: 3, time: "18:00", category: "ladies", ageMin: 40 })).toMatchObject({ category: null, ageMin: null });

    const first = (await autoCreateClubEvents(db, NOW)).created.find((c) => c.slot.id === slot.id)?.event;
    expect(first?.startsAt.toISOString()).toBe("2026-10-13T11:00:00.000Z");
    expect(first).toMatchObject({ category: "women", ageMin: 35, title: "Ladies social" });

    // Pausing writes the slot back through the cleaner: the tag must come through it whole.
    await updateClubSlot(db, club.slug, slot.id, { active: false });
    await updateClubSlot(db, club.slug, slot.id, { active: true });
    const [kept] = await db.select().from(clubSlots).where(eq(clubSlots.id, slot.id));
    expect(kept).toMatchObject({ category: "women", ageMin: 35, active: true });

    const second = (await autoCreateClubEvents(db, new Date(NOW.getTime() + 7 * DAY))).created.find((c) => c.slot.id === slot.id)?.event;
    expect(second?.startsAt.toISOString()).toBe("2026-10-20T11:00:00.000Z");
    expect(second).toMatchObject({ category: "women", ageMin: 35 });
  });

  it("gives a group's weekly match the tag of its latest one", async () => {
    const admin = await makePlayer(db, "Crew admin");
    const g0 = await createGroup(db, { name: "Thursday ladies", creatorPlayerId: admin.id, tz: "UTC", venueName: "Court 7" });
    const g = await updateGroup(db, g0.id, admin.id, { recurDow: 4, recurTime: "19:00", recurLeadDays: 5 });
    const monday = new Date("2026-10-12T10:00:00.000Z");
    const [first] = (await autoCreateGroupMatches(db, monday)).filter((c) => c.group.id === g.id);
    expect(first.event).toMatchObject({ category: null, ageMin: null });
    await updateEvent(db, first.event.id, admin.id, { category: "women", ageMin: 45 });
    const [second] = (await autoCreateGroupMatches(db, new Date(monday.getTime() + 7 * DAY))).filter((c) => c.group.id === g.id);
    expect(second.event.startsAt.toISOString()).toBe("2026-10-22T19:00:00.000Z");
    expect(second.event).toMatchObject({ category: "women", ageMin: 45 });
  });

  it("prints it on the Telegram, Discord and LINE cards", async () => {
    const org = await makePlayer(db, "Card");
    const ev = await match(org.id, { category: "women", ageMin: 45, levelMin: 3, levelMax: 4.5 });
    const detail = (await getEventByCode(db, ev.code))!;
    expect(renderCard(detail, BASE, "en", NOW).text).toContain("🎚 Level 3.0–4.5 · Women · 45+");
    expect(renderCard(detail, BASE, "ru", NOW).text).toContain("🎚 Уровень 3.0–4.5 · Женщины · 45+");
    expect(renderDiscordCard(detail, BASE, "en").embeds[0].description).toContain("🎚 Level 3.0–4.5 · Women · 45+");
    expect(JSON.stringify(renderLineCard(detail, BASE, "es").messages)).toContain("🎚 Nivel 3.0–4.5 · Mujeres · 45+");
  });
});

describe("the public API and the MCP", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await createTestDb()));
  afterAll(() => close());

  it("takes the tag on create and gives it back on the match and on the venue board's rows", async () => {
    const r = await createMatch(db, { startsAt: "2026-10-17T09:30", tz: TZ, venue: "Api Tag Club", listOnVenueBoard: true, category: "women", ageMin: 45, organizer: { name: "Ana" } }, NO_SIDE_EFFECTS);
    expect(r.match).toMatchObject({ category: "women", ageMin: 45 });
    const detail = (await getEventByCode(db, r.match.code))!;
    expect(matchToPublic(detail, BASE)).toMatchObject({ category: "women", ageMin: 45 });
    const board = (await getVenueBoard(db, "api-tag-club", NOW))!;
    expect(boardToPublic(board, BASE).matches.find((m) => m.code === r.match.code)).toMatchObject({ category: "women", ageMin: 45 });

    // Untagged: both keys are there and null, so a reader never has to ask whether the field exists.
    const plain = await createMatch(db, { startsAt: "2026-10-17T09:30", tz: TZ, organizer: { name: "Bo" } }, NO_SIDE_EFFECTS);
    expect(plain.match.category).toBeNull();
    expect(plain.match.ageMin).toBeNull();
    expect("category" in plain.match && "ageMin" in plain.match).toBe(true);
  });

  it("refuses a tag it does not know with a 422 that names the field, and makes no match", async () => {
    // Refused, not dropped: an assistant that sent "ladies" would otherwise tell its person the match
    // is tagged when it is not. A 422 naming the field lets it ask again with one of the three words.
    const status = async (body: Record<string, unknown>) => {
      try {
        await createMatch(db, { startsAt: "2026-10-17T09:30", tz: TZ, organizer: { name: "Cy" }, ...body }, NO_SIDE_EFFECTS);
        return { status: 201, text: "" };
      } catch (e) {
        const res = fail(e);
        return { status: res.status, text: JSON.stringify(await res.json()) };
      }
    };
    const before = (await db.select({ id: events.id }).from(events)).length;
    const ladies = await status({ category: "ladies" });
    expect(ladies.status).toBe(422);
    expect(ladies.text).toContain("category");
    const forty = await status({ ageMin: 40 });
    expect(forty.status).toBe(422);
    expect(forty.text).toContain("ageMin");
    expect((await db.select({ id: events.id }).from(events)).length).toBe(before);
    // Null is "no tag", which is allowed.
    expect((await status({ category: null, ageMin: null })).status).toBe(201);
  });
});
