"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { after } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { players } from "@/db/schema";
import { LOCALE_COOKIE, toLocale } from "@/i18n/config";
import { baseUrl, emailEnabled } from "@/lib/config";
import { changePlayerEmail, consumeEmailCode, findPlayerByPersonalToken, issueEmailCode, playersWithEmail, restoreByEmail, rotatePersonalToken } from "@/lib/domain/identity";
import { getPlayer, normalizeEmail, updatePlayer } from "@/lib/domain/players";
import { sendPersonalLinkEmail } from "@/lib/notify";
import { getEventByCode } from "@/lib/domain/queries";
import { sendEmailCode, welcomeEmail } from "@/lib/notify";
import { personalUrl } from "@/lib/personal";
import { getSessionPlayer, getSessionPlayerId, setSessionPlayer } from "@/lib/session";
import { ActionFailure, requirePlayer, runA, type ActionResult } from "./shared";

export type PublicPlayer = { id: string; name: string; email: string | null; locale: string };

const pub = (p: { id: string; displayName: string; email: string | null; locale: string }): PublicPlayer => ({
  id: p.id,
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
 * Self-entered email (decision 9). If `eventCode` is given and the player is
 * in that event, a calendar invite goes out right away.
 */
export async function updateMyEmail(email: string, eventCode?: string): Promise<ActionResult<PublicPlayer & { knownElsewhere: boolean; kept: boolean }>> {
  return runA(async () => {
    const db = await getDb();
    const me = await getSessionPlayer(db);
    if (!me) throw new Error("no identity");
    const normalized = normalizeEmail(email);
    const others = normalized ? (await playersWithEmail(db, normalized)).filter((o) => o.id !== me.id) : [];
    const { player: p, changed, kept } = await changePlayerEmail(db, me.id, normalized);
    if (changed) {
      // New address: calendar invite when in this match (carries the personal link), else the personal-link email.
      const detail = eventCode ? await getEventByCode(db, eventCode) : null;
      after(() => welcomeEmail(db, p, detail?.event ?? null));
    }
    if (eventCode) revalidatePath(`/${eventCode}`);
    revalidatePath("/me");
    return { ...pub(p), knownElsewhere: others.length > 0, kept };
  });
}

/** "Email me my link": the personal-link email to the address on file. */
export async function emailPersonalLinkAction(): Promise<ActionResult<{ email: string | null; sent: boolean }>> {
  return runA(async () => {
    const db = await getDb();
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    if (!me.email) return { email: null, sent: false };
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
    const player = await restoreByEmail(db, verified, currentId);
    await setSessionPlayer(player.id);
    revalidatePath("/", "layout");
    return pub(player);
  });
}

/** Activity emails on/off (calendar invites, changes and cancellations always go out). */
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
    const token = await rotatePersonalToken(db, me.id);
    revalidatePath("/me");
    return { url: personalUrl(baseUrl(), token) };
  });
}

/** Called by the personal-link page so the device that opened it gets the cookie. */
export async function adoptPersonalToken(token: string): Promise<ActionResult<PublicPlayer | null>> {
  return runA(async () => {
    const db = await getDb();
    const p = await findPlayerByPersonalToken(db, token);
    if (!p) return null;
    const currentId = await getSessionPlayerId();
    if (currentId !== p.id) await setSessionPlayer(p.id);
    return pub(p);
  });
}

/** localStorage mirror → cookie restore (identity survives cookie loss on the same device). */
export async function restoreIdentity(playerId: string): Promise<ActionResult<PublicPlayer | null>> {
  return runA(async () => {
    if (!/^[0-9a-f-]{36}$/i.test(playerId)) return null;
    const db = await getDb();
    const existing = await getSessionPlayer(db);
    if (existing) return pub(existing);
    const p = await getPlayer(db, playerId);
    if (!p) return null;
    await setSessionPlayer(p.id);
    return pub(p);
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
