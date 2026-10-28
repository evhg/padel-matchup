import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getDb, type Db } from "@/db";
import { events, metricsDaily, players, pushSubscriptions, type Player } from "@/db/schema";
import { deleteMyAccountAction, restoreIdentity, signOutAction } from "@/actions/identity";
import { passkeyCardAction } from "@/actions/passkeys";
import { subscribePushAction } from "@/actions/push";
import { savePushSubscription, subscriptionsFor } from "@/lib/domain/push";
import { POST as sessionRoute } from "@/app/api/me/session/route";
import { createEvent } from "@/lib/domain/events";
import { bumpMetrics, dayKey } from "@/lib/domain/metrics";
import { DELETED_PLAYER_NAME } from "@/lib/domain/result";
import { utcDay } from "@/lib/domain/browserSession";
import { phoneViewCounter } from "@/lib/source";
import {
  BY_NAME_COOKIE,
  grantManageAccess,
  HAS_ID_COOKIE,
  hasManageAccess,
  manageCookieName,
  markSignedInByName,
  ONE_YEAR,
  openRestoreSeal,
  PLAYER_COOKIE,
  restoreSeal,
  restoreSealForSession,
  sealPlayerId,
  sessionRenewDue,
  setSessionPlayer,
  SIGNED_OUT_COOKIE,
  unsealPlayerId,
} from "@/lib/session";
import { asAction } from "./helpers/action";
import { freezeClock } from "./helpers/clock";
import { DAY, makePlayer } from "./helpers/db";

/**
 * The owner's decisions of 28 October 2026, through the actions and the route a browser calls:
 *
 * - "A session by name ('That's me') can delete that player's account today ... Close this gap?" "Close it".
 * - "May a sign-in last one year after the last visit, and may every browser get 'Not you? Sign out'?"
 *   "Yes, both". A full sign-in gets a new year at most once in 30 days; a sign-in by name still ends a
 *   year after it began; a restore seal held from before a sign-out cannot sign the browser back in.
 * - The counters that come with them, each one upsert after the answer.
 */
const NOW = new Date("2026-10-28T09:00:00Z");
freezeClock(NOW);

let db: Db;
beforeAll(async () => {
  db = await getDb();
});
/** Today's value of a counter. */
const metric = async (key: string) => Number((await db.select().from(metricsDaily).where(and(eq(metricsDaily.day, dayKey(NOW)), eq(metricsDaily.key, key))))[0]?.value ?? 0);
const full = (p: Player) => ({ [PLAYER_COOKIE]: sealPlayerId(p.id) });
const byName = (p: Player) => ({ [PLAYER_COOKIE]: sealPlayerId(p.id, { byName: true }) });
const rowOf = async (p: Player) => (await db.select().from(players).where(eq(players.id, p.id)))[0];
const matchBy = (p: Player) => createEvent(db, { creatorPlayerId: p.id, type: "match", startsAt: new Date(NOW.getTime() + 3 * DAY), tz: "Asia/Bangkok", venueName: "Rawai Padel", whenFull: "waitlist" });
const statusOf = async (id: string) => (await db.select({ s: events.status }).from(events).where(eq(events.id, id)))[0]?.s;
/** A cookie the answer wrote, with its life and path. */
const wrote = (set: { name: string; value: string; maxAge?: number; path?: string }[], name: string) => set.find((c) => c.name === name && c.maxAge !== undefined);

describe("a session by name may not delete the account", () => {
  it("refuses a session by name, keeps the record and the matches it organises, and leaves the session as it was", async () => {
    const tim = await makePlayer(db, "Tim");
    const ev = await matchBy(tim);
    const { result, cookies } = await asAction(byName(tim), () => deleteMyAccountAction());
    expect(result).toEqual({ ok: false, error: "proof_required" });
    expect((await rowOf(tim)).displayName).toBe("Tim");
    expect(await statusOf(ev.id)).toBe("open");
    expect(cookies[PLAYER_COOKIE]).toBe(sealPlayerId(tim.id, { byName: true }));
  });

  it("still deletes for a full session: the record is emptied, its match called off, the cookies gone", async () => {
    const ana = await makePlayer(db, "Ana");
    const ev = await matchBy(ana);
    const { result, cookies } = await asAction(full(ana), () => deleteMyAccountAction());
    expect(result).toEqual({ ok: true, data: null });
    expect((await rowOf(ana)).displayName).toBe(DELETED_PLAYER_NAME);
    expect(await statusOf(ev.id)).toBe("cancelled");
    expect(cookies[PLAYER_COOKIE]).toBeUndefined();
  });

  it("deletes for a session by name once its record proved itself (an email code, Telegram)", async () => {
    const bo = await makePlayer(db, "Bo", { email: "bo@example.com", emailVerifiedAt: NOW });
    const { result } = await asAction(byName(bo), () => deleteMyAccountAction());
    expect(result).toEqual({ ok: true, data: null });
    expect((await rowOf(bo)).displayName).toBe(DELETED_PLAYER_NAME);
  });
});

