import { getDb } from "@/db";
import { later, reportError } from "@/lib/alerts";
import { verifySignature, whatsappEnabled, whatsappVerifyToken, type WaUpdate } from "@/lib/whatsapp/api";
import { handleWhatsappMessage } from "@/lib/whatsapp/bot";

export const dynamic = "force-dynamic";

/**
 * Meta calls this twice in a webhook's life and then for every message.
 *
 * The GET is the one-time subscription handshake: Meta sends a token it was given in the dashboard
 * and expects the challenge echoed back. The POST is every inbound message, signed with the app
 * secret — and unsigned bodies are refused rather than trusted, because this endpoint is public and
 * anything reaching it could otherwise claim to be any phone number.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const expected = whatsappVerifyToken();
  if (!expected || url.searchParams.get("hub.mode") !== "subscribe" || url.searchParams.get("hub.verify_token") !== expected) {
    return new Response("forbidden", { status: 403 });
  }
  return new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200, headers: { "content-type": "text/plain" } });
}

export async function POST(req: Request) {
  if (!whatsappEnabled()) return new Response("whatsapp disabled", { status: 404 });
  // The raw bytes, because the signature covers exactly what was sent and JSON.parse loses that.
  const raw = await req.text();
  if (!verifySignature(raw, req.headers.get("x-hub-signature-256"))) return new Response("forbidden", { status: 403 });

  let update: WaUpdate;
  try {
    update = JSON.parse(raw) as WaUpdate;
  } catch {
    return Response.json({ ok: true, outcome: "bad_json" });
  }

  const db = await getDb();
  const outcomes: string[] = [];
  for (const entry of update.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const messages = change.value?.messages ?? [];
      const contacts = change.value?.contacts ?? [];
      // A delivery carries a handful of messages at most; statuses and read receipts carry none, and
      // this is the common case — Meta sends far more of those than of anything a person typed.
      for (const msg of messages.slice(0, 10)) {
        const contact = contacts.find((c) => c.wa_id === msg.from);
        try {
          outcomes.push(await handleWhatsappMessage(db, msg, contact));
        } catch (e) {
          outcomes.push("error");
          await later(() => reportError("server", e instanceof Error ? e : new Error(String(e))));
        }
      }
    }
  }
  // Always 200: Meta retries a non-2xx for hours, and a message we could not understand is not a
  // message worth being sent twenty more times.
  return Response.json({ ok: true, outcome: outcomes.join(",") || "ignored" });
}
