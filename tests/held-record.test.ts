import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { attachHeldRecordAction, confirmInviteAction, declineInviteAction, joinAction, reserveAction } from "@/actions/slots";
import { matchToPublic } from "@/lib/api/serialize";
import { handleWhatsappMessage } from "@/lib/whatsapp/bot";
import { personalTokenFor } from "@/actions/shared";
import { metricsDaily } from "@/db/schema";
import { dayKey } from "@/lib/domain/metrics";
import { PLAYER_COOKIE, sealPlayerId } from "@/lib/session";
import { asAction } from "./helpers/action";
import { events, facts, notices, players, slots, tournamentRounds, type Player, type Slot } from "@/db/schema";
import { createEvent } from "@/lib/domain/events";
import { anonymizePlayer } from "@/lib/domain/anonymize";
import { afterConfirm } from "@/lib/aftermath";
import {
  attachHeldRecord,
  decideHeldLink,
  heldLinkVerdict,
  heldRecordOf,
  heldRecordView,
  keepRecordFor,
  pastPlayerNamed,
  pastPlayerRows,
  pickable,
  provableHere,
  takeHeldLink,
  type PastPlayer,
} from "@/lib/domain/heldRecord";
import { joinWithPolicy } from "@/lib/domain/joining";
import { getEventByCode, playedIn } from "@/lib/domain/queries";
import { LIMITS, takeRate } from "@/lib/domain/ratelimit";
import { DELETED_PLAYER_NAME } from "@/lib/domain/result";
import { claimSlotPaid, confirmInvite, isHeldPlace, joinEvent, paymentsFor, removeFromSlot, reserveSlot } from "@/lib/domain/slots";
import type { ThatsMeRow } from "@/lib/domain/thatsMe";
import { generateRound } from "@/lib/domain/tournament";
import { freezeClock } from "./helpers/clock";
import { createTestDb, DAY, makePlayer } from "./helpers/db";

/**
 * The owner, 11 October 2026: "Danny now has two records. When you hold a place for a player who played
 * with you before, may the held place keep that player's record?" = "Yes, keep the record". "When you
 * pick a past player for a held place, the place keeps their record. Their personal link then signs
 * them in as that record, inside the "That's me" limits." (`src/lib/domain/heldRecord.ts`)
 */

// A fixed clock (rule 11): past matches 5 to 40 days before NOW, coming ones 1 to 6 days after it.
const NOW = new Date(Date.UTC(2026, 9, 11, 6, 0));
const at = (days: number) => new Date(NOW.getTime() + days * DAY);
freezeClock(NOW);

// ------------------------------------------------------------------ the rules, pure

const pp = (id: string, name: string, days: number): PastPlayer => ({ id, name, last: at(days) });

describe("who the picker offers, and which record a name finds", () => {
  const list = [pp("d1", "Danny", -28), pp("j1", "Jakob", -10), pp("a1", "Ana", -12), pp("a2", "ana", -30), pp("e1", "Erik", -5)];

  it("finds the one past player of a name, typed any way, and nobody for a name two of them carry", () => {
    expect(pastPlayerNamed(list, "  DANNY ")?.id).toBe("d1");
    expect(pastPlayerNamed(list, "Ana")).toBeNull();
    expect(pastPlayerNamed(list, "Bo")).toBeNull();
    expect(pastPlayerNamed(list, "")).toBeNull();
  });

  it("offers each name only one record carries, and nobody already in this match, by record or by name", () => {
    expect(pickable(list, { ids: new Set(), names: [] })).toEqual(["Danny", "Jakob", "Erik"]);
    expect(pickable(list, { ids: new Set(["j1"]), names: ["erik "] })).toEqual(["Danny"]);
  });

  it("offers \"Keep Danny's matches\" only on a place held by name, with no record and no phone, for a record not in the match", () => {
    const held: Pick<Slot, "kind" | "status" | "playerId" | "invitedName" | "invitedPhone"> = { kind: "reserved", status: "invited", playerId: null, invitedName: "danny", invitedPhone: null };
    expect(keepRecordFor(list, held, new Set())).toBe("Danny");
    expect(keepRecordFor(list, { ...held, invitedPhone: "+66810000000" }, new Set())).toBeNull();
    expect(keepRecordFor(list, { ...held, playerId: "x" }, new Set())).toBeNull();
    expect(keepRecordFor(list, { ...held, status: "declined" }, new Set())).toBeNull();
    expect(keepRecordFor(list, { ...held, kind: "open" }, new Set())).toBeNull();
    expect(keepRecordFor(list, { ...held, invitedName: "Ana" }, new Set()), "two past players of the name").toBeNull();
    expect(keepRecordFor(list, held, new Set(["d1"])), "Danny holds a place here already").toBeNull();
  });

  it("reads a held place as a place nobody took: reserved, invited or declined, on the line-up", () => {
    expect(isHeldPlace({ kind: "reserved", status: "invited", position: 3 }, 4)).toBe(true);
    expect(isHeldPlace({ kind: "reserved", status: "declined", position: 3 }, 4)).toBe(true);
    expect(isHeldPlace({ kind: "reserved", status: "confirmed", position: 3 }, 4)).toBe(false);
    expect(isHeldPlace({ kind: "open", status: "joined", position: 3 }, 4)).toBe(false);
    expect(isHeldPlace({ kind: "reserved", status: "invited", position: 5 }, 4)).toBe(false);
  });
});

