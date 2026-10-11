import { describe, expect, it } from "vitest";
import { bookingHref, linksIn, readBooking, type BookingRead, type PickClub } from "@/lib/domain/bookingPaste";
import { freezeClock } from "./helpers/clock";

/**
 * "Paste your booking" (the owner, 11 October 2026): a court booked in a platform's app, pasted as
 * its share text or its link, fills the match form. The owner's own case is the first test: a court
 * at Warehaus in Phuket, booked in The Padel Society's app, with Danny and Alberto.
 *
 * Every "now" here is fixed. NOW is Sunday 11 October 2026, 13:00 in Phuket (06:00 UTC).
 */
const NOW = new Date("2026-10-11T06:00:00Z");
freezeClock(NOW);

const CLUBS: PickClub[] = [
  { slug: "warehaus", name: "WAREHAUS.club", tz: "Asia/Bangkok", bookingUrl: null, website: null },
  { slug: "rawai-padel", name: "Rawai Padel", tz: "Asia/Bangkok", bookingUrl: "https://playtomic.com/clubs/rawai-padel", website: null },
  { slug: "bangkok-padel", name: "Bangkok Padel", tz: "Asia/Bangkok", bookingUrl: "https://playtomic.com/clubs/bangkok-padel", website: null },
  { slug: "blue-tree", name: "Padel Phuket @ Blue Tree", tz: "Asia/Bangkok", bookingUrl: "https://www.matchi.se/facilities/bluetree", website: null },
  { slug: "prime-padel-dempsey", name: "Prime Padel Dempsey", tz: "Asia/Singapore", bookingUrl: null, website: "https://primepadel.example.sg/" },
  { slug: "setpoint-club", name: "Kata Courts", tz: "Asia/Bangkok", bookingUrl: "https://getsetpoint.io/checkout/kata-courts", website: null },
  { slug: "pod-club", name: "Pod Club Singapore", tz: "Asia/Singapore", bookingUrl: "https://podclub.podplay.app/book", website: null },
];

const read = (text: string, o: Partial<Parameters<typeof readBooking>[0]> = {}): BookingRead => readBooking({ text, clubs: CLUBS, now: NOW, tz: "Asia/Bangkok", ...o });

describe("the owner's case", () => {
  it("reads Warehaus, the day, the time, the length, the court and the two players", () => {
    const r = read("Warehaus Sun 12 Oct 18:00-19:30 court 3 with Danny, Alberto");
    expect(r).toMatchObject({ club: { slug: "warehaus" }, clubFrom: "text", date: "2026-10-12", time: "18:00", tz: "Asia/Bangkok", minutes: 90, court: "3", names: ["Danny", "Alberto"], missing: [] });
    expect(bookingHref(r)).toBe("/?src=paste&venue=WAREHAUS.club&date=2026-10-12&time=18%3A00&tz=Asia%2FBangkok&len=90&court=3&names=Danny%2CAlberto&booked=1");
  });

  it("takes the Padel Society link as the platform, and the club from the person's words", () => {
    const r = read("Warehaus tomorrow 6pm https://thepadelsociety.app.link/LMi1mpWR86b");
    expect(r).toMatchObject({ platform: { id: "padelsociety", name: "The Padel Society" }, club: { slug: "warehaus" }, date: "2026-10-12", time: "18:00", missing: [] });
  });

  it("skips the person's own name", () => {
    expect(read("Warehaus 12 Oct 18:00 with Cath, Danny and Alberto", { selfName: "Cath" }).names).toEqual(["Danny", "Alberto"]);
    expect(read("Warehaus 12 Oct 18:00 with Cath, Danny", { selfName: "Cath Tunti" }).names).toEqual(["Danny"]);
  });
});

