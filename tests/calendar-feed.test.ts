import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { events, players } from "@/db/schema";
import { feedEvents, feedKey, feedKeyFor, feedLinks, personalFeed, playerForFeedKey } from "@/lib/calendarFeed";
import { shortHost } from "@/lib/config";
import { cancelEvent, createEvent } from "@/lib/domain/events";
import { getOrCreatePersonalToken, rotatePersonalToken } from "@/lib/domain/identity";
import { getEventByCode } from "@/lib/domain/queries";
import { joinEvent } from "@/lib/domain/slots";
import { icsForDownload } from "@/lib/notify";
import { createTestDb, DAY, makePlayer } from "./helpers/db";
import { freezeClock } from "./helpers/clock";

/**
 * The player's own calendar: what "your calendar updates itself" means for somebody reached in a chat.
 * Which matches it holds (thirty days back on, seats and matches they organise), that each one reads as
 * the emailed invitation does, and that its address opens the calendar and never signs anybody in.
 */
const NOW = new Date("2026-09-25T09:00:00.000Z");
freezeClock(NOW);

const unfold = (ics: string) => ics.replace(/\r\n[ \t]/g, "");
/** One VEVENT's lines, by the UID it carries. */
const vevent = (ics: string, uid: string) => unfold(ics).split("BEGIN:VEVENT").find((b) => b.includes(`UID:${uid}`)) ?? "";
const lineOf = (block: string, name: string) => block.split("\r\n").find((l) => l.startsWith(`${name}:`)) ?? "";