describe("Not you? Sign out on this browser", () => {
  it("removes the session, its companion, the by-name mark and the manage cookie it is sent, stamps the moment, and counts it", async () => {
    const cy = await makePlayer(db, "Cy");
    const before = await metric("signout");
    const jar = { ...full(cy), [HAS_ID_COOKIE]: "1", [BY_NAME_COOKIE]: "x", [manageCookieName("AB2C")]: "y" };
    const { result, cookies, set } = await asAction(jar, () => signOutAction());
    expect(result).toEqual({ ok: true, data: null });
    for (const name of [PLAYER_COOKIE, HAS_ID_COOKIE, BY_NAME_COOKIE, manageCookieName("AB2C")]) expect(cookies[name], name).toBeUndefined();
    // The manage cookie lives on its match's own path, so it is deleted on that path, or the browser keeps it.
    expect(set.find((c) => c.name === manageCookieName("AB2C"))).toMatchObject({ value: "", path: "/AB2C", maxAge: 0 });
    expect(parseInt(cookies[SIGNED_OUT_COOKIE], 36)).toBe(NOW.getTime());
    expect(wrote(set, SIGNED_OUT_COOKIE)?.maxAge).toBe(ONE_YEAR);
    expect(await metric("signout")).toBe(before + 1);
  });

  it("refuses every restore seal the browser held from before, so nothing signs it back in", async () => {
    const dee = await makePlayer(db, "Dee");
    const { cookies: out } = await asAction(full(dee), () => signOutAction());
    const signedOut = { [SIGNED_OUT_COOKIE]: out[SIGNED_OUT_COOKIE] };
    // The seal the layout gave the signed-in browser, of either kind, and one of a sign-out before an earlier one.
    for (const seal of [restoreSeal(dee.id, false), restoreSeal(dee.id, true), restoreSeal(dee.id, false, { out: NOW.getTime() - 1 })]) {
      const { result, cookies } = await asAction(signedOut, () => restoreIdentity(seal));
      expect(result, seal).toEqual({ ok: true, data: false });
      expect(cookies[PLAYER_COOKIE], seal).toBeUndefined();
    }
  });

  it("takes the seal of a sign-in after the sign-out, and only while the browser keeps no older mark", async () => {
    const eve = await makePlayer(db, "Eve");
    const { cookies: out } = await asAction(full(eve), () => signOutAction());
    // Eve signs in again in this browser; the layout's seal carries the moment of the sign-out.
    const again = await asAction({ [SIGNED_OUT_COOKIE]: out[SIGNED_OUT_COOKIE] }, async () => {
      await setSessionPlayer(eve.id);
      return null;
    });
    const seal = (await asAction({ ...again.cookies }, () => restoreSealForSession(eve.id))).result;
    expect(openRestoreSeal(seal)).toEqual({ playerId: eve.id, byName: false, out: NOW.getTime(), until: 0 });
    // The cookie is lost, the mark is not: the seal brings Eve back.
    const back = await asAction({ [SIGNED_OUT_COOKIE]: out[SIGNED_OUT_COOKIE] }, () => restoreIdentity(seal));
    expect(back.result).toEqual({ ok: true, data: true });
    expect(unsealPlayerId(back.cookies[PLAYER_COOKIE])).toBe(eve.id);
    // A later sign-out shuts that seal too.
    const later = (NOW.getTime() + 1000).toString(36);
    expect((await asAction({ [SIGNED_OUT_COOKIE]: later }, () => restoreIdentity(seal))).result).toEqual({ ok: true, data: false });
  });

  it("shuts the manage cookies the browser held from before, which it could not delete, and opens one granted after", async () => {
    const before = await asAction({}, async () => grantManageAccess("AB2C", "secret-manage"));
    const old = { [manageCookieName("AB2C")]: before.cookies[manageCookieName("AB2C")] };
    expect((await asAction(old, () => hasManageAccess("AB2C", "secret-manage"))).result).toBe(true);
    const out = { [SIGNED_OUT_COOKIE]: NOW.getTime().toString(36) };
    expect((await asAction({ ...old, ...out }, () => hasManageAccess("AB2C", "secret-manage"))).result).toBe(false);
    // The organiser opens the manage link again after the sign-out: the new cookie carries the moment and works.
    const after = await asAction(out, async () => grantManageAccess("AB2C", "secret-manage"));
    const fresh: Record<string, string> = { [manageCookieName("AB2C")]: after.cookies[manageCookieName("AB2C")], ...out };
    expect((await asAction(fresh, () => hasManageAccess("AB2C", "secret-manage"))).result).toBe(true);
    // Another match's code or a changed signature opens nothing.
    expect((await asAction(fresh, () => hasManageAccess("AB2C", "other-manage"))).result).toBe(false);
    const forged = { ...fresh, [manageCookieName("AB2C")]: `${(NOW.getTime() + 5).toString(36)}.${fresh[manageCookieName("AB2C")].split(".")[1]}` };
    expect((await asAction(forged, () => hasManageAccess("AB2C", "secret-manage"))).result).toBe(false);
  });
});

