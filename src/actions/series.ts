"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { events } from "@/db/schema";
import { eq } from "drizzle-orm";
import { baseUrl } from "@/lib/config";
import { DomainError } from "@/lib/domain/errors";
import { createSeriesFromEvent, isRhythm, setSeriesActive } from "@/lib/domain/series";
import { pingIndexNow } from "@/lib/indexnow";
import { emitMatchEvent } from "@/lib/api/webhooks";
import { getSessionPlayer } from "@/lib/session";

export type ActionResult = { ok: true } | { ok: false; error: string };

/** The door on a finished tournament: name it, pick the rhythm, and the series page opens with the next edition already on it. */
export async function createSeriesAction(code: string, name: string, every: string, capacity?: number): Promise<ActionResult> {
  const db = await getDb();
  const me = await getSessionPlayer(db);
  if (!me) return { ok: false, error: "no_session" };
  if (!isRhythm(every)) return { ok: false, error: "invalid" };
  const [ev] = await db.select({ id: events.id }).from(events).where(eq(events.code, code)).limit(1);
  if (!ev) return { ok: false, error: "not_found" };
  let slug: string;
  let nextCode: string;
  try {
    const { series, next } = await createSeriesFromEvent(db, { eventId: ev.id, organizerPlayerId: me.id, name, every, capacity: Number.isInteger(capacity) ? capacity : undefined });
    slug = series.slug;
    nextCode = next.code;
  } catch (e) {
    return { ok: false, error: e instanceof DomainError ? e.message : "error" };
  }
  await emitMatchEvent(db, "match.created", nextCode, { automatic: true, series: slug });
  void pingIndexNow([`${baseUrl()}/s/${slug}`], { db }).catch(() => undefined);
  revalidatePath(`/${code}`);
  redirect(`/s/${slug}`);
}

/** Pause or resume: paused, no edition is made; the page stays. */
export async function setSeriesActiveAction(slug: string, active: boolean): Promise<ActionResult> {
  const db = await getDb();
  const me = await getSessionPlayer(db);
  if (!me) return { ok: false, error: "no_session" };
  try {
    await setSeriesActive(db, { slug, organizerPlayerId: me.id, active });
  } catch (e) {
    return { ok: false, error: e instanceof DomainError ? e.message : "error" };
  }
  revalidatePath(`/s/${slug}`);
  return { ok: true };
}
