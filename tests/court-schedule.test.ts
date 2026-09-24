import { describe, expect, it } from "vitest";
import { playingOrder, schedule, scheduleWeekend, type ScheduleMatch } from "@/lib/domain/courtSchedule";
import { planDraw, type Entrant } from "@/lib/domain/draw";
import { SCORING, scoringOfMatch } from "@/lib/domain/draw";

const TZ = "Asia/Bangkok";
const entrants = (n: number): Entrant[] => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, seed: i < 2 ? i + 1 : null, wildcard: false, order: i + 1 }));
const cfg = { format: "groups_knockout" as const, maxPairs: 8, groupSize: 4, groupsThrough: 2, consolation: true, qualifyingSpots: 0, seed: "s" };
const scoring = { scoringGroup: "set6tb", scoringKnockout: "set9", scoringFinal: "sets2stb" };

/** A category's planned matches as the scheduler sees them. */
function matchesOf(categoryId: string, plan: ReturnType<typeof planDraw>): ScheduleMatch[] {
  const rounds = Math.max(0, ...plan.matches.filter((m) => m.phase === "main").map((m) => m.round));
  return plan.matches.map((m, i) => ({ id: `${categoryId}-${i}`, categoryId, ...m, over: false, minutes: SCORING[scoringOfMatch(m, rounds, scoring)].minutes }));
}
const local = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);

