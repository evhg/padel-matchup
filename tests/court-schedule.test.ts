import { describe, expect, it } from "vitest";
import { playingOrder, schedule, type ScheduleMatch } from "@/lib/domain/courtSchedule";
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
    const slots = schedule({ matches: ms, courts: ["Court 1", "Court 2"], days: [{ date: "2026-10-10", start: "09:00", end: "21:00" }], tz: TZ, rest: 30 });
    // Every match but none of the byes: eighteen, all inside Saturday's window.
    expect(slots).toHaveLength(18);
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
    const slots = schedule({ matches: [...gold, ...mixed], courts: ["A"], days: [{ date: "2026-10-10", start: "09:00", end: "13:00" }, { date: "2026-10-11", start: "08:00", end: "22:00" }, { date: "2026-10-12", start: "09:00", end: "21:00" }], tz: TZ, playersOf, rest: 20 });
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
    const slots = schedule({ matches: ms, courts: ["A", "B"], days: [{ date: "2026-10-10", start: "09:00", end: "21:00" }], tz: TZ });
    expect(slots.map((s) => s.id)).not.toContain(ms.find((m) => m.bye)!.id);
    expect(slots).toHaveLength(ms.filter((m) => !m.bye).length);
    // A match pinned to court A at nine pushes the rest off that slot.
    const pinned = ms.find((m) => !m.bye)!;
    const withFixed = schedule({ matches: ms.map((m) => (m.id === pinned.id ? { ...m, fixed: { courtName: "A", startsAt: new Date("2026-10-10T02:00:00Z") } } : m)), courts: ["A", "B"], days: [{ date: "2026-10-10", start: "09:00", end: "21:00" }], tz: TZ });
    expect(withFixed.map((s) => s.id)).not.toContain(pinned.id);
    expect(withFixed.filter((s) => s.courtName === "A" && s.startsAt.getTime() < new Date("2026-10-10T02:40:00Z").getTime())).toEqual([]);
    expect(schedule({ matches: ms, courts: [], days: [{ date: "2026-10-10", start: "09:00", end: "21:00" }], tz: TZ })).toEqual([]);
  });
});
