"use server";

import { headers } from "next/headers";
import { getDb } from "@/db";
import { markHomescreen, removePushSubscription, savePushSubscription, validEndpoint, type SubscriptionInput } from "@/lib/domain/push";
import { pushEnabled } from "@/lib/push";
import { getSessionPlayer } from "@/lib/session";
import { ActionFailure, nameOnly, runA, type ActionResult } from "./shared";

const validSub = (s: SubscriptionInput) => validEndpoint(s?.endpoint) && typeof s.keys?.p256dh === "string" && typeof s.keys?.auth === "string";

/**
 * Browser subscribed for reminders: remember it for this player (any device count). Never for a session
 * by name that proved nothing (DECIDING rule 34, `proof_required`): every notification carries the
 * player's personal link, a full sign-in, so a subscription would hand that session what rule 34 holds
 * back. Found on 28 October 2026 with "Not you? Sign out": a stranger's "That's me", reminders on, a
 * sign-out, and the next reminder signed the phone in as the player in full.
 */
export async function subscribePushAction(sub: SubscriptionInput): Promise<ActionResult<null>> {
  return runA(async () => {
    if (!pushEnabled()) throw new ActionFailure("generic");
    if (!validSub(sub)) throw new ActionFailure("invalid");
    const db = await getDb();
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    if (await nameOnly(me)) throw new ActionFailure("proof_required");
    const ua = (await headers()).get("user-agent")?.slice(0, 200) ?? null;
    await savePushSubscription(db, me.id, sub, ua);
    return null;
  });
}

export async function unsubscribePushAction(endpoint: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const db = await getDb();
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    await removePushSubscription(db, endpoint);
    return null;
  });
}

/** Page opened in standalone (home-screen) mode: the shortcut exists. */
export async function markHomescreenAction(): Promise<ActionResult<null>> {
  return runA(async () => {
    const db = await getDb();
    const me = await getSessionPlayer(db);
    if (me && !me.homescreenAt) await markHomescreen(db, me.id);
    return null;
  });
}
