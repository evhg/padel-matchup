"use server";

import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import { after } from "next/server";
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/server";
import { getDb, type Db } from "@/db";
import { later } from "@/lib/alerts";
import { bumpMetric, bumpMetrics } from "@/lib/domain/metrics";
import { completePasskeySignIn, mayRegister, passkeyById, passkeyLabel, passkeysOf, removePasskey, savePasskey } from "@/lib/domain/passkeys";
import { LIMITS } from "@/lib/domain/ratelimit";
import { countSignIn, type SignInWay } from "@/lib/domain/signins";
import { mergesLater } from "@/lib/mergeCount";
import { promotedOf } from "@/lib/domain/slots";
import { notifyLineupChange, notifyPasskeySaved, notifyPromotion, notifyRefill } from "@/lib/notify";
import { isDomainError } from "@/lib/domain/errors";
import { passkeyAutofillOn } from "@/lib/config";
import { answerChallenge, openPageChallenge, pageChallengeCheck } from "@/lib/passkeys/page";
import { answerCredentialId, authenticationOptions, CHALLENGE_COOKIE, challengeCookie, openChallenge, quietPasskeyError, registrationOptions, sealChallenge, spendChallenge, verifyAssertion, verifyRegistration } from "@/lib/passkeys/webauthn";
import { getSessionPlayer, getSessionPlayerId, passkeyHandle, setSessionPlayer, signedInByName } from "@/lib/session";
import { ActionFailure, assertRate, clientKey, runA, type ActionResult } from "./shared";

/**
 * Passkeys, the owner's decision of 12 October 2026 (DECIDING rule 39): "Remember me on this phone"
 * saves one, and "Sign in with Face ID or fingerprint" uses one from any browser on the phone. Each
 * door is two calls: the options (a challenge, sealed into a five-minute cookie for its purpose) and
 * the answer (the cookie deleted first, so a challenge is used once, then checked). Both halves count
 * against the caller's address. A refusal of any kind answers `invalid` and nothing more, and counts
 * `passkey_refused`. The sign-in also takes the page's own challenge (src/lib/passkeys/page.ts), which a
 * page renders for the autofill of the player's own name field (the owner, 28 October 2026), with no
 * options call. Past its ten minutes it answers `expired`, and the browser asks for options as the
 * button does; while the kill switch is off it answers `autofill_off`, and the browser ends the
 * autofill. No credential id, public key or user handle reaches an answer, a page or a log: every
 * action runs through `runP`, which hands the error report a failure without the query's values.
 */

/** `runA`, with any failure but a refusal turned into one that names no value (`quietPasskeyError`) before it is reported. */
const runP = <T>(fn: () => Promise<T>): Promise<ActionResult<T>> =>
  runA(async () => {
    try {
      return await fn();
    } catch (e) {
      throw e instanceof ActionFailure || isDomainError(e) ? e : quietPasskeyError(e);
    }
  });

/** The session this browser holds: whose, and whether it came in by name (src/lib/session.ts). */
async function sessionNow() {
  const db = await getDb();
  const me = await getSessionPlayer(db);
  return { db, me, session: { playerId: me?.id ?? null, byName: me ? await signedInByName(me.id) : false } };
}

/**
 * The challenge this browser was given for `purpose`, taken out of its cookie, and spent. Deleting the
 * cookie stops an honest browser using it twice; a copy of the cookie sent again inside its five
 * minutes is stopped by the spend: one rate row per challenge with a limit of one (`spendChallenge`),
 * dated by the seal's own expiry so that a use after midnight UTC meets the same row, in
 * `metrics_daily` like every limit, pruned after two days. No table of its own.
 */
async function takeChallenge(db: Db, purpose: "register" | "signin", playerId: string | null): Promise<string | null> {
  const store = await cookies();
  const sealed = store.get(CHALLENGE_COOKIE)?.value;
  store.delete(CHALLENGE_COOKIE);
  const opened = openChallenge(sealed, purpose, playerId);
  return opened && (await spendChallenge(db, opened)) ? opened.challenge : null;
}

/** What the library checks the challenge the phone signed against: the options call's challenge itself, or the check of a page's seal. */
type Expected = string | ((signed: string) => boolean);

/**
 * The challenge a sign-in answer is checked against, spent once before anything signs in. A page's own
 * challenge, for the autofill on the player's own name field, when the phone signed one: the seal, its
 * purpose ("passkey-page") and its ten minutes, then the spend, on the row the options call's challenge
 * uses (`spendChallenge`, dated by the seal's expiry). Anything else is the options call's, from its
 * cookie (`takeChallenge`), as before. `expired`: a page's challenge past its ten minutes, so the page
 * falls back to the options call. `off`: any page's challenge while the kill switch is off
 * (`PASSKEY_AUTOFILL`), so a page that was open before the switch ends its request and drops the token
 * (review, 28 October 2026: "expired" there kept the autofill on every open tab until it reloaded).
 * Null: nothing to check against, or spent already.
 */
