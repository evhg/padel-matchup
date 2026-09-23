import { describe, expect, it } from "vitest";
import { mergeGroups, normalName, pickSurvivor, safeToMerge } from "@/lib/domain/dupes";

/**
 * When two rows are the same person, proven here rather than in production.
 *
 * A merge cannot be undone. Leaving one person with two halves of their history is a small cost;
 * handing one stranger's history to another is the thing this must never do. So every case below
 * asks the same question: is there a key two different people would not share?
 */

const at = (day: number) => new Date(Date.UTC(2026, 8, day, 12, 0, 0));
const row = (id: string, displayName: string, o: { email?: string | null; telegramId?: number | null; day?: number; weight?: number } = {}) => ({
  id,
  displayName,
  email: o.email ?? null,
  telegramId: o.telegramId ?? null,
  createdAt: at(o.day ?? 1),
  weight: o.weight ?? 0,
});

describe("when two rows are the same person", () => {
  it("merges on the address, whatever the name says", () => {
    // Jakob has two rows, one typed "Jakob" and one "jakob", both carrying the same address.
    const a = row("a", "Jakob", { email: "mr@example.com", day: 4 });
    const b = row("b", "jakob", { email: "MR@example.com", day: 8 });
    expect(safeToMerge(a, b)).toEqual({ ok: true, rule: "same_email" });
  });

  it("merges on the Telegram account", () => {
    expect(safeToMerge(row("a", "Erik", { telegramId: 12 }), row("b", "Erik", { telegramId: 12 }))).toEqual({ ok: true, rule: "same_telegram" });
  });

  it("merges the same name when at most one side can be reached", () => {
    const named = safeToMerge(row("a", "Micky", { email: "micky@example.com" }), row("b", "Micky"));
    expect(named).toEqual({ ok: true, rule: "same_name_one_address" });
    // Neither side reachable is still the same name and still nothing contradicting.
    expect(safeToMerge(row("a", "Nacho Garcia"), row("b", "nacho  garcia")).ok).toBe(true);
  });

  it("refuses two people who happen to share a name", () => {
    // The whole point. Two addresses is two people, and no name makes that safe.
    expect(safeToMerge(row("a", "Anna", { email: "anna@one.com" }), row("b", "Anna", { email: "anna@two.com" }))).toEqual({
      ok: false,
      reason: "two different addresses",
    });
    expect(safeToMerge(row("a", "Erik", { telegramId: 1 }), row("b", "Erik", { telegramId: 2 })).ok).toBe(false);
    expect(safeToMerge(row("a", "Erik"), row("b", "Erika")).ok).toBe(false);
    expect(safeToMerge(row("a", ""), row("b", "")).ok).toBe(false); // a blank name matches nobody
    expect(safeToMerge(row("a", "Erik"), row("a", "Erik")).ok).toBe(false); // a row is not its own duplicate
  });

  it("keeps the row that can be reached, then the one with the most history", () => {
    const quiet = row("q", "Erik", { day: 1, weight: 9 });
    const reachable = row("r", "Erik", { email: "e@example.com", day: 6, weight: 1 });
    expect(pickSurvivor([quiet, reachable])?.id).toBe("r");
    // With nobody reachable, the busiest wins, and the oldest breaks a tie.
    expect(pickSurvivor([row("x", "Erik", { day: 5, weight: 1 }), row("y", "Erik", { day: 2, weight: 3 })])?.id).toBe("y");
    expect(pickSurvivor([row("x", "Erik", { day: 5 }), row("y", "Erik", { day: 2 })])?.id).toBe("y");
    expect(pickSurvivor([])).toBeNull();
  });

  it("groups the real database's shape: five Erik rows into the one with the address", () => {
    // The five rows as production held them on 23 September: four anonymous, one carrying the
    // address, the Telegram account, eleven matches and a level.
    const rows = [
      row("e1", "Erik", { day: 3 }),
      row("e2", "Erik", { day: 3 }),
      row("e3", "Erik", { day: 3, weight: 2 }),
      row("e4", "Erik", { day: 3, weight: 4 }),
      row("e5", "Erik", { email: "verspui@example.com", telegramId: 1248577943, day: 6, weight: 21 }),
    ];
    const groups = mergeGroups(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].into.id).toBe("e5");
    expect(groups[0].from.map((r) => r.id).sort()).toEqual(["e1", "e2", "e3", "e4"]);
  });

  it("leaves two real people alone and takes nobody twice", () => {
    const rows = [row("a", "Anna", { email: "anna@one.com", day: 2 }), row("b", "Anna", { email: "anna@two.com", day: 3 }), row("c", "Anna", { day: 4 })];
    const groups = mergeGroups(rows);
    // Anna-with-one-address may take the row with no address; Anna-with-the-other must not also take it.
    const claimed = groups.flatMap((g) => g.from.map((r) => r.id));
    expect(new Set(claimed).size).toBe(claimed.length);
    expect(groups.every((g) => g.from.length <= 1)).toBe(true);
    expect(normalName("  Nacho   GARCIA ")).toBe("nacho garcia");
  });
});
