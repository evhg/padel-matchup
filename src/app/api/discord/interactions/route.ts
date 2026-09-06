import { after } from "next/server";
import { getDb } from "@/db";
import type { OpContext } from "@/lib/api/operations";
import { emitMatchEvent } from "@/lib/api/webhooks";
import { reportError } from "@/lib/alerts";
import { discordEnabled, discordPublicKey, verifyInteraction, type DcInteraction } from "@/lib/discord/api";
import { handleInteraction } from "@/lib/discord/bot";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Discord calls this for every slash command and button. The Ed25519
 * signature proves it is Discord (a bad one must get 401: Discord checks
 * that when the URL is saved). Slow work runs after the answer.
 */
export async function POST(req: Request) {
  if (!discordEnabled() || !discordPublicKey()) return new Response("discord disabled", { status: 404 });
  const raw = await req.text();
  if (!verifyInteraction(req.headers.get("x-signature-ed25519"), req.headers.get("x-signature-timestamp"), raw)) return new Response("invalid request signature", { status: 401 });
  let interaction: DcInteraction | null = null;
  try {
    interaction = JSON.parse(raw) as DcInteraction;
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const db = await getDb();
  const ctx: OpContext = {
    afterwards: (fn) => after(fn),
    emit: (event, code, extra) => after(() => emitMatchEvent(db, event, code, extra)),
  };
  const handled = await handleInteraction(db, interaction, ctx);
  if (handled.outcome.startsWith("error:")) void reportError("server", new Error(`discord interaction ${interaction.id}: ${handled.outcome}`));
  if (handled.followUp) {
    const followUp = handled.followUp;
    after(async () => {
      try {
        await followUp();
      } catch (e) {
        void reportError("server", e instanceof Error ? e : new Error(String(e)));
      }
    });
  }
  return Response.json(handled.response, { headers: { "x-kicksmash-outcome": handled.outcome } });
}
