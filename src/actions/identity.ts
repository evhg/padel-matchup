"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { after } from "next/server";
import { getDb } from "@/db";
import { LOCALE_COOKIE, toLocale } from "@/i18n/config";
import { getPlayer, normalizeEmail, updatePlayer } from "@/lib/domain/players";
import { getEventByCode } from "@/lib/domain/queries";
import { sendCalendarInvite } from "@/lib/notify";
import { getSessionPlayer, setSessionPlayer } from "@/lib/session";
import { requirePlayer, runA, type ActionResult } from "./shared";

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
export async function updateMyEmail(email: string, eventCode?: string): Promise<ActionResult<PublicPlayer>> {
  return runA(async () => {
    const db = await getDb();
    const me = await getSessionPlayer(db);
    if (!me) throw new Error("no identity");
    const normalized = normalizeEmail(email);
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

export async function setLocaleAction(locale: string, path?: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const l = toLocale(locale) ?? "en";
    const store = await cookies();
    store.set(LOCALE_COOKIE, l, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
    const db = await getDb();
    const me = await getSessionPlayer(db);
    if (me && me.locale !== l) await updatePlayer(db, me.id, { locale: l });
    revalidatePath(path ?? "/", "layout");
    return null;
  });
}
