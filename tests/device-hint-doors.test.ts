import { createHash, createHmac } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { deviceHints, metricsDaily, players, type Player } from "@/db/schema";
import { forgetHintAction, hintsOffAction } from "@/actions/deviceHints";
import { signOutAction, thatsMeAction, verifyRestoreCode } from "@/actions/identity";
import { joinAction } from "@/actions/slots";
import { GET as telegramLogin } from "@/app/api/telegram/login/route";
import { POST as miniAppSignIn } from "@/app/api/telegram/miniapp/route";
import { createEvent } from "@/lib/domain/events";
import { issueEmailCode } from "@/lib/domain/identity";
import { createPlayer } from "@/lib/domain/players";
import { joinEvent } from "@/lib/domain/slots";
import { canonicalSignals, cleanSignals, SIGNALS_COOKIE, type SignalsWire } from "@/lib/domain/hintSignals";
import { saveDeviceHint } from "@/lib/domain/deviceHints";
import { dayKey } from "@/lib/domain/metrics";
import { hintKey } from "@/lib/deviceHint";
import { PLAYER_COOKIE, sealPlayerId } from "@/lib/session";
import { asAction } from "./helpers/action";
import { freezeClock } from "./helpers/clock";

/**
 * Every door keeps the device hint in the request of the act itself (the owner's decision of 28 October
 * 2026): a join of the player's own record, the email code, "That's me" (a session by name saves too), a
 * Telegram sign-in by the login widget (its values ride in a one-minute cookie) and by the Mini App. Never
 * for a browser in a European zone. Each door is called the way the browser calls it.
 */
const PHONE: SignalsWire = { w: 390, h: 844, dpr: 3, langs: ["en-US"], tz: "Asia/Bangkok", platform: "iphone", touch: 5, text: 17, motion: false };
const EUROPE: SignalsWire = { ...PHONE, tz: "Europe/Madrid" };
const BOT = "123456:test-bot-token-for-device-hints";
/** Every fixture below counts from this instant, never from the calendar (rule 11). */
const NOW = new Date(Date.UTC(2026, 9, 28, 5, 0));
freezeClock(NOW);

