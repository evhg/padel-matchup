import { describe, expect, it } from "vitest";
import { noneInCountry, visitorCity, visitorCountry } from "@/lib/domain/countries";

/**
 * A visitor outside Thailand and Singapore. Every club on Kicksmash sits in one of those two
 * countries and every coach sits in Phuket, so the screens must name the reader's own country and
 * offer them the first place in it. These rules decide which country that is, and when to say it.
 */
describe("where the reader is", () => {
  it("takes the country the edge reports", () => {
    expect(visitorCountry("MY", "Asia/Bangkok")).toBe("MY");
    expect(visitorCountry("de", "Asia/Bangkok")).toBe("DE");
  });

  it("falls back to the time zone when the edge says nothing", () => {
    expect(visitorCountry(null, "Europe/Madrid")).toBe("ES");
    expect(visitorCountry("", "Europe/Moscow")).toBe("RU");
  });

  it("answers nothing for a country the claim form cannot accept", () => {
    // NG is a real code and `countryName` would render it, but the claim form's select does not
    // offer it. "Be the first club in Nigeria" is a promise the next screen breaks.
    expect(visitorCountry("NG", null)).toBeNull();
    expect(visitorCountry("ZZ", null)).toBeNull();
    expect(visitorCountry(null, "Africa/Lagos")).toBeNull();
  });

  it("answers nothing when neither source knows", () => {
    expect(visitorCountry(null, null)).toBeNull();
    expect(visitorCountry(null, "Mars/Olympus")).toBeNull();
  });

  it("says the country holds nothing only when it really holds nothing", () => {
    const clubs = ["TH", "TH", "SG", null];
    expect(noneInCountry(clubs, "MY")).toBe(true);
    expect(noneInCountry(clubs, "TH")).toBe(false);
    // Without a country there is no sentence to write.
    expect(noneInCountry(clubs, null)).toBe(false);
  });

  it("reads the city the edge sends percent-encoded", () => {
    expect(visitorCity("Kuala%20Lumpur")).toBe("Kuala Lumpur");
    expect(visitorCity("Berlin")).toBe("Berlin");
    expect(visitorCity("")).toBeNull();
    expect(visitorCity(null)).toBeNull();
    // A broken escape must not throw on a page render.
    expect(visitorCity("Bad%")).toBe("Bad%");
  });
});
