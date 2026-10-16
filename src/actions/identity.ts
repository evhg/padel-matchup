"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { after } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { players, type Player } from "@/db/schema";
import { LOCALE_COOKIE, toLocale } from "@/i18n/config";
import { baseUrl, emailEnabled } from "@/lib/config";
import { changePlayerEmail, consumeEmailCode, findPlayerByPersonalToken, issueEmailCode, playersWithEmail, restoreByEmail, rotatePersonalToken } from "@/lib/domain/identity";
import { getPlayer, normalizeEmail, updatePlayer } from "@/lib/domain/players";
import { sendPersonalLinkEmail } from "@/lib/notify";
import { getEventByCode } from "@/lib/domain/queries";
import { notifyLineupChange, notifyPromotion, notifyRefill, sendEmailCode, welcomeEmail, welcomeFor } from "@/lib/notify";
import { stayUpdated, type WelcomeKind } from "@/lib/domain/stayUpdated";
import { stayChannels } from "@/lib/calendarFeed";
import { bumpMetric } from "@/lib/domain/metrics";
import { personalUrl } from "@/lib/personal";
import { clearSessionPlayer, getSessionPlayer, getSessionPlayerId, markSignedInByName, openRestoreSeal, setSessionPlayer } from "@/lib/session";
import { ActionFailure, assertRate, clientKey, nameOnly, requirePlayer, runA, type ActionResult } from "./shared";
import { LIMITS } from "@/lib/domain/ratelimit";
import { removeOptOut } from "@/lib/domain/optouts";
import { liftOnConsent } from "@/lib/domain/emailMarks";
import { claimSameNameRow } from "@/lib/domain/sameName";
import { later } from "@/lib/alerts";
import { countSignIn } from "@/lib/domain/signins";
import { thatsMe } from "@/lib/domain/thatsMe";
import { unreachedNamed } from "@/lib/domain/unreached";
import { channelsOffered } from "@/lib/coach/reach";
import { isDeletedPlayer } from "@/lib/domain/result";
import { mergesLater } from "@/lib/mergeCount";
import { promotedOf } from "@/lib/domain/slots";
import { askForProof } from "./emailProof";

/** What an identity action tells the browser about its own player. Never the player id: an id once signed anybody in (`restoreIdentity` until 11 October 2026), and nothing on a screen needs it. */
export type PublicPlayer = { name: string; email: string | null; locale: string };

const pub = (p: { displayName: string; email: string | null; locale: string }): PublicPlayer => ({
  name: p.displayName,
  email: p.email,
  locale: p.locale,
});

/** First visit: one-time name entry → signed cookie. */
export async function ensureIdentity(name: string): Promise<ActionResult<PublicPlayer>> {
  return runA(async () => {
    const db = await getDb();
    const p = await requirePlayer(db, name);
    return pub(p);
  });
}

export async function updateMyName(name: string): Promise<ActionResult<PublicPlayer>> {
  return runA(async () => {
    const db = await getDb();
    const me = await requirePlayer(db, name);
    const p = (await updatePlayer(db, me.id, { displayName: name })) ?? me;
    revalidatePath("/", "layout");
    return pub(p);
  });
}

/**
 * What a save of an address answers. `welcome` is what went out because of the save (`welcomeFor`):
 * `invite`, `link`, or null when the address did not change or nothing goes; the "Stay updated" card
 * says that and nothing else. `code` is "sent" when nothing was saved and a 6-digit code went to the
 * address instead (a session by name, `askForProof`): the screen then shows the code box, and
 * `proveMyEmail` saves the address once the code comes back.
 */
export type EmailSave = PublicPlayer & { knownElsewhere: boolean; kept: boolean; welcome: WelcomeKind | null; code: "sent" | null };

/**
 * Self-entered email (decision 9). If `eventCode` is given and the player is
 * in that event, a calendar invite goes out right away.
 *
 * A session by name that proved nothing saves nothing here: the address gets a 6-digit code first
 * (`askForProof`, the owner's decision of 16 October 2026), and the answer says `code: "sent"`.
 *
 * `o.from: "stay"` marks the save on the "Stay updated" card itself, the one save `stay_linked_email`
 * counts. The invitation page's form, the match page's email row and My matches save without it.
 */
