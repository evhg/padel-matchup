import { createHash, timingSafeEqual } from "node:crypto";
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import type { Db } from "@/db";
import { events, players, slots, type Event, type Player } from "@/db/schema";
import { buildFeed, inviteFields } from "@/lib/calendar";
import { APP_NAME, baseUrl, emailEnabled, shortHost } from "@/lib/config";
import { getOrCreatePersonalToken, TOKEN_LENGTH } from "@/lib/domain/identity";
import { getPlayer } from "@/lib/domain/players";
import { stayUpdated, type StayChannel } from "@/lib/domain/stayUpdated";
import { translatorFor } from "@/lib/email/templates";
import { eventUrl } from "@/lib/share";
import { telegramEnabled } from "@/lib/telegram/api";
import { hexUuid, uuidSubject } from "@/lib/ticket";
import { whatsappLinkable } from "@/lib/whatsapp/api";

/**
 * The player's own calendar: every match they play in or organise, from thirty days back on, as a
 * feed a calendar subscribes to once and then keeps reading. It is what "your calendar updates
 * itself" means for somebody reached in a chat rather than by email: nothing is sent to the calendar,
 * the calendar comes and asks. Each entry carries the same UID and the same fields as the invitation
 * an email brings (`inviteFields`), so a match reads the same wherever it lands, and a cancelled
 * match stays in the feed marked CANCELLED, which is how a subscribed calendar learns it is off.
 *
 * The address is secret, like the private address of a Google calendar, but it is not the personal
 * link. It travels in chat messages, and a message can be forwarded, so the address carries a key made
 * from the personal token rather than the token itself: whoever holds it can read these matches and
 * cannot sign in. For the same reason every entry links the public match page, never the private
 * event link the emailed invitation carries — that link is a sign-in, and would turn the key back
 * into one. The key is checked against the current token and the one before it, so the lazy
 * shortening of an old token keeps a subscription working, and a reset of the personal link (which
 * keeps no previous token) ends it.
 */
export const FEED_DAYS_BACK = 30;
/** A season of matches and then some; the feed is read by a machine every hour or so, so it stays bounded. */
const FEED_MAX = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
const SIG_LENGTH = 20;

const sig = (token: string) => createHash("sha256").update(`calendar:${token}`).digest("hex").slice(0, SIG_LENGTH);

/** Which of the three channels this deployment runs, for the stay-updated rule (src/lib/domain/stayUpdated.ts). */
export const stayChannels = (): Record<StayChannel, boolean> => ({ whatsapp: whatsappLinkable(), telegram: telegramEnabled(), email: emailEnabled() });

/** Whether the feed keeps this player's calendar: the card's own rule, so a player with an address on file, who gets an invitation per match, is never offered the feed as well. */
export function feedCalendar(p: Pick<Player, "email" | "telegramId" | "phone">): boolean {
  const s = stayUpdated(p, stayChannels());
  return s.kind !== "reached" || s.calendar === "feed";
}

/** The feed's key: the player's id as 32 hex digits, then 20 hex digits of a hash of their personal token. */
export const feedKey = (playerId: string, token: string) => `${uuidSubject(playerId)}${sig(token)}`;

/** The key for this player's feed, minting their personal token first if they have none of today's length. */
export async function feedKeyFor(db: Db, player: Pick<Player, "id" | "personalToken">): Promise<string> {
  const token = player.personalToken?.length === TOKEN_LENGTH ? player.personalToken : await getOrCreatePersonalToken(db, player.id);
  return feedKey(player.id, token);
}

/** The player behind a key made from their current personal token or the one before it; null for anything else. One read by primary key. */
export async function playerForFeedKey(db: Db, key: string): Promise<Player | null> {
  const m = /^([0-9a-f]{32})([0-9a-f]{20})$/.exec(key);
  const id = m ? hexUuid(m[1]) : null;
  if (!m || !id) return null;
  const player = await getPlayer(db, id);
  if (!player) return null;
  const given = Buffer.from(m[2]);
  const matches = (token: string | null) => Boolean(token) && timingSafeEqual(Buffer.from(sig(token!)), given);
  return matches(player.personalToken) || matches(player.previousToken) ? player : null;
}

