import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { events, facts, groupMembers, groups, metricsDaily, slots, type Event, type Player } from "@/db/schema";
import { heldRowDoorsAction, takeHeldPlaceAction, takeHeldRecordAction } from "@/actions/slots";
import { createEvent } from "@/lib/domain/events";
import { normalName } from "@/lib/domain/dupes";
import { heldSeatsOf, type HeldMatch, type HeldSeat } from "@/lib/domain/heldByName";
import { addressed, heldKeys, heldMessageOf, heldMessageParts, heldRowOffers, heldTwin, rowCandidates, type HeldRowFacts, type HeldRowKind } from "@/lib/domain/heldRow";
import { dayKey } from "@/lib/domain/metrics";
import { joinEvent, reserveSlot } from "@/lib/domain/slots";
import { takeHeldRecord } from "@/lib/domain/heldRecord";
import { decideThatsMe, heldRecordFacts, offerFacts, thatsMeOffer, thatsMeRows } from "@/lib/domain/thatsMe";
import { generateRound } from "@/lib/domain/tournament";
import { PLAYER_COOKIE, sealPlayerId } from "@/lib/session";
import { asAction } from "./helpers/action";
import { freezeClock } from "./helpers/clock";
import { createTestDb, DAY, HOUR, makePlayer } from "./helpers/db";

/**
 * The owner, 6 November 2026: "Build A and C". Option C: "A 'That's me' button on each held row, in
 * place of the typed name. Every player confirms with one tap, also in a new browser." So each held row
 * shows "I'm Danny" to a browser that may take that place (`heldRowOffers` in src/lib/domain/heldRow.ts),
 * and the kind says what the one tap runs. The organiser's one message names the held places a browser
 * that knows nobody can take from the plain link (`heldMessageParts`, `heldMessageOf`).
 *
 * NOW is Friday 6 November 2026, 11:00 in Bangkok; every match starts a day or more after it.
 */
const NOW = new Date(Date.UTC(2026, 10, 6, 4, 0));
const at = (days: number) => new Date(NOW.getTime() + days * DAY);
freezeClock(NOW);

// ------------------------------------------------------------------ the rule, as a table

const ORG = "00000000-0000-4000-8000-0000000000aa";
const MARIA = "00000000-0000-4000-8000-0000000000b1";
const live: HeldMatch & Pick<Event, "capacity"> = { status: "open", startsAt: at(1), durationMinutes: 90, fixedPairs: false, creatorPlayerId: ORG, capacity: 8 };
const seat = (o: Partial<HeldSeat>): HeldSeat => ({ id: "s0", kind: "open", status: "joined", playerId: null, invitedName: null, invitedEmail: null, invitedPhone: null, position: 1, playerName: null, ...o });
const held = (o: Partial<HeldSeat>): HeldSeat => seat({ kind: "reserved", status: "invited", ...o });
const organiser = seat({ id: "s1", playerId: ORG, playerName: "Erik", position: 1 });
/** A place Erik held by name, with no record, no email and no phone. */
const danny = held({ id: "s2", invitedName: "Danny", position: 2 });
/** A place Erik held for old Maria from "Played with you": it keeps her record. */
const maria = held({ id: "s3", invitedName: "Maria", playerId: MARIA, playerName: "Maria", position: 3 });

const NOTHING: HeldRowFacts = { claimable: new Set(), doors: new Set(), fold: null };
const CLAIMABLE: HeldRowFacts = { ...NOTHING, claimable: new Set([MARIA]) };
const DOORS: HeldRowFacts = { ...NOTHING, doors: new Set([MARIA]) };
const FOLD: HeldRowFacts = { ...NOTHING, fold: MARIA };
const claims = (...ids: string[]): HeldRowFacts => ({ ...NOTHING, claimable: new Set(ids) });

type Case = { m?: Partial<HeldMatch & Pick<Event, "capacity">>; seats?: HeldSeat[]; viewer?: { id: string; name: string } | null; facts?: HeldRowFacts; now?: Date };

