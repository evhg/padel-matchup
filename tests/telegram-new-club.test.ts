import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { clubs, events, telegramChats, venues } from "@/db/schema";
import { NO_SIDE_EFFECTS } from "@/lib/api/operations";
import { cityBySlug, venueInCity } from "@/lib/domain/cities";
import { createGroup } from "@/lib/domain/groups";
import { getCityBoard, getVenueBoard } from "@/lib/domain/venueBoard";
import { handleTelegramUpdate } from "@/lib/telegram/bot";
import { findOrCreateTelegramPlayer } from "@/lib/telegram/identity";
import { strings } from "@/lib/telegram/card";
import { clubKeyWords, parseNewCommand } from "@/lib/telegram/parse";
import type { TgMessage, TgUpdate } from "@/lib/telegram/api";
import { freezeClock } from "./helpers/clock";
import { createTestDb } from "./helpers/db";

/**
 * /new and the club list (the owner's decision of 10 October 2026: "Yes, but only on the club's own
 * words", to "Should the place now match a club from our club list? Then the match moves onto that
 * club's board, and the club's regulars can hear about a free 4th spot").
 *
 * The matcher is proven against the whole directory (data/clubs.json), zone by zone, as the bot reads
 * it: a club's full name picks it, a city, an island, a district or a word everybody uses picks none.
 */

// Saturday 10 October 2026, noon in Bangkok: "tomorrow 19:00" is Sunday the 11th at 12:00 UTC.
const NOW = new Date("2026-10-10T05:00:00Z");
freezeClock(NOW);
const SUNDAY_7PM = new Date("2026-10-11T12:00:00Z");

type DirClub = { slug: string; name: string; tz: string; city: string | null };
const DIRECTORY = (JSON.parse(readFileSync(path.resolve(__dirname, "..", "data/clubs.json"), "utf8")) as { clubs: DirClub[] }).clubs;
const ZONES = [...new Set(DIRECTORY.map((c) => c.tz))];
const clubsIn = (tz: string) => DIRECTORY.filter((c) => c.tz === tz).map((c) => c.name);
const read = (place: string, tz: string, venues: string[] = []) => parseNewCommand(`tomorrow 19:00 ${place}`, { tz, now: NOW, venues, clubs: clubsIn(tz) });

