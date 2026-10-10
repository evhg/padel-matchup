import { describe, expect, it } from "vitest";
import { freezeClock } from "./helpers/clock";
import { matchVenue, parseNewCommand, resolveZone, tzHintFor } from "@/lib/telegram/parse";
import { strings } from "@/lib/telegram/card";

// Saturday 2026-09-05 12:00 in Bangkok (05:00Z).
const now = new Date("2026-09-05T05:00:00Z");
freezeClock(now);
const tz = "Asia/Bangkok";
const at = (date: string, time: string) => new Date(`${date}T${time}:00+07:00`);

describe("/new text parsing", () => {
  it("tomorrow at a time, a venue and the money line", () => {
    const p = parseNewCommand("tomorrow 19:00 Rawai Padel Club 400฿", { tz, now });
    expect(p.startsAt).toEqual(at("2026-09-06", "19:00"));
    expect(p.venue).toBe("Rawai Padel Club");
    expect(p.cost).toBe("400฿");
    expect(p.type).toBe("match");
    expect(p.capacity).toBeNull();
    expect(p.tzHint).toBe("Asia/Bangkok");
  });
  it("Russian, any order, dotted time, currency word", () => {
    const p = parseNewCommand("Равай завтра в 19.30, 400 бат", { tz, now });
    expect(p.startsAt).toEqual(at("2026-09-06", "19:30"));
    expect(p.venue).toBe("Равай");
    expect(p.cost).toBe("400 бат");
    expect(p.tzHint).toBe("Asia/Bangkok");
  });
  it("a bare time today rolls to tomorrow once it has passed; 'today' keeps it (logging after the fact)", () => {
    expect(parseNewCommand("9:00 Laguna", { tz, now }).startsAt).toEqual(at("2026-09-06", "09:00"));
    expect(parseNewCommand("today 9:00 Laguna", { tz, now }).startsAt).toEqual(at("2026-09-05", "09:00"));
    expect(parseNewCommand("18:00", { tz, now }).startsAt).toEqual(at("2026-09-05", "18:00"));
    expect(parseNewCommand("сегодня 18:00", { tz, now }).venue).toBeNull();
  });
  it("weekdays in both languages: the next one, next week when today's time is gone", () => {
    expect(parseNewCommand("thu 20:00", { tz, now }).startsAt).toEqual(at("2026-09-10", "20:00"));
    expect(parseNewCommand("в четверг 20:00", { tz, now }).startsAt).toEqual(at("2026-09-10", "20:00"));
    expect(parseNewCommand("сб 10:00", { tz, now }).startsAt).toEqual(at("2026-09-12", "10:00"));
    expect(parseNewCommand("sat 15:00", { tz, now }).startsAt).toEqual(at("2026-09-05", "15:00"));
  });
  it("explicit dates, with and without a year; a past date means next year", () => {
    expect(parseNewCommand("12.09 19:00 Kata", { tz, now }).startsAt).toEqual(at("2026-09-12", "19:00"));
    expect(parseNewCommand("12/09/2026 7pm", { tz, now }).startsAt).toEqual(at("2026-09-12", "19:00"));
    expect(parseNewCommand("2026-10-01 at 8", { tz, now }).startsAt).toEqual(at("2026-10-01", "08:00"));
    expect(parseNewCommand("03.01 19:00", { tz, now }).startsAt).toEqual(at("2027-01-03", "19:00"));
    expect(parseNewCommand("04.09 19:00", { tz, now }).startsAt).toEqual(at("2026-09-04", "19:00")); // yesterday: still this year
  });
  it("hours without minutes: 7pm, at 19, в 19, 19h, a bare 19", () => {
    for (const s of ["tmr 7pm", "tmr at 19", "завтра в 19", "завтра 19ч", "tmr 19", "tmr 19h"]) expect(parseNewCommand(s, { tz, now }).startsAt, s).toEqual(at("2026-09-06", "19:00"));
    expect(parseNewCommand("tmr 12:30am", { tz, now }).time).toBe("00:30");
  });
  it("tournaments: a format word or a head count, capacity rounded to fours", () => {
    const a = parseNewCommand("americano 8 sunday 10:00 Bangtao", { tz, now });
    expect(a.type).toBe("tournament");
    expect(a.format).toBe("americano");
    expect(a.capacity).toBe(8);
    expect(a.venue).toBe("Bangtao");
    const m = parseNewCommand("мексикано 12 вс 10:00", { tz, now });
    expect(m.format).toBe("mexicano");
    expect(m.capacity).toBe(12);
    expect(parseNewCommand("king sun 10:00", { tz, now }).format).toBe("king");
    const c = parseNewCommand("10 players tmr 18:00", { tz, now });
    expect(c.type).toBe("tournament");
    expect(c.capacity).toBe(12);
    expect(parseNewCommand("4 players tmr 18:00", { tz, now }).type).toBe("match");
  });
  it("levels, courts, and a venue that survives all of it", () => {
    const p = parseNewCommand("tmr 20:00 Kata Padel court 3 level 3-4.5 500 thb", { tz, now });
    expect(p.levelMin).toBe(3);
    expect(p.levelMax).toBe(4.5);
    expect(p.court).toBe("3");
    expect(p.venue).toBe("Kata Padel");
    expect(p.cost).toBe("500 thb");
    expect(parseNewCommand("tmr 20:00 3.5+", { tz, now }).levelMin).toBe(3.5);
    const bare = parseNewCommand("tmr 20:00 2-3 Chalong", { tz, now });
    expect([bare.levelMin, bare.levelMax, bare.venue]).toEqual([2, 3, "Chalong"]);
    expect(parseNewCommand("tmr 20:00 корт 2 ур 4", { tz, now }).court).toBe("2");
  });
  it("no time, no match: the day alone or nothing at all", () => {
    expect(parseNewCommand("tomorrow Rawai", { tz, now }).startsAt).toBeNull();
    expect(parseNewCommand("", { tz, now }).startsAt).toBeNull();
    expect(parseNewCommand("Rawai", { tz, now }).venue).toBe("Rawai");
  });
  it("a public match is one word away", () => {
    const r = parseNewCommand("tomorrow 19:00 Rawai public", { tz, now });
    expect(r.publicListing).toBe(true);
    expect(r.venue).toBe("Rawai");
    expect(parseNewCommand("завтра 19:00 Равай открытый", { tz, now }).publicListing).toBe(true);
    expect(parseNewCommand("tomorrow 19:00 Rawai", { tz, now }).publicListing).toBe(false);
  });

  it("the time zone hint and the /tz shortcuts", () => {
    expect(tzHintFor("завтра Равай")).toBe("Asia/Bangkok");
    expect(tzHintFor("Bang Tao 19:00")).toBe("Asia/Bangkok");
    expect(tzHintFor("singapore 19:00")).toBe("Asia/Singapore");
    expect(tzHintFor("19:00 somewhere")).toBeNull();
    expect(resolveZone("phuket")).toBe("Asia/Bangkok");
    expect(resolveZone("Москва")).toBe("Europe/Moscow");
    expect(resolveZone("asia/singapore")).toBe("Asia/Singapore");
    expect(resolveZone("Europe/Madrid")).toBe("Europe/Madrid");
    expect(resolveZone("Mars/Olympus")).toBeNull();
    expect(resolveZone("")).toBeNull();
  });
});