async function signInChallenge(db: Db, answer: unknown, now: Date): Promise<{ expected: Expected } | "expired" | "off" | null> {
  const page = openPageChallenge(answerChallenge(answer), now);
  if (page.state === "none") {
    const challenge = await takeChallenge(db, "signin", null);
    return challenge ? { expected: challenge } : null;
  }
  if (!passkeyAutofillOn()) return "off";
  if (page.state === "expired") return "expired";
  if (!(await spendChallenge(db, page))) return null;
  // The library runs this on the challenge inside the signed client data: the one just spent, still a page's own, still inside its ten minutes.
  return { expected: pageChallengeCheck(page.challenge, now) };
}

/** The sign-in's hint from the name field's autofill: it names the counter, and grants nothing. */
const fromAutofill = (hint: unknown): boolean => typeof hint === "object" && hint !== null && (hint as { via?: unknown }).via === "autofill";

/** "Remember me on this phone", first half: the options for `navigator.credentials.create`, for a session that may save one (`mayRegister`). */
export async function passkeySaveOptionsAction(): Promise<ActionResult<PublicKeyCredentialCreationOptionsJSON>> {
  return runP(async () => {
    const { db, me, session } = await sessionNow();
    if (!me || !mayRegister(session, me)) throw new ActionFailure("forbidden");
    await assertRate(db, "passkey_options", await clientKey(), LIMITS.passkeyOptionsPerIpPerDay);
    const options = await registrationOptions(me, await passkeysOf(db, me.id));
    (await cookies()).set(CHALLENGE_COOKIE, sealChallenge("register", options.challenge, me.id), challengeCookie());
    return options;
  });
}

/** "Remember me on this phone", second half: the phone's new passkey, checked and kept under the browser's own record. */
export async function passkeySaveAction(answer: unknown): Promise<ActionResult<{ saved: true }>> {
  return runP(async () => {
    const { db, me, session } = await sessionNow();
    if (!me || !mayRegister(session, me)) throw new ActionFailure("forbidden");
    await assertRate(db, "passkey_check", await clientKey(), LIMITS.passkeyChecksPerIpPerDay);
    const challenge = await takeChallenge(db, "register", me.id);
    const made = challenge ? await verifyRegistration(answer, challenge) : null;
    const label = passkeyLabel((await headers()).get("user-agent"));
    if (!made || !(await savePasskey(db, { ...made, playerId: me.id, label }))) {
      await later(() => bumpMetric(db, "passkey_refused"));
      throw new ActionFailure("invalid");
    }
    await later(() => bumpMetric(db, "passkey_saved"));
    // "A phone now signs you in: iPhone, Safari. Not you? Remove it on My matches.", to the record's own
    // channel through the notice gate, after the answer; never a personal link in it.
    await later(() => notifyPasskeySaved(db, me, label));
    // No revalidatePath: nothing else on the page changed. The cookie deleted above already makes Next.js
    // send the page again with the answer, and the match page keeps the card mounted for that render
    // (`RememberPhone` with `offer` false), so "This phone remembers you now." stays.
    return { saved: true };
  });
}

/** "Sign in with Face ID or fingerprint", first half: the options for `navigator.credentials.get`, for anybody (the phone offers its own passkeys). */
export async function passkeySignInOptionsAction(): Promise<ActionResult<PublicKeyCredentialRequestOptionsJSON>> {
  return runP(async () => {
    const db = await getDb();
    await assertRate(db, "passkey_options", await clientKey(), LIMITS.passkeyOptionsPerIpPerDay);
    const options = await authenticationOptions();
    (await cookies()).set(CHALLENGE_COOKIE, sealChallenge("signin", options.challenge, null), challengeCookie());
    return options;
  });
}

/**
 * "Sign in with Face ID or fingerprint", second half: one read of the passkey by its id, the signature
 * checked, then the browser becomes the passkey's own record with a full session. The record this
 * browser held before folds into it only when the rule says so (`passkeyFold`); otherwise the session
 * only switches. Never "Are these yours?": a passkey folds nothing else (the owner: "Nothing more").
 * The same for the autofill on the player's own name field, over the page's own challenge
 * (`signInChallenge`). Its hint, `{ via: "autofill" }`, only counts the sign-in as
 * `signin_passkey_autofill` beside `signin_passkey`: every check is the button's.
 */
