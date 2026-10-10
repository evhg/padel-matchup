import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { facts, groupMembers, groups, players, slots } from "@/db/schema";
import { createEvent } from "@/lib/domain/events";
import { joinEvent } from "@/lib/domain/slots";
import { LIMITS } from "@/lib/domain/ratelimit";
import { commitThatsMe, decideThatsMe, nameOnlySession, placeRank, thatsMe, thatsMeOffer, thatsMeRows, thatsMeVerdict, whyNot, type ThatsMeRefusal, type ThatsMeRow } from "@/lib/domain/thatsMe";
import { normalName } from "@/lib/domain/dupes";
import { normalizeName } from "@/lib/domain/players";
import { freezeClock } from "./helpers/clock";
import { createTestDb, DAY, makePlayer } from "./helpers/db";

/**
 * The owner, 10 October 2026: "Yes, 'That's me' signs in." A browser that has never seen this person
 * signs in as their record by name, with no email and no code, when the record has nothing to prove
 * it and shares the match or the crew — and never past any of the limits below, every one of which
 * the owner required (DECIDING rule 32).
 */

// ------------------------------------------------------------------ the rule, as a table

const bare: ThatsMeRow = {
  id: "00000000-0000-4000-8000-00000000000a",
  name: "Ana",
  key: "ana",
  named: true,
  sameName: 1,
  inContext: true,
  organiser: false,
  coOrganiser: false,
  email: false,
  recoveryEmail: false,
  phone: false,
  telegram: false,
  discord: false,
  line: false,
  push: false,
  coachBook: false,
  coachStudent: false,
  claimedClub: false,
  publicProfile: false,
  organisesMatches: false,
  runsCrew: false,
  organisesEvents: false,
  inAskingGroup: false,
};

/** Each limit, alone: the record is bare in every other way, so the limit named is the only thing that refuses it. */
const LIMIT_TABLE: [string, Partial<ThatsMeRow>, ThatsMeRefusal | null][] = [
  ["a record with nothing to prove it, seated in this match", {}, null],
  ["the match's organiser", { organiser: true }, "organiser"],
  ["a co-organiser: an admin or the creator of the crew", { coOrganiser: true }, "co_organiser"],
  ["a record with an email", { email: true }, "email"],
  ["a record with a recovery email", { recoveryEmail: true }, "recovery_email"],
  ["a record with a phone", { phone: true }, "phone"],
  ["a record with a Telegram account", { telegram: true }, "telegram"],
  ["a record with a Discord account", { discord: true }, "discord"],
  ["a record with a LINE account", { line: true }, "line"],
  ["a record with a push subscription", { push: true }, "push"],
  ["a record with a coach's book, its own or one it runs", { coachBook: true }, "coach_book"],
  ["a record that claimed a club", { claimedClub: true }, "claimed_club"],
  ["a record with a public profile", { publicProfile: true }, "public_profile"],
  ["a coach's student: accepted on a list, or holding a lesson package", { coachStudent: true }, "coach_student"],
  ["a record that organises another match or tournament", { organisesMatches: true }, "organises_matches"],
  ["a record that created or runs another crew", { runsCrew: true }, "runs_a_crew"],
  ["a record that organises a series or a competition", { organisesEvents: true }, "organises_events"],
  ["a member of a group that asks to join", { inAskingGroup: true }, "asking_group"],
  ["a record with no part in this match or its crew", { inContext: false }, "no_context"],
  ["one of two records of the same name in this match or crew", { sameName: 2 }, "namesake"],
];