describe("the doors keep a device hint", () => {
  let db: Db;
  let org: Player;
  let code: string;
  const hintsOf = async (playerId: string) => db.select().from(deviceHints).where(eq(deviceHints.playerId, playerId));

  beforeAll(async () => {
    db = await getDb();
    org = await createPlayer(db, { displayName: "Org", locale: "en", email: "org@example.com" });
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() + 2 * 86_400_000), tz: "Asia/Bangkok", venueName: "Rawai Padel", whenFull: "waitlist" });
    code = ev.code;
  });

  it("a join keeps it outside Europe, and nothing in Europe", async () => {
    const ana = await createPlayer(db, { displayName: "Ana", locale: "en" });
    const bo = await createPlayer(db, { displayName: "Bo", locale: "en" });
    const joined = await asAction({ [PLAYER_COOKIE]: sealPlayerId(ana.id) }, () => joinAction(code, undefined, undefined, undefined, { hint: PHONE }));
    expect(joined.result).toMatchObject({ ok: true });
    expect((await hintsOf(ana.id)).map((h) => h.label)).toEqual(["iPhone"]);
    const fromEurope = await asAction({ [PLAYER_COOKIE]: sealPlayerId(bo.id) }, () => joinAction(code, undefined, undefined, undefined, { hint: EUROPE }));
    expect(fromEurope.result).toMatchObject({ ok: true });
    expect(await hintsOf(bo.id)).toHaveLength(0);
  });

  it("\"That's me\" keeps it for the record it signs in by name", async () => {
    const tina = await createPlayer(db, { displayName: "Tina", locale: "en" });
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() + 3 * 86_400_000), tz: "Asia/Bangkok", venueName: "Kata Padel", whenFull: "waitlist" });
    await joinEvent(db, { eventId: ev.id, playerId: tina.id });
    const signed = await asAction({}, () => thatsMeAction(ev.code, "Tina", PHONE));
    expect(signed.result).toMatchObject({ ok: true });
    expect(signed.cookies[PLAYER_COOKIE]).toBe(sealPlayerId(tina.id, { byName: true }));
    expect(await hintsOf(tina.id)).toHaveLength(1);
  });

  it("the email code keeps it for the record the code signs in", async () => {
    const cy = await createPlayer(db, { displayName: "Cy", locale: "en", email: "cy@example.com" });
    const issued = await issueEmailCode(db, "cy@example.com");
    const signed = await asAction({}, () => verifyRestoreCode("cy@example.com", issued!.code, PHONE));
    expect(signed.result).toMatchObject({ ok: true });
    expect(await hintsOf(cy.id)).toHaveLength(1);
  });

  it("the Telegram login widget reads the one-minute cookie, keeps the hint and deletes the cookie", async () => {
    process.env.TELEGRAM_BOT_TOKEN = BOT;
    const fields: Record<string, string> = { id: "777001", first_name: "Dee", auth_date: String(Math.floor(Date.now() / 1000)) };
    const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
    fields.hash = createHmac("sha256", createHash("sha256").update(BOT).digest()).update(check).digest("hex");
    const url = `http://localhost/api/telegram/login?${new URLSearchParams(fields)}`;
    const { result: res } = await asAction({ [SIGNALS_COOKIE]: encodeURIComponent(JSON.stringify(PHONE)) }, () => telegramLogin(new Request(url)));
    expect(res.status).toBe(303);
    const [dee] = await db.select().from(players).where(eq(players.telegramId, 777001));
    expect(await hintsOf(dee.id)).toHaveLength(1);
    expect(res.headers.get("set-cookie") ?? "").toMatch(new RegExp(`${SIGNALS_COOKIE}=;.*Path=/api/telegram/login`, "i"));
    // Without the cookie the sign-in still works, and keeps nothing.
    const other: Record<string, string> = { id: "777002", first_name: "Eli", auth_date: String(Math.floor(Date.now() / 1000)) };
    const check2 = Object.keys(other).sort().map((k) => `${k}=${other[k]}`).join("\n");
    other.hash = createHmac("sha256", createHash("sha256").update(BOT).digest()).update(check2).digest("hex");
    const { result: plain } = await asAction({}, () => telegramLogin(new Request(`http://localhost/api/telegram/login?${new URLSearchParams(other)}`)));
    expect(plain.status).toBe(303);
    const [eli] = await db.select().from(players).where(eq(players.telegramId, 777002));
    expect(await hintsOf(eli.id)).toHaveLength(0);
  });

  it("the Mini App keeps it from the values in its own body", async () => {
    process.env.TELEGRAM_BOT_TOKEN = BOT;
    const fields: Record<string, string> = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 777003, first_name: "Fay" }) };
    const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
    fields.hash = createHmac("sha256", createHmac("sha256", "WebAppData").update(BOT).digest()).update(check).digest("hex");
    const body = JSON.stringify({ initData: new URLSearchParams(fields).toString(), hint: PHONE });
    const { result: res } = await asAction({}, () => miniAppSignIn(new Request("http://localhost/api/telegram/miniapp", { method: "POST", headers: { "content-type": "application/json" }, body })));
    expect(res.status).toBe(200);
    const [fay] = await db.select().from(players).where(eq(players.telegramId, 777003));
    expect(await hintsOf(fay.id)).toHaveLength(1);
  });

  it("\"Forget this phone\" takes one of the session's own rows, never another player's", async () => {
    const gus = await createPlayer(db, { displayName: "Gus", locale: "en" });
    const hal = await createPlayer(db, { displayName: "Hal", locale: "en" });
    await asAction({ [PLAYER_COOKIE]: sealPlayerId(gus.id) }, () => joinAction(code, undefined, undefined, undefined, { hint: PHONE }));
    await asAction({ [PLAYER_COOKIE]: sealPlayerId(hal.id) }, () => joinAction(code, undefined, undefined, undefined, { hint: PHONE }));
    const [halRow] = await hintsOf(hal.id);
    expect((await asAction({ [PLAYER_COOKIE]: sealPlayerId(gus.id) }, () => forgetHintAction(halRow.id))).result).toEqual({ ok: false, error: "invalid" });
    expect(await hintsOf(hal.id)).toHaveLength(1);
    const [gusRow] = await hintsOf(gus.id);
    // A session by name may forget one too: forgetting grants nothing.
    expect((await asAction({ [PLAYER_COOKIE]: sealPlayerId(gus.id, { byName: true }) }, () => forgetHintAction(gusRow.id))).result).toEqual({ ok: true, data: null });
    expect(await hintsOf(gus.id)).toHaveLength(0);
    expect((await asAction({}, () => forgetHintAction(halRow.id))).result).toMatchObject({ ok: false, error: "no_identity" });
  });

  it("\"Don't recognise my phones\": a full session sets and clears it; a session by name may not touch it", async () => {
    // Thai PDPA s.32 (DECIDING rule 40): the player's lasting objection to the key. A session by name proved
    // nothing (rule 34), so it may neither set the mark nor clear it.
    const ivo = await createPlayer(db, { displayName: "Ivo", locale: "en" });
    const markOf = async () => (await db.select({ off: players.hintsOff }).from(players).where(eq(players.id, ivo.id)))[0]?.off ?? null;
    await asAction({ [PLAYER_COOKIE]: sealPlayerId(ivo.id) }, () => joinAction(code, undefined, undefined, undefined, { hint: PHONE }));
    expect(await hintsOf(ivo.id)).toHaveLength(1);
    const byName = { [PLAYER_COOKIE]: sealPlayerId(ivo.id, { byName: true }) };
    expect((await asAction(byName, () => hintsOffAction(true))).result).toEqual({ ok: false, error: "forbidden" });
    expect(await markOf()).toBeNull();
    expect(await hintsOf(ivo.id)).toHaveLength(1);
    const full = { [PLAYER_COOKIE]: sealPlayerId(ivo.id) };
    expect((await asAction(full, () => hintsOffAction(true))).result).toEqual({ ok: true, data: { off: true } });
    expect(await markOf()).not.toBeNull();
    expect(await hintsOf(ivo.id)).toHaveLength(0);
    // Every door now keeps nothing: the next join from the same phone saves no key.
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() + 4 * 86_400_000), tz: "Asia/Bangkok", venueName: "Chalong Padel", whenFull: "waitlist" });
    expect((await asAction(full, () => joinAction(ev.code, undefined, undefined, undefined, { hint: PHONE }))).result).toMatchObject({ ok: true });
    expect(await hintsOf(ivo.id)).toHaveLength(0);
    // The session by name cannot clear it either.
    expect((await asAction(byName, () => hintsOffAction(false))).result).toEqual({ ok: false, error: "forbidden" });
    expect(await markOf()).not.toBeNull();
    expect((await asAction(full, () => hintsOffAction(false))).result).toEqual({ ok: true, data: { off: false } });
    expect(await markOf()).toBeNull();
    expect((await asAction({}, () => hintsOffAction(true))).result).toMatchObject({ ok: false, error: "no_identity" });
  });
});

