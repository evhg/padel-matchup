import { createPublicKey, verify as verifySig } from "node:crypto";

/**
 * Thin Discord REST client, HTTP interactions only (no gateway: the app runs
 * on serverless functions). One fetch per call, errors returned rather than
 * thrown so the bot can stay quiet on failure. Tests stub globalThis.fetch.
 */
export const discordEnabled = () => Boolean(process.env.DISCORD_BOT_TOKEN);
const token = () => process.env.DISCORD_BOT_TOKEN ?? "";
export const discordPublicKey = () => process.env.DISCORD_PUBLIC_KEY ?? null;
export const discordInviteUrl = () => process.env.DISCORD_INVITE_URL ?? null;

/** The application id is the bot user's id, which the first token segment encodes; DISCORD_APPLICATION_ID overrides. */
export function discordApplicationId(): string | null {
  if (process.env.DISCORD_APPLICATION_ID) return process.env.DISCORD_APPLICATION_ID;
  const head = token().split(".")[0];
  if (!head) return null;
  try {
    const id = Buffer.from(head, "base64").toString("utf8");
    return /^\d{15,22}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export const API = "https://discord.com/api/v10";

export type DcResult<T> = { ok: true; result: T } | { ok: false; status: number; error: string };

export async function dc<T = unknown>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<DcResult<T>> {
  if (!discordEnabled()) return { ok: false, status: 0, error: "discord disabled" };
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bot ${token()}`, "content-type": "application/json", "user-agent": "DiscordBot (https://kicksma.sh, 1.0)" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 204) return { ok: true, result: undefined as T };
    const json = (await res.json().catch(() => null)) as (T & { message?: string; code?: number }) | null;
    if (!res.ok) return { ok: false, status: res.status, error: json?.message ? `${json.message} (${json.code ?? res.status})` : `HTTP ${res.status}` };
    return { ok: true, result: json as T };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Shapes (the subset we touch)
// ---------------------------------------------------------------------------
export type DcUser = { id: string; username: string; global_name?: string | null; bot?: boolean; discriminator?: string };
export type DcChannel = { id: string; type: number; name?: string; guild_id?: string; parent_id?: string | null; last_message_id?: string | null };
export type DcGuild = { id: string; name: string };
export type DcMessage = { id: string; channel_id: string; type?: number; content?: string; author: DcUser; timestamp: string; mentions?: DcUser[]; referenced_message?: DcMessage | null };
export type DcEmbed = { title?: string; description?: string; url?: string; color?: number; fields?: { name: string; value: string; inline?: boolean }[]; footer?: { text: string }; image?: { url: string } };
export type DcButton = { type: 2; style: 1 | 2 | 3 | 4 | 5; label: string; custom_id?: string; url?: string; disabled?: boolean };
export type DcActionRow = { type: 1; components: DcButton[] };

/** Interaction types and response types we use. */
export const INTERACTION = { PING: 1, COMMAND: 2, COMPONENT: 3 } as const;
export const RESPONSE = { PONG: 1, MESSAGE: 4, DEFERRED_MESSAGE: 5, DEFERRED_UPDATE: 6, UPDATE_MESSAGE: 7 } as const;
export const EPHEMERAL = 64;
/** The three text channel types the listener reads: text, announcement, public thread. */
export const TEXT_CHANNEL_TYPES = new Set([0, 5, 11]);

export type DcInteraction = {
  id: string;
  application_id: string;
  type: number;
  token: string;
  guild_id?: string;
  channel_id?: string;
  channel?: DcChannel;
  member?: { user: DcUser; nick?: string | null };
  user?: DcUser;
  locale?: string;
  guild_locale?: string;
  message?: { id: string; channel_id: string };
  data?: { id?: string; name?: string; options?: { name: string; type: number; value?: string | number | boolean }[]; custom_id?: string; component_type?: number };
};

export type InteractionResponse = { type: number; data?: { content?: string; embeds?: DcEmbed[]; components?: DcActionRow[]; flags?: number; allowed_mentions?: { parse: string[] } } };

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------
export type MessagePayload = { content?: string; embeds?: DcEmbed[]; components?: DcActionRow[]; replyTo?: string | null; suppressNotifications?: boolean };

const body = (m: MessagePayload) => ({
  ...(m.content !== undefined ? { content: m.content } : {}),
  ...(m.embeds ? { embeds: m.embeds } : {}),
  ...(m.components ? { components: m.components } : {}),
  ...(m.replyTo ? { message_reference: { message_id: m.replyTo, fail_if_not_exists: false } } : {}),
  // Never ping roles or everyone; a reply may notify the person we answer.
  allowed_mentions: { parse: [], replied_user: true },
  ...(m.suppressNotifications ? { flags: 1 << 12 } : {}),
});

export const createMessage = (channelId: string, m: MessagePayload) => dc<DcMessage>("POST", `/channels/${channelId}/messages`, body(m));
export const editMessage = (channelId: string, messageId: string, m: MessagePayload) => dc<DcMessage>("PATCH", `/channels/${channelId}/messages/${messageId}`, body(m));
export const getMessages = (channelId: string, q: { after?: string | null; limit?: number } = {}) => dc<DcMessage[]>("GET", `/channels/${channelId}/messages?limit=${q.limit ?? 50}${q.after ? `&after=${q.after}` : ""}`);
export const listGuilds = () => dc<DcGuild[]>("GET", "/users/@me/guilds");
export const listGuildChannels = (guildId: string) => dc<DcChannel[]>("GET", `/guilds/${guildId}/channels`);
export const createInvite = (channelId: string) => dc<{ code: string }>("POST", `/channels/${channelId}/invites`, { max_age: 0, max_uses: 0, unique: false });

/** Follow-up on a deferred interaction: edits the "thinking" placeholder. */
export const editOriginalResponse = (interactionToken: string, m: MessagePayload) => {
  const app = discordApplicationId();
  if (!app) return Promise.resolve<DcResult<DcMessage>>({ ok: false, status: 0, error: "no application id" });
  return dc<DcMessage>("PATCH", `/webhooks/${app}/${interactionToken}/messages/@original`, body(m));
};

export type CommandSpec = { name: string; description: string; options?: { type: number; name: string; description: string; required?: boolean }[]; name_localizations?: Record<string, string>; description_localizations?: Record<string, string> };

/** Global slash commands; Discord replaces the whole set. */
export const registerCommands = (commands: CommandSpec[]) => {
  const app = discordApplicationId();
  if (!app) return Promise.resolve<DcResult<unknown>>({ ok: false, status: 0, error: "no application id" });
  return dc("PUT", `/applications/${app}/commands`, commands.map((c) => ({ ...c, type: 1, contexts: [0], integration_types: [0] })));
};

export const getApplication = () => dc<{ id: string; verify_key: string; interactions_endpoint_url?: string | null; flags?: number }>("GET", "/applications/@me");
export const patchApplication = (patch: Record<string, unknown>) => dc<{ id: string; flags?: number; interactions_endpoint_url?: string | null }>("PATCH", "/applications/@me", patch);

/** Message Content is a privileged intent; under 100 servers the "limited" flag is enough and can be set through the API. */
export const MESSAGE_CONTENT_LIMITED = 1 << 19;

/** Permissions the invite asks for: read and write in channels and threads, embeds, history, reactions, invites. */
export const BOT_PERMISSIONS = (1n << 0n) | (1n << 6n) | (1n << 10n) | (1n << 11n) | (1n << 14n) | (1n << 15n) | (1n << 16n) | (1n << 18n) | (1n << 35n) | (1n << 38n);

export function botInviteUrl(guildId?: string | null): string | null {
  const app = discordApplicationId();
  if (!app) return null;
  const q = new URLSearchParams({ client_id: app, scope: "bot applications.commands", permissions: BOT_PERMISSIONS.toString() });
  if (guildId) q.set("guild_id", guildId);
  return `https://discord.com/oauth2/authorize?${q.toString()}`;
}

// ---------------------------------------------------------------------------
// Signature: every interaction request carries an Ed25519 signature over
// timestamp + raw body, made with the application's key.
// ---------------------------------------------------------------------------
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function verifyInteraction(signatureHex: string | null, timestamp: string | null, rawBody: string, publicKeyHex = discordPublicKey()): boolean {
  if (!signatureHex || !timestamp || !publicKeyHex) return false;
  if (!/^[0-9a-f]{128}$/i.test(signatureHex) || !/^[0-9a-f]{64}$/i.test(publicKeyHex)) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]), format: "der", type: "spki" });
    return verifySig(null, Buffer.from(timestamp + rawBody), key, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

/** Escape for Discord markdown (names can carry underscores and stars). */
export const md = (s: string) => s.replace(/([\\*_~`|>#-])/g, "\\$1");

export const messageUrl = (guildId: string | null | undefined, channelId: string, messageId: string) => `https://discord.com/channels/${guildId ?? "@me"}/${channelId}/${messageId}`;
