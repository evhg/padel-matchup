import { after } from "next/server";
import { getDb } from "@/db";
import { reportError } from "@/lib/alerts";
import type { OpContext } from "@/lib/api/operations";
import { emitMatchEvent } from "@/lib/api/webhooks";
import { lineEnabled, verifySignature, type LineWebhookBody } from "@/lib/line/api";
import { handleLineWebhook } from "@/lib/line/bot";

export const dynamic = "force-dynamic";

/**
 * LINE calls this for every event in every room the bot is in. The signature over the raw body is
 * what proves it is LINE; an unsigned body is refused rather than trusted, because the endpoint is
 * public and anything reaching it could otherwise claim to be any room.
 *
 * The answer is always 200 once the signature checks out: LINE retries a non-2xx, and an event we
 * could not read is not an event worth being sent again.
 */
export async function POST(req: Request) {
  if (!lineEnabled()) return new Response("line disabled", { status: 404 });
  const raw = await req.text();
  if (!verifySignature(raw, req.headers.get("x-line-signature"))) return new Response("forbidden", { status: 403 });

  let body: LineWebhookBody;
  try {
    body = JSON.parse(raw) as LineWebhookBody;
  } catch {
    return Response.json({ ok: true, outcome: "bad_json" });
  }

  const db = await getDb();
  const ctx: OpContext = {
    afterwards: (fn) => after(fn),
    emit: (event, code, extra) => after(() => emitMatchEvent(db, event, code, extra, { channel: "line" })),
    channel: "line",
  };
  try {
    return Response.json({ ok: true, outcome: await handleLineWebhook(db, body, ctx) });
  } catch (e) {
    void reportError("server", e instanceof Error ? e : new Error(String(e)));
    return Response.json({ ok: true, outcome: "error" });
  }
}