describe("free chat: a question, Spanish, and a place matched against the known courts", () => {
  // Saturday 5 September, noon in Bangkok: Thursday is the 10th, tomorrow the 6th.
  it("a question asks for players; its own words never become the place", () => {
    const p = parseNewCommand("who's in Thursday 7pm Rawai?", { tz, now });
    expect(p.startsAt).toEqual(at("2026-09-10", "19:00"));
    expect(p.venue).toBe("Rawai");
    expect(parseNewCommand("Who’s in tomorrow 19:00?", { tz, now }).venue).toBeNull();
    expect(parseNewCommand("anyone for tmr 18:00 Kata?", { tz, now }).venue).toBe("Kata");
    const ru = parseNewCommand("Кто играет завтра в 19:00 Равай?", { tz, now });
    expect([ru.startsAt, ru.venue]).toEqual([at("2026-09-06", "19:00"), "Равай"]);
    const es = parseNewCommand("¿Quién juega mañana a las 19 Rawai?", { tz, now });
    expect([es.startsAt, es.venue]).toEqual([at("2026-09-06", "19:00"), "Rawai"]);
  });

  it("a seat word is never a place", () => {
    expect(parseNewCommand("I'm in", { tz, now }).venue).toBeNull();
    expect(parseNewCommand("tomorrow 19:00 I'm in", { tz, now }).venue).toBeNull();
    expect(parseNewCommand("12.09 19:00 can't make it", { tz, now }).venue).toBeNull();
    expect(parseNewCommand("12.09 19:00 me apunto", { tz, now }).venue).toBeNull();
  });

  it("Spanish days and hours, as the welcome line in Spanish tells people to type them", () => {
    const p = parseNewCommand("mañana 19:00 Rawai", { tz, now });
    expect([p.startsAt, p.venue]).toEqual([at("2026-09-06", "19:00"), "Rawai"]);
    expect(parseNewCommand("manana 19:00", { tz, now }).startsAt).toEqual(at("2026-09-06", "19:00"));
    expect(parseNewCommand("hoy a las 19 Rawai", { tz, now }).startsAt).toEqual(at("2026-09-05", "19:00"));
    expect(parseNewCommand("hoy a las 19 Rawai", { tz, now }).venue).toBe("Rawai");
    expect(parseNewCommand("esta noche a las 20", { tz, now }).startsAt).toEqual(at("2026-09-05", "20:00"));
    expect(parseNewCommand("pasado mañana 18:30", { tz, now }).startsAt).toEqual(at("2026-09-07", "18:30"));
    const thu = parseNewCommand("el jueves a las 20 Bangtao", { tz, now });
    expect([thu.startsAt, thu.venue]).toEqual([at("2026-09-10", "20:00"), "Bangtao"]);
    expect(parseNewCommand("jueves 20:00 en Kata", { tz, now }).venue).toBe("Kata");
    for (const [day, date] of [["lunes", "2026-09-07"], ["martes", "2026-09-08"], ["miércoles", "2026-09-09"], ["miercoles", "2026-09-09"], ["viernes", "2026-09-11"], ["sábado", "2026-09-12"], ["domingo", "2026-09-06"]] as const) {
      expect(parseNewCommand(`${day} 10:00`, { tz, now }).startsAt, day).toEqual(at(date, "10:00"));
    }
  });

  const known = ["Rawai Padel", "Padel Phuket @ Blue Tree", "Xplore Padel Phuket", "Sensei Padel Phuket", "Pattaya Padel Club", "WAREHAUS.club"];
  it("a place the chat already knows wins over the leftover words", () => {
    expect(parseNewCommand("who's in Thursday 7pm Rawai?", { tz, now, venues: known }).venue).toBe("Rawai Padel");
    expect(parseNewCommand("tmr 19:00 xplore padel phuket", { tz, now, venues: known }).venue).toBe("Xplore Padel Phuket");
    expect(parseNewCommand("tmr 19:00 at warehaus", { tz, now, venues: known }).venue).toBe("WAREHAUS.club");
    // A word several courts share decides nothing: the words stay as typed.
    expect(parseNewCommand("tmr 19:00 Phuket", { tz, now, venues: known }).venue).toBe("Phuket");
    // A court nobody has used yet is still a court.
    expect(parseNewCommand("tmr 19:00 Some New Court", { tz, now, venues: known }).venue).toBe("Some New Court");
    // A new court that shares one word with a known one is still the new court: every word typed must belong to the known one.
    expect(parseNewCommand("tmr 19:00 Rawai Beach Club", { tz, now, venues: known }).venue).toBe("Rawai Beach Club");
    expect(parseNewCommand("tmr 19:00 Blue Tree Rawai", { tz, now, venues: known }).venue).toBe("Blue Tree Rawai");
    expect(parseNewCommand("tmr 19:00", { tz, now, venues: known }).venue).toBeNull();
  });

  it("matchVenue: the whole name first, then the one court a word points at; a tie between the same words keeps the first", () => {
    expect(matchVenue("rawai", known)).toBe("Rawai Padel");
    expect(matchVenue("Blue Tree", known)).toBe("Padel Phuket @ Blue Tree");
    expect(matchVenue("phuket", known)).toBeNull();
    expect(matchVenue("pattaya", known)).toBe("Pattaya Padel Club");
    expect(matchVenue("rawai beach", known)).toBeNull();
    expect(matchVenue("Rawai Padel Club", known)).toBe("Rawai Padel");
    expect(matchVenue("padel club", known)).toBeNull();
    // The chat's own court comes first in the list, and the directory's spelling of it after.
    expect(matchVenue("Rawai", ["Rawai Padel Club", "Rawai Padel"])).toBe("Rawai Padel Club");
    expect(matchVenue("", known)).toBeNull();
    expect(matchVenue("rawai", [])).toBeNull();
  });
});

