import { describe, expect, it } from "vitest";
import { venueGo, type VenueOption } from "@/components/VenueCombobox";

/**
 * Go (Enter) in the create form's venue field while its list is open. A pick of a suggestion keeps the
 * focus (the field answers Go itself); no pick lets the form move on to the next field. A returning
 * organiser's own club is filled in, and Go there picked the same club again and kept the focus, so the
 * "next" key took two presses on the most common returning path (review, 15 October 2026).
 */
const own: VenueOption = { name: "Club Padel Test", mapUrl: "https://maps.app.goo.gl/own", where: "yours" };
const bare: VenueOption = { name: "Rawai Padel", mapUrl: null, where: "here" };
const venues = [own, bare, { name: "Club Padel Phuket", mapUrl: null, where: "nearby" }] as const;

describe("venueGo", () => {
  it("is no pick for the club the field already holds with its map link, so Go moves on", () => {
    expect(venueGo(venues, own, "Club Padel Test", "https://maps.app.goo.gl/own")).toBeNull();
  });

  it("is no pick for a held club with no map link, and keeps a link the organiser typed", () => {
    expect(venueGo(venues, bare, "Rawai Padel", "")).toBeNull();
    expect(venueGo(venues, bare, "Rawai Padel", "https://maps.app.goo.gl/typed")).toBeNull();
  });

  it("picks the club again when the field's map link is another one", () => {
    expect(venueGo(venues, own, "Club Padel Test", "https://maps.app.goo.gl/other")).toBe(own);
  });

  it("picks the club typed in full in another case or with spaces round it, because the pick writes its own name", () => {
    expect(venueGo(venues, own, "club padel test", "https://maps.app.goo.gl/own")).toBe(own);
    expect(venueGo(venues, own, "Club Padel Test ", "https://maps.app.goo.gl/own")).toBe(own);
  });

  it("picks the first suggestion for a partial name, as a tap does", () => {
    expect(venueGo(venues, own, "Club Pad", "")).toBe(own);
  });

  it("closes the list when only 'Use … as a new court' is left", () => {
    expect(venueGo(venues, undefined, "Somewhere new", "")).toBe("close");
  });

  it("is no pick for an empty field", () => {
    expect(venueGo(venues, own, "  ", "")).toBeNull();
  });
});