export async function updateMyEmail(email: string, eventCode?: string, o?: { from?: "stay" }): Promise<ActionResult<EmailSave>> {
  return runA(async () => {
    const db = await getDb();
    const me = await getSessionPlayer(db);
    if (!me) throw new Error("no identity");
    const normalized = normalizeEmail(email);
    if (normalized && (await nameOnly(me))) {
      await askForProof(db, me, normalized);
      return { ...pub(me), knownElsewhere: false, kept: false, welcome: null, code: "sent" as const };
    }
    const others = normalized ? (await playersWithEmail(db, normalized)).filter((o) => o.id !== me.id) : [];
    if (normalized && normalized !== me.email) await assertRate(db, "email", me.id, LIMITS.emailChangesPerPlayerPerDay);
    const { player: p, changed, kept } = await changePlayerEmail(db, me.id, normalized);
    // Typing an address in, new or the same one again, is asking for mail: a complaint or a run of
    // soft bounces on it is lifted (src/lib/domain/emailMarks.ts).
    if (normalized) await liftOnConsent(db, normalized);
    let welcome: WelcomeKind | null = null;
    if (changed) {
      // Adding your own address is explicit consent: lift any earlier "never email me".
      await removeOptOut(db, p.email);
      // New address: calendar invite when in this match (carries the personal link), else the personal-link email.
      // A session by name never reaches this line with an address: it proves the address first (above).
      const detail = eventCode ? await getEventByCode(db, eventCode) : null;
      welcome = welcomeFor(p, detail);
      if (welcome) after(() => welcomeEmail(db, p, detail?.event ?? null, { detail }));
      // "Stay updated" answered by email (docs/OPERATING.md): a save on the card itself, by a player the card
      // asked (no channel before it), that now reaches them by email. One upsert per save, after the answer.
      // Until 15 October 2026 any save with a match code counted, the invitation page's too, which never
      // shows the card (review), so the count ran ahead of the asks.
      if (eventCode && o?.from === "stay") countStayEmail(db, me, p);
    }
    if (eventCode) revalidatePath(`/${eventCode}`);
    revalidatePath("/me");
    return { ...pub(p), knownElsewhere: others.length > 0, kept, welcome, code: null };
  });
}

/** `stay_linked_email`: the card asked this player (no channel before the save), and email reaches them now. One upsert, after the answer. */
function countStayEmail(db: Db, before: Player, now: Player): void {
  const runs = stayChannels();
  const reached = stayUpdated(now, runs);
  if (stayUpdated(before, runs).kind === "ask" && reached.kind === "reached" && reached.via.includes("email")) after(() => bumpMetric(db, "stay_linked_email").catch(() => undefined));
}

/**
 * The second half of a save by a session by name (`updateMyEmail`, `setCreatorEmailAction`): the code
 * that went to the address comes back. The restore's own verify path runs (`verifyRestoreCode`): the
 * code is spent, `restoreByEmail` puts the proved address on this browser's record (or folds the record
 * into the one that already holds the address, as every restore does), and `setSessionPlayer` ends the
 * by-name mark, so the session is a full one. Then what a full session's save sends goes out: the
 * match's invitation for a seat, else the personal link (`welcomeFor`), unless the record that stays
 * held the address already. A wrong or spent code saves nothing (`invalid`).
 */
