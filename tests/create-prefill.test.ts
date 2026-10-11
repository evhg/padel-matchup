import { describe, expect, it } from "vitest";
import { bookingHref, readBooking } from "@/lib/domain/bookingPaste";
import { readCreateLink } from "@/lib/domain/createPrefill";
import { SEAT_NAMES_MAX } from "@/lib/domain/slots";

/**
 * The create form's address, read (`readCreateLink`, which `CreateScreen` calls): a club's link, the
 * americano generator's names and a pasted booking (`bookingHref`). Every value is something anybody
 * can type into a link, so each is held to the form's own bounds. No clock: every date is written out.
 */
const params = (href: string) => Object.fromEntries(new URL(href, "https://kicksma.sh").searchParams);

describe("the create form's address", () => {
  it("fills every field a pasted booking carries, and never lists the match on the venue board", () => {
    const p = readCreateLink(params("/?src=paste&venue=WAREHAUS.club&date=2026-10-12&time=18%3A00&tz=Asia%2FBangkok&len=90&court=3&cost=600%20THB&names=Danny%2CAlberto&booked=1"));
    expect(p).toEqual({
      fromPaste: true,
      venue: "WAREHAUS.club",
      date: "2026-10-12",
      time: "18:00",
      tz: "Asia/Bangkok",
      durationMinutes: 90,
      court: "3",
      cost: "600 THB",
      publicListing: false,
      booked: true,
      names: ["Danny", "Alberto"],
      missing: [],
      check: [],
    });
  });

  it("a club's own link with a venue still lists the match, as the venue board always did", () => {
    const p = readCreateLink({ venue: "WAREHAUS.club", date: "2026-10-12", time: "18:00", tz: "Asia/Bangkok" });
    expect(p).toMatchObject({ fromPaste: false, venue: "WAREHAUS.club", publicListing: true, date: "2026-10-12", time: "18:00", tz: "Asia/Bangkok", booked: false, missing: [] });
    // The guard is the paste alone: the same venue with src=paste stays off the board.
    expect(readCreateLink({ venue: "WAREHAUS.club", src: "paste" }).publicListing).toBe(false);
    expect(readCreateLink({ venue: "WAREHAUS.club" }).publicListing).toBe(true);
  });

  it("names what a pasted booking left out, so the form asks for it in place", () => {
    expect(readCreateLink({ src: "paste", tz: "Asia/Bangkok", time: "18:00" })).toMatchObject({ venue: null, date: null, time: "18:00", tz: "Asia/Bangkok", missing: ["venue", "date"] });
    expect(readCreateLink({ src: "paste", tz: "Asia/Bangkok", venue: "WAREHAUS.club", date: "2026-10-12" }).missing).toEqual(["time"]);
    // Without a zone a day and an hour mean nothing, so both are asked for.
    expect(readCreateLink({ src: "paste", venue: "WAREHAUS.club", date: "2026-10-12", time: "18:00", tz: "Mars/Olympus" })).toMatchObject({ date: null, time: null, tz: null, missing: ["date", "time"] });
  });

  it("a club's link brings the day, the hour and the zone together or not at all", () => {
    expect(readCreateLink({ venue: "Rawai Padel", date: "2026-10-12", tz: "Asia/Bangkok" })).toMatchObject({ date: null, time: null, tz: null });
    expect(readCreateLink({ venue: "Rawai Padel", date: "2026-10-12", time: "18:00" })).toMatchObject({ date: null, time: null, tz: null });
  });

  it("refuses what the form would refuse: a length that is not 60, 90 or 120, a day that does not exist, an hour off the clock", () => {
    for (const len of ["75", "45", "-90", "90.5", "ninety", "1200"]) expect(readCreateLink({ src: "paste", len }).durationMinutes).toBeNull();
    expect(readCreateLink({ src: "paste", len: "60" }).durationMinutes).toBe(60);
    expect(readCreateLink({ src: "paste", len: "120" }).durationMinutes).toBe(120);
    expect(readCreateLink({ src: "paste", tz: "UTC", date: "2026-02-30", time: "24:00" })).toMatchObject({ date: null, time: null });
    expect(readCreateLink({ src: "paste", tz: "UTC", date: "12/10/2026", time: "6pm" })).toMatchObject({ date: null, time: null });
  });

  it("holds the court and the price to the form's 40 characters, and drops a longer one rather than cut it", () => {
    expect(readCreateLink({ court: "  Centre   court  " }).court).toBe("Centre court");
    expect(readCreateLink({ court: "x".repeat(40) }).court).toBe("x".repeat(40));
    expect(readCreateLink({ court: "x".repeat(41) }).court).toBeNull();
    expect(readCreateLink({ cost: "6".repeat(41) }).cost).toBeNull();
    expect(readCreateLink({ cost: "" }).cost).toBeNull();
    expect(readCreateLink({ cost: "600\u0000THB" }).cost).toBe("600 THB");
  });

  it("booked only from booked=1, and the generator's names as before, at most the seats a list may fill", () => {
    expect(readCreateLink({ booked: "true" }).booked).toBe(false);
    expect(readCreateLink({ booked: "1" }).booked).toBe(true);
    expect(readCreateLink({ names: " Ana , ,Bo," }).names).toEqual(["Ana", "Bo"]);
    expect(readCreateLink({ names: Array.from({ length: 40 }, (_, i) => `P${i}`).join(",") }).names).toHaveLength(SEAT_NAMES_MAX);
    expect(readCreateLink({ names: "y".repeat(80) }).names).toEqual(["y".repeat(60)]);
  });

  it("reads back exactly what the reader's own link wrote (bookingHref)", () => {
    // Sunday 11 October 2026, 13:00 in Phuket: the owner's own paste, with no link.
    const read = readBooking({
      text: "Warehaus Mon 12 Oct 18:00-19:30 court 3 with Danny, Alberto",
      clubs: [{ slug: "warehaus", name: "WAREHAUS.club", tz: "Asia/Bangkok" }],
      now: new Date("2026-10-11T06:00:00Z"),
      tz: "Asia/Bangkok",
    });
    const p = readCreateLink(params(bookingHref(read)));
    expect(p).toMatchObject({ fromPaste: true, venue: "WAREHAUS.club", date: "2026-10-12", time: "18:00", tz: "Asia/Bangkok", durationMinutes: 90, court: "3", booked: true, publicListing: false, names: ["Danny", "Alberto"], missing: [], check: [] });
  });

  it("reads which pasted fields the organiser must check, only for a field the link fills", () => {
    const base = { src: "paste", venue: "WAREHAUS.club", date: "2026-10-12", time: "18:00", tz: "Asia/Bangkok" };
    expect(readCreateLink({ ...base, check: "venue,date" }).check).toEqual(["venue", "date"]);
    expect(readCreateLink({ ...base, check: "date" }).check).toEqual(["date"]);
    expect(readCreateLink({ ...base, check: "venue,court,<b>" }).check).toEqual(["venue"]);
    // Nothing to check in an empty field, and nothing outside a paste.
    expect(readCreateLink({ src: "paste", tz: "Asia/Bangkok", check: "venue,date" }).check).toEqual([]);
    expect(readCreateLink({ ...base, src: undefined, check: "venue,date" }).check).toEqual([]);
  });
});