/**
 * Each row changes one thing from the owner's case: Danny held by name and old Maria's record that
 * "That's me" signs in, seen by a browser that knows nobody. The rows that close a record's row keep the
 * record claimable, so the guard named is the only thing between it and a button.
 */
const ROW_TABLE: [string, Case, [string, HeldRowKind][]][] = [
  ["a place held by name, and a record \"That's me\" signs in, for a browser that knows nobody", {}, [["s2", "by_name"], ["s3", "record"]]],
  ["a record that proves itself: its own doors", { facts: DOORS }, [["s2", "by_name"], ["s3", "doors"]]],
  ["a record \"That's me\" refuses, with no door here", { facts: NOTHING }, [["s2", "by_name"]]],
  ["a browser whose record is called Danny and holds no place here: Danny's place", { viewer: { id: "v1", name: " DANNY " } }, [["s2", "by_name"]]],
  ["a browser that knows Ana: no button on anybody else's row", { viewer: { id: "v2", name: "Ana" } }, []],
  ["the organiser, even with a fold in the facts", { viewer: { id: ORG, name: "Erik" }, facts: FOLD }, []],
  ["a browser whose Danny holds a place here already", { seats: [organiser, danny, maria, seat({ id: "s4", playerId: "v1", playerName: "Daniel", position: 4 })], viewer: { id: "v1", name: "Danny" } }, []],
  ["a place held by name for an email", { seats: [organiser, { ...danny, invitedEmail: "danny@example.com" }, maria] }, [["s3", "record"]]],
  ["a place held by name for a phone", { seats: [organiser, { ...danny, invitedPhone: "+66810000000" }, maria] }, [["s3", "record"]]],
  ["two places held by name for Danny", { seats: [organiser, danny, held({ id: "s4", invitedName: "danny", position: 4 }), maria] }, [["s3", "record"]]],
  ["a record of the name seated here", { seats: [organiser, danny, maria, seat({ id: "s4", playerId: "p4", playerName: "Danny", position: 4 })] }, [["s3", "record"]]],
  ["a held record held as Danny, beside the place held by name: neither", { seats: [organiser, danny, held({ id: "s4", invitedName: "danny", playerId: "p4", playerName: "Danny", position: 4 })], facts: claims("p4") }, []],
  ["a held record renamed to Danny, beside the place held by name: neither", { seats: [organiser, danny, held({ id: "s4", invitedName: "Dan", playerId: "p4", playerName: "Danny", position: 4 })], facts: claims("p4") }, []],
  ["the record's own browser: mine", { viewer: { id: MARIA, name: "Maria" } }, [["s3", "mine"]]],
  ["the record's own browser, with an email typed on the place: mine", { seats: [organiser, danny, { ...maria, invitedEmail: "maria@example.com" }], viewer: { id: MARIA, name: "Maria" }, facts: NOTHING }, [["s3", "mine"]]],
  ["the record's own browser, with a twin: mine", { seats: [organiser, maria, held({ id: "s4", invitedName: "maria", position: 4 })], viewer: { id: MARIA, name: "Maria" }, facts: NOTHING }, [["s3", "mine"]]],
  ["the record's own browser, outside the limits: mine", { viewer: { id: MARIA, name: "Maria" }, facts: NOTHING }, [["s3", "mine"]]],
  ["a bare namesake seated beside the held record: the fold", { seats: [organiser, danny, maria, seat({ id: "s4", playerId: "v3", playerName: "Maria", position: 4 })], viewer: { id: "v3", name: "Maria" }, facts: FOLD }, [["s3", "fold"]]],
  ["a bare namesake on the waiting list: the fold", { seats: [organiser, danny, maria, seat({ id: "s9", playerId: "v3", playerName: "Maria", position: 9 })], viewer: { id: "v3", name: "Maria" }, facts: FOLD }, [["s3", "fold"]]],
  ["a namesake with no place here (a crew member): no button", { viewer: { id: "v3", name: "Maria" }, facts: FOLD }, []],
  ["a record with a typed email", { seats: [organiser, danny, { ...maria, invitedEmail: "maria@example.com" }] }, [["s2", "by_name"]]],
  ["a record with a typed phone", { seats: [organiser, danny, { ...maria, invitedPhone: "+66810000001" }] }, [["s2", "by_name"]]],
  ["a tournament's placeholder on a place held for an email", { seats: [organiser, held({ id: "s5", invitedName: "Pat", playerId: "pP", playerName: "Pat", invitedEmail: "pat@example.com", position: 5 })], facts: claims("pP") }, []],
  ["a tournament's placeholder on a place held for a phone", { seats: [organiser, held({ id: "s5", invitedName: "Pat", playerId: "pP", playerName: "Pat", invitedPhone: "+66810000002", position: 5 })], facts: claims("pP") }, []],
  ["a picked record and a name typed after it, the same name: neither", { seats: [organiser, maria, held({ id: "s4", invitedName: "maria", position: 4 })] }, []],
  ["a held record past the capacity", { seats: [organiser, danny, { ...maria, position: 9 }] }, [["s2", "by_name"]]],
  ["a declined place: an open spot now", { seats: [organiser, danny, { ...maria, status: "declined" }] }, [["s2", "by_name"]]],
  ["an invited row that is not a reserved place", { seats: [organiser, danny, { ...maria, kind: "open" }] }, [["s2", "by_name"]]],
  ["a fixed-pairs night", { m: { fixedPairs: true } }, []],
  ["a cancelled match", { m: { status: "cancelled" } }, []],
  ["a finished match", { m: { status: "past" } }, []],
  ["a match whose own length has run out", { now: new Date(at(1).getTime() + 2 * HOUR) }, []],
  ["a match under way and not over: the rows still offer", { now: new Date(at(1).getTime() + 30 * 60_000) }, [["s2", "by_name"], ["s3", "record"]]],
];