const bare: ThatsMeRow = {
  id: "00000000-0000-4000-8000-00000000000d",
  name: "Danny",
  key: "danny",
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

describe("the personal link signs in as the record, inside the \"That's me\" limits", () => {
  it.each([
    ["old Danny: nothing to prove him, his place here", {}, null],
    ["a namesake beside him: the link names the record, not a name", { sameName: 2 }, null],
    // A declined place keeps the record, and "That's me" reads no declined place as a place in the match.
    ["his place declined: the place itself is his context", { inContext: false }, null],
    ["a record with an email", { email: true }, "email"],
    ["a record with a Telegram account", { telegram: true }, "telegram"],
    ["a record with a push subscription", { push: true }, "push"],
    ["a record that organises a match still to come", { organisesMatches: true }, "organises_matches"],
    ["a record that runs a crew", { runsCrew: true }, "runs_a_crew"],
    ["a member of a group that asks to join", { inAskingGroup: true }, "asking_group"],
    ["the match's organiser", { organiser: true }, "organiser"],
  ] as [string, Partial<ThatsMeRow>, string | null][])("%s", (_label, change, reason) => {
    expect(heldLinkVerdict({ ...bare, ...change })).toBe(reason);
  });

  it("finds nobody when the record's row did not come back", () => {
    expect(heldLinkVerdict(undefined)).toBe("nobody");
  });

  it("shows the record \"I'm in\", another record whose place it is, and a browser that knows nobody \"I'm in\" or the way to prove itself", () => {
    expect(heldRecordView("actions", "invited", "record", "email")).toBe("actions");
    expect(heldRecordView("actions", "invited", "other", null)).toBe("held_for");
    expect(heldRecordView("declined", "declined", "other", null)).toBe("open_again");
    expect(heldRecordView("actions", "invited", "nobody", null)).toBe("actions");
    expect(heldRecordView("declined", "declined", "nobody", null)).toBe("declined");
    // Only the views that offer "I'm in" change.
    expect(heldRecordView("confirmed", "confirmed", "other", null)).toBe("confirmed");
    expect(heldRecordView("cancelled", "cancelled", "nobody", "email")).toBe("cancelled");
  });

  // The page offers the email code and Telegram (`ReturningPlayer bare`). A record with a phone, a push
  // subscription or a match still to come has neither, so "Sign in first" would send it to a door it
  // cannot open: such a link says whose place it is and points at the organiser.
  it("asks a browser that knows nobody to sign in first only when the record can open the door the page offers", () => {
    for (const r of ["email", "recovery_email", "telegram"] as const) {
      expect(heldRecordView("actions", "invited", "nobody", r), r).toBe("sign_in_first");
      expect(heldRecordView("declined", "declined", "nobody", r), r).toBe("sign_in_first");
    }
    for (const r of ["phone", "discord", "line", "push", "coach_book", "coach_student", "claimed_club", "public_profile", "organises_matches", "runs_a_crew", "organises_events", "asking_group", "no_context", "nobody"] as const) {
      expect(heldRecordView("actions", "invited", "nobody", r), r).toBe("ask_organiser");
    }
    // A door the deployment does not run is no door (rule 4): with no email, an email record asks the organiser.
    const telegramOnly = provableHere({ email: false, telegram: true });
    expect(heldRecordView("actions", "invited", "nobody", "email", telegramOnly)).toBe("ask_organiser");
    expect(heldRecordView("actions", "invited", "nobody", "telegram", telegramOnly)).toBe("sign_in_first");
    expect(heldRecordView("actions", "invited", "nobody", "telegram", provableHere({ email: false, telegram: false }))).toBe("ask_organiser");
  });
});

// ------------------------------------------------------------------ against the database

describe("a held place that keeps a past player's record", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  let n = 0;
  const key = () => `ip-record-${++n}`;
  /** A match `creator` made, starting `days` from NOW, with `seated` taking seats in order; a past one is written straight to the row, as the sweep leaves it. */
  const made = async (creator: Player, days: number, seated: Player[] = [], o: { status?: "open" | "past" | "cancelled"; capacity?: number; type?: "match" | "tournament"; levelMin?: number; levelMax?: number } = {}) => {
    const ev = await createEvent(db, { creatorPlayerId: creator.id, type: o.type ?? "match", capacity: o.capacity, startsAt: at(Math.max(days, 1)), tz: "Asia/Bangkok", whenFull: "waitlist", venueName: "Kross Padel", levelMin: o.levelMin, levelMax: o.levelMax });
    for (const p of seated) await joinEvent(db, { eventId: ev.id, playerId: p.id, now: NOW });
    if (days < 1 || o.status) await db.update(events).set({ startsAt: at(days), status: o.status ?? (days < 0 ? "past" : "open") }).where(eq(events.id, ev.id));
    const [fresh] = await db.select().from(events).where(eq(events.id, ev.id));
    return fresh;
  };
  /** Production on 11 October 2026: old Danny made R8n7 on 13 September and Erik joined it as player 2; Erik now makes TDsv. */
  const owners = async () => {
    const erik = await makePlayer(db, `Erik ${++n}`, { email: `erik${n}@example.com` });
    const danny = await makePlayer(db, "Danny");
    await made(danny, -28, [danny, erik]);
    const tdsv = await made(erik, 6, [erik]);
    return { erik, danny, tdsv };
  };
  const placeOf = async (eventId: string, playerId: string) => (await db.select().from(slots).where(and(eq(slots.eventId, eventId), eq(slots.playerId, playerId))))[0];
  const dannys = async () => (await db.select({ id: players.id }).from(players).where(eq(players.displayName, "Danny"))).length;
  /** The organiser picks `name` from "Played with you": the record is found again from the name, as `reserveAction` finds it. */
  const pick = async (ev: { id: string; creatorPlayerId: string }, name: string) => {
    const record = pastPlayerNamed(await pastPlayerRows(db, ev.creatorPlayerId, NOW), name);
    return reserveSlot(db, { eventId: ev.id, actorPlayerId: ev.creatorPlayerId, name, playerId: record?.id ?? null, now: NOW });
  };

  it("lists the players of matches the organiser made or only joined: started, not called off, taken seats, never the organiser or a deleted account", async () => {
    const { erik, danny } = await owners();
    const [bo, cy, wait, gone, later, off] = await Promise.all(["Bo", "Cy", "Wes", "Gone", "Lia", "Off"].map((x) => makePlayer(db, `${x} ${n}`)));
    // Erik's own past match: Bo and Cy seated, Wes on the waiting list of a full match.
    const mine = await made(erik, 2, [erik, bo, cy, gone, wait], { capacity: 4 });
    await db.update(events).set({ startsAt: at(-12), status: "past" }).where(eq(events.id, mine.id));
    await db.update(players).set({ displayName: DELETED_PLAYER_NAME }).where(eq(players.id, gone.id));
    // A match to come, and one called off: neither counts.
    await made(erik, 3, [later]);
    await made(erik, -20, [off], { status: "cancelled" });
    const list = await pastPlayerRows(db, erik.id, NOW);
    expect(list.map((p) => p.id).sort()).toEqual([danny.id, bo.id, cy.id].sort());
    // Latest first: Bo and Cy played 12 days ago, Danny 28.
    expect(list.at(-1)?.id).toBe(danny.id);
    expect(list.find((p) => p.id === danny.id)?.last.getTime()).toBe(at(-28).getTime());
  });

  it("the owner's case: the place keeps old Danny's record, his link signs a browser that knows nobody in as him, no second Danny, and Erik hears \"Danny confirmed\"", async () => {
    const before = await dannys();
    const { erik, danny, tdsv } = await owners();
    const { slot } = await pick(tdsv, "Danny");
    expect(slot).toMatchObject({ playerId: danny.id, kind: "reserved", status: "invited", invitedName: "Danny" });
    // Not seated, not a payer, not played: the line-up still has three places to take.
    expect((await getEventByCode(db, tdsv.code))!.roster.filter((s) => s.status === "joined" || s.status === "confirmed").length).toBe(1);
    expect(await heldRecordOf(db, slot)).toBe(danny.id);

    const d = await decideHeldLink(db, { inviteCode: slot.inviteCode!, rateKey: key(), now: NOW });
    expect(d).toMatchObject({ ok: true, playerId: danny.id });
    if (!d || !d.ok) throw new Error("refused");
    const res = await takeHeldLink(db, d, NOW);
    expect(res.outcome).toBe("confirmed");
    if (res.outcome !== "confirmed") throw new Error(res.outcome);
    expect(await placeOf(tdsv.id, danny.id)).toMatchObject({ id: slot.id, status: "confirmed" });
    // One Danny: the record that played in September, never a new one.
    expect(await dannys()).toBe(before + 1);
    const [fact] = await db.select().from(facts).where(and(eq(facts.kind, "player.thats_me"), eq(facts.subjectId, danny.id)));
    expect(fact?.data).toEqual({ folded: false, via: "link" });
    await afterConfirm(db, res, danny, { wasComplete: false });
    const [line] = await db.select().from(notices).where(and(eq(notices.playerId, erik.id), eq(notices.key, "noticeItem.organizerFeed")));
    expect(line?.params).toMatchObject({ what: "confirmed", name: "Danny" });
  });

  it("the record's own browser confirms its place, and the place is not freed for the waiting list", async () => {
    const { danny, tdsv } = await owners();
    const [b, c, w] = await Promise.all(["Bea", "Cal", "Wil"].map((x) => makePlayer(db, `${x} ${n}`)));
    for (const p of [b, c, w]) await joinEvent(db, { eventId: tdsv.id, playerId: p.id, now: NOW });
    // Erik, Bea, Cal and Wil fill the four seats; Erik takes Wil out, holds the seat for Danny, and Wil waits.
    await removeFromSlot(db, { eventId: tdsv.id, slotId: (await placeOf(tdsv.id, w.id)).id, actorPlayerId: tdsv.creatorPlayerId, now: NOW });
    const { slot } = await pick(tdsv, "Danny");
    await joinEvent(db, { eventId: tdsv.id, playerId: w.id, now: NOW });
    expect((await placeOf(tdsv.id, w.id)).position).toBe(5);
    // Until 11 October 2026 the record found its own held place as "a place elsewhere in the match" and freed it.
    const res = await confirmInvite(db, { inviteCode: slot.inviteCode!, playerId: danny.id, now: NOW });
    expect(res.outcome).toBe("confirmed");
    expect(await placeOf(tdsv.id, danny.id)).toMatchObject({ id: slot.id, status: "confirmed", position: slot.position });
    expect((await placeOf(tdsv.id, w.id)).position, "Wil still waits").toBe(5);
  });

  it("a forwarded link refuses a browser that knows another record, and folds nothing into it", async () => {
    const { danny, tdsv } = await owners();
    const { slot } = await pick(tdsv, "Danny");
    // A stranger whose browser knows Victor, not in the match, and a namesake Danny seated in it.
    const victor = await makePlayer(db, `Victor ${n}`);
    await expect(confirmInvite(db, { inviteCode: slot.inviteCode!, playerId: victor.id, now: NOW })).rejects.toMatchObject({ code: "forbidden", message: "held_record" });
    const other = await makePlayer(db, "Danny");
    await joinEvent(db, { eventId: tdsv.id, playerId: other.id, now: NOW });
    await expect(confirmInvite(db, { inviteCode: slot.inviteCode!, playerId: other.id, now: NOW })).rejects.toMatchObject({ code: "forbidden" });
    expect(await placeOf(tdsv.id, danny.id)).toMatchObject({ id: slot.id, status: "invited" });
    expect((await db.select().from(players).where(eq(players.id, danny.id))).length).toBe(1);
    expect(await placeOf(tdsv.id, other.id)).toMatchObject({ status: "joined" });
  });

  it("a number the place was held for, writing JOIN from WhatsApp, takes no record that is not its own", async () => {
    const { danny, tdsv } = await owners();
    const { slot } = await pick(tdsv, "Danny");
    await db.update(slots).set({ invitedPhone: "+66810000001" }).where(eq(slots.id, slot.id));
    const wa = await makePlayer(db, `Wa ${n}`, { phone: "+66810000001" });
    await expect(confirmInvite(db, { inviteCode: slot.inviteCode!, playerId: wa.id, phone: "+66810000001", now: NOW })).rejects.toMatchObject({ code: "forbidden" });
    expect(await placeOf(tdsv.id, danny.id)).toMatchObject({ status: "invited" });
    expect((await db.select().from(players).where(eq(players.id, danny.id))).length).toBe(1);
  });

  it("a record with an email is not signed in by the link: it proves itself first, and no record is made", async () => {
    const before = (await db.select({ id: players.id }).from(players)).length;
    const erik = await makePlayer(db, `Erik ${++n}`, { email: `erik${n}@example.com` });
    const mia = await makePlayer(db, `Mia ${n}`, { email: `mia${n}@example.com` });
    await made(erik, -9, [erik, mia]);
    const tdsv = await made(erik, 4, [erik]);
    const { slot } = await pick(tdsv, mia.displayName);
    expect(slot.playerId).toBe(mia.id);
    expect(await decideHeldLink(db, { inviteCode: slot.inviteCode!, rateKey: key(), now: NOW })).toEqual({ ok: false, reason: "email" });
    expect((await db.select({ id: players.id }).from(players)).length).toBe(before + 2);
    // Once she proved it (an email code signs this browser in as Mia), her own tap confirms.
    expect((await confirmInvite(db, { inviteCode: slot.inviteCode!, playerId: mia.id, now: NOW })).outcome).toBe("confirmed");
  });

  it("a record that organises a match still to come is not signed in by the link; one that organised only past matches is", async () => {
    const { erik, danny, tdsv } = await owners();
    const { slot } = await pick(tdsv, "Danny");
    const coming = await made(danny, 3, [danny]);
    expect(await decideHeldLink(db, { inviteCode: slot.inviteCode!, rateKey: key(), now: NOW })).toEqual({ ok: false, reason: "organises_matches" });
    await db.update(events).set({ status: "cancelled" }).where(eq(events.id, coming.id));
    expect(await decideHeldLink(db, { inviteCode: slot.inviteCode!, rateKey: key(), now: NOW })).toMatchObject({ ok: true, playerId: danny.id });
    expect(erik.id).not.toBe(danny.id);
  });

  it("shares the \"That's me\" rates: the address's twenty taps a day, refused ones too, and three sign-ins a day into one record", async () => {
    const { tdsv } = await owners();
    const { slot } = await pick(tdsv, "Danny");
    const ip = key();
    for (let i = 0; i < LIMITS.thatsMePerIpPerDay; i++) await takeRate(db, "thatsme", ip, LIMITS.thatsMePerIpPerDay, "day", NOW);
    expect(await decideHeldLink(db, { inviteCode: slot.inviteCode!, rateKey: ip, now: NOW })).toEqual({ ok: false, reason: "too_many" });
    // The record's own rate, from three other addresses.
    for (let i = 0; i < LIMITS.thatsMePerRecordPerDay; i++) expect(await decideHeldLink(db, { inviteCode: slot.inviteCode!, rateKey: key(), now: NOW })).toMatchObject({ ok: true });
    expect(await decideHeldLink(db, { inviteCode: slot.inviteCode!, rateKey: key(), now: NOW })).toEqual({ ok: false, reason: "too_many" });
  });

  it("a tournament's placeholder works as before: no life outside the night, so the link folds it into whoever confirms", async () => {
    const org = await makePlayer(db, `Host ${++n}`, { email: `host${n}@example.com` });
    const night = await made(org, 2, [org], { type: "tournament", capacity: 4 });
    for (const name of ["Pat", "Quin", "Rui"]) await reserveSlot(db, { eventId: night.id, actorPlayerId: org.id, name, now: NOW });
    // Round 1 gives each held name a placeholder record.
    await generateRound(db, { eventId: night.id, actorPlayerId: org.id, now: NOW });
    expect((await db.select().from(tournamentRounds).where(eq(tournamentRounds.eventId, night.id))).length).toBe(1);
    const [held] = await db.select().from(slots).where(and(eq(slots.eventId, night.id), eq(slots.invitedName, "Pat")));
    expect(held.playerId).toBeTruthy();
    expect(await heldRecordOf(db, held)).toBeNull();
    expect(await decideHeldLink(db, { inviteCode: held.inviteCode!, rateKey: key(), now: NOW })).toBeNull();
    const pat = await makePlayer(db, "Pat");
    expect((await confirmInvite(db, { inviteCode: held.inviteCode!, playerId: pat.id, now: NOW })).outcome).toBe("confirmed");
    expect((await db.select().from(players).where(eq(players.id, held.playerId!))).length, "the placeholder folded into Pat").toBe(0);
  });

  it("refuses to hold a place for a record already in the match, cleanly, never by the index's error", async () => {
    const { danny, tdsv } = await owners();
    await joinEvent(db, { eventId: tdsv.id, playerId: danny.id, now: NOW });
    await expect(reserveSlot(db, { eventId: tdsv.id, actorPlayerId: tdsv.creatorPlayerId, name: "Danny", playerId: danny.id, now: NOW })).rejects.toMatchObject({ code: "invalid", message: "already_in" });
  });

  it("holds the place by name only when two past players carry the name", async () => {
    const { erik, tdsv } = await owners();
    const twin = await makePlayer(db, "danny");
    await made(erik, -15, [erik, twin]);
    const { slot } = await pick(tdsv, "Danny");
    expect(slot.playerId).toBeNull();
  });

  it("\"Keep Danny's matches\" hands a place held by name the record, and refuses a place with a phone or a record in the match", async () => {
    const { erik, danny, tdsv } = await owners();
    const { slot } = await reserveSlot(db, { eventId: tdsv.id, actorPlayerId: erik.id, name: "danny", now: NOW });
    expect(slot.playerId).toBeNull();
    expect(await attachHeldRecord(db, { eventId: tdsv.id, slotId: slot.id, organiserId: erik.id, now: NOW })).toEqual({ name: "Danny" });
    expect((await db.select().from(slots).where(eq(slots.id, slot.id)))[0].playerId).toBe(danny.id);
    // Asked again: the place has its record now.
    await expect(attachHeldRecord(db, { eventId: tdsv.id, slotId: slot.id, organiserId: erik.id, now: NOW })).rejects.toMatchObject({ code: "invalid" });
    const second = await made(erik, 5, [erik]);
    const { slot: phoned } = await reserveSlot(db, { eventId: second.id, actorPlayerId: erik.id, name: "Danny", phone: "+66810000002", now: NOW });
    await expect(attachHeldRecord(db, { eventId: second.id, slotId: phoned.id, organiserId: erik.id, now: NOW })).rejects.toMatchObject({ code: "invalid", message: "no_record" });
    const third = await made(erik, 5, [erik, danny]);
    const { slot: named } = await reserveSlot(db, { eventId: third.id, actorPlayerId: erik.id, name: "Danny", now: NOW });
    await expect(attachHeldRecord(db, { eventId: third.id, slotId: named.id, organiserId: erik.id, now: NOW })).rejects.toMatchObject({ code: "invalid", message: "no_record" });
  });

  it("every door's join takes the record's own held place, on a full match, and a ranged match does not turn it into a request", async () => {
    const erik = await makePlayer(db, `Erik ${++n}`, { email: `erik${n}@example.com` });
    const danny = await makePlayer(db, "Danny", { level: 1.5 });
    await made(danny, -28, [danny, erik]);
    // 3.0 to 4.0, Danny declared 1.5: outside the range, so a plain join would ask Erik.
    const tdsv = await made(erik, 6, [erik], { levelMin: 3, levelMax: 4 });
    const { slot } = await pick(tdsv, "Danny");
    const [b, c] = await Promise.all(["Bea", "Cal"].map((x) => makePlayer(db, `${x} ${n}`, { level: 3.5 })));
    for (const p of [b, c]) await joinEvent(db, { eventId: tdsv.id, playerId: p.id, now: NOW });
    const detail = (await getEventByCode(db, tdsv.code))!;
    expect(detail.roster.filter((s) => s.status === "empty" || s.status === "declined")).toHaveLength(0);
    const decision = await joinWithPolicy(db, detail, danny, danny.level);
    expect(decision).toMatchObject({ kind: "joined", result: { outcome: "joined" } });
    expect(await placeOf(tdsv.id, danny.id)).toMatchObject({ id: slot.id, status: "confirmed" });
  });

  it("on a fixed-pairs night, the record's join with a partner's name takes its own held place, and the partner's place sits beside it", async () => {
    const erik = await makePlayer(db, `Erik ${++n}`, { email: `erik${n}@example.com` });
    const danny = await makePlayer(db, "Danny");
    await made(danny, -28, [danny, erik]);
    const night = await made(erik, 6, [erik], { type: "tournament", capacity: 8 });
    await db.update(events).set({ fixedPairs: true }).where(eq(events.id, night.id));
    const { slot } = await pick(night, "Danny");
    const decision = await joinWithPolicy(db, (await getEventByCode(db, night.code))!, danny, null, "Zoe");
    expect(decision).toMatchObject({ kind: "joined", result: { outcome: "joined" } });
    const mine = await placeOf(night.id, danny.id);
    expect(mine, "Danny sits in the place Erik held for him").toMatchObject({ id: slot.id, status: "confirmed" });
    const [zoe] = await db.select().from(slots).where(and(eq(slots.eventId, night.id), eq(slots.invitedName, "Zoe")));
    expect(zoe).toMatchObject({ kind: "reserved", status: "invited", pairId: mine.pairId });
    expect(mine.pairId).toBeTruthy();
  });

  it("the link reads the record again before it signs in: a record that got an email since the decision is refused", async () => {
    const { danny, tdsv } = await owners();
    const { slot } = await pick(tdsv, "Danny");
    const d = await decideHeldLink(db, { inviteCode: slot.inviteCode!, rateKey: key(), now: NOW });
    if (!d || !d.ok) throw new Error("refused");
    await db.update(players).set({ email: `danny-late${n}@example.com` }).where(eq(players.id, danny.id));
    await expect(takeHeldLink(db, d, NOW)).rejects.toMatchObject({ code: "forbidden", message: "held_record" });
    expect(await placeOf(tdsv.id, danny.id)).toMatchObject({ id: slot.id, status: "invited" });
  });

  it("the public shape of the match shows a held place by its held name, with no level: the record has not joined", async () => {
    const erik = await makePlayer(db, `Erik ${++n}`, { email: `erik${n}@example.com` });
    const danny = await makePlayer(db, "Danny", { level: 3.5 });
    await made(danny, -28, [danny, erik]);
    const tdsv = await made(erik, 6, [erik]);
    // Erik typed "danny"; "Keep Danny's matches" gave the place the record that played in September.
    const { slot } = await reserveSlot(db, { eventId: tdsv.id, actorPlayerId: erik.id, name: "danny", now: NOW });
    await attachHeldRecord(db, { eventId: tdsv.id, slotId: slot.id, organiserId: erik.id, now: NOW });
    const shape = matchToPublic((await getEventByCode(db, tdsv.code))!, "https://kicksma.sh");
    expect(shape.players.find((p) => p.status === "invited")).toEqual({ name: "danny", level: null, organizer: false, status: "invited" });
    // Once he takes the place, he is a seated player, with his level.
    await confirmInvite(db, { inviteCode: slot.inviteCode!, playerId: danny.id, now: NOW });
    const after = matchToPublic((await getEventByCode(db, tdsv.code))!, "https://kicksma.sh");
    expect(after.players.find((p) => p.status === "confirmed")).toMatchObject({ name: "Danny", level: 3.5 });
  });

  it("a place nobody took is not a seat to readers: no payer, no \"removed\" notice, not played, and released on account deletion", async () => {
    const { erik, danny, tdsv } = await owners();
    await db.update(events).set({ cost: "400 THB" }).where(eq(events.id, tdsv.id));
    const { slot } = await pick(tdsv, "Danny");
    expect((await paymentsFor(db, tdsv.id)).map((p) => p.playerId)).toEqual([erik.id]);
    expect(await claimSlotPaid(db, { eventId: tdsv.id, playerId: danny.id }, NOW)).toBe(false);
    // Played: a match's held place nobody took was never played; a tournament's held name played round 1.
    const ev = (await db.select().from(events).where(eq(events.id, tdsv.id)))[0];
    expect(playedIn({ event: { ...ev, startsAt: at(-1), status: "past" }, slot })).toBe(false);
    expect(playedIn({ event: { ...ev, startsAt: at(-1), status: "past", type: "tournament" }, slot })).toBe(true);
    expect(playedIn({ event: { ...ev, startsAt: at(-1), status: "past" }, slot: { ...slot, status: "confirmed" } })).toBe(true);
    // The organiser cancels the held place: nobody hears "you were removed".
    const removed = await removeFromSlot(db, { eventId: tdsv.id, slotId: slot.id, actorPlayerId: erik.id, now: NOW });
    expect(removed.removedPlayerId).toBeNull();
    // Held again, then Danny deletes his account: the place goes, the way a leave goes.
    const again = await pick(tdsv, "Danny");
    expect(again.slot.playerId).toBe(danny.id);
    await anonymizePlayer(db, danny.id, NOW);
    const [after] = await db.select().from(slots).where(eq(slots.id, again.slot.id));
    expect(after).toMatchObject({ playerId: null, status: "empty" });
  });
});

