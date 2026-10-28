import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { metricsDaily, players, type Player } from "@/db/schema";
import { restoreIdentity } from "@/actions/identity";
import { nameOnly } from "@/actions/shared";
import { createPlayer } from "@/lib/domain/players";
import { dayKey } from "@/lib/domain/metrics";
import { DELETED_PLAYER_NAME } from "@/lib/domain/result";
import { BY_NAME_COOKIE, markSignedInByName, openRestoreSeal, PLAYER_COOKIE, restoreSeal, restoreSealForSession, sealPlayerId, setSessionPlayer, signedInByName, unsealPlayerId } from "@/lib/session";
import { asAction } from "./helpers/action";

/**
 * The restore after a lost cookie (`IdentitySync` and `restoreIdentity`). Until 11 October 2026 it took
 * the raw player id that the browser kept in localStorage, and set the session cookie for any id it was
 * given, with no proof. The match page sends every seated player's id to every viewer of a started
 * match, so anybody could become anybody seated there, the organiser included. A restore now takes only
 * a value the server sealed for that player and for that purpose, and it gives back exactly the session
 * the lost cookie held: a sign-in by name (DECIDING rule 34) comes back marked by name.
 */
describe("restoring a lost session", () => {
  let db: Db;
  let ana: Player;
  let bo: Player;
  beforeAll(async () => {
    db = await getDb();
    ana = await createPlayer(db, { displayName: "Ana", locale: "en" });
    bo = await createPlayer(db, { displayName: "Bo", locale: "en" });
  });
  /** Today's count of the sign-in way "restore" (`countSignIn`). */
  const count = async () => Number((await db.select().from(metricsDaily).where(and(eq(metricsDaily.day, dayKey()), eq(metricsDaily.key, "signin_restore"))))[0]?.value ?? 0);

  /** A browser with no cookie at all hands `value` to the restore. */
  const restore = (value: unknown) => asAction({}, () => restoreIdentity(value as string));

  it("refuses a raw player id: no cookie, nothing counted", async () => {
    const before = await count();
    const { result, cookies } = await restore(ana.id);
    expect(result).toEqual({ ok: true, data: false });
    expect(cookies[PLAYER_COOKIE]).toBeUndefined();
    expect(await count()).toBe(before);
  });

  it("refuses a seal with one character changed, or cut short", async () => {
    const seal = restoreSeal(ana.id, false);
    const last = seal.slice(-1);
    for (const bad of [seal.slice(0, -1) + (last === "A" ? "B" : "A"), seal.slice(0, -4), `${seal}x`, seal.replace(ana.id, bo.id), "", null, 42, { id: ana.id }]) {
      const { result, cookies } = await restore(bad);
      expect(result, String(bad)).toEqual({ ok: true, data: false });
      expect(cookies[PLAYER_COOKIE]).toBeUndefined();
    }
  });

  it("refuses another player's seal turned into this player's, and a seal made for another purpose", async () => {
    // Bo's own seal with Ana's id put in its place: the signature is Bo's, so it opens nothing.
    const bos = restoreSeal(bo.id, false);
    expect((await restore(bos.replace(bo.id, ana.id))).result).toEqual({ ok: true, data: false });
    // The session cookie's own value is sealed by the same secret for another purpose: it is no restore.
    expect((await restore(sealPlayerId(ana.id))).result).toEqual({ ok: true, data: false });
    expect((await restore(sealPlayerId(ana.id, { byName: true }))).result).toEqual({ ok: true, data: false });
    // A by-name seal with its mark turned into a full one is a forgery.
    const byName = restoreSeal(ana.id, true);
    expect((await restore(byName.replace(".n.", ".p."))).result).toEqual({ ok: true, data: false });
  });

  it("accepts the right seal: the browser is that player again, and the restore is counted", async () => {
    const before = await count();
    const { result, cookies } = await restore(restoreSeal(ana.id, false));
    expect(result).toEqual({ ok: true, data: true });
    expect(unsealPlayerId(cookies[PLAYER_COOKIE])).toBe(ana.id);
    expect(cookies[BY_NAME_COOKIE]).toBeUndefined();
    expect(await count()).toBe(before + 1);
    // The answer carries no address, no name and no id: only that it worked.
    expect(JSON.stringify(result)).not.toContain(ana.id);
  });

  it("gives back a sign-in by name as a sign-in by name, never as a full one", async () => {
    const { result, cookies } = await restore(restoreSeal(bo.id, true));
    expect(result).toEqual({ ok: true, data: true });
    expect(unsealPlayerId(cookies[PLAYER_COOKIE])).toBe(bo.id);
    // In the restored browser the session still reads as by name, so My matches holds the personal link back.
    const after = await asAction(cookies, async () => ({ byName: await signedInByName(bo.id), held: await nameOnly(bo) }));
    expect(after.result).toEqual({ byName: true, held: true });
  });

  it("keeps the by-name mark inside the session cookie, so dropping the mark cookie upgrades nothing", async () => {
    const { cookies } = await restore(restoreSeal(bo.id, true));
    const dropped = { [PLAYER_COOKIE]: cookies[PLAYER_COOKIE] };
    const read = await asAction(dropped, async () => ({ byName: await signedInByName(bo.id), seal: await restoreSealForSession(bo.id) }));
    expect(read.result.byName).toBe(true);
    // And the seal the layout hands that browser restores by name again.
    expect(read.result.seal).toBe(restoreSeal(bo.id, true));
  });

  it("the layout's seal follows the session: full for a full sign-in, by name for one by name", async () => {
    const full = await asAction({ [PLAYER_COOKIE]: sealPlayerId(ana.id) }, () => restoreSealForSession(ana.id));
    expect(full.result).toBe(restoreSeal(ana.id, false));
    const forged = await asAction({ [PLAYER_COOKIE]: sealPlayerId(ana.id), [BY_NAME_COOKIE]: "x" }, () => restoreSealForSession(ana.id));
    expect(forged.result).toBe(restoreSeal(ana.id, false));
    // A sign-in by name from before the mark moved into the session cookie: a plain cookie and a valid mark beside it.
    // Since 28 October 2026 the mark carries the end of the sign-in, and so does the seal (`until`).
    const marked = await asAction({}, async () => {
      await setSessionPlayer(ana.id);
      await markSignedInByName(ana.id);
    });
    const legacy = await asAction({ [PLAYER_COOKIE]: sealPlayerId(ana.id), [BY_NAME_COOKIE]: marked.cookies[BY_NAME_COOKIE] }, () => restoreSealForSession(ana.id));
    expect(openRestoreSeal(legacy.result)).toMatchObject({ playerId: ana.id, byName: true });
    expect(openRestoreSeal(legacy.result)!.until).toBeGreaterThan(Date.now());
  });

  it("refuses the seal of a deleted account", async () => {
    const gone = await createPlayer(db, { displayName: "Cy", locale: "en" });
    const seal = restoreSeal(gone.id, false);
    await db.update(players).set({ displayName: DELETED_PLAYER_NAME, personalToken: null }).where(eq(players.id, gone.id));
    const { result, cookies } = await restore(seal);
    expect(result).toEqual({ ok: true, data: false });
    expect(cookies[PLAYER_COOKIE]).toBeUndefined();
  });

  it("leaves a browser that is signed in as it is", async () => {
    const jar = { [PLAYER_COOKIE]: sealPlayerId(bo.id) };
    const { result, cookies } = await asAction(jar, () => restoreIdentity(restoreSeal(ana.id, false)));
    expect(result).toEqual({ ok: true, data: true });
    expect(unsealPlayerId(cookies[PLAYER_COOKIE])).toBe(bo.id);
  });
});