describe("/new against the whole club list", () => {
  it("every club's full name picks that club, in its own zone", () => {
    expect(DIRECTORY.length).toBeGreaterThan(60);
    for (const c of DIRECTORY) {
      const p = read(c.name, c.tz);
      expect([p.venue, p.club], c.name).toEqual([c.name, c.name]);
    }
  });

  it("a city, an island or a district alone never picks a club", () => {
    const places = ["Phuket", "Rawai", "Kata", "Bangkok", "BKK", "Samui", "Koh Samui", "Pattaya", "Chiang Mai", "Chiangmai", "Hua Hin", "Krabi", "Phangan", "Koh Tao", "Asoke", "On Nut", "Sukhumvit", "Thonglor", "Soi 94", "Banthatthong", "Singapore", "Orchard", "Bedok", "Chinatown", "Changi", "Bugis", "Dempsey", "Havelock", "Holland", "Ayer Rajah", "Jalan Kayu", "Sentosa", "Laguna"];
    for (const tz of ZONES) {
      for (const place of places) {
        const p = read(place, tz);
        expect([p.club, p.venueKnown], `${place} in ${tz}`).toEqual([null, false]);
      }
    }
  });

  it("a word everybody uses never picks a club: \"Asia\", \"Thai\", \"Bay\" and their like", () => {
    for (const tz of ZONES) {
      for (const word of ["Asia", "Thai", "Bay", "Top", "Pop", "Swiss", "Tropical", "Lodge", "Beach", "Sky", "Racket", "Padel", "Club", "Drama", "No Drama", "Athletic", "the Athletic", "Destination"]) {
        const p = read(word, tz);
        expect([p.club, p.venueKnown, p.venue], `${word} in ${tz}`).toEqual([null, false, word]);
      }
    }
  });

  it("one word of a club's name picks it only when that word is the whole of what tells the club from the others", () => {
    for (const tz of ZONES) {
      for (const name of clubsIn(tz)) {
        for (const word of new Set(name.split(/[^\p{L}\d]+/u).filter((w) => w.length >= 3))) {
          const picked = read(word, tz).club;
          // "Kross" is none of the four Kross clubs, "Seasons" is not Four Seasons, "Samui" is not Padel Samui.
          if (picked) expect(clubKeyWords(picked), `${word} → ${picked}`).toEqual([word.toLowerCase()]);
        }
      }
    }
    const bkk = "Asia/Bangkok";
    const sg = "Asia/Singapore";
    // The club's own words, in full: picked.
    expect(read("Kross Asoke", bkk).club).toBe("Kross Padel Asoke");
    expect(read("Pad Thai", bkk).club).toBe("Pad Thai Padel");
    expect(read("Pattaya Padel", bkk).club).toBe("Pattaya Padel Club");
    expect(read("Padel Bay", bkk).club).toBe("Padel Bay Indoor Club");
    expect(read("Padel Asia", bkk).club).toBe("Padel Asia");
    expect(read("at warehaus", bkk).club).toBe("WAREHAUS.club");
    expect(read("Capella", sg).club).toBe("Capella Hotel Sentosa");
    expect(read("Ricochet Orchard", sg).club).toBe("Ricochet Padel Orchard");
    expect(read("Four Seasons", sg).club).toBe("Four Seasons Hotel Singapore");
    expect(read("Koh Tao Athletic", bkk).club).toBe("Koh Tao Athletic Club");
    expect(read("Destination Padel", bkk).club).toBe("Destination Padel Club");
    // Part of the club's own words: none, and the words stay as typed.
    for (const [line, tz] of [["Kross", bkk], ["Ricochet", sg], ["Seasons", sg], ["Love", sg], ["Pad", bkk], ["Pickle", sg]] as const) {
      const p = read(line, tz);
      expect([p.club, p.venue], line).toEqual([null, line]);
    }
  });

  it("the chat's own court still goes by its area: that is the chat's court, not the club list's pick", () => {
    const p = read("Rawai", "Asia/Bangkok", ["Rawai Padel"]);
    expect([p.venue, p.venueKnown, p.club]).toEqual(["Rawai Padel", true, null]);
    const full = read("Rawai Padel", "Asia/Bangkok", ["Rawai Padel"]);
    expect([full.venue, full.club]).toEqual(["Rawai Padel", "Rawai Padel"]);
  });

  it("every club of a city with a page sits in that city, so a match listed there shows in /games and on the city page", () => {
    for (const c of DIRECTORY) {
      const city = c.city ? cityBySlug(c.city) : null;
      if (city) expect(venueInCity(city, c.slug, c.tz), c.slug).toBe(true);
    }
  });
});