describe("the player's calendar feed", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  /** A match Dana holds a seat in, moved to `at` once she is in (joining refuses a match already played). */
  async function seated(dana: { id: string }, org: { id: string }, at: Date, o: { others?: { id: string }[]; venue?: string } = {}) {
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() + DAY), tz: "Europe/Madrid", venueName: o.venue ?? "Club Norte", court: "3", whenFull: "waitlist" });
    await joinEvent(db, { eventId: ev.id, playerId: dana.id });
    for (const p of o.others ?? []) await joinEvent(db, { eventId: ev.id, playerId: p.id });
    const [moved] = await db.update(events).set({ startsAt: at }).where(eq(events.id, ev.id)).returning();
    return moved;
  }

  it("holds the matches from thirty days back on, a cancelled one marked, and nothing older, no waitlist, nothing she left or was never in", async () => {
    const dana = await makePlayer(db, "Dana");
    const org = await makePlayer(db, "Org");
    const [b, c, d, e] = await Promise.all(["Bea", "Cal", "Dev", "Eli"].map((n) => makePlayer(db, n)));
    const recent = await seated(dana, org, new Date(NOW.getTime() - 10 * DAY));
    const edge = await seated(dana, org, new Date(NOW.getTime() - 29 * DAY));
    const old = await seated(dana, org, new Date(NOW.getTime() - 31 * DAY));
    const next = await seated(dana, org, new Date(NOW.getTime() + 3 * DAY));
    const off = await seated(dana, org, new Date(NOW.getTime() + 5 * DAY));
    await cancelEvent(db, off.id, org.id);
    // Full before she came: the waitlist is not a seat, and no invitation goes to one either.
    const full = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() + 2 * DAY), tz: "Europe/Madrid", venueName: "Club Sur", whenFull: "waitlist" });
    for (const p of [b, c, d, e]) await joinEvent(db, { eventId: full.id, playerId: p.id });
    await joinEvent(db, { eventId: full.id, playerId: dana.id });
    // One she organises without playing, and one of somebody else's she was never in.
    const hers = await createEvent(db, { creatorPlayerId: dana.id, type: "match", startsAt: new Date(NOW.getTime() + 4 * DAY), tz: "Europe/Madrid", venueName: "Club Este", whenFull: "waitlist" });
    const theirs = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() + 4 * DAY), tz: "Europe/Madrid", venueName: "Club Oeste", whenFull: "waitlist" });

    const codes = (await feedEvents(db, dana.id, NOW)).map((x) => x.code);
    expect(codes).toEqual([edge.code, recent.code, next.code, hers.code, off.code]);
    expect(codes).not.toContain(old.code);
    expect(codes).not.toContain(full.code);
    expect(codes).not.toContain(theirs.code);

    const ics = await personalFeed(db, dana, NOW);
    expect(unfold(ics)).toContain("METHOD:PUBLISH");
    expect(lineOf(vevent(ics, `${off.id}@${shortHost()}`), "STATUS")).toBe("STATUS:CANCELLED");
    expect(lineOf(vevent(ics, `${next.id}@${shortHost()}`), "STATUS")).toBe("STATUS:CONFIRMED");
    expect(unfold(ics)).not.toContain(old.id);
  });

  it("writes each match as the emailed invitation does: the same UID, sequence, title, place and players; the public page, never a sign-in link", async () => {
    const dana = await makePlayer(db, "Dana", { personalToken: "Ab3dEf6hIj9k" });
    const org = await makePlayer(db, "Org");
    const [b, c] = await Promise.all(["Bea", "Cal"].map((n) => makePlayer(db, n)));
    const ev = await seated(dana, org, new Date(NOW.getTime() + 2 * DAY), { others: [b, c, org], venue: "Club Norte" });
    const detail = (await getEventByCode(db, ev.code))!;
    const invite = await icsForDownload(db, detail, dana);
    const feed = await personalFeed(db, dana, NOW);
    const uid = `${ev.id}@${shortHost()}`;
    const [a, f] = [vevent(invite, uid), vevent(feed, uid)];
    expect(f).not.toBe("");
    for (const name of ["UID", "SEQUENCE", "DTSTART", "DTEND", "SUMMARY", "LOCATION", "STATUS"]) expect(lineOf(f, name)).toBe(lineOf(a, name));
    // Four seats taken: the title says so in both, and the players line names them.
    expect(lineOf(f, "SUMMARY")).toContain("COMPLETE");
    const players = (block: string) => lineOf(block, "DESCRIPTION").split("\\n\\n").at(-1);
    expect(players(f)).toBe("Players: Dana\\, Bea\\, Cal\\, Org");
    expect(players(f)).toBe(players(a));
    expect(lineOf(f, "URL")).toMatch(new RegExp(`/${ev.code}$`));
    // The invitation carries the private event link; the feed never does, because its address travels in chats.
    expect(unfold(invite)).toContain("Ab3dEf6hIj9k");
    expect(unfold(feed)).not.toContain("Ab3dEf6hIj9k");
    expect(unfold(feed)).not.toContain("/p/");
  });

  it("opens with a key made from the personal token or the one before it, and with nothing else", async () => {
    const dana = await makePlayer(db, "Dana");
    const eve = await makePlayer(db, "Eve");
    const token = await getOrCreatePersonalToken(db, dana.id);
    const key = feedKey(dana.id, token);
    // The address is not a way in: the sign-in token is nowhere in it.
    expect(key).not.toContain(token);
    expect(key).toMatch(/^[0-9a-f]{52}$/);
    expect((await playerForFeedKey(db, key))?.id).toBe(dana.id);
    expect(await feedKeyFor(db, (await playerForFeedKey(db, key))!)).toBe(key);

    const last = key.at(-1) === "0" ? "1" : "0";
    expect(await playerForFeedKey(db, `${key.slice(0, -1)}${last}`)).toBeNull();
    // Dana's signature under Eve's id opens nothing: the key is checked against the player it names.
    expect(await playerForFeedKey(db, `${feedKey(eve.id, token).slice(0, 32)}${key.slice(32)}`)).toBeNull();
    expect(await playerForFeedKey(db, token)).toBeNull();
    expect(await playerForFeedKey(db, "garbage")).toBeNull();

    // The lazy shortening keeps the old token as the previous one: a calendar subscribed before still reads.
    await db.update(players).set({ previousToken: token, personalToken: "Zz9yXx8wVv7u" }).where(eq(players.id, dana.id));
    expect((await playerForFeedKey(db, key))?.id).toBe(dana.id);
    expect((await playerForFeedKey(db, feedKey(dana.id, "Zz9yXx8wVv7u")))?.id).toBe(dana.id);
    // A reset of the personal link keeps no previous token, and ends every subscription made before it.
    await rotatePersonalToken(db, dana.id);
    expect(await playerForFeedKey(db, key)).toBeNull();
    expect(await playerForFeedKey(db, feedKey(dana.id, "Zz9yXx8wVv7u"))).toBeNull();
  });

  it("offers webcal for a phone or a Mac, Google's own page for a computer, and an https page a chat button can open, in the player's language", () => {
    const key = "a".repeat(52);
    const links = feedLinks("https://kicksma.sh", key, "ru");
    expect(links.https).toBe(`https://kicksma.sh/p/${key}/calendar.ics`);
    expect(links.webcal).toBe(`webcal://kicksma.sh/p/${key}/calendar.ics`);
    expect(links.google).toBe(`https://calendar.google.com/calendar/render?cid=${encodeURIComponent(links.webcal)}`);
    expect(links.page).toBe(`https://kicksma.sh/ru/p/${key}/calendar`);
    expect(feedLinks("https://kicksma.sh", key, "en").page).toBe(`https://kicksma.sh/p/${key}/calendar`);
    expect(feedLinks("https://kicksma.sh", key, "de").page).toBe(`https://kicksma.sh/p/${key}/calendar`);
  });
});