describe("the day", () => {
  it("reads month names in Russian and Spanish, every case", () => {
    expect(read("Warehaus 12 октября 18:00").date).toBe("2026-10-12");
    expect(read("Warehaus 3 января 18:00").date).toBe("2027-01-03");
    expect(read("Warehaus 12 de octubre 18:00").date).toBe("2026-10-12");
    expect(read("Warehaus 12 de octubre de 2026, 18:00").date).toBe("2026-10-12");
    expect(read("Warehaus Oct 14th, 18:00").date).toBe("2026-10-14");
    expect(read("Warehaus 14 Oct 2026 18:00").date).toBe("2026-10-14");
  });

  it("reads day-first figures, and a dot needs two figures a side", () => {
    expect(read("Warehaus 12/10 18:00").date).toBe("2026-10-12");
    expect(read("Warehaus 3/11 18:00").date).toBe("2026-11-03");
    expect(read("Warehaus 12.10.2026 18:00").date).toBe("2026-10-12");
    expect(read("Warehaus 2026-10-13 18:00").date).toBe("2026-10-13");
    // "1.5 hr" is a length and "3.5" a level, never the first of May or the third of May.
    const r = read("Warehaus Level 3.5-4.5 tomorrow 18:00 1.5 hr");
    expect(r).toMatchObject({ date: "2026-10-12", minutes: 90 });
  });

  it("takes the next such day for a day without a year, across the new year", () => {
    const december = new Date("2026-12-28T06:00:00Z");
    expect(read("Warehaus 3 Jan 18:00", { now: december }).date).toBe("2027-01-03");
    expect(read("Warehaus 03/01 18:00", { now: december }).date).toBe("2027-01-03");
    // Yesterday without a year is next year's; it is never a day already played.
    expect(read("Warehaus 10 Oct 18:00").date).toBe("2027-10-10");
  });

  it("refuses a date with its year more than a day in the past", () => {
    const r = read("Warehaus 5 Oct 2026 18:00");
    expect(r.date).toBeNull();
    expect(r.missing).toEqual(["date"]);
    expect(read("Warehaus 10 Oct 2026 18:00").date).toBe("2026-10-10");
  });

  it("reads weekdays and today and tomorrow in three languages", () => {
    // Sunday 11 October: "Sunday 18:00" is today at 13:00, "Sunday 9:00" is next week.
    expect(read("Warehaus Sunday 18:00").date).toBe("2026-10-11");
    expect(read("Warehaus Sunday 9:00").date).toBe("2026-10-18");
    expect(read("Warehaus Tue 18:00").date).toBe("2026-10-13");
    expect(read("Warehaus в среду 18:00").date).toBe("2026-10-14");
    expect(read("Warehaus el jueves 18:00").date).toBe("2026-10-15");
    expect(read("Warehaus сегодня 18:00").date).toBe("2026-10-11");
    expect(read("Warehaus завтра 18:00").date).toBe("2026-10-12");
    expect(read("Warehaus hoy 18:00").date).toBe("2026-10-11");
    expect(read("Warehaus mañana 18:00").date).toBe("2026-10-12");
    // "por la mañana" is the morning, not tomorrow.
    expect(read("Warehaus el jueves por la mañana 9:00").date).toBe("2026-10-15");
  });

  it("reads the day in the club's zone, not the caller's", () => {
    // 23:30 UTC on 11 October is already 12 October in Singapore.
    const late = new Date("2026-10-11T17:30:00Z");
    const r = read("Prime Padel Dempsey today 20:00", { now: late, tz: "Europe/Madrid" });
    expect(r).toMatchObject({ club: { slug: "prime-padel-dempsey" }, tz: "Asia/Singapore", date: "2026-10-12" });
  });
});

describe("the time and the length", () => {
  it("reads 24-hour and 12-hour clocks", () => {
    expect(read("Warehaus tomorrow 18.00").time).toBe("18:00");
    expect(read("Warehaus tomorrow 6pm").time).toBe("18:00");
    expect(read("Warehaus tomorrow 6:30 PM").time).toBe("18:30");
    expect(read("Warehaus tomorrow 9 a.m.").time).toBe("09:00");
    expect(read("Warehaus tomorrow 12pm").time).toBe("12:00");
  });

  it("reads a range, en dash too, and its length", () => {
    expect(read("Warehaus tomorrow 18:00–19:30")).toMatchObject({ time: "18:00", minutes: 90 });
    expect(read("Warehaus tomorrow 6-7:30pm")).toMatchObject({ time: "18:00", minutes: 90 });
    expect(read("Warehaus tomorrow 11-1pm")).toMatchObject({ time: "11:00", minutes: 120 });
    expect(read("Warehaus mañana de 18:00 a 19:00")).toMatchObject({ time: "18:00", minutes: 60 });
    // Two bare numbers are a score or a level, never a time.
    expect(read("Warehaus tomorrow 6-4").time).toBeNull();
  });

  it("reads a length in minutes or hours", () => {
    expect(read("Warehaus tomorrow 18:00 90 min").minutes).toBe(90);
    expect(read("Warehaus tomorrow 18:00 60 minutes").minutes).toBe(60);
    expect(read("Warehaus tomorrow 18:00 1.5 hr").minutes).toBe(90);
    expect(read("Warehaus tomorrow 18:00 1h30").minutes).toBe(90);
    expect(read("Warehaus tomorrow 18:00 2 hours").minutes).toBe(120);
    expect(read("Warehaus завтра 18:00 полтора часа").minutes).toBe(90);
    expect(read("Warehaus tomorrow 18:00 90 min").time).toBe("18:00");
  });

  it("sends a length to the form only when the form offers it", () => {
    const r = read("Warehaus tomorrow 18:00-19:15");
    expect(r.minutes).toBe(75);
    expect(bookingHref(r)).not.toContain("len=");
  });
});

