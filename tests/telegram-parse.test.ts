import { describe, expect, it } from "vitest";
import { freezeClock } from "./helpers/clock";
import { matchVenue, parseNewCommand, resolveZone, tzHintFor } from "@/lib/telegram/parse";

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
