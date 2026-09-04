import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events } from "@/db/schema";
import { buildHistory, mulberry32, rotationLength, scheduleRound } from "@/lib/domain/americano";
import { createEvent } from "@/lib/domain/events";
import { joinEvent } from "@/lib/domain/slots";
import { generateRound, loadRounds, setTournamentSettings } from "@/lib/domain/tournament";
import { createTestDb, HOUR, makePlayer } from "./helpers/db";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

const key = (p: string, q: string) => (p < q ? `${p}|${q}` : `${q}|${p}`);

describe("exact americano rotation", () => {
  it("every pair partners exactly once in n-1 rounds, for every field in fours up to 64", () => {
    for (const n of [4, 8, 12, 16, 20, 32, 64]) {
      const ids = Array.from({ length: n }, (_, i) => `p${i}`);
      const rounds: { matches: { a1: string; a2: string; b1: string; b2: string; sideA: null; sideB: null }[]; resting: string[] }[] = [];
      const partnered = new Map<string, number>();
      for (let r = 0; r < n - 1; r++) {
        const plan = scheduleRound(ids, r, buildHistory(rounds), mulberry32(r + 1));
        expect(plan.matches).toHaveLength(n / 4);
        expect(plan.resting).toEqual([]);
        const seen = new Set<string>();
        for (const m of plan.matches) {
          for (const p of [...m.a, ...m.b]) {
            expect(seen.has(p)).toBe(false);
            seen.add(p);
          }
          for (const [p, q] of [m.a, m.b]) partnered.set(key(p, q), (partnered.get(key(p, q)) ?? 0) + 1);
        }
        rounds.push({ matches: plan.matches.map((m) => ({ a1: m.a[0], a2: m.a[1], b1: m.b[0], b2: m.b[1], sideA: null, sideB: null })), resting: [] });
      }
      expect(partnered.size).toBe((n * (n - 1)) / 2);
      expect([...partnered.values()].every((v) => v === 1)).toBe(true);
    }
    expect(rotationLength(8)).toBe(7);
    expect(rotationLength(6)).toBeNull();
  });

  it("round index wraps: round n has the same partners as round 1", () => {
    const ids = Array.from({ length: 8 }, (_, i) => `p${i}`);
    const h = buildHistory([]);
    const first = scheduleRound(ids, 0, h, mulberry32(1)).matches.flatMap((m) => [key(...m.a), key(...m.b)]).sort();
    const eighth = scheduleRound(ids, 7, h, mulberry32(9)).matches.flatMap((m) => [key(...m.a), key(...m.b)]).sort();
    expect(eighth).toEqual(first);
  });

  it("in the db: 8 players → 7 clean rounds, round 8 replays round 1 exactly, courts can be named", async () => {
    const creator = await makePlayer(db, "Org");
    const ev = await createEvent(db, { creatorPlayerId: creator.id, type: "tournament", capacity: 8, startsAt: new Date(Date.now() - HOUR), tz: "UTC", whenFull: "waitlist" });
    for (let i = 0; i < 8; i++) await joinEvent(db, { eventId: ev.id, playerId: (await makePlayer(db, `R${i}`)).id });
    const partnered = new Set<string>();
    for (let r = 1; r <= 7; r++) {
      const round = await generateRound(db, { eventId: ev.id, actorPlayerId: creator.id });
      expect(round.roundNumber).toBe(r);
      expect(round.matches).toHaveLength(2);
      for (const m of round.matches) for (const k of [key(m.a1, m.a2), key(m.b1, m.b2)]) {
        expect(partnered.has(k)).toBe(false);
        partnered.add(k);
      }
    }
    expect(partnered.size).toBe(28);
    const r8 = await generateRound(db, { eventId: ev.id, actorPlayerId: creator.id });
    const rounds = await loadRounds(db, ev.id);
    const r1 = rounds.find((r) => r.roundNumber === 1)!;
    const sig = (ms: { court: number; a1: string; a2: string; b1: string; b2: string }[]) => ms.map((m) => `${m.court}:${key(m.a1, m.a2)}v${key(m.b1, m.b2)}`).sort();
    expect(sig(r8.matches)).toEqual(sig(r1.matches));

    await setTournamentSettings(db, { eventId: ev.id, actorPlayerId: creator.id, courtNames: [" 5 ", "Centre"] });
    const [fresh] = await db.select().from(events).where(eq(events.id, ev.id));
    expect(fresh.courtNames).toEqual(["5", "Centre"]);
    await expect(setTournamentSettings(db, { eventId: ev.id, actorPlayerId: creator.id, courtNames: Array(17).fill("x") })).rejects.toMatchObject({ code: "invalid" });
    await setTournamentSettings(db, { eventId: ev.id, actorPlayerId: creator.id, courtNames: ["", ""] });
    const [cleared] = await db.select().from(events).where(eq(events.id, ev.id));
    expect(cleared.courtNames).toBeNull();
  });
});