describe("\"Sign out on this browser\" forgets this browser's key", () => {
  // DECIDING, "A phone is never shared": the person who taps "Not you?" holds this phone, so a key saved
  // during a wrong sign-in belongs to that person, not to the record. Bob taps "That's me" on Tim's seat on
  // Bob's own phone: without this, Tim's record kept Bob's phone, and "Welcome back, Tim?" asked Bob again.
  let db: Db;
  const hintsOf = async (playerId: string) => db.select({ key: deviceHints.key }).from(deviceHints).where(eq(deviceHints.playerId, playerId));
  const metric = async (key: string) => Number((await db.select({ v: metricsDaily.value }).from(metricsDaily).where(and(eq(metricsDaily.day, dayKey(NOW)), eq(metricsDaily.key, key))))[0]?.v ?? 0);
  /** The key a browser's values make, by the key's own definition (never through the action's helper). */
  const keyOf = (values: SignalsWire) => hintKey(canonicalSignals(cleanSignals(values)!));
  /** Tim's own iPhone: another screen than Bob's, so another key. */
  const TIMS_PHONE: SignalsWire = { ...PHONE, w: 430, h: 932 };
  const keep = (playerId: string, values: SignalsWire) => saveDeviceHint(db, { playerId, key: keyOf(values), label: "iPhone", scope: null, now: NOW });

  beforeAll(async () => {
    db = await getDb();
  });

  it("deletes the key of this browser from the record it signs out of, and nothing else", async () => {
    const org = await createPlayer(db, { displayName: "Olga", locale: "en", email: "olga@example.com" });
    const tim = await createPlayer(db, { displayName: "Timo", locale: "en" });
    const ana = await createPlayer(db, { displayName: "Anya", locale: "en" });
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() + 5 * 86_400_000), tz: "Asia/Bangkok", venueName: "Rawai Padel", whenFull: "waitlist" });
    await joinEvent(db, { eventId: ev.id, playerId: tim.id });
    await keep(tim.id, TIMS_PHONE);
    // Another person's phone of the same model as Bob's: one key, on another record.
    await keep(ana.id, PHONE);
    // Bob, on his own phone, taps "That's me" on Tim's seat: the session is by name, and Tim's record keeps Bob's key.
    const signed = await asAction({}, () => thatsMeAction(ev.code, "Timo", PHONE));
    expect(signed.result).toMatchObject({ ok: true });
    expect((await hintsOf(tim.id)).map((h) => h.key).sort()).toEqual([keyOf(PHONE), keyOf(TIMS_PHONE)].sort());
    const [outBefore, forgotBefore] = [await metric("signout"), await metric("hint_signout")];
    const out = await asAction({ [PLAYER_COOKIE]: signed.cookies[PLAYER_COOKIE] }, () => signOutAction(null, { hint: PHONE }));
    expect(out.result).toEqual({ ok: true, data: null });
    expect(out.cookies[PLAYER_COOKIE]).toBeUndefined();
    // Bob's key left Tim's record; Tim's own phone stays, and so does the other record's row of Bob's key.
    expect((await hintsOf(tim.id)).map((h) => h.key)).toEqual([keyOf(TIMS_PHONE)]);
    expect((await hintsOf(ana.id)).map((h) => h.key)).toEqual([keyOf(PHONE)]);
    expect([await metric("signout"), await metric("hint_signout")]).toEqual([outBefore + 1, forgotBefore + 1]);
  });

  it("forgets nothing for a browser that sends no values, a European zone, or no session, and counts no forgotten key", async () => {
    const tim = await createPlayer(db, { displayName: "Timur", locale: "en" });
    const ana = await createPlayer(db, { displayName: "Anika", locale: "en" });
    const madrid: SignalsWire = { ...PHONE, tz: "Europe/Madrid" };
    await keep(tim.id, PHONE);
    // A row no door can write (a European browser keeps no key), put here by hand: the server makes no key
    // from European values at all, so even a row of exactly that key stays.
    await keep(tim.id, madrid);
    await keep(ana.id, PHONE);
    const forgotBefore = await metric("hint_signout");
    const session = { [PLAYER_COOKIE]: sealPlayerId(tim.id) };
    // No values at all (an old page), and values from a European zone, which a browser never sends but a script can.
    expect((await asAction(session, () => signOutAction())).result).toEqual({ ok: true, data: null });
    expect((await asAction(session, () => signOutAction(null, { hint: madrid }))).result).toEqual({ ok: true, data: null });
    expect((await hintsOf(tim.id)).map((h) => h.key).sort()).toEqual([keyOf(PHONE), keyOf(madrid)].sort());
    // A browser signed in as nobody leaves no record, so it takes no other record's row of its key.
    expect((await asAction({}, () => signOutAction(null, { hint: PHONE }))).result).toEqual({ ok: true, data: null });
    expect(await hintsOf(ana.id)).toHaveLength(1);
    expect(await metric("hint_signout")).toBe(forgotBefore);
  });

  it("forgets only the key that the values at the tap make: a key kept under other values stays, as the privacy page says", async () => {
    // The limit that privacy.keepBody names: the server finds a row only by the key of the values the
    // sign-out carries. A visitor joined in Phuket (Asia/Bangkok), and later the phone's text size, its
    // languages or its zone changed (Tokyo, or home to London, where it sends nothing). The row stays
    // until "Forget this phone" or the yearly prune, and no forgotten key is counted.
    const tim = await createPlayer(db, { displayName: "Timofey", locale: "en" });
    await keep(tim.id, PHONE);
    const forgotBefore = await metric("hint_signout");
    const session = { [PLAYER_COOKIE]: sealPlayerId(tim.id) };
    const changed: SignalsWire[] = [{ ...PHONE, text: 19 }, { ...PHONE, langs: ["en-US", "th-TH"] }, { ...PHONE, tz: "Asia/Tokyo" }, { ...PHONE, tz: "Europe/London" }];
    // Each value outside Europe is valid and makes a key of its own, so only the key stands between it and the row.
    for (const hint of changed.slice(0, 3)) {
      expect(cleanSignals(hint), JSON.stringify(hint)).not.toBeNull();
      expect(keyOf(hint), JSON.stringify(hint)).not.toBe(keyOf(PHONE));
    }
    for (const hint of changed) expect((await asAction(session, () => signOutAction(null, { hint }))).result).toEqual({ ok: true, data: null });
    expect((await hintsOf(tim.id)).map((h) => h.key)).toEqual([keyOf(PHONE)]);
    expect(await metric("hint_signout")).toBe(forgotBefore);
    // The same phone with the values of the save takes it off.
    expect((await asAction(session, () => signOutAction(null, { hint: PHONE }))).result).toEqual({ ok: true, data: null });
    expect(await hintsOf(tim.id)).toHaveLength(0);
    expect(await metric("hint_signout")).toBe(forgotBefore + 1);
  });

  it("forgets the key with the deployment's switch off too: a key kept before the switch still names this phone", async () => {
    const tim = await createPlayer(db, { displayName: "Timon", locale: "en" });
    await keep(tim.id, PHONE);
    const was = process.env.DEVICE_HINTS;
    process.env.DEVICE_HINTS = "off";
    try {
      expect((await asAction({ [PLAYER_COOKIE]: sealPlayerId(tim.id) }, () => signOutAction(null, { hint: PHONE }))).result).toEqual({ ok: true, data: null });
    } finally {
      if (was === undefined) delete process.env.DEVICE_HINTS;
      else process.env.DEVICE_HINTS = was;
    }
    expect(await hintsOf(tim.id)).toHaveLength(0);
  });
});
