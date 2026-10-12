import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { facts, passkeys, players, slots } from "@/db/schema";
import { anonymizePlayer } from "@/lib/domain/anonymize";
import { findDisposablePlayers, DISPOSABLE_AFTER_DAYS } from "@/lib/domain/disposable";
import { createEvent } from "@/lib/domain/events";
import { mergePlayers } from "@/lib/domain/merge";
import { completePasskeySignIn, hasPasskey, mayRegister, passkeyFold, passkeyLabel, passkeysOf, removePasskey, savePasskey } from "@/lib/domain/passkeys";
import { foldSameNameRows, proved, sameNameRows } from "@/lib/domain/sameName";
import { joinEvent } from "@/lib/domain/slots";
import { commitThatsMe, decideThatsMe, thatsMeRows } from "@/lib/domain/thatsMe";
import type { ThatsMeRefusal } from "@/lib/domain/thatsMe";
import { freezeClock } from "./helpers/clock";
import { createTestDb, DAY, makePlayer } from "./helpers/db";

/**
 * Passkeys, the owner's decision of 12 October 2026 (DECIDING rule 39): Face ID or a fingerprint signs
 * a player in from any browser on their phone. Three answers make the rules below:
 *   - "Only a proved browser": a session by name never saves one (`mayRegister`).
 *   - "Own record only": a sign-in signs in the passkey's record, and folds only the new record the
 *     browser made, when nothing proves or reaches that record and the merge is safe (`passkeyFold`).
 *   - A record with a passkey can prove itself, so "That's me" and "Are these yours?" never take it.
 */
const NOW = new Date(Date.UTC(2026, 9, 12, 4, 0));
freezeClock(NOW);
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

// ------------------------------------------------------------------ the rules, pure

describe("who may save a passkey", () => {
  const ana = { id: "00000000-0000-4000-8000-00000000000a", displayName: "Ana", personalToken: "tok" };
  it.each([
    ["a browser that made the record, or proved it (email code, Telegram, the personal link, a passkey)", { playerId: ana.id, byName: false }, ana, true],
    ["a browser that knows nobody", { playerId: null, byName: false }, null, false],
    ["a session by name (\"That's me\", a held place's link)", { playerId: ana.id, byName: true }, ana, false],
    ["a session whose record is somebody else's", { playerId: "00000000-0000-4000-8000-00000000000b", byName: false }, ana, false],
    ["a deleted account", { playerId: ana.id, byName: false }, { ...ana, displayName: "Deleted player", personalToken: null }, false],
  ] as const)("%s", (_label, session, player, ok) => {
    expect(mayRegister(session, player)).toBe(ok);
  });
});

describe("what a sign-in by passkey folds", () => {
  const owner = { id: "00000000-0000-4000-8000-0000000000a1", displayName: "Ana", email: "ana@example.com", telegramId: null };
  const mine = { id: "00000000-0000-4000-8000-0000000000b2", displayName: "Ana", email: null, telegramId: null, deleted: false };
  it("folds the new record this browser made, of the same name, that nothing proves or reaches", () => {
    expect(passkeyFold({ owner, current: mine, byName: false, held: null })).toEqual({ fold: true });
  });
  it.each([
    ["a browser that knew nobody", { current: null }, "no_session"],
    ["a session by name: a name is no proof the two are one", { byName: true }, "by_name"],
    ["the passkey's own record", { current: { ...mine, id: owner.id } }, "same_record"],
    ["a record that was deleted", { current: { ...mine, deleted: true } }, "gone"],
    ["a record of another name: it could be another person", { current: { ...mine, displayName: "Bo" } }, "not_same_person"],
  ] as const)("only switches the session for %s", (_label, change, why) => {
    expect(passkeyFold({ owner, current: mine, byName: false, held: null, ...change })).toEqual({ fold: false, why });
  });
  it.each(["email", "recovery_email", "phone", "telegram", "discord", "line", "push", "passkey", "coach_book", "coach_student", "claimed_club", "public_profile"] as ThatsMeRefusal[])("never folds a record with %s: it proves or reaches somebody", (held) => {
    expect(passkeyFold({ owner, current: mine, byName: false, held })).toEqual({ fold: false, why: held });
  });
});

describe("the words a passkey is listed under", () => {
  it.each([
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", "iPhone, Safari"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1", "iPhone, Chrome"],
    ["Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36", "Android, Samsung Internet"],
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36", "Android, Chrome"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", "Mac, Safari"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0", "Windows, Edge"],
    ["", null],
  ])("%s", (ua, label) => {
    expect(passkeyLabel(ua)).toBe(label);
  });
});

// ------------------------------------------------------------------ against the database