describe("the reviewers' cases: a known court never eats typed words, Spanish mornings, every preposition, how the time was read", () => {
  // The clubs the directory lists in Asia/Bangkok (data/clubs.json, 10 October 2026): Phuket's and Bangkok's in one zone.
  const BKK = ["WAREHAUS.club", "Padel Phuket @ Blue Tree", "Destination Padel Club", "Xplore Padel Phuket", "Rawai Padel", "Padel Bay Indoor Club", "Sensei Padel Phuket", "PTP Club Phuket", "Kross Padel On Nut", "Kross Padel Asoke", "Kross Padel Sky Club", "Pad Thai Padel", "Bangkok Padel", "Padel Club Bangkok", "Padel Asia", "Bel Club Padel", "The Padel Co. BKK", "Baan Padel", "No Drama Padel", "Top Padel", "Kross Padel Indoor Bangkok"];
  const venue = (line: string, o: { venues?: string[]; clubs?: string[] } = {}) => parseNewCommand(line, { tz, now, ...o }).venue;

  it("a city or area word alone never puts a /new line on a club's board; the chat's own court may go by its area", () => {
    // The /new line people already type keeps its words: before the known courts, "Rawai" was "Rawai".
    expect(venue("tmr 19:00 Rawai", { clubs: BKK })).toBe("Rawai");
    expect(venue("tmr 19:00 Phuket", { clubs: BKK })).toBe("Phuket");
    expect(venue("tmr 19:00 Bangkok", { clubs: BKK })).toBe("Bangkok");
    expect(matchVenue("rawai", [], BKK)).toBeNull();
    // The crew's usual court is called by its area, in either alphabet.
    expect(venue("tmr 19:00 Rawai", { venues: ["Rawai Padel"], clubs: BKK })).toBe("Rawai Padel");
    expect(venue("завтра 19:00 Равай", { venues: ["Rawai Padel"], clubs: BKK })).toBe("Rawai Padel");
    // A city decides nothing, even for the chat's own court and with no other court in sight.
    expect(venue("tmr 19:00 Phuket", { venues: ["Padel Phuket @ Blue Tree"] })).toBe("Phuket");
    expect(matchVenue("singapore", ["Singapore Padel Hub"])).toBeNull();
    // A word that is the club's own still finds it.
    expect(venue("tmr 19:00 at warehaus", { clubs: BKK })).toBe("WAREHAUS.club");
    expect(venue("tmr 19:00 xplore phuket", { clubs: BKK })).toBe("Xplore Padel Phuket");
    expect(venue("tmr 19:00 Kross", { clubs: BKK })).toBe("Kross");
  });

  it("a known name inside the words wins only when every other word typed is generic", () => {
    expect(venue("tmr 19:00 Rawai Padel Club", { clubs: BKK })).toBe("Rawai Padel");
    expect(venue("tmr 19:00 Rawai Padel Park", { clubs: BKK })).toBe("Rawai Padel Park");
    expect(venue("tmr 19:00 Rawai Padel Park", { venues: ["Rawai Padel"], clubs: BKK })).toBe("Rawai Padel Park");
    expect(venue("tmr 19:00 Top Padel Rawai", { clubs: BKK })).toBe("Top Padel Rawai");
    expect(venue("tmr 19:00 Baan Padel Kata", { clubs: BKK })).toBe("Baan Padel Kata");
    // The same words in another order are that club, not the one whose name is inside them.
    expect(venue("tmr 19:00 Bangkok Padel Club", { clubs: BKK })).toBe("Padel Club Bangkok");
    expect(venue("tmr 19:00 Bangkok Padel", { clubs: BKK })).toBe("Bangkok Padel");
    expect(venue("tmr 19:00 Xplore Padel Phuket", { clubs: BKK })).toBe("Xplore Padel Phuket");
  });

  it("Spanish \"mañana\" is tomorrow, and \"por la mañana\" is the morning of the day named", () => {
    // Thursday is the 10th; tomorrow the 6th.
    const thu = parseNewCommand("el jueves por la mañana a las 10 Rawai", { tz, now });
    expect([thu.startsAt, thu.venue, thu.meridiem]).toEqual([at("2026-09-10", "10:00"), "Rawai", true]);
    expect(parseNewCommand("jueves a las 9 de la mañana", { tz, now }).startsAt).toEqual(at("2026-09-10", "09:00"));
    expect(parseNewCommand("el jueves mañana a las 9", { tz, now }).startsAt).toEqual(at("2026-09-10", "09:00"));
    expect(parseNewCommand("mañana por la mañana a las 9", { tz, now }).startsAt).toEqual(at("2026-09-06", "09:00"));
    expect(parseNewCommand("esta mañana a las 9 Kata", { tz, now }).startsAt).toEqual(at("2026-09-05", "09:00"));
    // The afternoon says the hour is after noon.
    const late = parseNewCommand("mañana a las 7 de la tarde Rawai", { tz, now });
    expect([late.startsAt, late.venue, late.meridiem]).toEqual([at("2026-09-06", "19:00"), "Rawai", true]);
    expect(parseNewCommand("el viernes a las 8 de la noche", { tz, now }).startsAt).toEqual(at("2026-09-11", "20:00"));
  });

  it("every preposition goes, so the examples the bot pins in a crew's group give a clean place", () => {
    // The pinned notice's own examples, read out of it verbatim.
    const example = (locale: "en" | "ru" | "es") => [...strings(locale).crewHow.matchAll(/[“«]([^”»]+)[”»]/g)].map((m) => m[1]).find((q) => /\d/.test(q))!;
    expect(example("en")).toBe("who's in Thursday 7pm Rawai?");
    for (const locale of ["en", "ru", "es"] as const) {
      const p = parseNewCommand(example(locale), { tz, now });
      expect([p.startsAt, p.venue], locale).toEqual([at("2026-09-10", "19:00"), locale === "ru" ? "Равай" : "Rawai"]);
    }
    expect(parseNewCommand("завтра в 19:00 в Равай", { tz, now }).venue).toBe("Равай");
    expect(parseNewCommand("tmr at 19:00 at Kata", { tz, now }).venue).toBe("Kata");
  });

  it("the small words after a crew's question are not the place", () => {
    expect(parseNewCommand("who's in for the 7pm?", { tz, now }).venue).toBeNull();
    expect(parseNewCommand("who's in for Thursday 7pm Rawai?", { tz, now }).venue).toBe("Rawai");
    expect(parseNewCommand("who's in this Thursday 7pm Rawai?", { tz, now }).venue).toBe("Rawai");
    expect(parseNewCommand("who's in for Thursday 7pm Rawai?", { tz, now, venues: ["Rawai Padel"] }).venue).toBe("Rawai Padel");
    // "next" moves the day, so it stays for the caller to see.
    expect(parseNewCommand("who's in Thursday next week 7pm?", { tz, now }).place).toBe("next week");
  });

  it("says how it read the time and whether the place is a known court", () => {
    const bare = parseNewCommand("tmr 19 Rawai", { tz, now });
    expect([bare.timeFrom, bare.dayTyped, bare.meridiem]).toEqual(["bare", true, false]);
    const pm = parseNewCommand("tmr 7pm", { tz, now });
    expect([pm.timeFrom, pm.meridiem]).toEqual(["clock", true]);
    const at7 = parseNewCommand("at 7", { tz, now });
    expect([at7.timeFrom, at7.dayTyped, at7.meridiem]).toEqual(["clock", false, false]);
    expect(parseNewCommand("tomorrow Rawai", { tz, now }).timeFrom).toBeNull();
    const known = parseNewCommand("tmr 19:00 Rawai", { tz, now, venues: ["Rawai Padel"] });
    expect([known.venue, known.place, known.venueKnown]).toEqual(["Rawai Padel", "Rawai", true]);
    const typed = parseNewCommand("tmr 19:00 Kata", { tz, now, venues: ["Rawai Padel"] });
    expect([typed.venue, typed.place, typed.venueKnown]).toEqual(["Kata", "Kata", false]);
  });
});