describe("the court and the price", () => {
  it("reads a court in three languages, bounded", () => {
    expect(read("Warehaus tomorrow 18:00 Court 3").court).toBe("3");
    expect(read("Warehaus tomorrow 18:00 COURT 3 Center Court").court).toBe("Court 3 · Center Court");
    expect(read("Warehaus завтра 18:00 корт 2").court).toBe("2");
    expect(read("Warehaus mañana 18:00 pista 4").court).toBe("4");
    expect(read("Warehaus mañana 18:00 Pista Central").court).toBe("Pista Central");
    expect(read("Warehaus tomorrow 18:00 court booked").court).toBeNull();
    expect(read("Warehaus tomorrow 18:00 2 courts free").court).toBeNull();
  });

  it("reads a price beside a currency, as written", () => {
    expect(read("Warehaus tomorrow 18:00 ฿1,600").cost).toBe("฿1,600");
    expect(read("Warehaus tomorrow 18:00 1600 THB").cost).toBe("1600 THB");
    expect(read("Warehaus tomorrow 18:00 S$60").cost).toBe("S$60");
    expect(read("Warehaus tomorrow 18:00 Court 3 600 THB")).toMatchObject({ court: "3", cost: "600 THB" });
    expect(read("Warehaus tomorrow 18:00 400 THB/person").cost).toBe("400 THB/person");
    // A price is no time and no day.
    expect(read("Warehaus tomorrow 18:00 ฿1,600")).toMatchObject({ time: "18:00", date: "2026-10-12" });
  });
});

describe("the players", () => {
  it("reads team lines and 'with' in three languages", () => {
    expect(read("Warehaus tomorrow 18:00\nTeam A: Danny, Alberto\nTeam B: Mike, ?").names).toEqual(["Danny", "Alberto", "Mike"]);
    expect(read("Warehaus завтра 18:00 с Данни и Альберто").names).toEqual(["Данни", "Альберто"]);
    expect(read("Warehaus mañana 18:00 con Ana y Bea").names).toEqual(["Ana", "Bea"]);
    expect(read("Warehaus tomorrow 18:00 with Danny and Alberto at court 3")).toMatchObject({ names: ["Danny", "Alberto"], court: "3" });
  });

  it("reads a list of names on their own lines", () => {
    expect(read("Warehaus\nSun 12 Oct 18:00\nDanny\nAlberto").names).toEqual(["Danny", "Alberto"]);
    expect(read("Warehaus\n12 Oct 18:00\n1. Danny\n2. Alberto\n3. Mike").names).toEqual(["Danny", "Alberto", "Mike"]);
  });

  it("refuses what is not a name: days, months, clubs, platforms, the court", () => {
    expect(read("Warehaus\nSunday\n12 Oct 18:00").names).toEqual([]);
    expect(read("Join Padel Match Invitation\nWarehaus\nPlaytomic\n12 Oct 18:00").names).toEqual([]);
    expect(read("Warehaus tomorrow 18:00 with friends").names).toEqual([]);
    expect(read("Warehaus tomorrow 18:00 with Court").names).toEqual([]);
    expect(read("Warehaus tomorrow 18:00 with October").names).toEqual([]);
    // A lone word is not a list.
    expect(read("Danny\nWarehaus tomorrow 18:00").names).toEqual([]);
  });

  it("keeps seven names at most, forty letters each", () => {
    const r = read("Warehaus tomorrow 18:00\nPlayers: Ana, Bo, Cy, Di, Ed, Flo, Gus, Hal, Ivo");
    expect(r.names).toEqual(["Ana", "Bo", "Cy", "Di", "Ed", "Flo", "Gus"]);
  });
});