// ------------------------------------------------------------------ through the actions, as a browser calls them

describe("the picker and the personal link, called as a browser calls them", () => {
  let app: Db;
  beforeAll(async () => {
    app = await getDb();
  });
  let n = 0;
  const as = (p: Player): Record<string, string> => ({ [PLAYER_COOKIE]: sealPlayerId(p.id) });
  /** Old Danny's September match, which Erik joined; then Erik's new match, Erik seated. */
  const owners = async (record: Partial<typeof players.$inferInsert> = {}) => {
    const erik = await makePlayer(app, `Erik ${++n}`, { email: `erik-app${n}@example.com` });
    const danny = await makePlayer(app, "Danny", record);
    const past = await createEvent(app, { creatorPlayerId: danny.id, type: "match", startsAt: at(1), tz: "Asia/Bangkok", whenFull: "waitlist", venueName: "Kross Padel" });
    for (const p of [danny, erik]) await joinEvent(app, { eventId: past.id, playerId: p.id, now: NOW });
    await app.update(events).set({ startsAt: at(-28), status: "past" }).where(eq(events.id, past.id));
    const tdsv = await createEvent(app, { creatorPlayerId: erik.id, type: "match", startsAt: at(6), tz: "Asia/Bangkok", whenFull: "waitlist", venueName: "Warehaus" });
    await joinEvent(app, { eventId: tdsv.id, playerId: erik.id, now: NOW });
    return { erik, danny, tdsv };
  };
  const dannys = async () => (await app.select({ id: players.id }).from(players).where(eq(players.displayName, "Danny"))).length;
  const everybody = async () => (await app.select({ id: players.id }).from(players)).length;
  const held = async (eventId: string) => (await app.select().from(slots).where(and(eq(slots.eventId, eventId), eq(slots.kind, "reserved"))))[0];

  it("the owner's case: Erik picks old Danny from \"Played with you\", the link signs a browser that knows nobody in as old Danny, by name, no second Danny, and Erik hears \"Danny confirmed\"", async () => {
    const { erik, danny, tdsv } = await owners();
    const picked = await asAction(as(erik), () => reserveAction(tdsv.code, { name: "Danny", pick: true }));
    expect(picked.result).toMatchObject({ ok: true, data: { name: "Danny" } });
    expect((await held(tdsv.id)).playerId).toBe(danny.id);
    const before = await dannys();
    const metric = async () => Number((await app.select().from(metricsDaily).where(and(eq(metricsDaily.day, dayKey()), eq(metricsDaily.key, "signin_held_link"))))[0]?.value ?? 0);
    const counted = await metric();

    // The phone's own browser, which never saw Danny; an email typed anyway is not kept on his record.
    const { result, cookies } = await asAction({}, () => confirmInviteAction(tdsv.code, picked.result.ok ? picked.result.data.inviteCode : "", { name: "Danny", email: "typed@example.com" }));
    expect(result).toEqual({ ok: true, data: { outcome: "confirmed" } });
    expect(cookies[PLAYER_COOKIE], "signed in as old Danny, marked by name").toBe(sealPlayerId(danny.id, { byName: true }));
    expect(await dannys(), "no second Danny").toBe(before);
    expect((await held(tdsv.id))).toMatchObject({ playerId: danny.id, status: "confirmed" });
    expect((await app.select().from(players).where(eq(players.id, danny.id)))[0].email).toBeNull();
    expect(await metric()).toBe(counted + 1);
    const [line] = await app.select().from(notices).where(and(eq(notices.playerId, erik.id), eq(notices.key, "noticeItem.organizerFeed")));
    expect(line?.params).toMatchObject({ what: "confirmed", name: "Danny" });
    // A session by name: no personal link from any screen until Danny proves something.
    const fresh = (await app.select().from(players).where(eq(players.id, danny.id)))[0];
    expect((await asAction(cookies, () => personalTokenFor(app, fresh))).result).toBeNull();
  });

  it("a link forwarded to a stranger whose browser knows another record is refused, and signs nobody in", async () => {
    const { erik, danny, tdsv } = await owners();
    const picked = await asAction(as(erik), () => reserveAction(tdsv.code, { name: "Danny", pick: true }));
    const code = picked.result.ok ? picked.result.data.inviteCode : "";
    const victor = await makePlayer(app, `Victor ${n}`);
    const { result, cookies } = await asAction(as(victor), () => confirmInviteAction(tdsv.code, code, {}));
    expect(result).toEqual({ ok: false, error: "forbidden", detail: "held_record" });
    expect(cookies[PLAYER_COOKIE], "the browser is still Victor").toBe(sealPlayerId(victor.id));
    expect(await held(tdsv.id)).toMatchObject({ playerId: danny.id, status: "invited" });
    expect((await app.select().from(players).where(eq(players.id, danny.id))).length, "Danny is not folded into Victor").toBe(1);
  });

  it("a record with an email: the link asks for its proof, sets no cookie and makes no record", async () => {
    const { erik, tdsv } = await owners({ email: `danny-app${n + 1}@example.com` });
    const picked = await asAction(as(erik), () => reserveAction(tdsv.code, { name: "Danny", pick: true }));
    const code = picked.result.ok ? picked.result.data.inviteCode : "";
    const before = await everybody();
    const { result, cookies } = await asAction({}, () => confirmInviteAction(tdsv.code, code, { name: "Danny" }));
    expect(result).toEqual({ ok: false, error: "forbidden", detail: "held_record" });
    expect(cookies[PLAYER_COOKIE]).toBeUndefined();
    expect(await everybody()).toBe(before);
    expect((await held(tdsv.id)).status).toBe("invited");
  });

  it("a name typed without the pick holds the place by name, as before", async () => {
    const { erik, tdsv } = await owners();
    await asAction(as(erik), () => reserveAction(tdsv.code, { name: "Danny" }));
    expect((await held(tdsv.id)).playerId).toBeNull();
  });

  // Anybody with the link may tap "Can't make it", and with nobody waiting the declined place keeps old
  // Danny. Until this fix the limits read the place as no part of the match ("no_context"), so the link
  // asked a bare record to sign in with an email it never had, and refused the tap.
  it("a place declined from a browser that knows nobody still keeps old Danny: the link then signs a fresh browser in as him, by name", async () => {
    const { erik, danny, tdsv } = await owners();
    const picked = await asAction(as(erik), () => reserveAction(tdsv.code, { name: "Danny", pick: true }));
    const code = picked.result.ok ? picked.result.data.inviteCode : "";
    expect((await asAction({}, () => declineInviteAction(tdsv.code, code))).result).toEqual({ ok: true, data: { outcome: "declined" } });
    expect(await held(tdsv.id)).toMatchObject({ playerId: danny.id, status: "declined" });
    const before = await dannys();
    const { result, cookies } = await asAction({}, () => confirmInviteAction(tdsv.code, code, {}));
    expect(result).toEqual({ ok: true, data: { outcome: "confirmed" } });
    expect(cookies[PLAYER_COOKIE], "signed in as old Danny, marked by name").toBe(sealPlayerId(danny.id, { byName: true }));
    expect(await dannys(), "no second Danny").toBe(before);
    expect(await held(tdsv.id)).toMatchObject({ playerId: danny.id, status: "confirmed" });
  });

  // DECIDING rule 34: a plain join must not seat a second record of a held place's name. "Keep Danny's
  // matches" put a record on the place, and the guard then read the place as a placeholder and let the
  // typed name make a second Danny and take a second seat.
  it("after \"Keep Danny's matches\", a typed Danny from a browser that knows nobody is refused: no second Danny, no second seat", async () => {
    const { erik, danny, tdsv } = await owners();
    await asAction(as(erik), () => reserveAction(tdsv.code, { name: "Danny" }));
    const place = await held(tdsv.id);
    expect((await asAction({}, () => joinAction(tdsv.code, "Danny"))).result, "held by name: refused already").toMatchObject({ ok: false, error: "name_held" });
    expect((await asAction(as(erik), () => attachHeldRecordAction(tdsv.code, place.id))).result).toEqual({ ok: true, data: { name: "Danny" } });
    const before = await dannys();
    const { result, cookies } = await asAction({}, () => joinAction(tdsv.code, " danny "));
    expect(result).toMatchObject({ ok: false, error: "name_held" });
    expect(cookies[PLAYER_COOKIE], "no record was made for the browser").toBeUndefined();
    expect(await dannys()).toBe(before);
    const taken = (await app.select().from(slots).where(eq(slots.eventId, tdsv.id))).filter((s) => s.status === "joined" || s.status === "confirmed");
    expect(taken.map((s) => s.playerId)).toEqual([erik.id]);
    expect(await held(tdsv.id)).toMatchObject({ id: place.id, playerId: danny.id, status: "invited" });
  });

  /** A WhatsApp message through the bot, with the channel on and the Cloud API faked; the environment is put back after. */
  const whatsapp = async (from: string, body: string): Promise<string> => {
    const keys = ["WHATSAPP_TOKEN", "WHATSAPP_PHONE_ID"] as const;
    const saved = keys.map((k) => process.env[k]);
    process.env.WHATSAPP_TOKEN = "t";
    process.env.WHATSAPP_PHONE_ID = "123";
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ messages: [{ id: "wamid.out" }] }), { status: 200 }));
    try {
      return await handleWhatsappMessage(app, { from, id: `wamid.held${++n}`, timestamp: "0", type: "text", text: { body } }, { profile: { name: "Danny" }, wa_id: from });
    } finally {
      vi.unstubAllGlobals();
      keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
    }
  };
  const takenIn = async (eventId: string) => (await app.select().from(slots).where(eq(slots.eventId, eventId))).filter((s) => s.status === "joined" || s.status === "confirmed");

  // The phone field stays in the reserve form after a chip tap. A place with a number is that number's
  // (the WhatsApp JOIN takes it), so it keeps no record, as "Keep Danny's matches" refuses one.
  it("a pick with a phone typed after it holds the place by name: the number's JOIN takes that place, and nobody takes a second one", async () => {
    const { erik, tdsv } = await owners();
    const number = `6681${String(7000000 + n).padStart(7, "0")}`;
    const picked = await asAction(as(erik), () => reserveAction(tdsv.code, { name: "Danny", pick: true, phone: `+${number}` }));
    expect(picked.result).toMatchObject({ ok: true });
    expect(await held(tdsv.id)).toMatchObject({ playerId: null, invitedPhone: `+${number}` });
    expect(await whatsapp(number, `JOIN ${tdsv.code}`)).toBe("wa:confirmed");
    const taken = await takenIn(tdsv.id);
    expect(taken).toHaveLength(2);
    expect(taken.find((s) => s.playerId !== erik.id)?.kind, "the number sits in the place held for it").toBe("reserved");
  });

  it("a JOIN from the number of a place that keeps a record is answered and stops there: never a second seat", async () => {
    const { erik, danny, tdsv } = await owners();
    await asAction(as(erik), () => reserveAction(tdsv.code, { name: "Danny", pick: true }));
    const place = await held(tdsv.id);
    // The row the picker left before this fix: a record and a number on one place.
    const number = `6681${String(8000000 + n).padStart(7, "0")}`;
    await app.update(slots).set({ invitedPhone: `+${number}` }).where(eq(slots.id, place.id));
    expect(await whatsapp(number, `JOIN ${tdsv.code}`)).toBe("wa:held_record");
    expect((await takenIn(tdsv.id)).map((s) => s.playerId)).toEqual([erik.id]);
    expect(await held(tdsv.id)).toMatchObject({ id: place.id, playerId: danny.id, status: "invited" });
  });
});