describe("courts and times", () => {
  it("orders the draw's matches so nothing waits on a match after it", () => {
    const ms = matchesOf("gold", planDraw(entrants(8), cfg));
    const order = playingOrder(ms).map((m) => `${m.phase}:${m.round}`);
    expect(order.slice(0, 12).every((k) => k.startsWith("group:"))).toBe(true);
    expect(order.slice(12)).toEqual(["main:1", "main:1", "consolation:1", "consolation:1", "main:2", "consolation:2"]);
  });

  it("fills two courts in parallel, keeps a rest between a pair's matches, and puts the semis after the groups", () => {
    const ms = matchesOf("gold", planDraw(entrants(8), cfg));
    const { slots, unplaced } = schedule({ matches: ms, courts: ["Court 1", "Court 2"], days: [{ date: "2026-10-10", start: "09:00", end: "21:00" }], tz: TZ, rest: 30 });
    // Every match but none of the byes: eighteen, all inside Saturday's window, and none left over.
    expect(slots).toHaveLength(18);
    expect(unplaced).toBe(0);
    for (const s of slots) expect(local(s.startsAt).startsWith("Sat")).toBe(true);
    // The first two group matches start together, one per court.
    const first = slots.slice(0, 2).map((s) => [s.courtName, local(s.startsAt)]);
    expect(first).toEqual([
      ["Court 1", "Sat 09:00"],
      ["Court 2", "Sat 09:00"],
    ]);
    // No court holds two matches at once.
    for (const court of ["Court 1", "Court 2"]) {
      const mine = slots.filter((s) => s.courtName === court).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
      for (let i = 1; i < mine.length; i++) expect(mine[i].startsAt.getTime()).toBeGreaterThanOrEqual(mine[i - 1].endsAt.getTime());
    }
    // A pair rests thirty minutes between its matches.
    const byId = new Map(ms.map((m) => [m.id, m]));
    for (const pair of entrants(8).map((e) => e.id)) {
      const mine = slots.filter((s) => [byId.get(s.id)!.pairA, byId.get(s.id)!.pairB].includes(pair)).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
      for (let i = 1; i < mine.length; i++) expect(mine[i].startsAt.getTime() - mine[i - 1].endsAt.getTime()).toBeGreaterThanOrEqual(30 * 60_000);
    }
    // The semi-finals start after the last group match ends, plus the rest.
    const lastGroupEnd = Math.max(...slots.filter((s) => byId.get(s.id)!.phase === "group").map((s) => s.endsAt.getTime()));
    const semis = slots.filter((s) => byId.get(s.id)!.phase === "main" && byId.get(s.id)!.round === 1);
    expect(semis).toHaveLength(2);
    for (const s of semis) expect(s.startsAt.getTime()).toBeGreaterThanOrEqual(lastGroupEnd + 30 * 60_000);
    // The final, under two sets, is the longest, and starts after both semi-finals plus the rest.
    const final = slots.find((s) => byId.get(s.id)!.phase === "main" && byId.get(s.id)!.round === 2)!;
    expect(final.endsAt.getTime() - final.startsAt.getTime()).toBe(75 * 60_000);
    expect(final.startsAt.getTime()).toBeGreaterThanOrEqual(Math.max(...semis.map((s) => s.endsAt.getTime())) + 30 * 60_000);
  });

  it("rolls into the next day when a window is full, and never puts one player on two courts across categories", () => {
    const gold = matchesOf("gold", planDraw(entrants(8), cfg));
    const mixed = matchesOf("mixed", planDraw(entrants(8).map((e) => ({ ...e, id: e.id.replace("p", "m") })), cfg));
    // Player x plays in p1 (Gold) and m1 (Mixed).
    const playersOf = new Map<string, string[]>([
      ["p1", ["x", "y"]],
      ["m1", ["x", "z"]],
    ]);
    // Thirty-six matches on one court need about twenty-two hours: a short Saturday, a long Sunday, a Monday.
    const { slots } = schedule({ matches: [...gold, ...mixed], courts: ["A"], days: [{ date: "2026-10-10", start: "09:00", end: "13:00" }, { date: "2026-10-11", start: "08:00", end: "22:00" }, { date: "2026-10-12", start: "09:00", end: "21:00" }], tz: TZ, playersOf, rest: 20 });
    expect(slots).toHaveLength(36);
    const days = new Set(slots.map((s) => local(s.startsAt).slice(0, 3)));
    expect(days.has("Sat") && days.has("Sun")).toBe(true);
    // Nothing runs past 13:00 on Saturday.
    for (const s of slots.filter((s) => local(s.startsAt).startsWith("Sat"))) expect(local(s.endsAt) <= "Sat 13:00").toBe(true);
    const byId = new Map([...gold, ...mixed].map((m) => [m.id, m]));
    const xs = slots.filter((s) => ["p1", "m1"].includes(byId.get(s.id)!.pairA ?? "") || ["p1", "m1"].includes(byId.get(s.id)!.pairB ?? "")).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    for (let i = 1; i < xs.length; i++) expect(xs[i].startsAt.getTime() - xs[i - 1].endsAt.getTime()).toBeGreaterThanOrEqual(20 * 60_000);
  });

  it("keeps a fixed slot as a constraint and gives nothing to a bye", () => {
    const ms = matchesOf("k", planDraw(entrants(6), { ...cfg, format: "knockout" }));
    const { slots } = schedule({ matches: ms, courts: ["A", "B"], days: [{ date: "2026-10-10", start: "09:00", end: "21:00" }], tz: TZ });
    expect(slots.map((s) => s.id)).not.toContain(ms.find((m) => m.bye)!.id);
    expect(slots).toHaveLength(ms.filter((m) => !m.bye).length);
    // A match pinned to court A at nine pushes the rest off that slot.
    const pinned = ms.find((m) => !m.bye)!;
    const { slots: withFixed } = schedule({ matches: ms.map((m) => (m.id === pinned.id ? { ...m, fixed: { courtName: "A", startsAt: new Date("2026-10-10T02:00:00Z") } } : m)), courts: ["A", "B"], days: [{ date: "2026-10-10", start: "09:00", end: "21:00" }], tz: TZ });
    expect(withFixed.map((s) => s.id)).not.toContain(pinned.id);
    expect(withFixed.filter((s) => s.courtName === "A" && s.startsAt.getTime() < new Date("2026-10-10T02:40:00Z").getTime())).toEqual([]);
    // No court at all: nothing gets a slot, and every match still to play is counted rather than lost.
    expect(schedule({ matches: ms, courts: [], days: [{ date: "2026-10-10", start: "09:00", end: "21:00" }], tz: TZ })).toEqual({ slots: [], unplaced: ms.filter((m) => !m.bye).length });
  });

  it("counts the matches a short day has no room for, instead of dropping them", () => {
    const ms = matchesOf("gold", planDraw(entrants(8), cfg));
    const byId = new Map(ms.map((m) => [m.id, m]));
    // Two courts from nine to one. The twelve group matches of thirty minutes end at noon; the first
    // semi-final may start at half past twelve after the rest, and forty minutes of it pass one o'clock.
    const { slots, unplaced } = schedule({ matches: ms, courts: ["A", "B"], days: [{ date: "2026-10-10", start: "09:00", end: "13:00" }], tz: TZ, rest: 30 });
    expect(slots).toHaveLength(12);
    // The consolation final would fit at noon, but its semi-finals have no time: it gets none either.
    expect(slots.every((s) => byId.get(s.id)!.phase === "group")).toBe(true);
    // The six knockout matches, main and consolation, are the ones counted.
    expect(unplaced).toBe(6);
    expect(slots.length + unplaced).toBe(ms.filter((m) => !m.bye).length);
  });

  it("starts a match no earlier than its notBefore: the groups on Saturday, the knockout from Sunday morning", () => {
    const ms = matchesOf("gold", planDraw(entrants(8), cfg));
    const sunday = new Date("2026-10-11T02:00:00Z"); // 09:00 in Bangkok
    const knockout = (m: ScheduleMatch) => m.phase === "main" || m.phase === "consolation";
    const days = [
      { date: "2026-10-10", start: "09:00", end: "21:00" },
      { date: "2026-10-11", start: "09:00", end: "21:00" },
    ];
    const withLine = ms.map((m) => (knockout(m) ? { ...m, notBefore: sunday } : m));
    const { slots, unplaced } = schedule({ matches: withLine, courts: ["Court 1", "Court 2"], days, tz: TZ, rest: 30 });
    const byId = new Map(ms.map((m) => [m.id, m]));
    expect(slots).toHaveLength(18);
    expect(unplaced).toBe(0);
    for (const s of slots) expect(local(s.startsAt).slice(0, 3)).toBe(knockout(byId.get(s.id)!) ? "Sun" : "Sat");
    // Both semi-finals open Sunday on the two courts, and the final still follows them with the rest.
    const semis = slots.filter((s) => byId.get(s.id)!.phase === "main" && byId.get(s.id)!.round === 1).map((s) => [s.courtName, local(s.startsAt)]);
    expect(semis).toEqual([
      ["Court 1", "Sun 09:00"],
      ["Court 2", "Sun 09:00"],
    ]);
    const final = slots.find((s) => byId.get(s.id)!.phase === "main" && byId.get(s.id)!.round === 2)!;
    expect(final.startsAt.getTime()).toBeGreaterThanOrEqual(sunday.getTime() + (40 + 30) * 60_000);
    // Without the line, the same weekend puts all eighteen on Saturday: the fault it fixes.
    const plain = schedule({ matches: ms, courts: ["Court 1", "Court 2"], days, tz: TZ, rest: 30 });
    expect(plain.slots.every((s) => local(s.startsAt).startsWith("Sat"))).toBe(true);
  });

  describe("a weekend whose knockout waits for the last day", () => {
    const sunday = new Date("2026-10-11T02:00:00Z"); // 09:00 in Bangkok
    const weekend = { tz: TZ, days: [{ date: "2026-10-10", start: "09:00", end: "21:00" }, { date: "2026-10-11", start: "09:00", end: "21:00" }] };
    const knockout = (m: ScheduleMatch) => m.phase === "main" || m.phase === "consolation";
    const dayOf = (ms: ScheduleMatch[], slots: { id: string; startsAt: Date }[]) => {
      const byId = new Map(ms.map((m) => [m.id, m]));
      return (pick: (m: ScheduleMatch) => boolean) => new Set(slots.filter((s) => pick(byId.get(s.id)!)).map((s) => local(s.startsAt).slice(0, 3)));
    };

    it("fills a knockout-only category from the first day, as it did before the line", () => {
      // The consolation on, two courts. Held for Sunday, thirty-two pairs left Saturday empty and
      // eleven of their forty-six matches found no room; sixteen pairs fitted, all on Sunday, with
      // Saturday empty again (review, 24 September 2026).
      for (const [pairs, played] of [
        [32, 46],
        [16, 22],
      ]) {
        const open = matchesOf("open", planDraw(entrants(pairs), { ...cfg, format: "knockout", maxPairs: pairs }));
        const { slots, unplaced } = scheduleWeekend({ matches: open, courts: ["A", "B"], ...weekend }, sunday);
        expect(unplaced).toBe(0);
        expect(slots).toHaveLength(played);
        expect(dayOf(open, slots)(() => true).has("Sat")).toBe(true);
        expect({ slots, unplaced }).toEqual(schedule({ matches: open, courts: ["A", "B"], ...weekend }));
      }
    });

    it("holds the knockout after groups or a qualifying for Sunday, category by category", () => {
      const gold = matchesOf("gold", planDraw(entrants(8), cfg));
      // Sixteen pairs play for four places in a main draw of eight.
      const silver = matchesOf("silver", planDraw(entrants(16).map((e) => ({ ...e, id: e.id.replace("p", "s") })), { ...cfg, format: "knockout", qualifyingSpots: 4 }));
      const open = matchesOf("open", planDraw(entrants(8).map((e) => ({ ...e, id: e.id.replace("p", "o") })), { ...cfg, format: "knockout" }));
      const all = [...gold, ...silver, ...open];
      const { slots, unplaced } = scheduleWeekend({ matches: all, courts: ["A", "B", "C"], ...weekend }, sunday);
      expect(unplaced).toBe(0);
      const on = dayOf(all, slots);
      expect(on((m) => m.categoryId !== "open" && !knockout(m))).toEqual(new Set(["Sat"]));
      expect(on((m) => m.categoryId !== "open" && knockout(m))).toEqual(new Set(["Sun"]));
      // The knockout-only category beside them has nothing to wait for.
      expect(on((m) => m.categoryId === "open")).toEqual(new Set(["Sat"]));
    });

    it("drops the line when it costs a match: the plain fill wins", () => {
      // Twenty-four pairs play for four places in a main draw of sixteen, on one court. Held for
      // Sunday, five matches of the main draw and the consolation find no room.
      const q = matchesOf("q", planDraw(entrants(24), { ...cfg, format: "knockout", maxPairs: 16, qualifyingSpots: 4 }));
      const held = schedule({ matches: q.map((m) => (knockout(m) ? { ...m, notBefore: sunday } : m)), courts: ["A"], ...weekend });
      expect(held.unplaced).toBe(5);
      const { slots, unplaced } = scheduleWeekend({ matches: q, courts: ["A"], ...weekend }, sunday);
      expect(unplaced).toBe(0);
      expect(slots).toHaveLength(30);
      expect(dayOf(q, slots)(knockout).has("Sat")).toBe(true);
    });
  });
});
