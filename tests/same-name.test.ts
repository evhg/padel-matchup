import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { players, slots } from "@/db/schema";
import { createEvent } from "@/lib/domain/events";
import { restoreByEmail } from "@/lib/domain/identity";
import { claimSameNameRow, foldSameNameRows, sameNameMatches, sameNameRows } from "@/lib/domain/sameName";
import { joinEvent } from "@/lib/domain/slots";
import { linkTelegram } from "@/lib/telegram/identity";
import { createTestDb, DAY, makePlayer } from "./helpers/db";

/**
 * The owner, 24 September 2026: "When users have matches and the names are the same or very similar,
 * we may need a merge feature. To merge a user which has no contact, but does have matches, the
 * duplicate name user with a contact can auto merge it." Chosen with a guard (option A): automatically
 * at the moment of proof, only when the row nobody can reach shares a match, an organiser or a club
 * with the person proving; otherwise the person decides on My matches. A row that can be reached is
 * never merged by name.
 */
// A fixed clock (rule 11): matches a day or two after NOW, joins made at NOW.
const NOW = new Date(Date.UTC(2026, 8, 24, 4, 0));
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

describe("the same name, one side proved", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  const match = async (organiser: { id: string }, venueName: string, days: number, ...seated: { id: string }[]) => {
    const ev = await createEvent(db, { creatorPlayerId: organiser.id, type: "match", startsAt: at(days), tz: "Asia/Bangkok", whenFull: "closed", venueName });
    for (const p of seated) await joinEvent(db, { eventId: ev.id, playerId: p.id, now: NOW });
    return ev;
  };
  const seatsOf = async (id: string) => (await db.select().from(slots).where(eq(slots.playerId, id))).length;
  const exists = async (id: string) => (await db.select({ id: players.id }).from(players).where(eq(players.id, id))).length === 1;

  it("folds a row of the same name when its owner proves an address, if the two share an organiser", async () => {
    const org = await makePlayer(db, "Micky", { email: "micky@example.com" });
    const nacho = await makePlayer(db, "Nacho Garcia");
    // The same person in an in-app browser, typed with a double space and no capitals.
    const second = await makePlayer(db, "nacho  garcia");
    await match(org, "Rawai Padel Club", 1, nacho);
    await match(org, "Nai Harn Padel", 2, second);
    await restoreByEmail(db, "nacho@example.com", nacho.id);
    expect(await exists(second.id)).toBe(false);
    expect(await seatsOf(nacho.id)).toBe(2);
  });

  it("does not fold a stranger's row without a shared match, organiser or club, and lets the person decide", async () => {
    const org1 = await makePlayer(db, "Org One", { email: "org1@example.com" });
    const org2 = await makePlayer(db, "Org Two", { email: "org2@example.com" });
    const alex = await makePlayer(db, "Alex");
    const other = await makePlayer(db, "Alex");
    await match(org1, "Rawai Padel Club", 1, alex);
    await match(org2, "Bangkok Padel", 2, other);
    await restoreByEmail(db, "alex@example.com", alex.id);
    expect(await exists(other.id), "no shared context: not folded").toBe(true);

    const rows = await sameNameRows(db, alex.id);
    expect(rows.map((r) => [r.id, r.shared, r.matches])).toEqual([[other.id, false, 1]]);
    // What the person sees before deciding: the day, the club, who else played.
    const shown = (await sameNameMatches(db, [other.id])).get(other.id) ?? [];
    expect(shown.map((m) => m.venue)).toEqual(["Bangkok Padel"]);

    expect(await claimSameNameRow(db, alex.id, other.id)).toBe(true);
    expect(await exists(other.id)).toBe(false);
    expect(await seatsOf(alex.id)).toBe(2);
  });

  it("never merges a row that can be reached, never on a proof that is not one, never a deleted account", async () => {
    const org = await makePlayer(db, "Org Three", { email: "org3@example.com" });
    const bo = await makePlayer(db, "Bo");
    const reachable = await makePlayer(db, "Bo", { email: "another-bo@example.com" });
    const pushed = await makePlayer(db, "Bo", { phone: "+66800000001" });
    await match(org, "Rawai Padel Club", 1, bo, reachable, pushed);
    // Not proved yet: a name and a cookie are not proof of anything.
    expect(await foldSameNameRows(db, bo.id)).toEqual([]);
    const unrelated = await makePlayer(db, "Bo");
    await match(org, "Rawai Padel Club", 2, unrelated);
    expect(await claimSameNameRow(db, bo.id, unrelated.id), "an unproved person cannot claim").toBe(false);
    expect(await exists(unrelated.id)).toBe(true);

    await restoreByEmail(db, "bo@example.com", bo.id);
    // The row that shared the organiser went; the two that can be reached stayed.
    expect(await exists(unrelated.id)).toBe(false);
    expect(await exists(reachable.id)).toBe(true);
    expect(await exists(pushed.id)).toBe(true);

    const gone = await makePlayer(db, "Deleted player");
    const me = await makePlayer(db, "Deleted player", { email: "odd@example.com", emailVerifiedAt: NOW });
    await match(org, "Rawai Padel Club", 3, gone, me);
    expect(await sameNameRows(db, me.id)).toEqual([]);
  });

  it("folds at a Telegram link too, when the two played together", async () => {
    const org = await makePlayer(db, "Org Four", { email: "org4@example.com" });
    const cy = await makePlayer(db, "Cy");
    const second = await makePlayer(db, "Cy");
    await match(org, "Rawai Padel Club", 1, cy, second);
    await linkTelegram(db, cy.id, { id: 515151, is_bot: false, first_name: "Cy" });
    expect(await exists(second.id)).toBe(false);
  });
});
