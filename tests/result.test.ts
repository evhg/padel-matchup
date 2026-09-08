import { describe, expect, it } from "vitest";
import { matchResult } from "@/lib/domain/result";

describe("match result names", () => {
  const sets = [
    { setNumber: 1, sideA: 3, sideB: 6 },
    { setNumber: 2, sideA: 5, sideB: 7 },
  ];
  it("a seat the organizer reserved by name is on the card once a score exists; an empty invite is not", () => {
    const r = matchResult(sets, [
      { team: "a", status: "joined", name: "Erik" },
      { team: "a", status: "confirmed", name: "Adrian" },
      { team: "b", status: "confirmed", name: "Micky" },
      { team: "b", status: "invited", name: "Timo" },
    ])!;
    expect(r.a).toEqual(["Erik", "Adrian"]);
    expect(r.b).toEqual(["Micky", "Timo"]);
    expect(r.winner).toBe("b");
    expect(r.score).toBe("3-6 5-7");
    const partial = matchResult(sets, [
      { team: "a", status: "joined", name: "Erik" },
      { team: "b", status: "invited", name: "?" },
      { team: "b", status: "declined", name: "Gone" },
      { team: "b", status: "empty", name: "?" },
    ])!;
    expect(partial.b).toEqual([]);
    expect(partial.hasTeams).toBe(false);
  });
});
