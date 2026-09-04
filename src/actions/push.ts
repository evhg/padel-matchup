"use server";

import { headers } from "next/headers";
import { getDb } from "@/db";
import { markHomescreen, removePushSubscription, savePushSubscription, type SubscriptionInput } from "@/lib/domain/push";
import { pushEnabled } from "@/lib/push";
import { getSessionPlayer } from "@/lib/session";
import { ActionFailure, runA, type ActionResult } from "./shared";

const validSub = (s: SubscriptionInput) => typeof s?.endpoint === "string" && /^https:\/\//.test(s.endpoint) && s.endpoint.length < 2048 && typeof s.keys?.p256dh === "string" && typeof s.keys?.auth === "string";

/** Browser subscribed for reminders: remember it for this player (any device count). */
export async function subscribePushAction(sub: SubscriptionInput): Promise<ActionResult<null>> {
  return runA(async () => {
    if (!pushEnabled()) throw new ActionFailure("generic");
    if (!validSub(sub)) throw new ActionFailure("invalid");
    const db = await getDb();
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
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
