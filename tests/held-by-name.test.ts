import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { events, groupMembers, groups, metricsDaily, notices, slots, type Player } from "@/db/schema";
import { createEvent } from "@/lib/domain/events";
import { decideHeldByName, heldNameFor, heldOffers, heldSeatsOf, heldVerdict, inviteView, takeHeldByName, whoJoins, type HeldMatch, type HeldRefusal, type HeldSeat, type InviteState, type InviteView } from "@/lib/domain/heldByName";
import { joinWithPolicy } from "@/lib/domain/joining";
import { LIMITS } from "@/lib/domain/ratelimit";
import { getEventByCode, holdsPlaceIn } from "@/lib/domain/queries";
import { confirmInvite, joinEvent, mayUseHeldLink, reserveNames, reserveSlot } from "@/lib/domain/slots";
import { joinPair } from "@/lib/domain/pairSeats";
import { afterConfirm, afterRelease } from "@/lib/aftermath";
import { freezeClock } from "./helpers/clock";
import { createTestDb, DAY, HOUR, makePlayer } from "./helpers/db";

/**
 * The owner, 11 October 2026: "Yes, two taps (Recommended)". A held place with no email and no phone
 * ("Danny") can be taken on the plain match link by typing the name (never from its row): the first tap
 * asks, the second confirms, and the organiser hears "Danny confirmed" (DECIDING rule 34, extended). And
 * the three invite fixes the trace found beside it.
 */

// A fixed clock (rule 11): every match starts a day or more after NOW.
const NOW = new Date(Date.UTC(2026, 9, 11, 4, 0));
const at = (days: number) => new Date(NOW.getTime() + days * DAY);
freezeClock(NOW);

// ------------------------------------------------------------------ the rule, as a table

const ORG = "00000000-0000-4000-8000-0000000000aa";
const live: HeldMatch = { status: "open", startsAt: at(1), durationMinutes: 90, fixedPairs: false, creatorPlayerId: ORG };
const seat = (o: Partial<HeldSeat>): HeldSeat => ({ id: "s0", kind: "open", status: "joined", playerId: null, invitedName: null, invitedEmail: null, invitedPhone: null, position: 1, playerName: null, ...o });
const organiser = seat({ id: "s1", playerId: ORG, playerName: "Org", position: 1 });
const danny = seat({ id: "s2", kind: "reserved", status: "invited", invitedName: "Danny", position: 2 });
const empty = seat({ id: "s3", status: "empty", position: 3 });

/** Each limit alone: the line-up is the owner's case in every other way, so the change named is the only thing that refuses it. */
const LIMIT_TABLE: [string, { m?: Partial<HeldMatch>; seats?: HeldSeat[]; name?: string; viewer?: { id: string; name: string } | null; now?: Date }, HeldRefusal | null][] = [
  ["the owner's case: a held Danny, typed as \"danny\" in a browser that knows nobody", {}, null],
  ["a browser whose record is called Danny and holds no place here", { viewer: { id: "v1", name: " DANNY " } }, null],
  ["a cancelled match", { m: { status: "cancelled" } }, "cancelled"],
  ["a finished match", { m: { status: "past" } }, "past"],
  ["a match whose own length has run out", { now: new Date(at(1).getTime() + 2 * HOUR) }, "past"],
  ["a fixed-pairs night, where the player who named a partner holds that link", { m: { fixedPairs: true } }, "fixed_pairs"],
  ["a name nobody holds a place for", { name: "Dan" }, "nobody"],
  ["two held places of that name", { seats: [organiser, danny, seat({ ...danny, id: "s4", invitedName: "danny", position: 3 })] }, "namesake"],
  ["a held place with an email", { seats: [organiser, { ...danny, invitedEmail: "danny@example.com" }, empty] }, "email"],
  ["a held place with a phone", { seats: [organiser, { ...danny, invitedPhone: "+66810000000" }, empty] }, "phone"],
  ["a held place a tournament gave a placeholder record", { seats: [organiser, { ...danny, playerId: "p9", playerName: "Danny" }, empty] }, "placeholder"],
  ["an invited row that is not a reserved place", { seats: [organiser, { ...danny, kind: "open" }, empty] }, "not_held"],
  ["a record of that name seated in the match", { seats: [organiser, danny, seat({ id: "s3", playerId: "p3", playerName: "Danny", position: 3 })] }, "seated_namesake"],
  ["a record of that name on the waiting list", { seats: [organiser, danny, empty, seat({ id: "s5", playerId: "p5", playerName: "danny", position: 5 })] }, "seated_namesake"],
  ["the organiser's own browser", { viewer: { id: ORG, name: "Danny" } }, "organiser"],
  // Only the organiser guard stands here: the organiser holds no place, so "already_in" cannot refuse.
  ["the organiser's own browser, with no place in the match", { seats: [danny, empty], viewer: { id: ORG, name: "Danny" } }, "organiser"],
  ["a browser whose Danny holds a place here already", { seats: [organiser, danny, seat({ id: "s3", playerId: "v1", playerName: "Daniel", position: 3 })], viewer: { id: "v1", name: "Danny" } }, "already_in"],
  ["a browser that knows Ana", { viewer: { id: "v2", name: "Ana" } }, "other_name"],
];

