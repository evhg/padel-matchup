import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { competitionPairs, players } from "@/db/schema";
import {
  addCategory,
  claimPartnerSpot,
  competitionPage,
  createCompetition,
  enterPair,
  entriesOf,
  listOpenCompetitions,
  pairByClaimToken,
  removeCategory,
  setCompetitionStatus,
  setPairPaid,
  withdrawEntriesOf,
  withdrawPair,
} from "@/lib/domain/competitions";
import { DomainError } from "@/lib/domain/errors";
import { freezeClock } from "./helpers/clock";
import { createTestDb, makePlayer } from "./helpers/db";

/** Tuesday 8 September 2026, 16:00 in Phuket; the competition is a month out. */
freezeClock(new Date("2026-09-08T09:00:00Z"));

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof DomainError ? `${e.code}:${e.message === e.code ? "" : e.message}` : String(e);
  }
};

describe("the serious tournament: entries and categories", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await createTestDb()));
  afterAll(() => close());

  it("takes a competition with categories, pairs by name, a waiting list, a claim and a withdrawal", async () => {
    const org = await makePlayer(db, "Org");
    const c = await createCompetition(db, { organizerPlayerId: org.id, name: "Phuket Open", tz: "Asia/Bangkok", startsOn: "2026-10-10", endsOn: "2026-10-11", venueName: "Rawai Padel", entryNote: "1,500 THB per pair, PromptPay 081-234-5678" });
    expect(c.slug).toBe("phuket-open");
    expect(c.status).toBe("open");
    expect((await createCompetition(db, { organizerPlayerId: org.id, name: "Phuket Open", tz: "Asia/Bangkok", startsOn: "2026-11-10" })).slug).toBe("phuket-open-2");
    expect(await code(createCompetition(db, { organizerPlayerId: org.id, name: "X", tz: "Asia/Bangkok", startsOn: "2026-10-10" }))).toBe("invalid:name");
    expect(await code(createCompetition(db, { organizerPlayerId: org.id, name: "Ends first", tz: "Asia/Bangkok", startsOn: "2026-10-10", endsOn: "2026-10-09" }))).toBe("invalid:endsOn");

    const gold = await addCategory(db, { competitionId: c.id, organizerPlayerId: org.id, name: "Gold 4.0+", levelMin: 4, maxPairs: 4 });
    const mixed = await addCategory(db, { competitionId: c.id, organizerPlayerId: org.id, name: "Mixed", maxPairs: 16 });
    const senior = await addCategory(db, { competitionId: c.id, organizerPlayerId: org.id, name: "Senior 45+" });
    expect([gold.position, mixed.position, senior.position]).toEqual([0, 1, 2]);
    expect(senior.maxPairs).toBe(16);
    expect(await code(addCategory(db, { competitionId: c.id, organizerPlayerId: (await makePlayer(db, "Stranger")).id, name: "Pro" }))).toBe("forbidden:organizer");

    // Ana enters Gold with Boris, who has no account yet: a placeholder with a claim token.
    const ana = await makePlayer(db, "Ana", { level: 4.5 });
    const first = await enterPair(db, { categoryId: gold.id, playerId: ana.id, partner: { name: "  Boris " }, locale: "en" });
    expect(first.pair.status).toBe("entered");
    expect(first.pair.position).toBe(1);
    expect(first.partner.displayName).toBe("Boris");
    expect(first.claimToken).toMatch(/^[a-z2-9]{12}$/);
    expect(first.pair.claimToken).toBe(first.claimToken);
    // The same partner again in Mixed is the same placeholder, not a second Boris.
    const second = await enterPair(db, { categoryId: mixed.id, playerId: ana.id, partner: { name: "boris" }, locale: "en" });
    expect(second.partner.id).toBe(first.partner.id);
    expect(second.claimToken).toMatch(/^[a-z2-9]{12}$/);
    expect(second.claimToken).not.toBe(first.claimToken);
    // Once per category, two categories per competition — for the partner too.
    expect(await code(enterPair(db, { categoryId: gold.id, playerId: ana.id, partner: { name: "Carl" }, locale: "en" }))).toBe("already_in:you");
    expect(await code(enterPair(db, { categoryId: senior.id, playerId: ana.id, partner: { name: "Carl" }, locale: "en" }))).toBe("too_many:you");
    const carl = await makePlayer(db, "Carl");
    expect(await code(enterPair(db, { categoryId: senior.id, playerId: carl.id, partner: { playerId: first.partner.id }, locale: "en" }))).toBe("too_many:partner");
    expect(await code(enterPair(db, { categoryId: senior.id, playerId: carl.id, partner: { playerId: carl.id }, locale: "en" }))).toBe("invalid:same_player");
    // A declared level outside the band is refused, unless the organiser enters the pair at the desk.
    const dan = await makePlayer(db, "Dan", { level: 3 });
    expect(await code(enterPair(db, { categoryId: gold.id, playerId: dan.id, partner: { name: "Eli" }, locale: "en" }))).toBe("invalid:level");
    const desk = await enterPair(db, { categoryId: gold.id, playerId: dan.id, partner: { name: "Eli" }, locale: "en", byOrganizer: true });
    expect(desk.pair.status).toBe("entered");

    // Gold holds four pairs; the fifth waits.
    for (const n of ["Fil", "Gus"]) {
      const p = await makePlayer(db, n, { level: 4 });
      expect((await enterPair(db, { categoryId: gold.id, playerId: p.id, partner: { name: `${n} partner` }, locale: "en" })).pair.status).toBe("entered");
    }
    const hal = await makePlayer(db, "Hal", { level: 5 });
    const waiting = await enterPair(db, { categoryId: gold.id, playerId: hal.id, partner: { name: "Ivo" }, locale: "en" });
    expect(waiting.pair.status).toBe("waiting");
    expect(waiting.pair.position).toBe(5);

    let page = await competitionPage(db, c);
    expect(page.organizerName).toBe("Org");
    expect(page.pairs).toBe(6);
    expect(page.categories.map((k) => [k.category.name, k.entered.length, k.waiting.length])).toEqual([
      ["Gold 4.0+", 4, 1],
      ["Mixed", 1, 0],
      ["Senior 45+", 0, 0],
    ]);
    expect(page.categories[0].entered[0]).toMatchObject({ p1: { name: "Ana" }, p2: { name: "Boris" }, claimed: false, paid: false });

    // Dan withdraws: Hal and Ivo move up.
    const w = await withdrawPair(db, { pairId: desk.pair.id, actorPlayerId: dan.id });
    expect(w.pair.status).toBe("withdrawn");
    expect(w.movedUp?.id).toBe(waiting.pair.id);
    expect(w.movedUp?.status).toBe("entered");
    expect(await code(withdrawPair(db, { pairId: first.pair.id, actorPlayerId: carl.id }))).toBe("forbidden:");
    // Withdrawing again changes nothing and frees nobody.
    expect((await withdrawPair(db, { pairId: desk.pair.id, actorPlayerId: org.id })).movedUp).toBeNull();

    // Boris opens his claim link signed in as himself: both pairs are his now, the placeholder is gone.
    const boris = await makePlayer(db, "Boris R", { email: "boris@example.com" });
    const seen = await pairByClaimToken(db, first.claimToken!);
    expect(seen).toMatchObject({ p1Name: "Ana", p2Name: "Boris", categoryName: "Gold 4.0+" });
    expect(await code(claimPartnerSpot(db, { token: first.claimToken!, playerId: ana.id }))).toBe("invalid:own_pair");
    const claimed = await claimPartnerSpot(db, { token: first.claimToken!, playerId: boris.id });
    expect(claimed.p2PlayerId).toBe(boris.id);
    expect(claimed.claimToken).toBeNull();
    const borisPairs = await entriesOf(db, c.id, boris.id);
    expect(borisPairs.map((p) => p.categoryId).sort()).toEqual([gold.id, mixed.id].sort());
    expect(await db.select().from(players).where(eq(players.id, first.partner.id))).toEqual([]);
    expect(await code(claimPartnerSpot(db, { token: first.claimToken!, playerId: boris.id }))).toBe("not_found:token");
    // The Mixed pair kept its own token; Boris spends it too, harmlessly.
    expect((await claimPartnerSpot(db, { token: second.claimToken!, playerId: boris.id })).claimToken).toBeNull();
    expect(await pairByClaimToken(db, second.claimToken!)).toBeNull();
    page = await competitionPage(db, c);
    expect(page.categories[0].entered[0]).toMatchObject({ p2: { id: boris.id, name: "Boris R" }, claimed: true });

    // Paid is the organiser's mark and nobody else's.
    expect(await code(setPairPaid(db, { pairId: first.pair.id, organizerPlayerId: ana.id, paid: true }))).toBe("forbidden:organizer");
    expect((await setPairPaid(db, { pairId: first.pair.id, organizerPlayerId: org.id, paid: true })).paid).toBe(true);

    // A category with pairs in it stays; an empty one goes.
    expect(await code(removeCategory(db, { categoryId: gold.id, organizerPlayerId: org.id }))).toBe("invalid:has_pairs");
    await removeCategory(db, { categoryId: senior.id, organizerPlayerId: org.id });
    expect((await competitionPage(db, c)).categories).toHaveLength(2);

    // Closed takes no entries from players; the desk still can.
    await setCompetitionStatus(db, { id: c.id, organizerPlayerId: org.id, status: "closed" });
    const jay = await makePlayer(db, "Jay");
    expect(await code(enterPair(db, { categoryId: mixed.id, playerId: jay.id, partner: { name: "Kim" }, locale: "en" }))).toBe("closed:");
    expect((await enterPair(db, { categoryId: mixed.id, playerId: jay.id, partner: { name: "Kim" }, locale: "en", byOrganizer: true })).pair.status).toBe("entered");
    expect((await listOpenCompetitions(db, "2026-10-11")).map((x) => x.slug)).toEqual(["phuket-open-2"]);
    await setCompetitionStatus(db, { id: c.id, organizerPlayerId: org.id, status: "open" });
    expect((await listOpenCompetitions(db, "2026-10-11")).map((x) => x.slug)).toEqual(["phuket-open", "phuket-open-2"]);
    expect((await listOpenCompetitions(db, "2026-10-12")).map((x) => x.slug)).toEqual(["phuket-open-2"]);

    // An account going takes its entries with it.
    const gone = await withdrawEntriesOf(db, ana.id);
    expect(gone).toHaveLength(2);
    expect(await entriesOf(db, c.id, ana.id)).toEqual([]);
    expect((await db.select().from(competitionPairs).where(eq(competitionPairs.p1PlayerId, ana.id))).every((p) => p.status === "withdrawn")).toBe(true);
  });
});