/**
 * Where the feed lives. `webcal:` asks the device's calendar to subscribe rather than to import one
 * copy; Google takes the same address through its own page, on a computer. `page` is the https page
 * that offers both, because a chat button can only open http(s) — Telegram refuses any other scheme
 * on a URL button and WhatsApp does not make one tappable. It opens in the player's language.
 */
export function feedLinks(base: string, key: string, locale?: string | null) {
  const https = `${base}/p/${key}/calendar.ics`;
  const webcal = https.replace(/^https?:/, "webcal:");
  const prefix = locale === "ru" || locale === "es" ? `/${locale}` : "";
  return { https, webcal, google: `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcal)}`, page: `${base}${prefix}/p/${key}/calendar` };
}

/**
 * The matches in the feed: those the player holds a seat in (the waitlist is not a seat, and the
 * invitation goes to a seat too) and those they organise, starting from thirty days back. Two reads,
 * each down its own index (`slots_player_idx`, `events_creator_idx`), rather than one OR that would
 * walk every match in the window.
 */
export async function feedEvents(db: Db, playerId: string, now = new Date()): Promise<Event[]> {
  const since = new Date(now.getTime() - FEED_DAYS_BACK * DAY_MS);
  const seated = await db
    .select({ event: events })
    .from(slots)
    .innerJoin(events, eq(events.id, slots.eventId))
    .where(and(eq(slots.playerId, playerId), inArray(slots.status, ["joined", "confirmed"]), lte(slots.position, events.capacity), gte(events.startsAt, since)))
    .orderBy(asc(events.startsAt))
    .limit(FEED_MAX);
  const organised = await db
    .select()
    .from(events)
    .where(and(eq(events.creatorPlayerId, playerId), gte(events.startsAt, since)))
    .orderBy(asc(events.startsAt))
    .limit(FEED_MAX);
  const byId = new Map<string, Event>();
  for (const ev of [...seated.map((r) => r.event), ...organised]) byId.set(ev.id, ev);
  return [...byId.values()].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime()).slice(0, FEED_MAX);
}

/** The whole feed for one player, in their language: two reads for the matches, one for every roster in it. */
export async function personalFeed(db: Db, player: Pick<Player, "id" | "displayName" | "locale">, now = new Date()): Promise<string> {
  const list = await feedEvents(db, player.id, now);
  const seats = list.length
    ? await db
        .select({ eventId: slots.eventId, status: slots.status, position: slots.position, invitedName: slots.invitedName, name: players.displayName })
        .from(slots)
        .leftJoin(players, eq(players.id, slots.playerId))
        .where(inArray(slots.eventId, list.map((e) => e.id)))
        // Seat order, as the invitation names them.
        .orderBy(asc(slots.eventId), asc(slots.position))
    : [];
  const rosters = new Map<string, typeof seats>();
  for (const s of seats) rosters.set(s.eventId, [...(rosters.get(s.eventId) ?? []), s]);
  const { t } = await translatorFor(player.locale);
  const translate = t as unknown as Parameters<typeof inviteFields>[2];
  const base = baseUrl();
  const entries = list.map((event) => {
    const roster = (rosters.get(event.id) ?? []).map((s) => ({ status: s.status, position: s.position, invitedName: s.invitedName, player: s.name ? { displayName: s.name } : null }));
    const f = inviteFields(event, roster, translate);
    return { event, title: f.title, url: eventUrl(base, event.code), location: f.location, extra: f.playersLine ? [f.playersLine] : undefined };
  });
  return buildFeed({ name: t("calendar.feedName", { app: APP_NAME }), domain: shortHost(), entries });
}
