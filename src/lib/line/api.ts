import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The LINE Messaging API, one fetch per call, errors returned rather than thrown. Tests stub
 * `globalThis.fetch`, as the Telegram and Discord clients beside it do.
 *
 * Two things about LINE shape everything above this file:
 *
 * A sent message **cannot be edited**. Every other channel keeps one card per match and edits it as
 * people join; here an "edit" is a new message in everyone's chat. So the adapter declares
 * `canEdit: false` and the card algorithm keys on what a player would actually notice.
 *
 * And a **reply is free while a push is metered**. Answering an inbound event costs nothing and uses
 * a reply token that is single-use and short-lived; anything the app starts by itself — a sync, the
 * hour-before reminder, a result — is a push and counts against a monthly budget. So `post` replies
 * when it was given a token and pushes only when it has to.
 */

const API = "https://api.line.me/v2/bot";

/** Optional, like every other channel (rule 4): unset, LINE is simply off. */
export const lineEnabled = () => Boolean(process.env.LINE_CHANNEL_TOKEN && process.env.LINE_CHANNEL_SECRET);
const token = () => process.env.LINE_CHANNEL_TOKEN ?? "";
const secret = () => process.env.LINE_CHANNEL_SECRET ?? "";

export type LineResult<T = unknown> = { ok: true; result: T } | { ok: false; status: number; error: string };

/** A Flex bubble, loosely typed: the shape is LINE's and this file does not improve on it. */
export type FlexBubble = Record<string, unknown>;
export type LineMessage =
  | { type: "text"; text: string }
  | { type: "flex"; altText: string; contents: FlexBubble }
  | { type: "image"; originalContentUrl: string; previewImageUrl: string };

async function count(key: "line_sent" | "line_failed"): Promise<void> {
  try {
    const [{ getDb }, { bumpMetric }] = await Promise.all([import("@/db"), import("@/lib/domain/metrics")]);
    await bumpMetric(await getDb(), key);
  } catch {
    /* metrics are optional */
  }
}

async function call<T = unknown>(path: string, body: Record<string, unknown>): Promise<LineResult<T>> {
  if (!lineEnabled()) return { ok: false, status: 0, error: "line disabled" };
  try {
    const res = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      void count("line_failed");
      return { ok: false, status: res.status, error: text.slice(0, 300) || `line ${res.status}` };
    }
    void count("line_sent");
    return { ok: true, result: (await res.json().catch(() => ({}))) as T };
  } catch (e) {
    void count("line_failed");
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Free, and the reason the router carries the token around. Single use: a second reply is refused. */
export const reply = (replyToken: string, messages: LineMessage[]): Promise<LineResult> => call("/message/reply", { replyToken, messages: messages.slice(0, 5) });

/** Metered. Everything the app starts by itself lands here, which is why it is kept to what changed. */
export const push = (to: string, messages: LineMessage[]): Promise<LineResult> => call("/message/push", { to, messages: messages.slice(0, 5) });

/**
 * LINE signs the raw body with the channel secret. Unsigned bodies are refused rather than trusted:
 * the endpoint is public, and anything reaching it could otherwise claim to be any room.
 */
export function verifySignature(rawBody: string, header: string | null): boolean {
  const s = secret();
  if (!s || !header) return false;
  const expected = createHmac("sha256", s).update(rawBody, "utf8").digest("base64");
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// --------------------------------------------------------------------------- inbound

/** Where a message came from: a group, a multi-person room, or one person. */
export type LineSource = { type: "user" | "group" | "room"; userId?: string; groupId?: string; roomId?: string };
export type LineEvent = {
  type: string;
  replyToken?: string;
  source: LineSource;
  message?: { id: string; type: string; text?: string };
  postback?: { data: string };
};
export type LineWebhookBody = { destination?: string; events?: LineEvent[] };

/** The id of the place an event happened, whichever of the three shapes it is. */
export const sourceId = (s: LineSource): string | null => s.groupId ?? s.roomId ?? s.userId ?? null;