describe("passkeys in the database", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await createTestDb()));
  afterAll(() => close());

  let n = 0;
  const key = async (playerId: string, id = `cred-${++n}`) => {
    await savePasskey(db, { id, playerId, publicKey: "pk", counter: 0, transports: ["internal"], deviceType: "multiDevice", backedUp: true, label: "iPhone, Safari", now: NOW });
    return (await db.select().from(passkeys).where(eq(passkeys.id, id)))[0];
  };
  const match = async (people: { id: string }[]) => {
    const org = await makePlayer(db, `Org${++n}`, { email: `org${n}@example.com` });
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: at(2), tz: "Asia/Bangkok", whenFull: "waitlist" });
    await joinEvent(db, { eventId: ev.id, playerId: org.id, now: NOW });
    for (const p of people) await joinEvent(db, { eventId: ev.id, playerId: p.id, now: NOW });
    return ev;
  };
  const playerRow = async (id: string) => (await db.select().from(players).where(eq(players.id, id)))[0];

  it("\"That's me\" refuses a record with a passkey: it can prove itself (rule 34)", async () => {
    const dee = await makePlayer(db, "Dee");
    const ev = await match([dee]);
    expect((await thatsMeRows(db, ev, { name: "Dee", now: NOW })).find((r) => r.id === dee.id)?.passkey).toBe(false);
    await key(dee.id);
    const rows = await thatsMeRows(db, ev, { name: "Dee", now: NOW });
    expect(rows.find((r) => r.id === dee.id)?.passkey).toBe(true);
    expect(await decideThatsMe(db, { code: ev.code, name: "Dee", viewerId: null, rateKey: `rk-${n}`, now: NOW })).toEqual({ ok: false, reason: "passkey" });
  });

  it("\"That's me\" refuses a record that saved a passkey between the read and the write", async () => {
    const kim = await makePlayer(db, "Kim");
    const ev = await match([kim]);
    const d = await decideThatsMe(db, { code: ev.code, name: "Kim", viewerId: null, rateKey: `rk-kim-${n}`, now: NOW });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    await key(kim.id);
    expect(await commitThatsMe(db, d, { viewerId: null, now: NOW })).toEqual({ ok: false, reason: "nobody" });
  });

  it("\"Are these yours?\" never offers or folds a row of the same name that has a passkey", async () => {
    const proven = await makePlayer(db, "Eve", { email: "eve@example.com", emailVerifiedAt: NOW });
    const other = await makePlayer(db, "Eve");
    await match([proven, other]);
    expect((await sameNameRows(db, proven.id)).map((r) => r.id)).toEqual([other.id]);
    await key(other.id);
    expect(await sameNameRows(db, proven.id)).toEqual([]);
    expect(await foldSameNameRows(db, proven.id)).toEqual([]);
    expect(await playerRow(other.id)).toBeDefined();
    // And a passkey is not proof for that fold: a record with only a passkey proves nothing there.
    expect(proved(await playerRow(other.id))).toBe(false);
  });

  it("a merge moves the passkeys to the record that stays", async () => {
    const keep = await makePlayer(db, "Fay");
    const drop = await makePlayer(db, "Fay");
    const pk = await key(drop.id);
    await mergePlayers(db, keep.id, [drop.id]);
    expect(await playerRow(drop.id)).toBeUndefined();
    expect((await db.select().from(passkeys).where(eq(passkeys.id, pk.id)))[0]?.playerId).toBe(keep.id);
  });

  it("deleting an account removes its passkeys, though the row stays as \"Deleted player\"", async () => {
    const gil = await makePlayer(db, "Gil");
    await key(gil.id);
    await key(gil.id);
    expect((await passkeysOf(db, gil.id)).length).toBe(2);
    await anonymizePlayer(db, gil.id, NOW);
    expect((await playerRow(gil.id))?.displayName).toBe("Deleted player");
    expect(await passkeysOf(db, gil.id)).toEqual([]);
  });

  it("the 14-day removal keeps a row with a passkey, and a deleted row takes its passkeys with it", async () => {
    const hal = await makePlayer(db, "Hal");
    await db.update(players).set({ createdAt: new Date(NOW.getTime() - (DISPOSABLE_AFTER_DAYS + 1) * DAY) }).where(eq(players.id, hal.id));
    expect((await findDisposablePlayers(db, NOW)).map((r) => r.id)).toContain(hal.id);
    const pk = await key(hal.id);
    expect((await findDisposablePlayers(db, NOW)).map((r) => r.id)).not.toContain(hal.id);
    await db.delete(players).where(eq(players.id, hal.id));
    expect(await db.select().from(passkeys).where(eq(passkeys.id, pk.id))).toEqual([]);
  });

  it("a player removes their own passkey, never another's", async () => {
    const ivy = await makePlayer(db, "Ivy");
    const jon = await makePlayer(db, "Jon");
    const pk = await key(ivy.id);
    expect(await removePasskey(db, jon.id, pk.id)).toBe(false);
    expect(await hasPasskey(db, ivy.id)).toBe(true);
    expect(await removePasskey(db, ivy.id, pk.id)).toBe(true);
    expect(await hasPasskey(db, ivy.id)).toBe(false);
  });

  it("a sign-in signs in the passkey's own record and folds the new record this browser made", async () => {
    const ana = await makePlayer(db, "Ana", { email: "ana@example.com" });
    const pk = await key(ana.id);
    const newAna = await makePlayer(db, "Ana");
    const ev = await match([newAna]);
    const res = await completePasskeySignIn(db, { passkey: pk, newCounter: 3, session: { playerId: newAna.id, byName: false }, now: NOW });
    expect(res).toMatchObject({ ok: true, folded: true });
    expect(res.ok && res.player.id).toBe(ana.id);
    expect(await playerRow(newAna.id)).toBeUndefined();
    // The seat came across: one Ana in the match, and it is the passkey's record.
    const seats = await db.select().from(slots).where(and(eq(slots.eventId, ev.id), eq(slots.playerId, ana.id)));
    expect(seats.length).toBe(1);
    const [row] = await db.select().from(passkeys).where(eq(passkeys.id, pk.id));
    expect(row.counter).toBe(3);
    expect(row.lastUsedAt?.getTime()).toBe(NOW.getTime());
    const [fact] = await db.select().from(facts).where(and(eq(facts.kind, "player.passkey"), eq(facts.subjectId, ana.id)));
    expect(fact.data).toEqual({ folded: true });
  });

  it("where both records hold a place in one match, the passkey's record keeps one and the other is freed", async () => {
    const bea = await makePlayer(db, "Bea", { email: "bea@example.com" });
    const pk = await key(bea.id);
    const newBea = await makePlayer(db, "Bea");
    const ev = await match([bea, newBea]);
    const res = await completePasskeySignIn(db, { passkey: pk, newCounter: 0, session: { playerId: newBea.id, byName: false }, now: NOW });
    expect(res).toMatchObject({ ok: true, folded: true });
    expect(res.ok && res.seats.length).toBe(1);
    const taken = await db.select().from(slots).where(eq(slots.eventId, ev.id));
    expect(taken.filter((s) => s.playerId === bea.id).length).toBe(1);
    expect(taken.filter((s) => s.playerId === newBea.id).length).toBe(0);
  });

  /** A new record of the browser, then a sign-in: whether it folded, and the record is still there when not. */
  const signInOver = async (current: { id: string }, byName = false) => {
    const owner = await makePlayer(db, "Cy", { email: `cy${++n}@example.com` });
    const pk = await key(owner.id);
    const res = await completePasskeySignIn(db, { passkey: pk, newCounter: 0, session: { playerId: current.id, byName }, now: NOW });
    return { res, owner, stays: Boolean(await playerRow(current.id)) };
  };

  it("never folds a record the browser holds by name: the session only switches", async () => {
    const cy = await makePlayer(db, "Cy");
    const { res, owner, stays } = await signInOver(cy, true);
    expect(res).toMatchObject({ ok: true, folded: false });
    expect(res.ok && res.player.id).toBe(owner.id);
    expect(stays).toBe(true);
  });

  it("never folds a record that proves or reaches somebody: an email, a push subscription, a passkey of its own", async () => {
    const withEmail = await makePlayer(db, "Cy", { email: "other-cy@example.com" });
    expect((await signInOver(withEmail)).stays).toBe(true);
    const withPush = await makePlayer(db, "Cy");
    await db.insert(schema.pushSubscriptions).values({ playerId: withPush.id, endpoint: `https://push.example/${++n}`, p256dh: "k", auth: "a" });
    expect((await signInOver(withPush)).stays).toBe(true);
    const withKey = await makePlayer(db, "Cy");
    await key(withKey.id);
    expect((await signInOver(withKey)).stays).toBe(true);
  });

  it("never folds a record of another name, nor one that organises a match still to come", async () => {
    const bo = await makePlayer(db, "Bo");
    expect((await signInOver(bo)).stays).toBe(true);
    const org = await makePlayer(db, "Cy");
    await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: at(3), tz: "Asia/Bangkok", whenFull: "waitlist" });
    expect((await signInOver(org)).stays).toBe(true);
  });

  it("folds nothing else: a bare row of the same name elsewhere stays, as \"Nothing more\" says", async () => {
    const dot = await makePlayer(db, "Dot", { email: "dot@example.com", emailVerifiedAt: NOW });
    const pk = await key(dot.id);
    const elsewhere = await makePlayer(db, "Dot");
    await match([dot, elsewhere]);
    const res = await completePasskeySignIn(db, { passkey: pk, newCounter: 0, session: { playerId: null, byName: false }, now: NOW });
    expect(res).toMatchObject({ ok: true, folded: false });
    expect(await playerRow(elsewhere.id)).toBeDefined();
  });

  it("answers no for a passkey whose record was deleted", async () => {
    const gus = await makePlayer(db, "Gus");
    const pk = await key(gus.id);
    await db.update(players).set({ displayName: "Deleted player", personalToken: null }).where(eq(players.id, gus.id));
    expect(await completePasskeySignIn(db, { passkey: pk, newCounter: 0, session: { playerId: null, byName: false }, now: NOW })).toEqual({ ok: false });
  });
});