describe("who sees \"I'm Danny\" on a held row, and what the tap runs", () => {
  it.each(ROW_TABLE)("%s", (_label, c, expected) => {
    const offers = heldRowOffers({ ...live, ...c.m }, c.seats ?? [organiser, danny, maria], c.viewer ?? null, c.facts ?? CLAIMABLE, c.now ?? NOW);
    expect(offers.map((o) => [o.slotId, o.kind])).toEqual(expected);
  });

  it("names the row by the record's own name, else the name held", () => {
    const renamed = { ...maria, invitedName: "Mari" };
    expect(heldRowOffers(live, [organiser, renamed], null, CLAIMABLE, NOW)).toEqual([{ slotId: "s3", name: "Maria", kind: "record" }]);
    expect(heldRowOffers(live, [organiser, danny], null, NOTHING, NOW)).toEqual([{ slotId: "s2", name: "Danny", kind: "by_name" }]);
  });

  it("reads an address, a held place's names and a twin as the rule compares them", () => {
    expect(addressed({ invitedEmail: null, invitedPhone: null })).toBe(false);
    expect(addressed({ invitedEmail: "a@example.com", invitedPhone: null })).toBe(true);
    expect(addressed({ invitedEmail: null, invitedPhone: "+66810000000" })).toBe(true);
    expect(heldKeys(held({ invitedName: "Dan", playerId: "p", playerName: " DANNY " }))).toEqual(["dan", "danny"]);
    expect(heldKeys(held({ invitedName: "Danny", playerId: "p", playerName: "danny" }))).toEqual(["danny"]);
    // A record's name counts only with a record on the place, and a name of one letter is no name.
    expect(heldKeys(held({ invitedName: "D", playerName: "Danny" }))).toEqual([]);
    // A seat taken by a namesake is not a held place: no twin (the rule's seated namesake covers a place held by name).
    expect(heldTwin([maria, seat({ id: "s4", playerId: "v3", playerName: "Maria", position: 4 })], maria)).toBe(false);
    expect(heldTwin([maria, held({ id: "s4", invitedName: "MARIA", position: 4 })], maria)).toBe(true);
  });

  it("asks the one message's read only about held records with no address and no twin, on the line-up", () => {
    const eli = held({ id: "s4", invitedName: "Eli", playerId: "pE", playerName: "Eli", invitedEmail: "eli@example.com", position: 4 });
    const waiting = held({ id: "s9", invitedName: "Wes", playerId: "pW", playerName: "Wes", position: 9 });
    expect(rowCandidates(live, [organiser, danny, maria, eli, waiting]).map((s) => s.id)).toEqual(["s3"]);
    expect(rowCandidates({ ...live, fixedPairs: true }, [organiser, danny, maria])).toEqual([]);
  });
});

