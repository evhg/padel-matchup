import { describe, expect, it } from "vitest";
import { coachCardGaps } from "@/lib/domain/coaching";

/**
 * What a player compares on and the card does not answer.
 *
 * Both live coaches are listed with all four missing, and the notice that says so has lived since
 * Tier 1 inside a settings screen a coach opens once. The rule is here so the coach's book can show
 * it too, and so the price question is asked of the card rather than of one column.
 */
const bare = { bio: null, priceSingle: null, priceSecondSingle: null, teachesLevelMin: null, teachesLevelMax: null };

describe("the gaps in a coach's card", () => {
  it("names all four for a coach who filled in nothing, in the order a player reads them", () => {
    expect(coachCardGaps(bare, { photo: false })).toEqual(["photo", "bio", "price", "levels"]);
  });

  it("says nothing when the card answers everything", () => {
    expect(coachCardGaps({ ...bare, bio: "Ten years in Phuket.", priceSingle: 800, teachesLevelMin: 2, teachesLevelMax: 4 }, { photo: true })).toEqual([]);
  });

  it("counts the second person's price, because the card shows it", () => {
    // priceFrom takes the lowest one-person price, and priceSecondSingle is one.
    expect(coachCardGaps({ ...bare, priceSecondSingle: 600 }, { photo: false })).not.toContain("price");
  });

  it("counts a package, because a card with no hourly price still shows one", () => {
    const offers = [{ size: 10, price: 7000, heads: 1 }];
    expect(coachCardGaps(bare, { photo: false, offers })).not.toContain("price");
    // A package for two is not a price a single player reads off the card.
    expect(coachCardGaps(bare, { photo: false, offers: [{ size: 10, price: 9000, heads: 2 }] })).toContain("price");
  });

  it("takes one end of the level range as an answer", () => {
    expect(coachCardGaps({ ...bare, teachesLevelMin: 3 }, { photo: false })).not.toContain("levels");
    expect(coachCardGaps({ ...bare, teachesLevelMax: 5 }, { photo: false })).not.toContain("levels");
  });

  it("does not take whitespace for words of their own", () => {
    expect(coachCardGaps({ ...bare, bio: "   " }, { photo: false })).toContain("bio");
  });

  it("drops only what is filled in", () => {
    expect(coachCardGaps({ ...bare, bio: "Hello." }, { photo: true })).toEqual(["price", "levels"]);
  });
});