describe("a /new match at a club named in full goes on the club's board, with one tap to take it off", () => {
  let db: Db;
  let updateId = 1;
  let messageId = 1;
  type Call = { method: string; body: Record<string, unknown> };
  let calls: Call[] = [];
  let ephemeralFails = false;
  const sent = (method: string) => calls.filter((c) => c.method === method);

  beforeAll(async () => {
    ({ db } = await createTestDb());
    await db.insert(clubs).values({ slug: "warehaus", name: "WAREHAUS.club", manageToken: "tok-warehaus-newclub-abcdefghijklmnop", source: "directory", tz: "Asia/Bangkok", city: "phuket" });
  });
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:TESTTOKEN";
    process.env.TELEGRAM_BOT_USERNAME = "kicksmash_bot";
    calls = [];
    ephemeralFails = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const method = String(url).split("/").pop()!;
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        calls.push({ method, body });
        const reply = (result: unknown, ok = true) => new Response(JSON.stringify(ok ? { ok: true, result } : { ok: false, error_code: 400, description: String(result) }), { status: ok ? 200 : 400, headers: { "content-type": "application/json" } });
        if (method === "sendMessage" && body.ephemeral_message_parameters && ephemeralFails) return reply("Bad Request: ephemeral message can't be sent", false);
        if (method === "sendMessage" || method === "sendPhoto") return reply({ message_id: 5000 + calls.length, chat: { id: body.chat_id } });
        return reply(true);
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const user = (id: number, first_name: string) => ({ id, first_name, language_code: "en" });
  const update = (u: Omit<TgUpdate, "update_id">) => handleTelegramUpdate(db, { update_id: updateId++, ...u }, NO_SIDE_EFFECTS);
  const say = (chat: TgMessage["chat"], from: ReturnType<typeof user>, text: string) => update({ message: { message_id: messageId++, date: 0, chat, from, text } });
  const tap = (chat: TgMessage["chat"], from: ReturnType<typeof user>, data: string, messageId = 4242) => update({ callback_query: { id: `cb${updateId}`, from, message: { message_id: messageId, date: 0, chat }, data } });
  const eventOf = async (outcome: string) => (await db.select().from(events).where(eq(events.code, outcome.split(":")[1])))[0];
  const boardNote = () => sent("sendMessage").find((c) => JSON.stringify(c.body.reply_markup ?? {}).includes('"vb:'));

  it("in a private chat: on the board and in /games, the note offers the take-off, and only the organiser's tap counts", async () => {
    const chat = { id: 610001, type: "private" as const };
    const ana = user(61, "Ana");
    expect(await say(chat, ana, "/tz phuket")).toBe("tz");
    calls = [];
    const outcome = await say(chat, ana, "/new tomorrow 19:00 Warehaus");
    expect(outcome).toMatch(/^new_created:/);
    let ev = await eventOf(outcome);
    expect([ev.startsAt.toISOString(), ev.venueName, ev.venueSlug, ev.publicListing]).toEqual([SUNDAY_7PM.toISOString(), "WAREHAUS.club", "warehaus", true]);
    expect((await getVenueBoard(db, "warehaus", NOW))!.events.map((b) => b.event.code)).toContain(ev.code);
    expect((await getCityBoard(db, cityBySlug("phuket")!, NOW)).events.map((b) => b.event.code)).toContain(ev.code);
    const note = boardNote()!;
    expect(note.body.text).toBe(strings("en").boardOn("WAREHAUS.club"));
    expect(note.body.reply_markup).toEqual({ inline_keyboard: [[{ text: strings("en").boardOff, callback_data: `vb:${ev.code}:0` }]] });

    // Somebody else's tap changes nothing. Bo is a player the bot knows, so the organiser check is the
    // only thing that refuses him (a stranger with no player row would be refused before it).
    const bo = await findOrCreateTelegramPlayer(db, user(62, "Bo"));
    expect(bo.id).not.toBe(ev.creatorPlayerId);
    expect(await tap(chat, user(62, "Bo"), `vb:${ev.code}:0`)).toBe("board_not_organizer");
    expect((await eventOf(outcome)).publicListing).toBe(true);
    // The organiser's: off the board, the note says so and offers the way back.
    calls = [];
    expect(await tap(chat, ana, `vb:${ev.code}:0`)).toBe("board_off");
    ev = await eventOf(outcome);
    expect(ev.publicListing).toBe(false);
    expect((await getVenueBoard(db, "warehaus", NOW))!.events.map((b) => b.event.code)).not.toContain(ev.code);
    const edited = sent("editMessageText")[0];
    expect([edited.body.text, edited.body.reply_markup]).toEqual([strings("en").boardOffDone("WAREHAUS.club"), { inline_keyboard: [[{ text: strings("en").boardBack, callback_data: `vb:${ev.code}:1` }]] }]);
    expect(await tap(chat, ana, `vb:${ev.code}:1`)).toBe("board_on");
    expect((await eventOf(outcome)).publicListing).toBe(true);
    expect(await tap(chat, ana, "vb:ZZZZ:0")).toBe("board_no_match");
  });

  it("an area, or a court not on the list, stays private with no note; \"public\" lists it as before, with no note", async () => {
    const chat = { id: 610002, type: "private" as const };
    const bo = user(63, "Cy");
    expect(await say(chat, bo, "/tz phuket")).toBe("tz");
    for (const line of ["/new tomorrow 18:00 Rawai", "/new tomorrow 17:00 Joe's Court"]) {
      calls = [];
      const outcome = await say(chat, bo, line);
      expect(outcome, line).toMatch(/^new_created:/);
      expect((await eventOf(outcome)).publicListing, line).toBe(false);
      expect(boardNote(), line).toBeUndefined();
    }
    calls = [];
    const pub = await say(chat, bo, "/new tomorrow 16:00 Warehaus public");
    expect((await eventOf(pub)).publicListing).toBe(true);
    expect(boardNote()).toBeUndefined();
  });

  it("the sender's own spelling of the club is the same club: on its board, with the note, as for anybody else", async () => {
    const chat = { id: 610005, type: "private" as const };
    const fay = user(66, "Fay");
    expect(await say(chat, fay, "/tz phuket")).toBe("tz");
    // Fay has played at "Warehaus" before, as she typed it: her courts come first in the matcher.
    const me = await findOrCreateTelegramPlayer(db, fay);
    await db.insert(venues).values({ creatorPlayerId: me.id, name: "Warehaus" });
    calls = [];
    const outcome = await say(chat, fay, "/new tomorrow 19:00 Warehaus");
    const ev = await eventOf(outcome);
    expect([ev.venueName, ev.venueSlug, ev.publicListing]).toEqual(["Warehaus", "warehaus", true]);
    expect((await getVenueBoard(db, "warehaus", NOW))!.events.map((b) => b.event.code)).toContain(ev.code);
    expect(boardNote()!.body.text).toBe(strings("en").boardOn("Warehaus"));

    // Her own court that only looks like a listed club sits on a board of its own, not the club's: it stays private.
    await db.insert(clubs).values({ slug: "rawai-padel", name: "Rawai Padel", manageToken: "tok-rawai-newclub-abcdefghijklmnopq", source: "directory", tz: "Asia/Bangkok", city: "phuket" });
    await db.insert(venues).values({ creatorPlayerId: me.id, name: "Rawai Padel Club" });
    calls = [];
    const own = await eventOf(await say(chat, fay, "/new tomorrow 18:00 Rawai Padel Club"));
    expect([own.venueName, own.venueSlug, own.publicListing]).toEqual(["Rawai Padel Club", "rawai-padel-club", false]);
    expect(boardNote()).toBeUndefined();
  });

  it("in a crew's own group a /new at a club stays off the board, by one line or by a reply to a prompt; \"public\" still lists it", async () => {
    // A stranger who joins from the board becomes a member of the crew, and the crew page hands its members
    // the crew group's invite link: so the crew's chat never lists a match by default.
    const chat = { id: -610004, type: "group" as const, title: "Thursday crew" };
    const eve = user(65, "Eve");
    expect(await say(chat, eve, "/tz phuket")).toBe("tz");
    const owner = await findOrCreateTelegramPlayer(db, eve);
    const crew = await createGroup(db, { name: "Thursday crew", creatorPlayerId: owner.id, tz: "Asia/Bangkok" });
    await db.update(telegramChats).set({ groupId: crew.id }).where(eq(telegramChats.chatId, chat.id));
    calls = [];
    const outcome = await say(chat, eve, "/new tomorrow 19:00 Warehaus");
    const ev = await eventOf(outcome);
    expect([ev.venueSlug, ev.groupId, ev.publicListing]).toEqual(["warehaus", crew.id, false]);
    expect((await getVenueBoard(db, "warehaus", NOW))!.events.map((b) => b.event.code)).not.toContain(ev.code);
    expect(boardNote()).toBeUndefined();
    // The reply to the bot's place prompt ("… /new 11.10 18:00") goes the same way.
    calls = [];
    const prompt = { message_id: 777, date: 0, chat, from: { id: 123456, is_bot: true, first_name: "Kicksmash" }, text: "Where?\n/new 11.10 18:00" };
    const replied = await update({ message: { message_id: messageId++, date: 0, chat, from: eve, text: "Warehaus", reply_to_message: prompt } });
    expect(replied).toMatch(/^new_created:/);
    expect((await eventOf(replied)).publicListing).toBe(false);
    expect(boardNote()).toBeUndefined();
    // "public" is the organiser's own word: the match goes on the board.
    expect((await eventOf(await say(chat, eve, "/new tomorrow 16:00 Warehaus public"))).publicListing).toBe(true);
  });

  it("in a group the note goes to the organiser alone, and as a quiet reply only when Telegram will not deliver that", async () => {
    const chat = { id: -610003, type: "group" as const, title: "Padel friends" };
    const dee = user(64, "Dee");
    expect(await say(chat, dee, "/tz phuket")).toBe("tz");
    calls = [];
    expect(await say(chat, dee, "/new tomorrow 20:00 WAREHAUS.club")).toMatch(/^new_created:/);
    expect(boardNote()!.body.ephemeral_message_parameters).toEqual({ receiver_user_id: 64 });
    ephemeralFails = true;
    calls = [];
    const msgId = messageId;
    expect(await say(chat, dee, "/new tomorrow 21:00 Warehaus")).toMatch(/^new_created:/);
    const notes = sent("sendMessage").filter((c) => JSON.stringify(c.body.reply_markup ?? {}).includes('"vb:'));
    expect(notes.map((c) => Boolean(c.body.ephemeral_message_parameters))).toEqual([true, false]);
    expect(notes[1].body.reply_parameters).toMatchObject({ message_id: msgId });
  });
});