export async function proveMyEmail(email: string, code: string, eventCode?: string, o?: { from?: "stay" }): Promise<ActionResult<PublicPlayer & { welcome: WelcomeKind | null }>> {
  return runA(async () => {
    if (typeof email !== "string" || typeof code !== "string") throw new ActionFailure("invalid");
    const db = await getDb();
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    const byName = await nameOnly(me);
    const verified = await consumeEmailCode(db, email, code);
    // Whether a record held this address as its own before: the record that stays then has it already, so nothing is new and no welcome goes.
    const held = (await playersWithEmail(db, verified)).some((p) => p.email === verified);
    const player = await restoreByEmail(db, verified, me.id, undefined, mergesLater(db));
    await setSessionPlayer(player.id);
    if (player.id !== me.id) await later(() => countSignIn(db, "email_code"));
    // A session by name that proved its address: how often a real player who came in by "That's me" typed the one code (the decision's con).
    if (byName) await later(() => bumpMetric(db, "email_proved_by_name"));
    await removeOptOut(db, verified);
    let welcome: WelcomeKind | null = null;
    if (!held) {
      const detail = eventCode ? await getEventByCode(db, eventCode) : null;
      welcome = welcomeFor(player, detail);
      if (welcome) after(() => welcomeEmail(db, player, detail?.event ?? null, { detail }));
      if (eventCode && o?.from === "stay") countStayEmail(db, me, player);
    }
    revalidatePath("/", "layout");
    return { ...pub(player), welcome };
  });
}

/** "Email me my link": the personal-link email to the address on file. */
export async function emailPersonalLinkAction(): Promise<ActionResult<{ email: string | null; sent: boolean }>> {
  return runA(async () => {
    const db = await getDb();
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    if (await nameOnly(me)) throw new ActionFailure("forbidden");
    if (!me.email) return { email: null, sent: false };
    await assertRate(db, "linkmail", me.id, LIMITS.personalLinkMailsPerPlayerPerDay);
    const sent = await sendPersonalLinkEmail(db, me);
    return { email: me.email, sent };
  });
}

/** Restore step 1: email a 6-digit code if any identity carries that email. */
export async function requestRestoreCode(email: string): Promise<ActionResult<{ known: boolean; sent: boolean }>> {
  return runA(async () => {
    if (!emailEnabled()) throw new ActionFailure("email_disabled");
    const db = await getDb();
    const normalized = normalizeEmail(email);
    if (!normalized) throw new ActionFailure("invalid");
    await assertRate(db, "restore", await clientKey(), LIMITS.restoreCodesPerIpPerDay);
    const owners = await playersWithEmail(db, normalized);
    if (owners.length === 0) return { known: false, sent: false };
    const issued = await issueEmailCode(db, normalized);
    if (!issued) throw new ActionFailure("too_many");
    const locale = (await getSessionPlayer(db))?.locale ?? owners[0].locale;
    const sent = await sendEmailCode(issued.email, issued.code, locale);
    return { known: true, sent };
  });
}

/** Restore step 2: verify the code, merge every identity with that email, sign in as the result. */
export async function verifyRestoreCode(email: string, code: string): Promise<ActionResult<PublicPlayer>> {
  return runA(async () => {
    const db = await getDb();
    const verified = await consumeEmailCode(db, email, code);
    const currentId = await getSessionPlayerId();
    const player = await restoreByEmail(db, verified, currentId, undefined, mergesLater(db));
    await setSessionPlayer(player.id);
    if (player.id !== currentId) await later(() => countSignIn(db, "email_code"));
    revalidatePath("/", "layout");
    return pub(player);
  });
}

/**
 * "These are mine" on My matches: folds a row of the same name that nobody can reach into the signed-in
 * person. Everything the card showed is checked again (`claimSameNameRow`); a row that no longer fits
 * is refused rather than merged.
 */
export async function claimSameNameAction(rowId: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const db = await getDb();
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    if (!/^[0-9a-f-]{36}$/i.test(rowId ?? "") || !(await claimSameNameRow(db, me.id, rowId, mergesLater(db)))) throw new ActionFailure("invalid");
    revalidatePath("/me");
    return null;
  });
}

/**
 * "That's me" on a match page (DECIDING rule 34): this browser signs in as the record of that name in
 * this match or its crew, without proof, inside the owner's limits (`thatsMe`). A browser that already
 * made its own new record folds it into the old one. Refused as `invalid` whatever the reason, so the
 * answer says nothing about the record beyond what the page already showed; `too_many` past the rate.
 */