describe("who 'That's me' may sign in", () => {
  it.each(LIMIT_TABLE)("%s", (_label, change, reason) => {
    const row = { ...bare, ...change };
    expect(whyNot(row)).toBe(reason);
    const verdict = thatsMeVerdict([row]);
    // A record outside the match and crew is not even a candidate: the answer is that nobody is there.
    expect(verdict).toEqual(reason === null ? { ok: true, id: row.id, fold: false } : { ok: false, reason: reason === "no_context" ? "nobody" : reason });
  });

  it("offers neither of two records of the same name, even when only one of them could be signed in", () => {
    const other = { ...bare, id: "00000000-0000-4000-8000-00000000000b", email: true, sameName: 2 };
    expect(thatsMeVerdict([{ ...bare, sameName: 2 }, other])).toEqual({ ok: false, reason: "namesake" });
    // Two rows of the name are two people, whatever count came with them: the verdict counts them itself.
    expect(thatsMeVerdict([bare, { ...bare, id: "00000000-0000-4000-8000-00000000000c" }])).toEqual({ ok: false, reason: "namesake" });
  });

  it("finds nobody for a name nobody here carries", () => {
    expect(thatsMeVerdict([{ ...bare, named: false }])).toEqual({ ok: false, reason: "nobody" });
  });

  const mine: ThatsMeRow = { ...bare, id: "00000000-0000-4000-8000-0000000000ff", named: true, sameName: 2 };
  it("folds the browser's own new record into the old one, which its own row does not make a namesake", () => {
    expect(thatsMeVerdict([{ ...bare, sameName: 2 }, mine], mine.id)).toEqual({ ok: true, id: bare.id, fold: true });
  });

  it("refuses the fold when the browser's own record can be reached, or carries another name", () => {
    expect(thatsMeVerdict([{ ...bare, sameName: 2 }, { ...mine, email: true }], mine.id)).toEqual({ ok: false, reason: "email" });
    expect(thatsMeVerdict([{ ...bare, sameName: 2 }, { ...mine, push: true }], mine.id)).toEqual({ ok: false, reason: "push" });
    expect(thatsMeVerdict([bare, { ...mine, key: "anna", named: false, sameName: 1 }], mine.id)).toEqual({ ok: false, reason: "not_same_name" });
  });

  it("refuses the fold of a browser's own record that is not in this match or crew, or that runs or asks anything", () => {
    const old = { ...bare, sameName: 2 };
    // Outside the match and crew, the browser's record is not in the count: the old record is the one Ana there.
    expect(thatsMeVerdict([bare, { ...mine, inContext: false, sameName: 1 }], mine.id)).toEqual({ ok: false, reason: "no_context" });
    expect(thatsMeVerdict([old, { ...mine, inAskingGroup: true }], mine.id)).toEqual({ ok: false, reason: "asking_group" });
    expect(thatsMeVerdict([old, { ...mine, organiser: true }], mine.id)).toEqual({ ok: false, reason: "organiser" });
    expect(thatsMeVerdict([old, { ...mine, coOrganiser: true }], mine.id)).toEqual({ ok: false, reason: "co_organiser" });
    expect(thatsMeVerdict([old, { ...mine, organisesMatches: true }], mine.id)).toEqual({ ok: false, reason: "organises_matches" });
    expect(thatsMeVerdict([old, { ...mine, runsCrew: true }], mine.id)).toEqual({ ok: false, reason: "runs_a_crew" });
    expect(thatsMeVerdict([old, { ...mine, coachStudent: true }], mine.id)).toEqual({ ok: false, reason: "coach_student" });
  });

  it("ranks a place in a match: a seat taken over a seat held, a seat held over a waiting place", () => {
    expect(placeRank({ position: 2, status: "joined" }, 4)).toBeGreaterThan(placeRank({ position: 3, status: "invited" }, 4));
    expect(placeRank({ position: 3, status: "confirmed" }, 4)).toBe(placeRank({ position: 1, status: "joined" }, 4));
    expect(placeRank({ position: 3, status: "invited" }, 4)).toBeGreaterThan(placeRank({ position: 5, status: "joined" }, 4));
  });

  it("holds back the personal link of a session that came in by name until the record proves something", () => {
    const none = { emailVerifiedAt: null, telegramId: null, discordId: null, lineId: null, phone: null };
    expect(nameOnlySession(true, none)).toBe(true);
    expect(nameOnlySession(false, none)).toBe(false);
    expect(nameOnlySession(true, null)).toBe(false);
    expect(nameOnlySession(true, { ...none, emailVerifiedAt: new Date(0) })).toBe(false);
    expect(nameOnlySession(true, { ...none, telegramId: 42 })).toBe(false);
    expect(nameOnlySession(true, { ...none, discordId: "d" })).toBe(false);
    expect(nameOnlySession(true, { ...none, lineId: "l" })).toBe(false);
    expect(nameOnlySession(true, { ...none, phone: "+66810000000" })).toBe(false);
  });

  it("stores and compares a name composed, without invisible characters, and keeps an emoji whole", () => {
    expect(normalizeName("Jose\u0301")).toBe("Jos\u00e9");
    expect(normalizeName("A\u200Bna\u00AD")).toBe("Ana");
    expect(normalizeName("Ana \u{1F468}\u200D\u{1F469}")).toBe("Ana \u{1F468}\u200D\u{1F469}");
    expect(normalName("Jose\u0301")).toBe(normalName("JOS\u00c9"));
    expect(normalName("A\u200Bna")).toBe("ana");
  });

  it("treats a cookie whose record is gone as a browser that knows nobody", () => {
    expect(thatsMeVerdict([bare], "00000000-0000-4000-8000-0000000000ee")).toEqual({ ok: true, id: bare.id, fold: false });
  });
});

