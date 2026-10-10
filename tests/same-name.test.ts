import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { players, slots } from "@/db/schema";
import { createEvent } from "@/lib/domain/events";
import { createGroup, getGroupMember, updateGroup } from "@/lib/domain/groups";
import { restoreByEmail } from "@/lib/domain/identity";
import { claimSameNameRow, foldSameNameRows, mayClaim, sameNameMatches, sameNameRows } from "@/lib/domain/sameName";
import { joinEvent } from "@/lib/domain/slots";
import { linkTelegram } from "@/lib/telegram/identity";
import { freezeClock } from "./helpers/clock";
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
freezeClock(NOW);

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

  // The owner, 10 October 2026, on "Are these yours?" and a group that asks to join (DECIDING rule 30):
  // "Need a shared match first". A merge moves the row's memberships, admin role and all.
  it("a row in a crew that asks to join needs a shared match first: a member's and an admin's place stay with the old row", async () => {
    const org1 = await makePlayer(db, "Org Five", { email: "org5@example.com" });
    const org2 = await makePlayer(db, "Org Six", { email: "org6@example.com" });
    const boss = await makePlayer(db, "Boss", { email: "boss@example.com" });
    const dana = await makePlayer(db, "Dana");
    const asMember = await makePlayer(db, "Dana");
    const asAdmin = await makePlayer(db, "Dana");
    await match(org1, "Rawai Padel Club", 1, dana);
    await match(org2, "Bangkok Padel", 2, asMember);
    await match(org2, "Bangkok Padel", 3, asAdmin);
    const ladies = await createGroup(db, { name: "Ladies crew", creatorPlayerId: boss.id, tz: "Asia/Bangkok", memberIds: [asMember.id] });
    await updateGroup(db, ladies.id, boss.id, { askToJoin: true });
    const level = await createGroup(db, { name: "Level crew", creatorPlayerId: asAdmin.id, tz: "Asia/Bangkok" });
    await updateGroup(db, level.id, asAdmin.id, { askToJoin: true });

    await restoreByEmail(db, "dana@example.com", dana.id);
    const rows = await sameNameRows(db, dana.id);
    expect(rows.map((r) => [r.id, r.shared, r.inAskingGroup]).sort()).toEqual([[asMember.id, false, true], [asAdmin.id, false, true]].sort());
    expect(rows.every((r) => !mayClaim(r))).toBe(true);

    expect(await claimSameNameRow(db, dana.id, asMember.id), "a member's place in an asking crew is not a name's to take").toBe(false);
    expect(await claimSameNameRow(db, dana.id, asAdmin.id), "nor an admin's").toBe(false);
    expect(await exists(asMember.id)).toBe(true);
    expect(await exists(asAdmin.id)).toBe(true);
    expect((await getGroupMember(db, ladies.id, asMember.id))?.role).toBe("member");
    expect((await getGroupMember(db, level.id, asAdmin.id))?.role).toBe("admin");
    expect(await getGroupMember(db, ladies.id, dana.id)).toBeNull();
    expect(await getGroupMember(db, level.id, dana.id)).toBeNull();
    expect(await seatsOf(dana.id)).toBe(1);
  });

  it("with a shared organiser, a row in a crew that asks to join folds as before, at the proof and by claim", async () => {
    const org = await makePlayer(db, "Org Seven", { email: "org7@example.com" });
    const boss = await makePlayer(db, "Boss Two", { email: "boss2@example.com" });
    // At the moment of proof: the automatic fold, unchanged.
    const eli = await makePlayer(db, "Eli");
    const eli2 = await makePlayer(db, "Eli");
    await match(org, "Rawai Padel Club", 1, eli);
    await match(org, "Nai Harn Padel", 2, eli2);
    const crew = await createGroup(db, { name: "Asking crew", creatorPlayerId: boss.id, tz: "Asia/Bangkok", memberIds: [eli2.id] });
    await updateGroup(db, crew.id, boss.id, { askToJoin: true });
    await restoreByEmail(db, "eli@example.com", eli.id);
    expect(await exists(eli2.id)).toBe(false);
    expect((await getGroupMember(db, crew.id, eli.id))?.role).toBe("member");

    // By claim: a row that turns up after the proof, sharing the organiser.
    const fin = await makePlayer(db, "Fin");
    await match(org, "Rawai Padel Club", 1, fin);
    await restoreByEmail(db, "fin@example.com", fin.id);
    const fin2 = await makePlayer(db, "Fin");
    await match(org, "Bangkok Padel", 4, fin2);
    const crew2 = await createGroup(db, { name: "Fin's crew", creatorPlayerId: fin2.id, tz: "Asia/Bangkok" });
    await updateGroup(db, crew2.id, fin2.id, { askToJoin: true });
    const [row] = await sameNameRows(db, fin.id);
    expect(row).toMatchObject({ id: fin2.id, shared: true, inAskingGroup: true });
    expect(mayClaim(row)).toBe(true);
    expect(await claimSameNameRow(db, fin.id, fin2.id)).toBe(true);
    expect(await exists(fin2.id)).toBe(false);
    expect((await getGroupMember(db, crew2.id, fin.id))?.role).toBe("admin");
  });

  it("a crew that does not ask to join behaves exactly as before: the claim folds the row, membership and all", async () => {
    const org1 = await makePlayer(db, "Org Eight", { email: "org8@example.com" });
    const org2 = await makePlayer(db, "Org Nine", { email: "org9@example.com" });
    const gus = await makePlayer(db, "Gus");
    const gus2 = await makePlayer(db, "Gus");
    await match(org1, "Rawai Padel Club", 1, gus);
    await match(org2, "Bangkok Padel", 2, gus2);
    const open = await createGroup(db, { name: "Open crew", creatorPlayerId: org2.id, tz: "Asia/Bangkok", memberIds: [gus2.id] });
    await restoreByEmail(db, "gus@example.com", gus.id);
    const [row] = await sameNameRows(db, gus.id);
    expect(row).toMatchObject({ id: gus2.id, shared: false, inAskingGroup: false });
    expect(await claimSameNameRow(db, gus.id, gus2.id)).toBe(true);
    expect(await exists(gus2.id)).toBe(false);
    expect((await getGroupMember(db, open.id, gus.id))?.role).toBe("member");
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
