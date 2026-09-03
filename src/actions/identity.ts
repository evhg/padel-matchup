"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { after } from "next/server";
import { getDb } from "@/db";
import { LOCALE_COOKIE, toLocale } from "@/i18n/config";
import { baseUrl, emailEnabled } from "@/lib/config";
import { consumeEmailCode, findPlayerByPersonalToken, issueEmailCode, playersWithEmail, restoreByEmail, rotatePersonalToken } from "@/lib/domain/identity";
import { getPlayer, normalizeEmail, updatePlayer } from "@/lib/domain/players";
import { getEventByCode } from "@/lib/domain/queries";
import { sendCalendarInvite, sendEmailCode } from "@/lib/notify";
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
export async function updateMyEmail(email: string, eventCode?: string): Promise<ActionResult<PublicPlayer & { knownElsewhere: boolean }>> {
  return runA(async () => {
    const db = await getDb();
    const me = await getSessionPlayer(db);
    if (!me) throw new Error("no identity");
    const normalized = normalizeEmail(email);
    const others = normalized ? (await playersWithEmail(db, normalized)).filter((o) => o.id !== me.id) : [];
    const p = (await updatePlayer(db, me.id, { email: normalized })) ?? me;
    if (normalized && eventCode) {
      const detail = await getEventByCode(db, eventCode);
      const inEvent = detail?.roster.some((s) => s.playerId === me.id && (s.status === "joined" || s.status === "confirmed"));
      if (detail && inEvent && detail.event.status !== "cancelled") {
        after(() => sendCalendarInvite(db, detail.event, p));
      }
      revalidatePath(`/${eventCode}`);
    }
    revalidatePath("/me");
    return { ...pub(p), knownElsewhere: others.length > 0 };
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
