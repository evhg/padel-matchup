import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events, players, slots } from "@/db/schema";
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

  // "Need a shared match first" means a match: a shared organiser or a shared club is not one, and a
  // match called off is none. Both doors ask it, the claim and the automatic fold at the proof.
  it("a row in a crew that asks to join does not fold through a shared organiser alone, at the proof or by claim", async () => {
    const org = await makePlayer(db, "Org Seven", { email: "org7@example.com" });
    const boss = await makePlayer(db, "Boss Two", { email: "boss2@example.com" });
    // At the moment of proof: Eli and the other Eli played for the same organiser, never in one match.
    const eli = await makePlayer(db, "Eli");
    const eli2 = await makePlayer(db, "Eli");
    await match(org, "Rawai Padel Club", 1, eli);
    await match(org, "Nai Harn Padel", 2, eli2);
    const crew = await createGroup(db, { name: "Asking crew", creatorPlayerId: boss.id, tz: "Asia/Bangkok", memberIds: [eli2.id] });
    await updateGroup(db, crew.id, boss.id, { askToJoin: true });
    await restoreByEmail(db, "eli@example.com", eli.id);
    expect(await exists(eli2.id), "a shared organiser is not a shared match").toBe(true);
    expect((await getGroupMember(db, crew.id, eli2.id))?.role).toBe("member");
    expect(await getGroupMember(db, crew.id, eli.id)).toBeNull();

    // By claim: the other Fin runs an asking crew and played at the same club as Fin, never with him.
    const fin = await makePlayer(db, "Fin");
    await match(org, "Rawai Padel Club", 1, fin);
    await restoreByEmail(db, "fin@example.com", fin.id);
    const fin2 = await makePlayer(db, "Fin");
    const org2 = await makePlayer(db, "Org Ten", { email: "org10@example.com" });
    await match(org2, "Rawai Padel Club", 4, fin2);
    const crew2 = await createGroup(db, { name: "Fin's crew", creatorPlayerId: fin2.id, tz: "Asia/Bangkok" });
    await updateGroup(db, crew2.id, fin2.id, { askToJoin: true });
    const [row] = await sameNameRows(db, fin.id);
    expect(row).toMatchObject({ id: fin2.id, shared: true, sharedMatch: false, inAskingGroup: true });
    expect(mayClaim(row)).toBe(false);
    expect(await claimSameNameRow(db, fin.id, fin2.id), "a shared club is not a shared match").toBe(false);
    expect(await exists(fin2.id)).toBe(true);
    expect((await getGroupMember(db, crew2.id, fin2.id))?.role).toBe("admin");
    expect(await getGroupMember(db, crew2.id, fin.id)).toBeNull();
  });

  it("a match called off is no shared match: a stranger who made one at the row's club and called it off gets nothing", async () => {
    // The audit's probe of 11 October 2026: the stranger proves an address, makes a match at the club the
    // card named, calls it off, and asks again. The crew's admin row must stay where it is.
    const org = await makePlayer(db, "Org Eleven", { email: "org11@example.com" });
    const hal = await makePlayer(db, "Hal");
    await match(org, "Kross Padel", 1, hal);
    const crew = await createGroup(db, { name: "Hal's crew", creatorPlayerId: hal.id, tz: "Asia/Bangkok" });
    await updateGroup(db, crew.id, hal.id, { askToJoin: true });
    const stranger = await makePlayer(db, "Hal");
    await restoreByEmail(db, "stranger-hal@example.com", stranger.id);
    const made = await match(stranger, "Kross Padel", 5);
    await db.update(events).set({ status: "cancelled" }).where(eq(events.id, made.id));
    const [row] = await sameNameRows(db, stranger.id);
    expect(row).toMatchObject({ id: hal.id, shared: false, sharedMatch: false, inAskingGroup: true });
    expect(await claimSameNameRow(db, stranger.id, hal.id)).toBe(false);
    expect(await foldSameNameRows(db, stranger.id)).toEqual([]);
    expect((await getGroupMember(db, crew.id, hal.id))?.role).toBe("admin");
    expect(await getGroupMember(db, crew.id, stranger.id)).toBeNull();
    // And a match the two were both in, called off, is none either.
    await db.update(events).set({ status: "open" }).where(eq(events.id, made.id));
    await joinEvent(db, { eventId: made.id, playerId: hal.id, now: NOW });
    await db.update(events).set({ status: "cancelled" }).where(eq(events.id, made.id));
    const [again] = await sameNameRows(db, stranger.id);
    expect(again).toMatchObject({ sharedMatch: false });
    expect(await claimSameNameRow(db, stranger.id, hal.id)).toBe(false);
  });

  // "Together" means a seat in one match that is not called off, and a match still to come counts:
  // both matches below start after NOW. The owner has not decided whether it should (review of
  // 11 October 2026: a stranger can take a free seat beside the record).
  it("a row in a crew that asks to join folds once the two sat in one match together, a match still to come included, at the proof and by claim", async () => {
    const org = await makePlayer(db, "Org Twelve", { email: "org12@example.com" });
    const boss = await makePlayer(db, "Boss Three", { email: "boss3@example.com" });
    // At the moment of proof: Ivy's two records sat in one match, from two browsers.
    const ivy = await makePlayer(db, "Ivy");
    const ivy2 = await makePlayer(db, "Ivy");
    await match(org, "Rawai Padel Club", 1, ivy, ivy2);
    const crew = await createGroup(db, { name: "Ivy's asking crew", creatorPlayerId: boss.id, tz: "Asia/Bangkok", memberIds: [ivy2.id] });
    await updateGroup(db, crew.id, boss.id, { askToJoin: true });
    await restoreByEmail(db, "ivy@example.com", ivy.id);
    expect(await exists(ivy2.id)).toBe(false);
    expect((await getGroupMember(db, crew.id, ivy.id))?.role).toBe("member");

    // By claim: the other Jo organised a match Jo sat in, and runs an asking crew.
    const jo = await makePlayer(db, "Jo");
    await restoreByEmail(db, "jo@example.com", jo.id);
    const jo2 = await makePlayer(db, "Jo");
    await match(jo2, "Bangkok Padel", 4, jo);
    const crew2 = await createGroup(db, { name: "Jo's crew", creatorPlayerId: jo2.id, tz: "Asia/Bangkok" });
    await updateGroup(db, crew2.id, jo2.id, { askToJoin: true });
    const [row] = await sameNameRows(db, jo.id);
    expect(row).toMatchObject({ id: jo2.id, sharedMatch: true, inAskingGroup: true });
    expect(mayClaim(row)).toBe(true);
    expect(await claimSameNameRow(db, jo.id, jo2.id)).toBe(true);
    expect(await exists(jo2.id)).toBe(false);
    expect((await getGroupMember(db, crew2.id, jo.id))?.role).toBe("admin");
  });

  it("a place on the waiting list of the same match is not a shared match", async () => {
    const org = await makePlayer(db, "Org Thirteen", { email: "org13@example.com" });
    const kim = await makePlayer(db, "Kim");
    await restoreByEmail(db, "kim@example.com", kim.id);
    const kim2 = await makePlayer(db, "Kim");
    const [p2, p3] = [await makePlayer(db, "Lou"), await makePlayer(db, "Max")];
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: at(2), tz: "Asia/Bangkok", whenFull: "waitlist", venueName: "Bangkok Padel" });
    for (const p of [org, p2, p3, kim2, kim]) await joinEvent(db, { eventId: ev.id, playerId: p.id, now: NOW });
    const crew = await createGroup(db, { name: "Kim's crew", creatorPlayerId: kim2.id, tz: "Asia/Bangkok" });
    await updateGroup(db, crew.id, kim2.id, { askToJoin: true });
    const [row] = await sameNameRows(db, kim.id);
    // Kim waits behind four seats: the two never sat in one match together, although they share it.
    expect(row).toMatchObject({ id: kim2.id, shared: true, sharedMatch: false, inAskingGroup: true });
    expect(await claimSameNameRow(db, kim.id, kim2.id)).toBe(false);
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

  it("folds at a Telegram link too, when the two sat in one match together", async () => {
    const org = await makePlayer(db, "Org Four", { email: "org4@example.com" });
    const cy = await makePlayer(db, "Cy");
    const second = await makePlayer(db, "Cy");
    await match(org, "Rawai Padel Club", 1, cy, second);
    await linkTelegram(db, cy.id, { id: 515151, is_bot: false, first_name: "Cy" });
    expect(await exists(second.id)).toBe(false);
  });
});
