"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { getLocale } from "next-intl/server";
import { emitMatchEvent } from "@/lib/api/webhooks";
import { joinGroup } from "@/lib/domain/groups";
import { pastPlayerRows, recordForAnswer } from "@/lib/domain/heldRecord";
import { putOnPlace, removeFromPlace, replaceOnPlace, takeOpenPlace, type FixActor, type FixDone } from "@/lib/domain/lineupFix";
import { notifyRemovedBy } from "@/lib/notify";
import { ActionFailure, getViewer, loadEvent, nameOnly, runA, type ActionResult } from "./shared";

/**
 * The line-up of a played match put right (the owner's decision of 24 November 2026; the rules are
 * `fixWindow.ts`, the writes `lineupFix.ts`). The browser sends seat ids and names, never a player id:
 * a past player is found again here, among the actor's own past players, from the name. Each write is
 * one request and one transaction; the notice to the player who lost a place, the match's webhook and
 * the crew's join go in `after()`, out of the path the person waits on (rule 12).
 */

const SEAT = /^[0-9a-f-]{36}$/i;

async function fixContext(code: unknown) {
  if (typeof code !== "string") throw new ActionFailure("invalid");
  const { db, detail } = await loadEvent(code);
  const viewer = await getViewer(db, detail);
  const me = viewer.player;
  const actor: FixActor = { id: me?.id ?? null, organiser: viewer.isCreator, locale: me?.locale ?? (await getLocale()) };
  // The name the removed player reads: the actor's own, or the organiser's for a manage link with nobody signed in.
  const actorName = me?.displayName ?? detail.creator.displayName;
  return { db, detail, me, actor, actorName, code };
}

function afterFix(ctx: Awaited<ReturnType<typeof fixContext>>, done: FixDone, o: { joined?: boolean } = {}) {
  const { db, code, me, actorName } = ctx;
  after(async () => {
    if (done.out) await notifyRemovedBy(db, done.event, done.out, actorName);
    if (o.joined && me && done.event.groupId) await joinGroup(db, done.event.groupId, me.id, "match").catch(() => undefined);
    await emitMatchEvent(db, "match.updated", code);
  });
  revalidatePath(`/${code}`);
  revalidatePath("/me");
}

/**
 * A name in an open place, or a place changed to another person. `pick`: the name is a "Played with you"
 * chip, so the place takes that past player's record, found again among the actor's own past players
 * (`recordForAnswer`); a name nobody there carries, or a session by name that proved nothing, gets a new
 * record of the typed name.
 */
export async function fixPutAction(code: string, slotId: string, name: string, pick?: boolean): Promise<ActionResult<null>> {
  return runA(async () => {
    if (typeof slotId !== "string" || !SEAT.test(slotId) || typeof name !== "string" || !name.trim() || name.length > 80) throw new ActionFailure("invalid");
    const ctx = await fixContext(code);
    const record = pick === true && ctx.me && !(await nameOnly(ctx.me)) ? recordForAnswer(await pastPlayerRows(ctx.db, ctx.me.id, new Date()), name, true) : null;
    const done = await putOnPlace(ctx.db, { eventId: ctx.detail.event.id, slotId, actor: ctx.actor, name, recordId: record?.id ?? null });
    afterFix(ctx, done);
    return null;
  });
}

/** A player or a hold out of the line-up. */
export async function fixRemoveAction(code: string, slotId: string): Promise<ActionResult<null>> {
  return runA(async () => {
    if (typeof slotId !== "string" || !SEAT.test(slotId)) throw new ActionFailure("invalid");
    const ctx = await fixContext(code);
    const done = await removeFromPlace(ctx.db, { eventId: ctx.detail.event.id, slotId, actor: ctx.actor });
    afterFix(ctx, done);
    return null;
  });
}

/** "Add me": the signed-in person takes an open place, the one tapped. */
export async function fixTakeAction(code: string, slotId?: string): Promise<ActionResult<null>> {
  return runA(async () => {
    if (slotId !== undefined && (typeof slotId !== "string" || !SEAT.test(slotId))) throw new ActionFailure("invalid");
    const ctx = await fixContext(code);
    if (!ctx.me) throw new ActionFailure("no_identity");
    const done = await takeOpenPlace(ctx.db, { eventId: ctx.detail.event.id, actor: ctx.actor, slotId: slotId ?? null });
    afterFix(ctx, done, { joined: true });
    return null;
  });
}

/** "I played instead of Bo": the signed-in person takes that place. */
export async function fixReplaceAction(code: string, slotId: string): Promise<ActionResult<null>> {
  return runA(async () => {
    if (typeof slotId !== "string" || !SEAT.test(slotId)) throw new ActionFailure("invalid");
    const ctx = await fixContext(code);
    if (!ctx.me) throw new ActionFailure("no_identity");
    const done = await replaceOnPlace(ctx.db, { eventId: ctx.detail.event.id, slotId, actor: ctx.actor });
    afterFix(ctx, done, { joined: true });
    return null;
  });
}