describe("the club", () => {
  it("takes the club from a link first, against the clubs' booking links and websites", () => {
    expect(read("tomorrow 18:00 https://playtomic.com/clubs/rawai-padel?date=2026-10-12")).toMatchObject({ club: { slug: "rawai-padel" }, clubFrom: "link", platform: { id: "playtomic" } });
    expect(read("tomorrow 18:00 https://www.matchi.se/facilities/bluetree")).toMatchObject({ club: { slug: "blue-tree" }, clubFrom: "link" });
    expect(read("tomorrow 18:00 https://getsetpoint.io/checkout/kata-courts?slot=1")).toMatchObject({ club: { slug: "setpoint-club" }, platform: { id: "setpoint" } });
    expect(read("tomorrow 18:00 https://podclub.podplay.app/booking/9")).toMatchObject({ club: { slug: "pod-club" }, platform: { id: "podplay" } });
    expect(read("tomorrow 18:00 https://primepadel.example.sg/booking?x=1")).toMatchObject({ club: { slug: "prime-padel-dempsey" } });
    // A link beats the words: the link is what the platform says.
    expect(read("Warehaus tomorrow 18:00 https://playtomic.com/clubs/bangkok-padel").club?.slug).toBe("bangkok-padel");
  });

  it("finds a club by its name in the words, never by a city or an area alone", () => {
    expect(read("Join my match at Warehaus tomorrow 18:00").club?.slug).toBe("warehaus");
    expect(read("Booking confirmed\nBlue Tree, Phuket\ntomorrow 18:00").club?.slug).toBe("blue-tree");
    expect(read("Phuket tomorrow 18:00").club).toBeNull();
    expect(read("Rawai tomorrow 18:00").club).toBeNull();
    expect(read("Rawai Padel tomorrow 18:00").club?.slug).toBe("rawai-padel");
    // The words around a club's name in a platform's share text, and a lower-case "with" phrase, name no club.
    expect(read("Join my match at Bangkok Padel on Monday 12 October at 18:00!")).toMatchObject({ club: { slug: "bangkok-padel" }, date: "2026-10-12", time: "18:00" });
    expect(read("warehaus tmrw 7pm 90min with danny")).toMatchObject({ club: { slug: "warehaus" }, time: "19:00", minutes: 90, names: [] });
    const share = "Join my match on The Padel Society at Warehaus\nMon 19 Oct · 6:30 PM - 8:00 PM\nCourt 2 · ฿1,600\nPlayers: Danny, Alberto, Cath";
    expect(read(share, { selfName: "Cath" })).toMatchObject({ club: { slug: "warehaus" }, date: "2026-10-19", time: "18:30", minutes: 90, court: "2", cost: "฿1,600", names: ["Danny", "Alberto"], missing: [] });
  });

  it("uses the zone of the caller when no club is found, and says what is missing", () => {
    const r = read("tomorrow 18:00", { tz: "Europe/Madrid" });
    expect(r).toMatchObject({ club: null, tz: "Europe/Madrid", date: "2026-10-12", time: "18:00", missing: ["club"] });
    expect(read("", { tz: "Asia/Bangkok" }).missing).toEqual(["club", "date", "time"]);
  });

  it("takes the organiser's last venue only when nothing else names a club", () => {
    const warehaus = CLUBS[0];
    expect(read("tomorrow 18:00", { fallbackClub: warehaus })).toMatchObject({ club: { slug: "warehaus" }, clubFrom: "history", missing: [] });
    expect(read("Rawai Padel tomorrow 18:00", { fallbackClub: warehaus }).club?.slug).toBe("rawai-padel");
  });
});

describe("the preview", () => {
  const generic = { title: "Join Padel Match Invitation", description: "Let's join our match to play together", ref: { type: "matchInvite", id: "12345" } };

  it("passes a Padel Society ref through, and its generic words fill nothing", () => {
    const r = read("https://thepadelsociety.app.link/AbCdEf12345", { preview: generic });
    expect(r).toMatchObject({ ref: { type: "matchInvite", id: "12345" }, platform: { id: "padelsociety" }, club: null, date: null, time: null, names: [], missing: ["club", "date", "time"] });
  });

  it("fills only what the person's text left out", () => {
    const preview = { title: "Padel at Rawai Padel", description: "Mon 19 Oct, 20:00 - 21:30, Court 2, ฿1,200" };
    const r = read("Warehaus 12 Oct 18:00", { preview });
    expect(r).toMatchObject({ club: { slug: "warehaus" }, clubFrom: "text", date: "2026-10-12", time: "18:00", court: "2", cost: "฿1,200" });
    // The range's length comes from the preview too, because the text gave none.
    expect(r.minutes).toBe(90);
    const empty = read("https://example.com/x", { preview });
    expect(empty).toMatchObject({ club: { slug: "rawai-padel" }, clubFrom: "preview", date: "2026-10-19", time: "20:00", minutes: 90 });
  });

  it("never reads names from the preview", () => {
    expect(read("Warehaus tomorrow 18:00", { preview: { title: "Danny, Alberto", description: "with Danny and Alberto" } }).names).toEqual([]);
  });
});

describe("links", () => {
  it("finds http(s) links, adds the message's own, cleans and dedupes them, five at most", () => {
    const text = "Booked! https://playtomic.com/clubs/x. And (https://thepadelsociety.app.link/abc) ftp://x.y https://playtomic.com/clubs/x.";
    expect(linksIn(text, ["https://getsetpoint.io/checkout/kata"])).toEqual(["https://playtomic.com/clubs/x", "https://thepadelsociety.app.link/abc", "https://getsetpoint.io/checkout/kata"]);
    const many = Array.from({ length: 8 }, (_, i) => `https://a${i}.example.com/`).join(" ");
    expect(linksIn(many)).toHaveLength(5);
  });
});