export async function passkeySignInAction(answer: unknown, hint?: { via?: "autofill" }): Promise<ActionResult<{ name: string; folded: boolean }>> {
  return runP(async () => {
    const db = await getDb();
    await assertRate(db, "passkey_check", await clientKey(), LIMITS.passkeyChecksPerIpPerDay);
    const challenge = await signInChallenge(db, answer, new Date());
    const refuse = async (): Promise<never> => {
      await later(() => bumpMetric(db, "passkey_refused"));
      throw new ActionFailure("invalid");
    };
    // A page left open past its ten minutes: no refusal of the person, so no counter; the browser asks for options.
    if (challenge === "expired") throw new ActionFailure("expired");
    // The kill switch, pulled while the page was open: no refusal either; the browser ends the autofill.
    if (challenge === "off") throw new ActionFailure("autofill_off");
    if (!challenge) return refuse();
    const id = answerCredentialId(answer);
    const passkey = id ? await passkeyById(db, id) : null;
    if (!passkey) return refuse();
    const checked = await verifyAssertion(answer, challenge.expected, passkey);
    if (!checked) return refuse();
    const currentId = await getSessionPlayerId();
    const session = { playerId: currentId, byName: currentId ? await signedInByName(currentId) : false };
    // A fold counts as `merge_passkey` after the answer (`mergesLater`), never in the path the player waits on.
    const res = await completePasskeySignIn(db, { passkey, newCounter: checked.newCounter, session, counter: mergesLater(db) });
    if (!res.ok) return refuse();
    if (res.player.id !== currentId || session.byName) await setSessionPlayer(res.player.id);
    // Counted when the cookie changes to another record, as every way in is (`countSignIn`).
    const moved = res.player.id !== currentId;
    const ways: SignInWay[] = [...(moved ? (["passkey"] as const) : []), ...(moved && fromAutofill(hint) ? (["passkey_autofill"] as const) : []), ...(res.folded ? (["passkey_fold"] as const) : [])];
    const ua = (await headers()).get("user-agent");
    await later(() => countSignIn(db, ways, ua));
    // A fold that gave up a place in a match: the line-up changed, and whoever moved up hears it, as after a leave.
    for (const seats of res.seats) {
      after(async () => {
        const { emitMatchEvent } = await import("@/lib/api/webhooks");
        // Everybody it moved up is told by `notifyPromotion` alone: a fixed-pairs night moves a pair.
        const fresh = await notifyLineupChange(db, seats.event, seats.wasComplete, promotedOf(seats.promotion).map((p) => p.playerId));
        await notifyPromotion(db, fresh ?? seats.event, seats.promotion);
        if (!seats.promotion) await notifyRefill(db, seats.event.id);
        await emitMatchEvent(db, "match.updated", seats.event.code, { calendarChanged: false });
      });
    }
    revalidatePath("/", "layout");
    return { name: res.player.displayName, folded: res.folded };
  });
}

/**
 * "Remove" under "Phones that remember you": the player's own passkey only, named by its handle
 * (`passkeyHandle`), never by its credential id, from a session that may save one (never by name). The phone keeps its copy until the player deletes it
 * there; it then signs in nobody.
 */
export async function removePasskeyAction(handle: string): Promise<ActionResult<null>> {
  return runP(async () => {
    const { db, me, session } = await sessionNow();
    if (!me) throw new ActionFailure("no_identity");
    // A session by name proved nothing in this browser, so it may not take the real player's way in away either.
    if (!mayRegister(session, me)) throw new ActionFailure("forbidden");
    const mine = typeof handle === "string" ? (await passkeysOf(db, me.id)).find((p) => passkeyHandle(me.id, p.id) === handle) : undefined;
    if (!mine || !(await removePasskey(db, me.id, mine.id))) throw new ActionFailure("invalid");
    revalidatePath("/", "layout");
    return null;
  });
}

/**
 * The "Remember me on this phone" card, counted from the browser, because only the browser knows that it
 * really showed: the phone can keep a passkey and no "Not now" hides it (the owner's questions of
 * 28 October 2026). `shown` at most once a day per browser (`RememberPhone` keeps the day it last
 * counted), `not_now` on each tap of "Not now". One upsert after the answer; nothing else read or written.
 * The limit is the browser's own, so a script can call this as often as it likes (docs/OPERATING.md,
 * "Honest browsers only"): a page view's cost each time, and a counter to read as a trend.
 */
export async function passkeyCardAction(what: "shown" | "not_now"): Promise<ActionResult<null>> {
  return runA(async () => {
    if (what !== "shown" && what !== "not_now") throw new ActionFailure("invalid");
    const db = await getDb();
    await later(() => bumpMetrics(db, [what === "shown" ? "passkey_shown" : "passkey_not_now"]));
    return null;
  });
}