// ------------------------------------------------------------------ against the database

// A fixed clock (rule 11): every match a day or more after NOW.
const NOW = new Date(Date.UTC(2026, 9, 10, 4, 0));
const at = (days: number) => new Date(NOW.getTime() + days * DAY);
freezeClock(NOW);

describe("'That's me' on a real match", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  let n = 0;
  /** A match with an organiser who can be reached, and the players given seated in it. */
  const match = async (seated: { id: string }[], o: { groupId?: string } = {}) => {
    const org = await makePlayer(db, `Organiser ${++n}`, { email: `org${n}@example.com` });
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: at(1), tz: "Asia/Bangkok", whenFull: "waitlist", venueName: "Rawai Padel" });
    if (o.groupId) await db.update(schema.events).set({ groupId: o.groupId }).where(eq(schema.events.id, ev.id));
    await joinEvent(db, { eventId: ev.id, playerId: org.id, now: NOW });
    for (const p of seated) await joinEvent(db, { eventId: ev.id, playerId: p.id, now: NOW });
    return { ev: { ...ev, groupId: o.groupId ?? null }, org };
  };
  const crew = async (creatorId: string, askToJoin = false) => {
    const code = `C${String(++n).padStart(5, "0")}`;
    const [g] = await db.insert(groups).values({ code, name: `Crew ${n}`, creatorPlayerId: creatorId, tz: "Asia/Bangkok", askToJoin }).returning();
    return g;
  };
  const seatsOf = async (eventId: string, playerId: string) => (await db.select().from(slots).where(and(eq(slots.eventId, eventId), eq(slots.playerId, playerId)))).length;
  const key = () => `ip-${++n}`;

  it("signs a browser that knows nobody in as the record on the line-up, and records it without a name", async () => {
    const ana = await makePlayer(db, "Ana");
    const { ev } = await match([ana]);
    const res = await thatsMe(db, { code: ev.code, name: "  ana ", viewerId: null, rateKey: key() });
    expect(res).toMatchObject({ ok: true, folded: false, seats: null });
    expect(res.ok && res.player.id).toBe(ana.id);
    const [fact] = await db.select().from(facts).where(and(eq(facts.kind, "player.thats_me"), eq(facts.subjectId, ana.id)));
    expect(fact).toMatchObject({ code: ev.code, channel: "web", actorPlayerId: ana.id, data: { folded: false } });
    expect(JSON.stringify(fact.data)).not.toContain("Ana");
  });

  it("folds the record this browser made into the old one, and the seat moves with it", async () => {
    const admin = await makePlayer(db, "Crew admin", { email: "crew-admin@example.com" });
    const g = await crew(admin.id);
    const bo = await makePlayer(db, "Bo");
    await db.insert(groupMembers).values({ groupId: g.id, playerId: bo.id, role: "member" });
    // In a browser that never saw Bo, Bo typed the name and joined: a new record holding the seat.
    const fresh = await makePlayer(db, "bo");
    const { ev } = await match([fresh], { groupId: g.id });
    const res = await thatsMe(db, { code: ev.code, name: "Bo", viewerId: fresh.id, rateKey: key() });
    expect(res).toMatchObject({ ok: true, folded: true, seats: null });
    expect(res.ok && res.player.id).toBe(bo.id);
    expect((await db.select().from(players).where(eq(players.id, fresh.id))).length).toBe(0);
    expect(await seatsOf(ev.id, bo.id)).toBe(1);
  });

  /** The places of a match, in order, as "position status name". */
  const placesOf = async (eventId: string) =>
    (await db.select({ position: slots.position, status: slots.status, name: players.displayName }).from(slots).leftJoin(players, eq(players.id, slots.playerId)).where(eq(slots.eventId, eventId)).orderBy(slots.position)).map((x) => `${x.position} ${x.status} ${x.name ?? "-"}`);

  it("keeps the seat when the old record was waiting and the new one held the seat", async () => {
    const a = await makePlayer(db, `Ann${++n}`);
    const b = await makePlayer(db, `Ben${++n}`);
    const mine = await makePlayer(db, "Gus");
    const w = await makePlayer(db, `Wil${++n}`);
    const old = await makePlayer(db, "Gus");
    // Seats 1-4: the organiser, Ann, Ben and Gus's new record; Wil waits at 5 and Gus's old record at 6,
    // so only keeping the better place gives Gus his seat: freeing it would hand it to Wil.
    const { ev } = await match([a, b, mine, w, old]);
    expect(await placesOf(ev.id)).toEqual([expect.stringMatching(/^1 joined Organiser/), `2 joined ${a.displayName}`, `3 joined ${b.displayName}`, "4 joined Gus", `5 joined ${w.displayName}`, "6 joined Gus"]);
    const res = await thatsMe(db, { code: ev.code, name: "Gus", viewerId: mine.id, rateKey: key() });
    expect(res).toMatchObject({ ok: true, folded: true });
    expect(await placesOf(ev.id)).toEqual([expect.stringMatching(/^1 joined Organiser/), `2 joined ${a.displayName}`, `3 joined ${b.displayName}`, "4 joined Gus", `5 joined ${w.displayName}`]);
    expect(await seatsOf(ev.id, old.id)).toBe(1);
    expect((await db.select().from(slots).where(and(eq(slots.eventId, ev.id), eq(slots.playerId, old.id))))[0].position).toBe(4);
  });

  it("frees the second seat of one person through the leave path: the first waiting player moves up", async () => {
    const cy = await makePlayer(db, `Cyd${++n}`);
    const mine = await makePlayer(db, cy.displayName);
    const x = await makePlayer(db, `Xan${++n}`);
    const w = await makePlayer(db, `Wen${++n}`);
    const { ev } = await match([cy, mine, x, w]);
    const res = await thatsMe(db, { code: ev.code, name: cy.displayName, viewerId: mine.id, rateKey: key() });
    expect(res.ok).toBe(true);
    expect(res.ok && res.seats?.promotion?.playerId).toBe(w.id);
    const wen = (await db.select().from(slots).where(and(eq(slots.eventId, ev.id), eq(slots.playerId, w.id))))[0];
    expect(wen.position).toBeLessThanOrEqual(4);
    expect(await seatsOf(ev.id, cy.id)).toBe(1);
  });

  it("folds a new record seated beside the old one into it, so the line-up shows one row, not two", async () => {
    const cy = await makePlayer(db, "Cy");
    const fresh = await makePlayer(db, "Cy");
    const { ev } = await match([cy, fresh]);
    const res = await thatsMe(db, { code: ev.code, name: "Cy", viewerId: fresh.id, rateKey: key() });
    expect(res).toMatchObject({ ok: true, folded: true });
    const named = await db.select().from(slots).innerJoin(players, eq(players.id, slots.playerId)).where(and(eq(slots.eventId, ev.id), eq(players.displayName, "Cy")));
    expect(named.length).toBe(1);
    expect(named[0].players.id).toBe(cy.id);
  });

  /** One record called `name`, seated (or not) with `extra`, refused for `reason`. */
  const refuses = async (reason: ThatsMeRefusal, setUp: (p: { id: string }) => Promise<{ code: string } | void>, extra: Partial<typeof players.$inferInsert> = {}, seat = true) => {
    const name = `Dee${++n}`;
    const p = await makePlayer(db, name, extra);
    const custom = await setUp(p);
    const code = custom ? custom.code : (await match(seat ? [p] : [])).ev.code;
    const res = await thatsMe(db, { code, name, viewerId: null, rateKey: key() });
    expect(res).toEqual({ ok: false, reason });
  };
  const nothing = async () => undefined;

  it("never signs in the match's organiser", async () => {
    const org = await makePlayer(db, `Host${++n}`);
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: at(1), tz: "Asia/Bangkok", whenFull: "waitlist" });
    await joinEvent(db, { eventId: ev.id, playerId: org.id, now: NOW });
    expect(await thatsMe(db, { code: ev.code, name: org.displayName, viewerId: null, rateKey: key() })).toEqual({ ok: false, reason: "organiser" });
  });

  it("never signs in a co-organiser: an admin of the match's crew, or its creator", async () => {
    const creator = await makePlayer(db, `Founder${++n}`);
    const g = await crew(creator.id);
    const adm = await makePlayer(db, `Admin${++n}`);
    await db.insert(groupMembers).values([
      { groupId: g.id, playerId: creator.id, role: "admin" },
      { groupId: g.id, playerId: adm.id, role: "admin" },
    ]);
    const { ev } = await match([], { groupId: g.id });
    expect(await thatsMe(db, { code: ev.code, name: adm.displayName, viewerId: null, rateKey: key() })).toEqual({ ok: false, reason: "co_organiser" });
    // The crew's creator, made a plain member: the creator still organises.
    await db.update(groupMembers).set({ role: "member" }).where(eq(groupMembers.playerId, creator.id));
    expect(await thatsMe(db, { code: ev.code, name: creator.displayName, viewerId: null, rateKey: key() })).toEqual({ ok: false, reason: "co_organiser" });
  });

  it("never signs in a record with an email, a recovery email, a phone, a Telegram, Discord or LINE account", async () => {
    await refuses("email", nothing, { email: "dee@example.com" });
    await refuses("recovery_email", nothing, { recoveryEmail: "old@example.com" });
    await refuses("phone", nothing, { phone: "+66810000000" });
    await refuses("telegram", nothing, { telegramId: 9001 + n });
    await refuses("discord", nothing, { discordId: `d${n}` });
    await refuses("line", nothing, { lineId: `l${n}` });
  });

  it("never signs in a record with a push subscription, a coach's book, a claimed club or a public profile", async () => {
    await refuses("push", async (p) => {
      await db.insert(schema.pushSubscriptions).values({ playerId: p.id, endpoint: `https://push.example/${n}`, p256dh: "k", auth: "a" });
    });
    await refuses("coach_book", async (p) => {
      await db.insert(schema.coaches).values({ playerId: p.id, handle: `coach-${n}`, displayName: "Coach", tz: "Asia/Bangkok" });
    });
    await refuses("coach_book", async (p) => {
      const owner = await makePlayer(db, `Owner${++n}`);
      const [c] = await db.insert(schema.coaches).values({ playerId: owner.id, handle: `coach-${n}`, displayName: "Coach", tz: "Asia/Bangkok" }).returning();
      await db.insert(schema.coachManagers).values({ coachId: c.id, playerId: p.id });
    });
    await refuses("claimed_club", async (p) => {
      await db.insert(schema.clubs).values({ slug: `club-${n}`, name: "Club", manageToken: `tok-${n}`, claimedBy: p.id });
    });
    await refuses("public_profile", nothing, { publicProfile: true, publicSlug: `dee-${n}` });
  });

  it("never signs in a record that organises another match, or created or runs another crew: the cookie alone carries those powers", async () => {
    // Bob made match Y last week and sits in this one: as Bob, a stranger could cancel Y and read its invitees' contacts.
    await refuses("organises_matches", async (p) => {
      await createEvent(db, { creatorPlayerId: p.id, type: "match", startsAt: at(3), tz: "Asia/Bangkok", whenFull: "waitlist" });
    });
    await refuses("runs_a_crew", async (p) => {
      const g = await crew((await makePlayer(db, `Founder${++n}`, { email: `f${n}@example.com` })).id);
      await db.insert(groupMembers).values({ groupId: g.id, playerId: p.id, role: "admin" });
    });
    await refuses("runs_a_crew", async (p) => {
      await crew(p.id);
    });
  });

  it("never signs in a coach's student: accepted on a coach's list, or holding a lesson package", async () => {
    const coachOf = async () => {
      const owner = await makePlayer(db, `Coach${++n}`, { email: `coach${n}@example.com` });
      const [c] = await db.insert(schema.coaches).values({ playerId: owner.id, handle: `coach-${n}`, displayName: "Coach", tz: "Asia/Bangkok" }).returning();
      return c;
    };
    await refuses("coach_student", async (p) => {
      await db.insert(schema.coachStudents).values({ coachId: (await coachOf()).id, playerId: p.id, status: "accepted" });
    });
    await refuses("coach_student", async (p) => {
      await db.insert(schema.lessonPackages).values({ coachId: (await coachOf()).id, studentPlayerId: p.id, size: 10, amount: 5000, paidAt: NOW });
    });
  });

  it("never signs in a record that organises a series or a competition", async () => {
    await refuses("organises_events", async (p) => {
      await db.insert(schema.series).values({ slug: `open-${n}`, name: "Open", organizerPlayerId: p.id, tz: "Asia/Bangkok", capacity: 8, dow: 6, time: "18:00", anchorAt: at(7) });
    });
    await refuses("organises_events", async (p) => {
      await db.insert(schema.competitions).values({ slug: `cup-${n}`, name: "Cup", organizerPlayerId: p.id, tz: "Asia/Bangkok", startsOn: "2026-11-01", endsOn: "2026-11-02" });
    });
  });

  it("never signs in a member of a group that asks to join, wherever that group is", async () => {
    await refuses("asking_group", async (p) => {
      const owner = await makePlayer(db, `Ladies${++n}`, { email: `ladies${n}@example.com` });
      const g = await crew(owner.id, true);
      await db.insert(groupMembers).values({ groupId: g.id, playerId: p.id, role: "member" });
    });
  });

  it("never reaches across matches: a record with no seat, waiting place, invite or membership here is nobody", async () => {
    await refuses("nobody", nothing, {}, false);
    // A seat in another match of the same organiser is still not a part in this one.
    const elsewhere = await makePlayer(db, `Far${++n}`);
    await match([elsewhere]);
    const { ev } = await match([]);
    expect(await thatsMe(db, { code: ev.code, name: elsewhere.displayName, viewerId: null, rateKey: key() })).toEqual({ ok: false, reason: "nobody" });
  });

  it("offers neither of two records of the same name in one match or crew", async () => {
    const admin = await makePlayer(db, `Boss${++n}`, { email: `boss${n}@example.com` });
    const g = await crew(admin.id);
    const one = await makePlayer(db, "Eve");
    const two = await makePlayer(db, "EVE");
    await db.insert(groupMembers).values({ groupId: g.id, playerId: two.id, role: "member" });
    const { ev } = await match([one], { groupId: g.id });
    expect(await thatsMe(db, { code: ev.code, name: "Eve", viewerId: null, rateKey: key() })).toEqual({ ok: false, reason: "namesake" });
    // And the page, which reads the whole match and crew at once, puts "That's me" on neither row.
    const offer = await thatsMeOffer(db, ev, null, []);
    expect([one.id, two.id].filter((id) => offer.ids.has(id))).toEqual([]);
    expect(offer.names.filter((x) => /^eve$/i.test(x))).toEqual([]);
  });

  it("refuses the fold of a browser's own record from outside this match and crew, from an asking crew, or of its organiser", async () => {
    // (a) A Dee who belongs to an asking crew and has no part here: a name is no way into that crew for the other Dee.
    const ladies = await crew((await makePlayer(db, `Lady${++n}`, { email: `lady${n}@example.com` })).id, true);
    const outsider = await makePlayer(db, "Dee");
    await db.insert(groupMembers).values({ groupId: ladies.id, playerId: outsider.id, role: "member" });
    const dee = await makePlayer(db, "Dee");
    const m1 = await match([dee]);
    expect(await thatsMe(db, { code: m1.ev.code, name: "Dee", viewerId: outsider.id, rateKey: key() })).toEqual({ ok: false, reason: "no_context" });
    // (b) The same Dee seated here as well: in context now, and still a member of an asking crew.
    await joinEvent(db, { eventId: m1.ev.id, playerId: outsider.id, now: NOW });
    expect(await thatsMe(db, { code: m1.ev.code, name: "Dee", viewerId: outsider.id, rateKey: key() })).toEqual({ ok: false, reason: "asking_group" });
    // (c) The organiser's own browser, aiming at a namesake seated in the match.
    const eve = await makePlayer(db, `Eve${++n}`);
    const ev = await createEvent(db, { creatorPlayerId: eve.id, type: "match", startsAt: at(1), tz: "Asia/Bangkok", whenFull: "waitlist" });
    await joinEvent(db, { eventId: ev.id, playerId: eve.id, now: NOW });
    const other = await makePlayer(db, eve.displayName);
    await joinEvent(db, { eventId: ev.id, playerId: other.id, now: NOW });
    expect(await thatsMe(db, { code: ev.code, name: eve.displayName, viewerId: eve.id, rateKey: key() })).toEqual({ ok: false, reason: "organiser" });
    const [still] = await db.select().from(schema.events).where(eq(schema.events.id, ev.id));
    expect(still.creatorPlayerId).toBe(eve.id);
  });

  it("refuses the fold of a browser's own record that can be reached, and leaves both records as they were", async () => {
    const fi = await makePlayer(db, "Fi");
    const mine = await makePlayer(db, "Fi", { email: "fi@example.com" });
    const { ev } = await match([fi, mine]);
    expect(await thatsMe(db, { code: ev.code, name: "Fi", viewerId: mine.id, rateKey: key() })).toEqual({ ok: false, reason: "email" });
    expect(await seatsOf(ev.id, fi.id)).toBe(1);
    expect(await seatsOf(ev.id, mine.id)).toBe(1);
  });

  it("reads the record again before it signs in: an address that arrived in the same moment closes the door", async () => {
    const ida = await makePlayer(db, `Ida${++n}`);
    const { ev } = await match([ida]);
    const d = await decideThatsMe(db, { code: ev.code, name: ida.displayName, viewerId: null, rateKey: key() });
    expect(d.ok).toBe(true);
    // Ida confirms an email code on her phone between the rule's read and the sign-in.
    await db.update(players).set({ email: "ida@example.com", emailVerifiedAt: NOW }).where(eq(players.id, ida.id));
    expect(d.ok && (await commitThatsMe(db, d, { viewerId: null }))).toEqual({ ok: false, reason: "nobody" });
  });

  it("does no more than the page offers: a cancelled match signs nobody in", async () => {
    const fay = await makePlayer(db, `Fay${++n}`);
    const { ev } = await match([fay]);
    await db.update(schema.events).set({ status: "cancelled" }).where(eq(schema.events.id, ev.id));
    expect(await thatsMe(db, { code: ev.code, name: fay.displayName, viewerId: null, rateKey: key() })).toEqual({ ok: false, reason: "not_found" });
  });

  it("sees one name in 'José' typed two ways, and in a name with a zero-width space: neither is offered", async () => {
    const composed = await makePlayer(db, "Jos\u00e9");
    const decomposed = await makePlayer(db, "Jose\u0301");
    const { ev } = await match([composed, decomposed]);
    expect(await thatsMe(db, { code: ev.code, name: "Jos\u00e9", viewerId: null, rateKey: key() })).toEqual({ ok: false, reason: "namesake" });
    expect((await thatsMeOffer(db, ev, null, [])).ids.size).toBe(0);
    const ana = await makePlayer(db, `Lia${++n}`);
    const hidden = await makePlayer(db, ana.displayName.replace("ia", "i\u200Ba"));
    const two = await match([ana, hidden]);
    expect(await thatsMe(db, { code: two.ev.code, name: ana.displayName, viewerId: null, rateKey: key() })).toEqual({ ok: false, reason: "namesake" });
  });

  it("signs one record in by name a few times a day at most, from any number of addresses", async () => {
    const kim = await makePlayer(db, `Kim${++n}`);
    const { ev } = await match([kim]);
    for (let i = 0; i < LIMITS.thatsMePerRecordPerDay; i++) expect((await thatsMe(db, { code: ev.code, name: kim.displayName, viewerId: null, rateKey: key() })).ok).toBe(true);
    expect(await thatsMe(db, { code: ev.code, name: kim.displayName, viewerId: null, rateKey: key() })).toEqual({ ok: false, reason: "too_many" });
  });

  it("takes the rate before it answers, so names cannot be tried one after another", async () => {
    const gil = await makePlayer(db, "Gil");
    const { ev } = await match([gil]);
    const ip = key();
    for (let i = 0; i < LIMITS.thatsMePerIpPerDay; i++) expect((await thatsMe(db, { code: ev.code, name: `Guess${i}`, viewerId: null, rateKey: ip })).ok).toBe(false);
    expect(await thatsMe(db, { code: ev.code, name: "Gil", viewerId: null, rateKey: ip })).toEqual({ ok: false, reason: "too_many" });
    // Another address is not held back by this one.
    expect((await thatsMe(db, { code: ev.code, name: "Gil", viewerId: null, rateKey: key() })).ok).toBe(true);
  });

  it("reads only this line-up for a browser that knows nobody, and the page offers exactly what the tap allows", async () => {
    const admin = await makePlayer(db, `Lead${++n}`, { email: `lead${n}@example.com` });
    const g = await crew(admin.id);
    const hal = await makePlayer(db, "Hal");
    const ivy = await makePlayer(db, "Ivy", { email: "ivy@example.com" });
    const jo = await makePlayer(db, "Jo");
    await db.insert(groupMembers).values({ groupId: g.id, playerId: jo.id, role: "member" });
    const { ev, org } = await match([hal, ivy], { groupId: g.id });
    // The crew's Jo is not on this line-up: neither read for the page nor sent to it.
    const rows = await thatsMeRows(db, ev);
    expect(rows.map((r) => r.name).sort()).toEqual(["Hal", "Ivy", org.displayName].sort());
    const offer = await thatsMeOffer(db, ev, null, []);
    expect([...offer.ids]).toEqual([hal.id]);
    expect(offer.names).toEqual(["Hal"]);
    expect(offer.fold).toBeNull();
    // But a namesake in the crew still counts: a crew Hal makes the seated Hal one of two, and neither is offered.
    const crewHal = await makePlayer(db, "hal");
    await db.insert(groupMembers).values({ groupId: g.id, playerId: crewHal.id, role: "member" });
    expect((await thatsMeOffer(db, ev, null, [])).ids.size).toBe(0);
    await db.delete(groupMembers).where(eq(groupMembers.playerId, crewHal.id));
    // A browser that made its own "Jo" is offered the fold into the crew's Jo, and nobody else.
    const myJo = await makePlayer(db, "Jo");
    await joinEvent(db, { eventId: ev.id, playerId: myJo.id, now: NOW });
    const mineOffer = await thatsMeOffer(db, ev, myJo, ["Hal", "Ivy", "Jo"]);
    expect(mineOffer.fold).toEqual({ id: jo.id, name: "Jo" });
    // A browser signed in as a record with an address is offered nothing, and costs no read.
    expect(await thatsMeOffer(db, ev, ivy, ["Ivy"])).toMatchObject({ fold: null, names: [] });
  });
});