describe("a sign-out ends this browser's notifications, and a session by name gets none", () => {
  // Every notification carries the player's personal link, a full sign-in: a subscription left on the
  // phone after "Not you? Sign out", or one a session by name made, signed the browser in as the player.
  const sub = (tag: string) => ({ endpoint: `https://push.example.com/send/${tag}-${randomUUID()}`, keys: { p256dh: "p256dh-key", auth: "auth-key" } });
  const endpointsOf = async (p: Player) => (await subscriptionsFor(db, [p.id])).map((r) => r.endpoint);
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("deletes this browser's subscription by its endpoint, by name or not, and leaves every other row", async () => {
    const tim = await makePlayer(db, "Tim");
    const ana = await makePlayer(db, "Ana");
    const phone = sub("phone");
    const other = sub("laptop");
    const anas = sub("ana");
    await savePushSubscription(db, tim.id, phone);
    await savePushSubscription(db, tim.id, other);
    await savePushSubscription(db, ana.id, anas);
    const { result } = await asAction(byName(tim), () => signOutAction(phone.endpoint));
    expect(result).toEqual({ ok: true, data: null });
    // The reminder run reads exactly this: the phone is gone, Tim's other browser and Ana's stay.
    expect(await endpointsOf(tim)).toEqual([other.endpoint]);
    expect(await endpointsOf(ana)).toEqual([anas.endpoint]);
    // A full session, and a browser whose row a session by name bound to another record: the endpoint alone decides.
    await asAction(full(ana), () => signOutAction(other.endpoint));
    expect(await endpointsOf(tim)).toEqual([]);
    expect(await endpointsOf(ana)).toEqual([anas.endpoint]);
  });

  it("signs out all the same with no endpoint, or one that is not a push address, and deletes nothing", async () => {
    const bo = await makePlayer(db, "Bo");
    const mine = sub("bo");
    await savePushSubscription(db, bo.id, mine);
    for (const endpoint of [null, undefined, "", "http://push.example.com/plain", `https://${"x".repeat(2048)}`]) {
      const { result, cookies } = await asAction(full(bo), () => signOutAction(endpoint));
      expect(result, String(endpoint)).toEqual({ ok: true, data: null });
      expect(cookies[PLAYER_COOKIE]).toBeUndefined();
    }
    expect(await endpointsOf(bo)).toEqual([mine.endpoint]);
  });

  it("refuses a subscription to a session by name that proved nothing, and takes one from a full session", async () => {
    vi.stubEnv("VAPID_PUBLIC_KEY", "test-public");
    vi.stubEnv("VAPID_PRIVATE_KEY", "test-private");
    const cy = await makePlayer(db, "Cy");
    const stranger = sub("stranger");
    expect((await asAction(byName(cy), () => subscribePushAction(stranger))).result).toEqual({ ok: false, error: "proof_required" });
    expect(await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, stranger.endpoint))).toEqual([]);
    const own = sub("cy");
    expect((await asAction(full(cy), () => subscribePushAction(own))).result).toEqual({ ok: true, data: null });
    expect(await endpointsOf(cy)).toEqual([own.endpoint]);
    // A session by name whose record proved itself (an email code) subscribes too.
    const dee = await makePlayer(db, "Dee", { email: "dee@example.com", emailVerifiedAt: NOW });
    expect((await asAction(byName(dee), () => subscribePushAction(sub("dee")))).result).toEqual({ ok: true, data: null });
  });
});