describe("the places the one message names, and the ones it leaves to their personal link", () => {
  const cap = { ...live, capacity: 14 };
  const LINE: HeldSeat[] = [
    organiser,
    danny,
    maria,
    held({ id: "s4", invitedName: "Mia", playerId: "pMia", playerName: "Mia", position: 4 }),
    held({ id: "s5", invitedName: "Cal", invitedEmail: "cal@example.com", position: 5 }),
    held({ id: "s6", invitedName: "Dee", invitedPhone: "+66810000003", position: 6 }),
    held({ id: "s7", invitedName: "Rui", playerId: "pRui", playerName: "Rui", invitedEmail: "rui@example.com", position: 7 }),
    held({ id: "s8", invitedName: "Jo", position: 8 }),
    held({ id: "s9", invitedName: "Jo", playerId: "pJo", playerName: "Jo", position: 9 }),
    held({ id: "s10", invitedName: "Kai", position: 10 }),
    seat({ id: "s11", playerId: "pKai", playerName: "Kai", position: 11 }),
    held({ id: "s12", invitedName: "Olaf", playerId: "pOlaf", playerName: "Olaf", position: 12 }),
  ];
  const facts: HeldRowFacts = { claimable: new Set([MARIA, "pRui", "pJo"]), doors: new Set(["pMia"]), fold: null };

  it("names the places taken by name, by a record \"That's me\" signs in and by a record with its own doors, in the line-up's order; the rest keep their links", () => {
    const parts = heldMessageParts([...LINE].reverse(), cap.capacity, heldRowOffers(cap, LINE, null, facts, NOW));
    expect(parts.names).toEqual(["Danny", "Maria", "Mia"]);
    // A typed email, a typed phone, a record with an address, a twin pair, a name a seated record carries, a record outside the limits.
    expect(parts.others).toEqual(["Cal", "Dee", "Rui", "Jo", "Jo", "Kai", "Olaf"]);
  });

  it("names nothing when no place is held", () => {
    expect(heldMessageParts([organiser, seat({ id: "s2", status: "empty", position: 2 })], 4, [])).toEqual({ names: [], others: [] });
  });
});

// ------------------------------------------------------------------ the page and the tap, against the database

