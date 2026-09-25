import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The WhatsApp Cloud API, one fetch per call. No SDK, errors returned rather than thrown, tests stub
 * `globalThis.fetch` — the same shape as the Telegram client beside it.
 *
 * What this is NOT is a card channel, and the reason is worth keeping here rather than in a document
 * that rots. Every other chat integration Kicksmash has works by putting one card in a room somebody
 * else made and editing it in place as people join. WhatsApp does not sell that, at any tier: its
 * Groups API only creates the business's own groups — invite link only, eight participants, one
 * business per group, an Official Business Account required, and no endpoint that adds a participant.
 * Re-checked against Meta's own page on 14 September 2026 and unchanged.
 *
 * So this talks to one person at a time. That turns out to carry almost the whole of a player's
 * experience: reply buttons to take or give up a spot, a list to choose between times, a map pin for
 * the court, a template for a reminder. What it cannot carry is the part everybody sees at once —
 * nobody learns the roster filled without asking, and the group cannot settle a score.
 */

const API_VERSION = "v21.0";

/** Every one of these is optional (rule 4): with none set, WhatsApp is simply off and nothing breaks. */
export const whatsappEnabled = () => Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID);
/** The number people message, digits only, for the wa.me hand-off link. Readable without the send token. */
export const whatsappNumber = () => (process.env.WHATSAPP_NUMBER ?? "").replace(/\D/g, "") || null;
export const whatsappVerifyToken = () => process.env.WHATSAPP_VERIFY_TOKEN ?? null;
/** Meta's app secret: it signs every delivery to the webhook, and it signs the `LINK-` code a match page puts in a player's mouth (link.ts). */
export const whatsappAppSecret = () => process.env.WHATSAPP_APP_SECRET || null;
const appSecret = whatsappAppSecret;
/**
 * Whether a match page may offer "link my WhatsApp": a number to write to, a signed code only this
 * deployment can make (the app secret), and a thread that can answer (the send token and phone id).
 * Short of any one of them, the tap would open a conversation nobody replies to, so the choice is
 * simply not there.
 */
export const whatsappLinkable = () => Boolean(whatsappEnabled() && whatsappNumber() && whatsappAppSecret());
const token = () => process.env.WHATSAPP_TOKEN ?? "";
const phoneId = () => process.env.WHATSAPP_PHONE_ID ?? "";

export type WaResult<T = unknown> = { ok: true; result: T } | { ok: false; status: number; error: string };

/** Meta's own caps. Exceeding one is a 400, so the senders below cut rather than discover it in production. */
export const LIMITS = { body: 1024, buttonTitle: 20, buttons: 3, rowTitle: 24, rowDescription: 72, rows: 10, header: 60 } as const;
const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** One counter per call, for the service board; never blocks a send and never throws. */
async function count(key: "whatsapp_sent" | "whatsapp_failed"): Promise<void> {
  try {
    const [{ getDb }, { bumpMetric }] = await Promise.all([import("@/db"), import("@/lib/domain/metrics")]);
    await bumpMetric(await getDb(), key);
  } catch {
    /* metrics are optional */
  }
}

async function send<T = unknown>(body: Record<string, unknown>): Promise<WaResult<T>> {
  if (!whatsappEnabled()) return { ok: false, status: 0, error: "whatsapp disabled" };
  try {
    const res = await fetch(`https://graph.facebook.com/${API_VERSION}/${phoneId()}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...body }),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    if (!res.ok) {
      void count("whatsapp_failed");
      return { ok: false, status: res.status, error: json?.error?.message ?? `whatsapp ${res.status}` };
    }
    void count("whatsapp_sent");
    return { ok: true, result: json as T };
  } catch (e) {
    void count("whatsapp_failed");
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

export const sendText = (to: string, text: string): Promise<WaResult> => send({ to, type: "text", text: { body: cut(text, LIMITS.body), preview_url: true } });

export type WaButton = { id: string; title: string };

/**
 * Up to three buttons under a message. Not a template, so no approval queue — which is why the whole
 * take-a-spot loop can exist at all without waiting on Meta to read anything.
 */
export const sendButtons = (to: string, text: string, buttons: WaButton[]): Promise<WaResult> =>
  send({
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: cut(text, LIMITS.body) },
      action: { buttons: buttons.slice(0, LIMITS.buttons).map((b) => ({ type: "reply", reply: { id: b.id, title: cut(b.title, LIMITS.buttonTitle) } })) },
    },
  });

export type WaRow = { id: string; title: string; description?: string };

/** A ten-row list: the shape for choosing between times, matches or courts. */
export const sendList = (to: string, text: string, buttonLabel: string, rows: WaRow[]): Promise<WaResult> =>
  send({
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: cut(text, LIMITS.body) },
      action: {
        button: cut(buttonLabel, LIMITS.buttonTitle),
        sections: [{ rows: rows.slice(0, LIMITS.rows).map((r) => ({ id: r.id, title: cut(r.title, LIMITS.rowTitle), ...(r.description ? { description: cut(r.description, LIMITS.rowDescription) } : {}) })) }],
      },
    },
  });

/** The court as a pin, which is the one thing this channel does better than the web page. */
export const sendLocation = (to: string, at: { latitude: number; longitude: number; name?: string; address?: string }): Promise<WaResult> =>
  send({ to, type: "location", location: at });

/**
 * The only rationed message. Everything above is free inside the 24-hour window a person opens by
 * writing to us; a template is what reaches somebody who has gone quiet, and it is what the daily
 * limit actually counts — Meta's definition is unique numbers messaged *outside* a customer service
 * window, so replies inside one are not counted at all.
 */
export const sendTemplate = (to: string, name: string, language: string, params: string[]): Promise<WaResult> =>
  send({
    to,
    type: "template",
    template: {
      name,
      language: { code: language },
      ...(params.length ? { components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }] } : {}),
    },
  });

/**
 * Meta signs every delivery with the app secret. Unsigned bodies are refused rather than trusted:
 * this endpoint is public, and anything that reaches it can otherwise claim to be any phone number.
 * With no secret configured the webhook refuses everything, which is the safe direction for a channel
 * that is off by default.
 */
export function verifySignature(rawBody: string, header: string | null): boolean {
  const secret = appSecret();
  if (!secret || !header) return false;
  const given = header.startsWith("sha256=") ? header.slice(7) : header;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(given, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

// --------------------------------------------------------------------------- inbound shapes

export type WaInboundMessage = {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  interactive?: { type: string; button_reply?: { id: string; title: string }; list_reply?: { id: string; title: string } };
};
export type WaContact = { wa_id: string; profile?: { name?: string } };
export type WaUpdate = {
  object?: string;
  entry?: { id: string; changes?: { field: string; value: { messaging_product?: string; contacts?: WaContact[]; messages?: WaInboundMessage[] } }[] }[];
};

/** What the person actually said: typed text, or the id behind the button or row they tapped. */
export function readInbound(msg: WaInboundMessage): { text: string; tappedId: string | null } {
  const reply = msg.interactive?.button_reply ?? msg.interactive?.list_reply;
  if (reply) return { text: reply.title, tappedId: reply.id };
  return { text: msg.text?.body ?? "", tappedId: null };
}