describe("a full sign-in lasts a year after the last visit, renewed at most once in 30 days", () => {
  const renew = (jar: Record<string, string>) => asAction(jar, () => sessionRoute(new Request("http://localhost/api/me/session?do=renew", { method: "POST" })));

  it("gives a full session whose year began 30 days ago or more a new year: the same value, today's day, counted", async () => {
    const fay = await makePlayer(db, "Fay");
    const counted = await metric("session_renewed");
    for (const day of ["1", utcDay(new Date(NOW.getTime() - 30 * DAY))]) {
      const jar = { ...full(fay), [HAS_ID_COOKIE]: day };
      expect((await asAction(jar, () => sessionRenewDue())).result, day).toBe(true);
      const { set } = await renew(jar);
      expect(wrote(set, PLAYER_COOKIE), day).toMatchObject({ value: sealPlayerId(fay.id), maxAge: ONE_YEAR });
      expect(wrote(set, HAS_ID_COOKIE), day).toMatchObject({ value: utcDay(NOW), maxAge: ONE_YEAR });
    }
    expect(await metric("session_renewed")).toBe(counted + 2);
  });

  it("writes nothing for a year that began under 30 days ago, a session by name, or no session", async () => {
    const gus = await makePlayer(db, "Gus");
    const counted = await metric("session_renewed");
    const recent = utcDay(new Date(NOW.getTime() - 29 * DAY));
    const old = utcDay(new Date(NOW.getTime() - 200 * DAY));
    for (const jar of [{ ...full(gus), [HAS_ID_COOKIE]: recent }, { ...byName(gus), [HAS_ID_COOKIE]: old }, { [HAS_ID_COOKIE]: old }]) {
      expect((await asAction(jar, () => sessionRenewDue())).result).toBe(false);
      const { set } = await renew(jar);
      expect(wrote(set, PLAYER_COOKIE)).toBeUndefined();
      expect(wrote(set, HAS_ID_COOKIE)).toBeUndefined();
    }
    expect(await metric("session_renewed")).toBe(counted);
  });

  it("dates km_has_id at every sign-in, which starts the year", async () => {
    const hal = await makePlayer(db, "Hal");
    const { set } = await asAction({}, () => setSessionPlayer(hal.id));
    expect(wrote(set, HAS_ID_COOKIE)).toMatchObject({ value: utcDay(NOW), maxAge: ONE_YEAR });
  });
});

describe("a sign-in by name ends a year after it began, also through the restore", () => {
  it("marks the end in the signed mark and the seal, and gives every cookie of the session that life", async () => {
    const ivy = await makePlayer(db, "Ivy");
    const { cookies, set } = await asAction({}, async () => {
      await setSessionPlayer(ivy.id);
      await markSignedInByName(ivy.id);
    });
    for (const name of [PLAYER_COOKIE, BY_NAME_COOKIE, HAS_ID_COOKIE]) expect(wrote(set, name)?.maxAge, name).toBe(ONE_YEAR);
    const seal = (await asAction(cookies, () => restoreSealForSession(ivy.id))).result;
    expect(openRestoreSeal(seal)).toEqual({ playerId: ivy.id, byName: true, out: 0, until: NOW.getTime() + ONE_YEAR * 1000 });
  });

  it("refuses a seal whose sign-in by name is over, and gives back only what is left of one that is not", async () => {
    const jo = await makePlayer(db, "Jo");
    const over = await asAction({}, () => restoreIdentity(restoreSeal(jo.id, true, { until: NOW.getTime() })));
    expect(over.result).toEqual({ ok: true, data: false });
    expect(over.cookies[PLAYER_COOKIE]).toBeUndefined();
    const left = await asAction({}, () => restoreIdentity(restoreSeal(jo.id, true, { until: NOW.getTime() + 2 * DAY })));
    expect(left.result).toEqual({ ok: true, data: true });
    expect(left.cookies[PLAYER_COOKIE]).toBe(sealPlayerId(jo.id, { byName: true }));
    for (const name of [PLAYER_COOKIE, BY_NAME_COOKIE, HAS_ID_COOKIE]) expect(wrote(left.set, name)?.maxAge, name).toBe(2 * 24 * 3600);
    // The end travels on: the seal of the restored browser carries the same end.
    const seal = (await asAction(left.cookies, () => restoreSealForSession(jo.id))).result;
    expect(openRestoreSeal(seal)?.until).toBe(NOW.getTime() + 2 * DAY);
  });

  it("refuses a seal whose end was changed by hand", async () => {
    const kai = await makePlayer(db, "Kai");
    const seal = restoreSeal(kai.id, true, { until: NOW.getTime() - 1 });
    const parts = seal.split(".");
    parts[4] = (NOW.getTime() + 100 * DAY).toString(36);
    expect((await asAction({}, () => restoreIdentity(parts.join(".")))).result).toEqual({ ok: true, data: false });
  });
});