describe("who may take a held place by name", () => {
  it.each(LIMIT_TABLE)("%s", (_label, c, reason) => {
    const v = heldVerdict({ ...live, ...c.m }, c.seats ?? [organiser, danny, empty], c.name ?? "danny", c.viewer ?? null, c.now ?? NOW);
    expect(v).toEqual(reason === null ? { ok: true, slotId: "s2", name: "Danny" } : { ok: false, reason });
  });

  // The audit of 11 October 2026: on a full match a typed "Alberto" joined the waiting list as a second
  // Alberto, and the held place could then never be taken by name. A known browser's one-tap Join did
  // the same. The web's join now asks first, over the rows it read, and refuses such a join.
  it("names the held place a plain join would strand: a typed name, or a known browser's own name, on a full match too", () => {
    const full = [organiser, danny, seat({ id: "s3", playerId: "p3", playerName: "Jakob", position: 3 }), seat({ id: "s4", playerId: "p4", playerName: "Erik", position: 4 })];
    expect(heldNameFor(live, full, null, " danny ", NOW)).toBe("Danny");
    expect(heldNameFor(live, full, { id: "v1", name: "DANNY" }, undefined, NOW)).toBe("Danny");
    // Whatever such a browser types, its record's name is what joins.
    expect(heldNameFor(live, full, { id: "v1", name: "Danny" }, "Bo", NOW)).toBe("Danny");
    // Every limit of the rule still holds: another name, a place with an address, a Danny in the match, the organiser.
    expect(heldNameFor(live, full, null, "Dana", NOW)).toBeNull();
    expect(heldNameFor(live, full, { id: "v2", name: "Ana" }, undefined, NOW)).toBeNull();
    expect(heldNameFor(live, [organiser, { ...danny, invitedEmail: "danny@example.com" }], null, "Danny", NOW)).toBeNull();
    expect(heldNameFor(live, [...full, seat({ id: "s5", playerId: "p5", playerName: "Danny", position: 5 })], null, "Danny", NOW)).toBeNull();
    expect(heldNameFor(live, full, { id: ORG, name: "Danny" }, undefined, NOW)).toBeNull();
    expect(heldNameFor({ ...live, fixedPairs: true }, full, null, "Danny", NOW)).toBeNull();
  });

  it("offers on the page exactly the held rows the tap allows, and none to a browser that knows another name", () => {
    const bo = seat({ id: "s4", kind: "reserved", status: "invited", invitedName: "Bo", invitedEmail: "bo@example.com", position: 4 });
    expect(heldOffers(live, [organiser, danny, empty, bo], null, NOW)).toEqual([{ slotId: "s2", name: "Danny" }]);
    expect(heldOffers(live, [organiser, danny, empty, bo], { id: "v2", name: "Ana" }, NOW)).toEqual([]);
    expect(heldOffers({ ...live, status: "cancelled" }, [organiser, danny], null, NOW)).toEqual([]);
  });
});

// ------------------------------------------------------------------ the personal link's page

/** What the page shows: the place's state, whether the viewer's record is in the match, and whether `mayUseHeldLink` said yes. */
const VIEW_TABLE: [string, InviteState, boolean, boolean, InviteView][] = [
  ["a stranger on a held place", "invited", false, true, "actions"],
  ["the person it is held for, in by another door", "invited", true, true, "actions"],
  ["anybody else in the match, on a held place", "invited", true, false, "held_for"],
  ["a stranger on a declined place", "declined", false, true, "declined"],
  ["the person who declined, in by another door", "declined", true, true, "declined"],
  // The place is open, as the line-up says ("Bo declined · open"): never "This place is held for Bo".
  ["anybody else in the match, on a declined place", "declined", true, false, "open_again"],
  ["a viewer in the match on a link whose place is gone", "gone", true, true, "already_in"],
  ["a stranger on a link whose place is gone", "gone", false, true, "gone"],
  ["the record the place is confirmed for", "confirmed_mine", true, true, "confirmed"],
  ["a cancelled match", "cancelled", true, false, "cancelled"],
];