export async function thatsMeAction(code: string, name: string): Promise<ActionResult<PublicPlayer & { folded: boolean }>> {
  return runA(async () => {
    if (typeof code !== "string" || typeof name !== "string" || !name.trim() || name.length > 80) throw new ActionFailure("invalid");
    const db = await getDb();
    // A name nobody in the match or its crew carries may be a past partner on the organiser's unreached list
    // (the owner's decision of 16 October 2026, D6): the server looks it up, only then, and keeps the answer.
    const unreached = async (typed: string) => {
      const detail = await getEventByCode(db, code);
      return detail ? unreachedNamed(db, detail, typed, channelsOffered(), new Date()) : null;
    };
    const res = await thatsMe(db, { code, name, viewerId: await getSessionPlayerId(), rateKey: await clientKey(), counter: mergesLater(db), unreached });
    if (!res.ok) throw new ActionFailure(res.reason === "too_many" ? "too_many" : "invalid");
    await setSessionPlayer(res.player.id);
    // Marked until the record proves something: no personal link for a sign-in by name.
    await markSignedInByName(res.player.id);
    await later(() => countSignIn(db, "thats_me"));
    // Counted beside `signin_thats_me`: how often the organiser's unreached list brought a player back (D6).
    if (res.via === "unreached") await later(() => bumpMetric(db, "thats_me_unreached"));
    if (res.folded) await later(() => countSignIn(db, "thats_me_fold"));
    // A fold that gave up a place in the match: the line-up changed, and whoever moved up hears it, as after a leave.
    const seats = res.seats;
    if (seats) {
      after(async () => {
        const { emitMatchEvent } = await import("@/lib/api/webhooks");
        // Everybody it moved up is told by `notifyPromotion` alone: a fixed-pairs night moves a pair.
        const fresh = await notifyLineupChange(db, seats.event, seats.wasComplete, promotedOf(seats.promotion).map((p) => p.playerId));
        await notifyPromotion(db, fresh ?? seats.event, seats.promotion);
        if (!seats.promotion) await notifyRefill(db, seats.event.id);
        await emitMatchEvent(db, "match.updated", code, { calendarChanged: false });
      });
    }
    revalidatePath("/", "layout");
    return { ...pub(res.player), folded: res.folded };
  });
}

/** Activity emails on/off (calendar invites, changes and cancellations always go out). */
/** Passport: the public page switch. Off by default; the slug is minted once and kept. */
export async function setPublicProfileAction(on: boolean): Promise<ActionResult<{ slug: string; on: boolean }>> {
  return runA(async () => {
    const db = await getDb();
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    const { setPublicProfile } = await import("@/lib/domain/profile");
    const row = await setPublicProfile(db, me.id, Boolean(on));
    if (!row?.publicSlug) throw new ActionFailure("generic");
    revalidatePath("/me");
    revalidatePath(`/u/${row.publicSlug}`);
    return { slug: row.publicSlug, on: row.publicProfile };
  });
}

export async function setMyLevelAction(level: number): Promise<ActionResult<{ level: number | null }>> {
  return runA(async () => {
    const db = await getDb();
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    const { setPlayerLevel } = await import("@/lib/domain/rating");
    const saved = await setPlayerLevel(db, me.id, level);
    if (saved == null) throw new ActionFailure("invalid");
    revalidatePath("/", "layout");
    return { level: saved };
  });
}

export async function setRankingOptInAction(on: boolean): Promise<ActionResult<null>> {
  return runA(async () => {
    const db = await getDb();
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    const { setRankingOptIn } = await import("@/lib/domain/ranking");
    await setRankingOptIn(db, me.id, Boolean(on));
    revalidatePath("/", "layout");
    return null;
  });
}

export async function setEmailNotificationsAction(on: boolean): Promise<ActionResult<null>> {
  return runA(async () => {
    const db = await getDb();
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    await db.update(players).set({ emailNotifications: Boolean(on) }).where(eq(players.id, me.id));
    revalidatePath("/", "layout");
    return null;
  });
}

