import webpush from "web-push";
import { emailFrom } from "@/lib/config";

/**
 * Web Push via VAPID. Works in Chrome/Android, desktop browsers and iOS 16.4+
 * when the site was added to the home screen. Off until VAPID keys are set.
 */
export const pushEnabled = () => Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
export const vapidPublicKey = () => process.env.VAPID_PUBLIC_KEY ?? null;

let configuredFor: string | null = null;
function ensureConfigured() {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) throw new Error("VAPID keys missing");
  if (configuredFor === pub) return;
  const m = emailFrom().match(/<([^>]+)>/);
  webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? `mailto:${m ? m[1] : "hello@example.com"}`, pub, priv);
  configuredFor = pub;
}

export type PushPayload = { title: string; body: string; url: string; tag?: string };

/** "gone" = the browser dropped the subscription (404/410): delete it. */
export async function sendPush(sub: { endpoint: string; p256dh: string; auth: string }, payload: PushPayload): Promise<"sent" | "gone" | "failed"> {
  ensureConfigured();
  try {
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), { TTL: 3600, urgency: "high" });
    return "sent";
  } catch (e) {
    const code = (e as { statusCode?: number }).statusCode;
    if (code === 404 || code === 410) return "gone";
    console.warn("[push] send failed", code, (e as Error).message);
    return "failed";
  }
}