describe("what the personal link's page shows", () => {
  it.each(VIEW_TABLE)("%s", (_label, state, inMatch, theirs, view) => {
    expect(inviteView(state, inMatch, theirs)).toBe(view);
  });
});

// ------------------------------------------------------------------ against the database

describe("the held place by name on a real match", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  let n = 0;
  const key = () => `ip-held-${++n}`;
  /** A match whose organiser can be reached and sits in it, with the names given held by `reserveNames`, as "Paste the names" holds them. */
  const match = async (held: string[] = ["Danny"], o: { fixedPairs?: boolean; groupId?: string; type?: "match" | "tournament" } = {}) => {
    const org = await makePlayer(db, `Organiser ${++n}`, { email: `org${n}@example.com` });
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: o.type ?? "match", startsAt: at(1), tz: "Asia/Bangkok", whenFull: "waitlist", venueName: "Rawai Padel", ...(o.fixedPairs ? { fixedPairs: true, capacity: 8 } : {}) });
    if (o.groupId) await db.update(events).set({ groupId: o.groupId }).where(eq(events.id, ev.id));
    await joinEvent(db, { eventId: ev.id, playerId: org.id, now: NOW });
    if (held.length) await reserveNames(db, { eventId: ev.id, actorPlayerId: org.id, names: held, now: NOW });
    return { ev: { ...ev, groupId: o.groupId ?? null }, org };
  };
  const heldRow = async (eventId: string, name: string) => (await db.select().from(slots).where(and(eq(slots.eventId, eventId), eq(slots.invitedName, name))))[0];
  /** What the action does after a yes, for a browser that knows nobody: an ordinary record carrying the held name, then the take. */
  const tapTwice = async (code: string, typed: string, rateKey = key()) => {
    const d = await decideHeldByName(db, { code, name: typed, viewer: null, rateKey, now: NOW });
    if (!d.ok) return d;
    const fresh = await makePlayer(db, d.name);
    return { ...(await takeHeldByName(db, d, { id: fresh.id, name: fresh.displayName }, NOW)), fresh };
  };
  const metric = async (k: string) => Number((await db.select().from(metricsDaily).where(eq(metricsDaily.key, k)))[0]?.value ?? 0);

  it("the owner's case: a held Danny, \"danny\" typed on the plain link, the same place confirmed, one Danny, and the organiser hears \"Danny confirmed\"", async () => {
    const { ev, org } = await match(["Danny"]);
    const place = await heldRow(ev.id, "Danny");
    const res = await tapTwice(ev.code, " danny ");
    expect(res.ok).toBe(true);
    if (!res.ok || !("fresh" in res)) throw new Error("refused");
    // The personal link's own write: the same row, the record on it, confirmed at the moment of the tap.
    const [after] = await db.select().from(slots).where(eq(slots.id, place.id));
    expect(after).toMatchObject({ playerId: res.fresh.id, status: "confirmed", kind: "reserved", inviteCode: place.inviteCode, position: place.position });
    expect(after.joinedAt?.getTime()).toBe(NOW.getTime());
    // One Danny in the match, never a second row on an empty seat; the open seats stay open.
    const names = (await heldSeatsOf(db, ev.id)).map((s) => s.playerName ?? (s.status === "empty" ? "(open)" : s.invitedName));
    expect(names.filter((x) => x && /^danny$/i.test(x))).toEqual(["Danny"]);
    expect(names.filter((x) => x === "(open)")).toHaveLength(2);
    // The organiser's feed: exactly the line the personal link gives.
    await afterConfirm(db, res, res.fresh, { wasComplete: res.wasComplete });
    const [line] = await db.select().from(notices).where(and(eq(notices.playerId, org.id), eq(notices.key, "noticeItem.organizerFeed")));
    expect(line?.params).toMatchObject({ what: "confirmed", name: "Danny" });
  });

  it("on a full match, the typed held name takes its place, and nobody lands on the waiting list", async () => {
    // TDsv as production held it on 11 October 2026: the organiser and three names, every place taken.
    const { ev } = await match(["Alberto", "Bo", "Cy"]);
    const [row] = await db.select({ status: events.status }).from(events).where(eq(events.id, ev.id));
    expect(row.status).toBe("full");
    const seats = await heldSeatsOf(db, ev.id);
    expect(heldNameFor(ev, seats, null, "alberto", NOW)).toBe("Alberto");
    expect(heldOffers(ev, seats, null, NOW).map((o) => o.name).sort()).toEqual(["Alberto", "Bo", "Cy"]);
    const res = await tapTwice(ev.code, "alberto");
    expect(res.ok).toBe(true);
    const after = await heldSeatsOf(db, ev.id);
    expect(after.filter((s) => s.position > ev.capacity && s.status !== "empty")).toEqual([]);
    expect(after.filter((s) => s.playerName === "Alberto").map((s) => s.status)).toEqual(["confirmed"]);
  });

  // Review of 11 October 2026: nothing proved the web join's own refusal. The checks stopped at the
  // page's guards, which never send the join, so a stale page or a direct call of the action was
  // covered by nothing. `joinAction` asks `whoJoins` before it makes a record or seats anybody; this
  // drives that step as the action does, then the join itself, on a full match.
  it("refuses the web's plain join of a held name on a full match, typed or known, and puts nobody on the waiting list", async () => {
    const { ev } = await match(["Danny", "Bo", "Cy"]);
    let made = 0;
    /** `joinAction` after `loadEvent`: who joins (`whoJoins`), then the join (`joinWithPolicy`). */
    const webJoin = async (known: Player | null, typed: string | undefined) => {
      const detail = (await getEventByCode(db, ev.code))!;
      const who = await whoJoins(detail, known, typed, NOW, async () => {
        made += 1;
        return makePlayer(db, typed ?? "");
      });
      if ("held" in who) return { refused: who.held };
      const d = await joinWithPolicy(db, detail, who.player, who.player.level);
      return { outcome: d.kind === "joined" ? d.result.outcome : d.kind };
    };
    const waiting = async () => (await heldSeatsOf(db, ev.id)).filter((s) => s.position > ev.capacity && s.status !== "empty").map((s) => s.playerName);
    // A browser that knows nobody types "danny"; a browser that knows a Danny with no place taps Join.
    expect(await webJoin(null, " danny ")).toEqual({ refused: "Danny" });
    const knownDanny = await makePlayer(db, "Danny");
    expect(await webJoin(knownDanny, undefined)).toEqual({ refused: "Danny" });
    // Whatever that browser types, its own record's name is what would join.
    expect(await webJoin(knownDanny, "Daniel")).toEqual({ refused: "Danny" });
    expect(made).toBe(0);
    expect(await waiting()).toEqual([]);
    // The same step lets any other name through to the waiting list, so the refusal above is the only
    // thing that kept Danny off it.
    expect(await webJoin(null, "Eve")).toEqual({ outcome: "waitlisted" });
    expect(made).toBe(1);
    expect(await waiting()).toEqual(["Eve"]);
  });

  it("the page offers the same place, from the rows it already read, and nothing once it is taken", async () => {
    const { ev } = await match(["Danny"]);
    const seats = await heldSeatsOf(db, ev.id);
    const place = await heldRow(ev.id, "Danny");
    expect(heldOffers(ev, seats, null, NOW)).toEqual([{ slotId: place.id, name: "Danny" }]);
    expect((await tapTwice(ev.code, "Danny")).ok).toBe(true);
    expect(heldOffers(ev, await heldSeatsOf(db, ev.id), null, NOW)).toEqual([]);
  });

  it("takes the place into a record of the same name this browser already knows, and makes no new one", async () => {
    const { ev } = await match(["Danny"]);
    const mine = await makePlayer(db, "danny");
    const d = await decideHeldByName(db, { code: ev.code, name: "Danny", viewer: { id: mine.id, name: mine.displayName }, rateKey: key(), now: NOW });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    const res = await takeHeldByName(db, d, { id: mine.id, name: mine.displayName }, NOW);
    expect(res.ok && res.slot.playerId).toBe(mine.id);
  });

  /** One held Danny set up by `setUp`, refused on the server for `reason`, and the place still held. */
  const refused = async (reason: HeldRefusal | "too_many", setUp: (m: Awaited<ReturnType<typeof match>>) => Promise<{ viewer?: { id: string; name: string } }> | Promise<void>, held = ["Danny"]) => {
    const m = await match(held);
    const extra = (await setUp(m)) ?? {};
    const res = await decideHeldByName(db, { code: m.ev.code, name: "danny", viewer: extra.viewer ?? null, rateKey: key(), now: NOW });
    expect(res).toEqual({ ok: false, reason });
    const rows = await db.select().from(slots).where(and(eq(slots.eventId, m.ev.id), eq(slots.status, "invited")));
    expect(rows.every((r) => r.playerId === null)).toBe(true);
    return m;
  };

  it("never takes a place held for an email or a phone", async () => {
    const withEmail = await match([]);
    await reserveSlot(db, { eventId: withEmail.ev.id, actorPlayerId: withEmail.org.id, name: "Danny", email: "danny@example.com", now: NOW });
    expect(await decideHeldByName(db, { code: withEmail.ev.code, name: "danny", viewer: null, rateKey: key(), now: NOW })).toEqual({ ok: false, reason: "email" });
    const withPhone = await match([]);
    await reserveSlot(db, { eventId: withPhone.ev.id, actorPlayerId: withPhone.org.id, name: "Danny", phone: "+66 81 000 0000", now: NOW });
    expect(await decideHeldByName(db, { code: withPhone.ev.code, name: "danny", viewer: null, rateKey: key(), now: NOW })).toEqual({ ok: false, reason: "phone" });
  });

  it("never takes one of two held Dannys", async () => {
    await refused("namesake", async () => undefined, ["Danny", "DANNY"]);
  });

  it("never takes a held Danny while a Danny record sits in the match", async () => {
    await refused("seated_namesake", async (m) => {
      await joinEvent(db, { eventId: m.ev.id, playerId: (await makePlayer(db, "Danny")).id, now: NOW });
    });
  });

  it("gives nothing to a browser that knows Ana", async () => {
    await refused("other_name", async () => ({ viewer: { id: (await makePlayer(db, "Ana")).id, name: "Ana" } }));
  });

  it("does nothing on a cancelled match", async () => {
    await refused("cancelled", async (m) => {
      await db.update(events).set({ status: "cancelled" }).where(eq(events.id, m.ev.id));
    });
  });

  it("does nothing on a fixed-pairs night", async () => {
    const m = await match([], { fixedPairs: true, type: "tournament" });
    const ana = await makePlayer(db, "Ana");
    await joinPair(db, { eventId: m.ev.id, playerId: ana.id, partnerName: "Danny" });
    expect(await decideHeldByName(db, { code: m.ev.code, name: "danny", viewer: null, rateKey: key(), now: NOW })).toEqual({ ok: false, reason: "fixed_pairs" });
  });

  it("counts every tap against the address's daily limit, refused ones too, in the bucket \"That's me\" uses", async () => {
    const { ev } = await match(["Danny"]);
    const ip = key();
    const before = await metric("held_by_name_refused");
    for (let i = 0; i < LIMITS.thatsMePerIpPerDay; i++) expect((await decideHeldByName(db, { code: ev.code, name: `Guess${i}`, viewer: null, rateKey: ip, now: NOW })).ok).toBe(false);
    expect(await metric("held_by_name_refused")).toBe(before + LIMITS.thatsMePerIpPerDay);
    expect(await decideHeldByName(db, { code: ev.code, name: "Danny", viewer: null, rateKey: ip, now: NOW })).toEqual({ ok: false, reason: "too_many" });
    // The same bucket as "That's me": the twenty taps are one allowance per address, whichever button took them.
    const [bucket] = await db.select().from(metricsDaily).where(sql`${metricsDaily.key} = ${`rl:thatsme:${ip}`}`);
    expect(Number(bucket.value)).toBeGreaterThan(LIMITS.thatsMePerIpPerDay);
    // Another address is not held back by this one.
    expect((await decideHeldByName(db, { code: ev.code, name: "Danny", viewer: null, rateKey: key(), now: NOW })).ok).toBe(true);
  });

  it("refuses a forced request for a place held in another match", async () => {
    const a = await match([]);
    const b = await match(["Danny"]);
    // By name: Danny is held in B, so A has nobody of that name.
    expect(await decideHeldByName(db, { code: a.ev.code, name: "Danny", viewer: null, rateKey: key(), now: NOW })).toEqual({ ok: false, reason: "nobody" });
    // By a forged decision: C's lock and C's places, B's row. C holds a Danny of its own, so only the
    // check that the place decided is the place found stands between the forgery and a confirmation.
    const c = await match(["Danny"]);
    const bPlace = await heldRow(b.ev.id, "Danny");
    const cPlace = await heldRow(c.ev.id, "Danny");
    const intruder = await makePlayer(db, "Danny");
    const forced = await takeHeldByName(db, { ok: true, eventId: c.ev.id, code: c.ev.code, slotId: bPlace.id, name: "Danny" }, { id: intruder.id, name: "Danny" }, NOW);
    expect(forced).toEqual({ ok: false, reason: "nobody" });
    for (const id of [bPlace.id, cPlace.id]) expect((await db.select().from(slots).where(eq(slots.id, id)))[0]).toMatchObject({ status: "invited", playerId: null });
  });

  it("asks the rule again under the lock: an email the organiser added after the first answer closes the door", async () => {
    const { ev } = await match(["Danny"]);
    const d = await decideHeldByName(db, { code: ev.code, name: "Danny", viewer: null, rateKey: key(), now: NOW });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    await db.update(slots).set({ invitedEmail: "danny@example.com" }).where(eq(slots.id, d.slotId));
    const fresh = await makePlayer(db, "Danny");
    expect(await takeHeldByName(db, d, { id: fresh.id, name: "Danny" }, NOW)).toEqual({ ok: false, reason: "email" });
  });

  // ------------------------------------------------------------------ the three invite fixes

  it("knows whether a record holds a seat or a waiting place in a match, for the personal link that outlived its place", async () => {
    const { ev, org } = await match([]);
    const ana = await makePlayer(db, "Ana");
    expect(await holdsPlaceIn(db, ev.code, ana.id)).toBe(false);
    await joinEvent(db, { eventId: ev.id, playerId: ana.id, now: NOW });
    expect(await holdsPlaceIn(db, ev.code, ana.id)).toBe(true);
    expect(await holdsPlaceIn(db, ev.code, org.id)).toBe(true);
    // A waiting place counts too.
    for (const x of ["B1", "C1", "D1"]) await joinEvent(db, { eventId: ev.id, playerId: (await makePlayer(db, x)).id, now: NOW });
    const waiter = await makePlayer(db, "Wai");
    await joinEvent(db, { eventId: ev.id, playerId: waiter.id, now: NOW });
    expect(await holdsPlaceIn(db, ev.code, waiter.id)).toBe(true);
  });

  it("refuses the organiser, in the match already, who taps \"I'm in\" on somebody else's link, and the place stays held", async () => {
    const { ev, org } = await match(["Danny"]);
    const place = await heldRow(ev.id, "Danny");
    await expect(confirmInvite(db, { inviteCode: place.inviteCode!, playerId: org.id, now: NOW })).rejects.toMatchObject({ code: "forbidden" });
    expect((await db.select().from(slots).where(eq(slots.id, place.id)))[0]).toMatchObject({ status: "invited", inviteCode: place.inviteCode });
  });

  it("refuses a co-organiser in the match, an admin of its crew, the same way", async () => {
    const creator = await makePlayer(db, `Founder${++n}`, { email: `founder${n}@example.com` });
    const [g] = await db.insert(groups).values({ code: `H${String(++n).padStart(5, "0")}`, name: `Crew ${n}`, creatorPlayerId: creator.id, tz: "Asia/Bangkok" }).returning();
    const adm = await makePlayer(db, `Admin${++n}`);
    await db.insert(groupMembers).values({ groupId: g.id, playerId: adm.id, role: "admin" });
    const { ev } = await match(["Danny"], { groupId: g.id });
    await joinEvent(db, { eventId: ev.id, playerId: adm.id, now: NOW });
    const place = await heldRow(ev.id, "Danny");
    await expect(confirmInvite(db, { inviteCode: place.inviteCode!, playerId: adm.id, now: NOW })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses any other player in the match on Danny's link: the place stays held and nobody waiting takes it", async () => {
    const { ev } = await match(["Danny"]);
    const place = await heldRow(ev.id, "Danny");
    const [ana, cy, wil] = await Promise.all(["Ana", "Cy", "Wil"].map((x) => makePlayer(db, x)));
    for (const p of [ana, cy, wil]) await joinEvent(db, { eventId: ev.id, playerId: p.id, now: NOW });
    await expect(confirmInvite(db, { inviteCode: place.inviteCode!, playerId: ana.id, now: NOW })).rejects.toMatchObject({ code: "forbidden" });
    expect((await db.select().from(slots).where(eq(slots.id, place.id)))[0]).toMatchObject({ status: "invited", playerId: null, invitedName: "Danny" });
    expect((await db.select().from(slots).where(and(eq(slots.eventId, ev.id), eq(slots.playerId, wil.id))))[0].position).toBeGreaterThan(4);
    // The invite page asks the same rule, so it shows Ana no "I'm in".
    expect(await mayUseHeldLink(db, ev, place, ana)).toBe(false);
  });

  it("lets a co-organiser called Danny, in by the plain link, free his own held place", async () => {
    const creator = await makePlayer(db, `Founder${++n}`, { email: `founder${n}@example.com` });
    const [g] = await db.insert(groups).values({ code: `H${String(++n).padStart(5, "0")}`, name: `Crew ${n}`, creatorPlayerId: creator.id, tz: "Asia/Bangkok" }).returning();
    const dannyAdmin = await makePlayer(db, "Danny");
    await db.insert(groupMembers).values({ groupId: g.id, playerId: dannyAdmin.id, role: "admin" });
    const { ev } = await match(["Danny"], { groupId: g.id });
    await joinEvent(db, { eventId: ev.id, playerId: dannyAdmin.id, now: NOW });
    const place = await heldRow(ev.id, "Danny");
    expect(await mayUseHeldLink(db, ev, place, dannyAdmin)).toBe(true);
    expect((await confirmInvite(db, { inviteCode: place.inviteCode!, playerId: dannyAdmin.id, now: NOW })).outcome).toBe("already_in");
    expect((await db.select().from(slots).where(eq(slots.id, place.id)))[0]).toMatchObject({ status: "empty", inviteCode: null });
  });

  it("frees a place held for a number when that number writes, whatever name its record carries", async () => {
    const { ev, org } = await match([]);
    await reserveSlot(db, { eventId: ev.id, actorPlayerId: org.id, name: "Danny", phone: "+66 81 000 0077", now: NOW });
    const place = await heldRow(ev.id, "Danny");
    const daniel = await makePlayer(db, "Daniel");
    await joinEvent(db, { eventId: ev.id, playerId: daniel.id, now: NOW });
    // A typed name is no proof, and another number is none either.
    await expect(confirmInvite(db, { inviteCode: place.inviteCode!, playerId: daniel.id, now: NOW })).rejects.toMatchObject({ code: "forbidden" });
    await expect(confirmInvite(db, { inviteCode: place.inviteCode!, playerId: daniel.id, phone: "66810000078", now: NOW })).rejects.toMatchObject({ code: "forbidden" });
    // The WhatsApp JOIN from the number the place was held for: Meta sends it without the plus.
    expect((await confirmInvite(db, { inviteCode: place.inviteCode!, playerId: daniel.id, phone: "66810000077", now: NOW })).outcome).toBe("already_in");
  });

  it("a Danny already in by the plain link who opens his link frees the held place the way a leave does: the first player waiting moves up, and the organiser hears it", async () => {
    const { ev, org } = await match(["Danny"]);
    const place = await heldRow(ev.id, "Danny");
    const danny2 = await makePlayer(db, "Danny");
    const c = await makePlayer(db, "Cy");
    await joinEvent(db, { eventId: ev.id, playerId: danny2.id, now: NOW });
    await joinEvent(db, { eventId: ev.id, playerId: c.id, now: NOW });
    const waiter = await makePlayer(db, "Wil");
    await joinEvent(db, { eventId: ev.id, playerId: waiter.id, now: NOW });
    const res = await confirmInvite(db, { inviteCode: place.inviteCode!, playerId: danny2.id, now: NOW });
    expect(res.outcome).toBe("already_in");
    if (res.outcome !== "already_in") return;
    expect(res.promotion?.playerId).toBe(waiter.id);
    const [freed] = await db.select().from(slots).where(eq(slots.id, place.id));
    expect(freed).toMatchObject({ playerId: waiter.id, status: "joined", inviteCode: null, invitedName: null });
    expect((await db.select().from(slots).where(eq(slots.eventId, ev.id))).filter((s) => s.position > 4)).toEqual([]);
    await afterRelease(db, res, { wasComplete: true });
    const lines = await db.select().from(notices).where(and(eq(notices.playerId, org.id), eq(notices.key, "noticeItem.organizerFeed")));
    expect(lines.map((l) => l.params)).toContainEqual(expect.objectContaining({ what: "promoted", name: "Wil" }));
    const moved = await db.select().from(notices).where(and(eq(notices.playerId, waiter.id), eq(notices.key, "noticeItem.movedUp")));
    expect(moved).toHaveLength(1);
  });

  it("keeps the pair forming on a fixed-pairs night when the partner somebody named was in already", async () => {
    const { ev } = await match([], { fixedPairs: true, type: "tournament" });
    const [ana, bo] = await Promise.all(["Ana", "Bo"].map((x) => makePlayer(db, x)));
    await joinEvent(db, { eventId: ev.id, playerId: ana.id, now: NOW });
    await joinEvent(db, { eventId: ev.id, playerId: bo.id, now: NOW });
    const res = await joinPair(db, { eventId: ev.id, playerId: ana.id, partnerName: "Bo" });
    expect((await confirmInvite(db, { inviteCode: res.partner!.inviteCode!, playerId: bo.id, now: NOW })).outcome).toBe("already_in");
    const rows = await db.select().from(slots).where(eq(slots.eventId, ev.id));
    const pairOf = (id: string) => rows.find((s) => s.playerId === id)?.pairId;
    expect(pairOf(ana.id)).toBeTruthy();
    expect(pairOf(ana.id)).toBe(pairOf(bo.id));
  });

  it("pairs on a fixed-pairs night when the name Ana typed (\"Dani\") is not the record's (\"Daniel\"): the page offers \"I'm in\" and the tap makes the pair", async () => {
    const { ev } = await match([], { fixedPairs: true, type: "tournament" });
    const [ana, daniel] = await Promise.all(["Ana", "Daniel"].map((x) => makePlayer(db, x)));
    await joinEvent(db, { eventId: ev.id, playerId: ana.id, now: NOW });
    await joinEvent(db, { eventId: ev.id, playerId: daniel.id, now: NOW });
    const res = await joinPair(db, { eventId: ev.id, playerId: ana.id, partnerName: "Dani" });
    const link = res.partner!;
    expect(await mayUseHeldLink(db, ev, link, daniel)).toBe(true);
    expect((await confirmInvite(db, { inviteCode: link.inviteCode!, playerId: daniel.id, now: NOW })).outcome).toBe("already_in");
    const rows = await db.select().from(slots).where(eq(slots.eventId, ev.id));
    const pairOf = (id: string) => rows.find((s) => s.playerId === id)?.pairId;
    expect(pairOf(daniel.id)).toBeTruthy();
    expect(pairOf(daniel.id)).toBe(pairOf(ana.id));
  });

  it("pairs the organiser on a fixed-pairs night when a player named them, and still refuses the organiser on somebody else's partner link", async () => {
    const dana = await makePlayer(db, "Dana", { email: `dana${++n}@example.com` });
    const ev = await createEvent(db, { creatorPlayerId: dana.id, type: "tournament", startsAt: at(1), tz: "Asia/Bangkok", whenFull: "waitlist", venueName: "Rawai Padel", fixedPairs: true, capacity: 8 });
    await joinEvent(db, { eventId: ev.id, playerId: dana.id, now: NOW });
    const [ana, cy] = await Promise.all(["Ana", "Cy"].map((x) => makePlayer(db, x)));
    await joinEvent(db, { eventId: ev.id, playerId: ana.id, now: NOW });
    const named = (await joinPair(db, { eventId: ev.id, playerId: ana.id, partnerName: "Dana" })).partner!;
    expect(await mayUseHeldLink(db, ev, named, dana)).toBe(true);
    expect((await confirmInvite(db, { inviteCode: named.inviteCode!, playerId: dana.id, now: NOW })).outcome).toBe("already_in");
    const rows = await db.select().from(slots).where(eq(slots.eventId, ev.id));
    const pairOf = (id: string) => rows.find((s) => s.playerId === id)?.pairId;
    expect(pairOf(dana.id)).toBeTruthy();
    expect(pairOf(dana.id)).toBe(pairOf(ana.id));
    // Cy names Bo; the organiser who checks Bo's link is not Bo, and the link stays Bo's.
    const bo = (await joinPair(db, { eventId: ev.id, playerId: cy.id, partnerName: "Bo" })).partner!;
    expect(await mayUseHeldLink(db, ev, bo, dana)).toBe(false);
    await expect(confirmInvite(db, { inviteCode: bo.inviteCode!, playerId: dana.id, now: NOW })).rejects.toMatchObject({ code: "forbidden" });
  });
});