export async function rotatePersonalLinkAction(): Promise<ActionResult<{ url: string }>> {
  return runA(async () => {
    const db = await getDb();
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    // A sign-in by name may not lock the real player's home-screen icon and other devices out (DECIDING rule 34).
    if (await nameOnly(me)) throw new ActionFailure("forbidden");
    const token = await rotatePersonalToken(db, me.id);
    revalidatePath("/me");
    return { url: personalUrl(baseUrl(), token) };
  });
}

/**
 * "Delete my account": personal data goes, history stays anonymous. Upcoming
 * spots are released; upcoming matches this player organizes are cancelled.
 */
export async function deleteMyAccountAction(): Promise<ActionResult<null>> {
  return runA(async () => {
    const db = await getDb();
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    const { anonymizePlayer } = await import("@/lib/domain/anonymize");
    const { cancelledEvents, leftEvents, coachClosure } = await anonymizePlayer(db, me.id);
    after(async () => {
      const { notifyEventCancelled, notifyCreator, notifyPromotion } = await import("@/lib/notify");
      const { emitMatchEvent } = await import("@/lib/api/webhooks");
      for (const ev of cancelledEvents) {
        await notifyEventCancelled(db, ev);
        await emitMatchEvent(db, "match.cancelled", ev.code);
      }
      for (const { event, promotion } of leftEvents) {
        await notifyCreator(db, event, "left", me.displayName, me.id);
        await notifyPromotion(db, event, promotion);
      }
      if (coachClosure) {
        // The coach's name is the one the student knows, so it is the one the notice carries — taken
        // before the page went, not from the row that now reads "Deleted player".
        const { notifyLessonCancelled } = await import("@/lib/coach/notify");
        for (const c of coachClosure.cancelled) {
          if (!c.student) continue;
          await notifyLessonCancelled(db, { lesson: c.lesson, coach: coachClosure.coach, student: c.student, pkg: null, by: "coach", outcome: c.outcome }).catch(() => undefined);
        }
      }
    });
    await clearSessionPlayer();
    revalidatePath("/", "layout");
    return null;
  });
}

/** Called by the personal-link page so the device that opened it gets the cookie. A link with a destination is handed on server-side instead (`/p/[token]/go`). */
export async function adoptPersonalToken(token: string): Promise<ActionResult<PublicPlayer | null>> {
  return runA(async () => {
    const db = await getDb();
    const p = await findPlayerByPersonalToken(db, token);
    if (!p) return null;
    const currentId = await getSessionPlayerId();
    if (currentId !== p.id) {
      await setSessionPlayer(p.id);
      await later(() => countSignIn(db, "personal_link"));
    }
    return pub(p);
  });
}

/**
 * The localStorage copy brings back a lost cookie on the same device (`IdentitySync`). It takes only
 * the seal the server gave this browser while it was signed in (`restoreSeal`), never a raw player id:
 * a player id is on screens other people see, and until 11 October 2026 this action signed in as any
 * id it was given. The session comes back as it was, so a sign-in by name comes back by name (DECIDING
 * rule 34), and a deleted account does not come back. The answer says only whether the browser is
 * signed in now: no name, no address, no id.
 */
export async function restoreIdentity(seal: string): Promise<ActionResult<boolean>> {
  return runA(async () => {
    const opened = openRestoreSeal(seal);
    if (!opened) return false;
    const db = await getDb();
    if (await getSessionPlayerId()) return true;
    const p = await getPlayer(db, opened.playerId);
    if (!p || isDeletedPlayer(p)) return false;
    await setSessionPlayer(p.id);
    if (opened.byName) await markSignedInByName(p.id);
    await later(() => countSignIn(db, "restore"));
    return true;
  });
}

/** Persists the language choice. The client sets the cookie and refreshes itself. */
export async function setLocaleAction(locale: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const l = toLocale(locale) ?? "en";
    const store = await cookies();
    store.set(LOCALE_COOKIE, l, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
    const db = await getDb();
    const me = await getSessionPlayer(db);
    if (me && me.locale !== l) await updatePlayer(db, me.id, { locale: l });
    return null;
  });
}
