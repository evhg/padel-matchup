import { baseUrl } from "@/lib/config";
import { MESSAGE_CONTENT_LIMITED, botInviteUrl, discordEnabled, discordPublicKey, getApplication, patchApplication, registerCommands } from "@/lib/discord/api";
import { COMMANDS } from "@/lib/discord/bot";

export const dynamic = "force-dynamic";

/**
 * One-time (idempotent) registration: slash commands, the interactions URL,
 * the limited message-content flag (reading questions in channels) and the
 * install link. Protected like the cron routes.
 */
export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) return new Response("unauthorized", { status: 401 });
  if (!discordEnabled() || !discordPublicKey()) return Response.json({ ok: false, error: "DISCORD_BOT_TOKEN or DISCORD_PUBLIC_KEY missing" }, { status: 400 });
  const url = `${baseUrl()}/api/discord/interactions`;
  const commands = await registerCommands(COMMANDS);
  const before = await getApplication();
  const wantFlags = ((before.ok ? before.result.flags : 0) ?? 0) | MESSAGE_CONTENT_LIMITED;
  const endpoint = before.ok && before.result.interactions_endpoint_url === url ? { ok: true as const, skipped: true } : await patchApplication({ interactions_endpoint_url: url, description: "Padel matches with one link. One card per match, one tap to join. Quiet by design. kicksma.sh", tags: ["padel", "sports", "matches", "americano", "open source"] });
  const flags = before.ok && (before.result.flags ?? 0) === wantFlags ? { ok: true as const, skipped: true } : await patchApplication({ flags: wantFlags });
  const after = await getApplication();
  return Response.json({
    ok: commands.ok && endpoint.ok && flags.ok,
    url,
    commands: commands.ok ? COMMANDS.map((c) => c.name) : commands,
    endpoint,
    flags,
    application: after.ok ? { id: after.result.id, interactions_endpoint_url: after.result.interactions_endpoint_url, flags: after.result.flags } : after,
    invite: botInviteUrl(),
  });
}
