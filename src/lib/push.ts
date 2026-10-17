import { emailFrom } from "@/lib/config";
import { pushEnabled, vapidPublicKey } from "@/lib/pushConfig";

/**
 * Web Push via VAPID. Works in Chrome/Android, desktop browsers and iOS 16.4+
 * when the site was added to the home screen. Off until VAPID keys are set.
 * The two switches live in `pushConfig.ts`: a screen that only asks them imports that file, and the
 * senders keep importing them from here.
 */
export { pushEnabled, vapidPublicKey };

type WebPush = typeof import("web-push");
let loaded: Promise<WebPush> | null = null;

/**
 * web-push and its crypto, loaded on the first send of an instance and never before. A page's server
 * entry loads every module that the page and its server actions import, and most pages reach a module
 * that can send a push: `notify.ts` behind the actions of the match page (a join, a score, a group),
 * `feedback/store.ts` on My matches. So the static import that stood here put web-push into the start
 * of 90 of the 140 route entries of a build, where nothing but `pushEnabled()` ran. Since 16 October
 * 2026 it is in none of them: the chunk list at the end of each route's `page.js` under
 * `.next/server/app` says so (`scripts/check-bundle.mjs`, `ON_USE`), not this comment.
 */
const webPush = (): Promise<WebPush> => (loaded ??= import("web-push").then((m) => ((m as { default?: WebPush }).default ?? m) as WebPush));

let configuredFor: string | null = null;
async function ensureConfigured(): Promise<WebPush> {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) throw new Error("VAPID keys missing");
  const webpush = await webPush();
  if (configuredFor === pub) return webpush;
  const m = emailFrom().match(/<([^>]+)>/);
  webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? `mailto:${m ? m[1] : "hello@example.com"}`, pub, priv);
  configuredFor = pub;
  return webpush;
}

export type PushPayload = { title: string; body: string; url: string; tag?: string };

/** "gone" = the browser dropped the subscription (404/410): delete it. */
export async function sendPush(sub: { endpoint: string; p256dh: string; auth: string }, payload: PushPayload): Promise<"sent" | "gone" | "failed"> {
  const webpush = await ensureConfigured();
  try {
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), { TTL: 3600, urgency: "high" });
    return "sent";
  } catch (e) {
    const code = (e as { statusCode?: number }).statusCode;
    if (code === 404 || code === 410) return "gone";
    console.warn("[push] send failed", code, (e as Error).message);
    // Counted for the service board's Web Push row ("N failed today"); a dropped subscription above is not a failure.
    await countFailed();
    return "failed";
  }
}

async function countFailed(): Promise<void> {
  try {
    const [{ later }, { getDb }, { bumpMetric }] = await Promise.all([import("@/lib/later"), import("@/db"), import("@/lib/domain/metrics")]);
    await later(async () => bumpMetric(await getDb(), "push_failed"));
  } catch {
    /* metrics are optional */
  }
}