describe("the page offers what the tap does", () => {
  let app: Db;
  // No mail goes out in these tests unless one says so: the machine's own key never sends a test's notice.
  const mailKey = process.env.RESEND_API_KEY;
  beforeAll(async () => {
    app = await getDb();
    delete process.env.RESEND_API_KEY;
  });
  afterAll(() => {
    if (mailKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = mailKey;
  });
  let n = 0;
  const RUNS = { email: true, telegram: false };
  /** Each tap from its own address, so no test meets another's daily "That's me" limit. */
  const tap = () => ({ headers: { "x-forwarded-for": `held-row-${++n}` } });
  const as = (p: Player): Record<string, string> => ({ [PLAYER_COOKIE]: sealPlayerId(p.id) });
  const metric = async (key: string) => Number((await app.select().from(metricsDaily).where(and(eq(metricsDaily.day, dayKey()), eq(metricsDaily.key, key))))[0]?.value ?? 0);
  /** The page's own steps for a browser that knows nobody: `thatsMeOffer` over the line-up, then one offer per held row. */
  const pageOffers = async (ev: Event) => {
    const offer = await thatsMeOffer(app, ev, null, [], NOW, RUNS);
    return heldRowOffers(ev, await heldSeatsOf(app, ev.id), null, { claimable: offer.ids, doors: offer.doors, fold: null }, NOW);
  };
  const fresh = async (id: string) => (await app.select().from(events).where(eq(events.id, id)))[0];

  /**
   * Erik's crew night, every kind of held place on it: Bea by name; Cal by name for an email; Dee by name
   * for a phone; old Danny's bare record; Eli's bare record with an email typed on the place; Mia's record
   * with an email; Olaf's record, which organises a match still to come; Jo's record, beside a crew member
   * also called Jo.
   */
  const crewMatch = async () => {
    const k = ++n;
    const erik = await makePlayer(app, `Erik ${k}`);
    const lead = await makePlayer(app, `Lead ${k}`, { email: `lead-row${k}@example.com` });
    const [crew] = await app.insert(groups).values({ code: `H${String(k).padStart(5, "0")}`, name: `Crew ${k}`, creatorPlayerId: lead.id, tz: "Asia/Bangkok" }).returning();
    await app.insert(groupMembers).values({ groupId: crew.id, playerId: (await makePlayer(app, "Jo")).id, role: "member" });
    // An americano night of twelve: a match has four places, too few for every kind of held place.
    const ev = await createEvent(app, { creatorPlayerId: erik.id, type: "tournament", capacity: 12, startsAt: at(2), tz: "Asia/Bangkok", whenFull: "waitlist", venueName: "Rawai Padel" });
    await app.update(events).set({ groupId: crew.id }).where(eq(events.id, ev.id));
    await joinEvent(app, { eventId: ev.id, playerId: erik.id, now: NOW });
    const hold = (name: string, o: { email?: string; phone?: string; playerId?: string } = {}) => reserveSlot(app, { eventId: ev.id, actorPlayerId: erik.id, name, now: NOW, ...o });
    await hold("Bea");
    await hold("Cal", { email: `cal-row${k}@example.com` });
    await hold("Dee", { phone: `+6681${String(2_000_000 + k).padStart(7, "0")}` });
    await hold("Danny", { playerId: (await makePlayer(app, "Danny")).id });
    await hold("Eli", { playerId: (await makePlayer(app, "Eli")).id, email: `eli-row${k}@example.com` });
    await hold("Mia", { playerId: (await makePlayer(app, "Mia", { email: `mia-row${k}@example.com` })).id });
    const olaf = await makePlayer(app, "Olaf");
    await createEvent(app, { creatorPlayerId: olaf.id, type: "match", startsAt: at(4), tz: "Asia/Bangkok", whenFull: "waitlist", venueName: "Kata Padel" });
    await hold("Olaf", { playerId: olaf.id });
    await hold("Jo", { playerId: (await makePlayer(app, "Jo")).id });
    return { erik, ev: await fresh(ev.id) };
  };

  /** Erik's americano night: Pat held by name, Quin for a phone, Rui by name; round 1 gives each a placeholder record. */
  const night = async () => {
    const k = ++n;
    const erik = await makePlayer(app, `Erik ${k}`);
    const ev = await createEvent(app, { creatorPlayerId: erik.id, type: "tournament", capacity: 8, startsAt: at(2), tz: "Asia/Bangkok", whenFull: "waitlist", venueName: "Rawai Padel" });
    await joinEvent(app, { eventId: ev.id, playerId: erik.id, now: NOW });
    await reserveSlot(app, { eventId: ev.id, actorPlayerId: erik.id, name: "Pat", now: NOW });
    await reserveSlot(app, { eventId: ev.id, actorPlayerId: erik.id, name: "Quin", phone: `+6681${String(3_000_000 + k).padStart(7, "0")}`, now: NOW });
    await reserveSlot(app, { eventId: ev.id, actorPlayerId: erik.id, name: "Rui", now: NOW });
    await generateRound(app, { eventId: ev.id, actorPlayerId: erik.id, now: NOW });
    return { erik, ev: await fresh(ev.id) };
  };

  /**
   * Every held name tapped from a browser that knows nobody, with each of the three row actions. The doors
   * read changes nothing; a take by name from such a browser makes an ordinary record from the name, which
   * an action under this harness cannot do (`requirePlayer` reads `getLocale`, which next-intl answers only
   * inside a page Next.js renders), so it stops there, after the rule said yes, and writes nothing.
   */
  const tapEvery = async (ev: Event, names: string[]) => {
    const kinds = new Map((await pageOffers(ev)).map((o) => [normalName(o.name), o.kind]));
    for (const name of names) {
      const kind = kinds.get(normalName(name)) ?? null;
      // Mail goes out while the doors are read, as the page's `RUNS` say; then it is off again.
      process.env.RESEND_API_KEY = "re_test_held_row";
      const doors = await asAction({}, () => heldRowDoorsAction(ev.code, name), tap()).finally(() => delete process.env.RESEND_API_KEY);
      expect(doors.result.ok, `${name}: the doors read`).toBe(kind === "doors");
      const byName = await asAction({}, () => takeHeldPlaceAction(ev.code, name, undefined, "row"), tap());
      // The rule said yes, and the harness stops at `requirePlayer` (`generic`): a refusal of the rule is `invalid` or `too_many`.
      if (kind === "by_name") expect(byName.result, `${name}: the rule lets the take by name through`).toEqual({ ok: false, error: "generic" });
      else expect(byName.result, `${name}: no take by name`).toEqual({ ok: false, error: "invalid" });
      const record = await asAction({}, () => takeHeldRecordAction(ev.code, name), tap());
      expect(record.result.ok, `${name}: the record's take`).toBe(kind === "record");
      if (kind !== "record") expect(record.cookies[PLAYER_COOKIE], `${name}: no cookie`).toBeUndefined();
    }
    return kinds;
  };

  it("on a crew night: Bea by name, old Danny's record, Mia's doors, and nothing on the other rows; each tap does exactly that", async () => {
    const { ev } = await crewMatch();
    const offers = await pageOffers(ev);
    expect(offers.map((o) => [o.name, o.kind])).toEqual([
      ["Bea", "by_name"],
      ["Danny", "record"],
      ["Mia", "doors"],
    ]);
    await tapEvery(ev, ["Bea", "Cal", "Dee", "Danny", "Eli", "Mia", "Olaf", "Jo"]);
    // Old Danny took his place in the one tap; Bea's place waits for a browser that may make her record.
    const places = await heldSeatsOf(app, ev.id);
    expect(places.find((s) => s.invitedName === "Danny")?.status).toBe("confirmed");
    expect(places.filter((s) => s.status === "invited").map((s) => s.invitedName)).toEqual(["Bea", "Cal", "Dee", "Eli", "Mia", "Olaf", "Jo"]);
  });

  it("a browser that knows a Bea with no place here takes Bea's place from the row in one request, and the row's take is counted beside every take by name", async () => {
    const { ev } = await crewMatch();
    const bea = await makePlayer(app, "Bea");
    const offers = heldRowOffers(ev, await heldSeatsOf(app, ev.id), { id: bea.id, name: "Bea" }, { claimable: new Set(), doors: new Set(), fold: null }, NOW);
    expect(offers.map((o) => [o.name, o.kind])).toEqual([["Bea", "by_name"]]);
    const [byName, fromRow] = [await metric("held_by_name"), await metric("held_row_by_name")];
    const { result } = await asAction(as(bea), () => takeHeldPlaceAction(ev.code, "Bea", undefined, "row"), tap());
    expect(result).toEqual({ ok: true, data: { outcome: "confirmed" } });
    expect((await app.select().from(slots).where(and(eq(slots.eventId, ev.id), eq(slots.invitedName, "Bea"))))[0]).toMatchObject({ playerId: bea.id, status: "confirmed" });
    expect([await metric("held_by_name"), await metric("held_row_by_name")]).toEqual([byName + 1, fromRow + 1]);
    // The typed name's take counts only `held_by_name`, as before.
    const cal = await makePlayer(app, "Cal");
    const second = await crewMatch();
    await app.update(slots).set({ invitedEmail: null }).where(and(eq(slots.eventId, second.ev.id), eq(slots.invitedName, "Cal")));
    expect((await asAction(as(cal), () => takeHeldPlaceAction(second.ev.code, "Cal"), tap())).result).toEqual({ ok: true, data: { outcome: "confirmed" } });
    expect([await metric("held_by_name"), await metric("held_row_by_name")]).toEqual([byName + 2, fromRow + 1]);
  });

  it("on an americano night after round 1: a placeholder on a plain place takes its row, and one on a place held for a phone does not", async () => {
    const { ev } = await night();
    expect((await pageOffers(ev)).map((o) => [o.name, o.kind])).toEqual([
      ["Pat", "record"],
      ["Rui", "record"],
    ]);
    await tapEvery(ev, ["Pat", "Quin", "Rui"]);
    const places = await heldSeatsOf(app, ev.id);
    expect(places.filter((s) => s.kind === "reserved").map((s) => [s.invitedName, s.status])).toEqual([
      ["Pat", "confirmed"],
      ["Quin", "invited"],
      ["Rui", "confirmed"],
    ]);
  });

  it("the organiser's narrowed read gives each held record the answer the full read gives, and reads only those records", async () => {
    const { ev } = await crewMatch();
    const seats = await heldSeatsOf(app, ev.id);
    const ids = rowCandidates(ev, seats).map((s) => s.playerId!);
    const named = (id: string) => seats.find((s) => s.playerId === id)?.playerName ?? undefined;
    expect(ids.map(named)).toEqual(["Danny", "Mia", "Olaf", "Jo"]);
    const narrow = await heldRecordFacts(app, ev, ids, NOW, RUNS);
    const full = offerFacts(await thatsMeRows(app, ev, { now: NOW }), RUNS);
    for (const id of ids) {
      expect(narrow.claimable.has(id), named(id)).toBe(full.claimable.has(id));
      expect(narrow.doors.has(id), named(id)).toBe(full.doors.has(id));
    }
    expect([...narrow.claimable].map(named)).toEqual(["Danny"]);
    expect([...narrow.doors].map(named)).toEqual(["Mia"]);
    const rows = await thatsMeRows(app, ev, { now: NOW, only: ids });
    expect(rows.map((r) => r.id).sort()).toEqual([...ids].sort());
    // The counts stay whole: Jo is still one of two Jos, with the crew's.
    expect(rows.find((r) => r.name === "Jo")?.sameName).toBe(2);
    // Anything that is not an id is dropped, and a list with no id reads no place.
    expect(await thatsMeRows(app, ev, { now: NOW, only: ["x') or true --"] })).toEqual([]);
    expect(await thatsMeRows(app, ev, { now: NOW, only: [] })).toEqual([]);
    expect(await heldRecordFacts(app, ev, [], NOW, RUNS)).toEqual({ claimable: new Set(), doors: new Set() });
  });

  it("the one message names Bea, Danny and Mia, and leaves the rest to their personal link; nothing on a fixed-pairs night", async () => {
    const { ev } = await crewMatch();
    const seats = await heldSeatsOf(app, ev.id);
    expect(await heldMessageOf(app, ev, seats, NOW, RUNS)).toEqual({ names: ["Bea", "Danny", "Mia"], others: ["Cal", "Dee", "Eli", "Olaf", "Jo"] });
    // Where mail does not go out, Mia has no door here: her place keeps its personal link.
    expect(await heldMessageOf(app, ev, seats, NOW, { email: false, telegram: false })).toEqual({ names: ["Bea", "Danny"], others: ["Cal", "Dee", "Eli", "Mia", "Olaf", "Jo"] });
    const pairs = await createEvent(app, { creatorPlayerId: ev.creatorPlayerId, type: "tournament", capacity: 8, startsAt: at(3), tz: "Asia/Bangkok", whenFull: "waitlist", venueName: "Rawai Padel" });
    await app.update(events).set({ fixedPairs: true }).where(eq(events.id, pairs.id));
    await reserveSlot(app, { eventId: pairs.id, actorPlayerId: ev.creatorPlayerId, name: "Bea", now: NOW });
    const night = await fresh(pairs.id);
    expect(await heldMessageOf(app, night, await heldSeatsOf(app, night.id), NOW, RUNS)).toEqual({ names: [], others: [] });
    expect(heldRowOffers(night, await heldSeatsOf(app, night.id), null, NOTHING, NOW)).toEqual([]);
  });
});

// ------------------------------------------------------------------ the two new statements, on the test database (real Postgres with TEST_DATABASE_URL)

describe("the narrowed read and the row's take, on the test database", () => {
  let db: Db;
  beforeAll(async () => {
    ({ db } = await createTestDb());
  });
  let n = 0;
  const RUNS = { email: true, telegram: false };
  /** Erik's match: Danny's bare record held, Mia's record with an email held, Bea held by name. */
  const match = async () => {
    const erik = await makePlayer(db, `Erik ${++n}`);
    const ev = await createEvent(db, { creatorPlayerId: erik.id, type: "match", startsAt: at(2), tz: "Asia/Bangkok", whenFull: "waitlist", venueName: "Rawai Padel" });
    const danny = await makePlayer(db, "Danny");
    const mia = await makePlayer(db, "Mia", { email: `mia-pg${n}@example.com` });
    await reserveSlot(db, { eventId: ev.id, actorPlayerId: erik.id, name: "Danny", playerId: danny.id, now: NOW });
    await reserveSlot(db, { eventId: ev.id, actorPlayerId: erik.id, name: "Mia", playerId: mia.id, now: NOW });
    await reserveSlot(db, { eventId: ev.id, actorPlayerId: erik.id, name: "Bea", now: NOW });
    const [fresh] = await db.select().from(events).where(eq(events.id, ev.id));
    return { ev: fresh, danny, mia };
  };

  it("reads only the ids asked for, with the answers the full read gives", async () => {
    const { ev, danny, mia } = await match();
    const rows = await thatsMeRows(db, ev, { now: NOW, only: [danny.id, mia.id, "not-an-id"] });
    expect(rows.map((r) => r.name).sort()).toEqual(["Danny", "Mia"]);
    expect(await heldRecordFacts(db, ev, [danny.id, mia.id], NOW, RUNS)).toEqual({ claimable: new Set([danny.id]), doors: new Set([mia.id]) });
    const full = offerFacts(await thatsMeRows(db, ev, { now: NOW }), RUNS);
    expect([full.claimable.has(danny.id), full.doors.has(mia.id)]).toEqual([true, true]);
    expect(await heldMessageOf(db, ev, await heldSeatsOf(db, ev.id), NOW, RUNS)).toEqual({ names: ["Danny", "Mia", "Bea"], others: [] });
  });

  it("takes the record's own held place under the match's lock, and refuses a place an address came to after the decision", async () => {
    const { ev, danny } = await match();
    const d = await decideThatsMe(db, { code: ev.code, name: "Danny", viewerId: null, rateKey: `pg-${++n}`, now: NOW });
    if (!d.ok) throw new Error(d.reason);
    const [place] = await db.select().from(slots).where(and(eq(slots.eventId, ev.id), eq(slots.playerId, danny.id)));
    await db.update(slots).set({ invitedEmail: "late@example.com" }).where(eq(slots.id, place.id));
    expect(await takeHeldRecord(db, d, NOW)).toEqual({ ok: false, reason: "addressed" });
    await db.update(slots).set({ invitedEmail: null }).where(eq(slots.id, place.id));
    const res = await takeHeldRecord(db, d, NOW);
    expect(res).toMatchObject({ ok: true, wasComplete: false, slot: { id: place.id, playerId: danny.id, status: "confirmed" } });
    const [fact] = await db.select().from(facts).where(and(eq(facts.kind, "player.thats_me"), eq(facts.subjectId, danny.id)));
    expect(fact?.data).toEqual({ folded: false, via: "row" });
  });
});