describe("a signed cookie whose record is gone is ended and counted once", () => {
  const dead = (jar: Record<string, string>) => asAction(jar, () => sessionRoute(new Request("http://localhost/api/me/session?do=dead", { method: "POST" })));

  it("clears the cookies and counts session_dead, so the next visit has nothing to count", async () => {
    const before = await metric("session_dead");
    const gone = { [PLAYER_COOKIE]: sealPlayerId(randomUUID()), [HAS_ID_COOKIE]: "1" };
    const first = await dead(gone);
    expect(first.cookies[PLAYER_COOKIE]).toBeUndefined();
    expect(first.cookies[HAS_ID_COOKIE]).toBeUndefined();
    expect(await metric("session_dead")).toBe(before + 1);
    await dead(first.cookies);
    expect(await metric("session_dead")).toBe(before + 1);
  });

  it("ends a session whose account was deleted in another browser: the row stays, anonymous, and is no sign-in to renew", async () => {
    const mo = await makePlayer(db, "Mo");
    expect((await asAction(full(mo), () => deleteMyAccountAction())).result).toEqual({ ok: true, data: null });
    const before = await metric("session_dead");
    // The other browser still holds Mo's signed cookie, and the row is "Deleted player" now.
    const { cookies } = await dead({ ...full(mo), [HAS_ID_COOKIE]: "1" });
    expect(cookies[PLAYER_COOKIE]).toBeUndefined();
    expect(cookies[HAS_ID_COOKIE]).toBeUndefined();
    expect(await metric("session_dead")).toBe(before + 1);
  });

  it("leaves a live session alone", async () => {
    const lu = await makePlayer(db, "Lu");
    const before = await metric("session_dead");
    const { cookies } = await dead(full(lu));
    expect(cookies[PLAYER_COOKIE]).toBe(sealPlayerId(lu.id));
    expect(await metric("session_dead")).toBe(before);
  });
});

describe("the counters of one request, in one statement", () => {
  it("sums a key named twice, and writes nothing for no key", async () => {
    const before = await metric("test_bump_twice");
    await bumpMetrics(db, ["test_bump_twice", "test_bump_twice", "test_bump_once"]);
    await bumpMetrics(db, []);
    expect(await metric("test_bump_twice")).toBe(before + 2);
    expect(await metric("test_bump_once")).toBeGreaterThanOrEqual(1);
  });

  it("counts the passkey card from the browser: shown, and Not now, and refuses any other word", async () => {
    const shown = await metric("passkey_shown");
    const notNow = await metric("passkey_not_now");
    expect((await asAction({}, () => passkeyCardAction("shown"))).result).toEqual({ ok: true, data: null });
    expect((await asAction({}, () => passkeyCardAction("not_now"))).result).toEqual({ ok: true, data: null });
    expect((await asAction({}, () => passkeyCardAction("hacked" as never))).result).toEqual({ ok: false, error: "invalid" });
    expect(await metric("passkey_shown")).toBe(shown + 1);
    expect(await metric("passkey_not_now")).toBe(notNow + 1);
  });

  it("counts a phone's full load of a match still to come by whether its browser knows the viewer", () => {
    const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
    const samsung = "Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36";
    const view = (o: Partial<Parameters<typeof phoneViewCounter>[0]>) => phoneViewCounter({ ua: iphone, fullLoad: true, upcoming: true, known: false, ...o });
    expect(view({})).toBe("view_anon_ios_safari");
    expect(view({ known: true })).toBe("view_known_ios_safari");
    expect(view({ ua: samsung, known: true })).toBe("view_known_android_samsung");
    expect(view({ ua: `${iphone} Instagram 337.0` })).toBe("view_anon_other");
    // A computer, a link preview, a refresh, a match that started or was called off: nothing.
    expect(view({ ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36" })).toBeNull();
    expect(view({ ua: "WhatsApp/2.23.20.0 A" })).toBeNull();
    expect(view({ fullLoad: false })).toBeNull();
    expect(view({ upcoming: false })).toBeNull();
  });
});
