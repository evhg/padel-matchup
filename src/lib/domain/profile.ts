import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { players, type Player } from "@/db/schema";
import { clubStatus, listClubsClaimedBy } from "./clubs";
import { getPlayerGroups } from "./groups";
import { bandOf, isLevelVerified } from "./levels";
import { signPassport, type Passport, type SignedPassport } from "./passport";
import { getPlayerEvents, type MyEvent } from "./queries";
import { venueSlug } from "./venueBoard";

/**
 * The player passport: an opt-in public page (/u/{slug}), a signed level
 * document any app can verify, and a one-file export of everything we hold.
 * Off by default; nothing here is reachable until the player switches it on.
 */
const SLUG_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const PASSPORT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const suffix = () => Array.from(randomBytes(5), (b) => SLUG_ALPHABET[b % SLUG_ALPHABET.length]).join("");

/** "Ana María" → "ana-x7k2m": first name, ASCII, plus five random characters so names never collide. */
export function mintPublicSlug(displayName: string): string {
  const first = venueSlug(displayName.trim().split(/\s+/)[0] ?? "")?.slice(0, 20) || "player";
  return `${first}-${suffix()}`;
}

export const isValidPublicSlug = (s: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s) && s.length >= 7 && s.length <= 40;

export async function setPublicProfile(db: Db, playerId: string, on: boolean, now = new Date()): Promise<Player | null> {
  const [me] = await db.select().from(players).where(eq(players.id, playerId)).limit(1);
  if (!me) return null;
  const slug = me.publicSlug ?? mintPublicSlug(me.displayName);
  const [row] = await db
    .update(players)
    .set({ publicProfile: on, publicSlug: slug, publicSince: on ? (me.publicSince ?? now) : me.publicSince })
    .where(eq(players.id, playerId))
    .returning();
  return row;
}

export async function getPublicPlayer(db: Db, slug: string): Promise<Player | null> {
  if (!isValidPublicSlug(slug)) return null;
  const [p] = await db.select().from(players).where(and(eq(players.publicSlug, slug), eq(players.publicProfile, true))).limit(1);
  return p ?? null;
}

export type ProfileStats = { played: number; won: number; decided: number; podiums: number; clubs: { name: string; slug: string }[]; since: Date };

/** Results the player was actually in (not organised from the sidelines), finished matches only. */
export function statsFromEvents(player: Pick<Player, "id" | "createdAt">, past: MyEvent[]): ProfileStats {
  const played = past.filter((m) => m.event.status !== "cancelled" && m.slot.position > 0 && m.slot.position <= m.event.capacity);
  const won = played.filter((m) => m.outcome === "won").length;
  const decided = played.filter((m) => m.outcome === "won" || m.outcome === "lost").length;
  const podiums = played.filter((m) => m.event.type === "tournament" && (m.event.standings ?? []).slice(0, 3).includes(player.id)).length;
  const clubs = new Map<string, string>();
  for (const m of played) {
    const slug = m.event.venueSlug;
    if (slug && m.event.venueName && !clubs.has(slug)) clubs.set(slug, m.event.venueName);
  }
  return { played: played.length, won, decided, podiums, clubs: [...clubs.entries()].slice(0, 8).map(([slug, name]) => ({ slug, name })), since: player.createdAt };
}

export async function profileStats(db: Db, player: Player, now = new Date()): Promise<ProfileStats> {
  const { past } = await getPlayerEvents(db, player.id, now);
  return statsFromEvents(player, past);
}

export function buildPassport(player: Player, stats: Pick<ProfileStats, "played" | "won">, base: string, publicKeyHex: string | null, now = new Date()): Passport {
  return {
    v: 1,
    iss: base,
    kid: publicKeyHex ? publicKeyHex.slice(0, 8).toLowerCase() : "none",
    sub: `${base}/u/${player.publicSlug}`,
    name: player.displayName,
    level: player.level,
    band: player.level != null ? bandOf(player.level) : null,
    verified: isLevelVerified(player),
    source: player.levelSource,
    played: stats.played,
    won: stats.won,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PASSPORT_TTL_MS).toISOString(),
  };
}

export const passportKeys = () => {
  const priv = process.env.PASSPORT_PRIVATE_KEY;
  const pub = process.env.PASSPORT_PUBLIC_KEY;
  return priv && pub && /^[0-9a-f]{64}$/i.test(priv) && /^[0-9a-f]{64}$/i.test(pub) ? { priv, pub } : null;
};

/** The signed document, or the plain one with alg "none" when no key is configured (a self-hosted copy without keys). */
export async function issuePassport(player: Player, stats: Pick<ProfileStats, "played" | "won">, base: string, now = new Date()): Promise<SignedPassport | (Passport & { alg: "none"; sig: null })> {
  const keys = passportKeys();
  const doc = buildPassport(player, stats, base, keys?.pub ?? null, now);
  if (!keys) return { ...doc, alg: "none", sig: null };
  return signPassport(doc, keys.priv, keys.pub);
}

/** Everything we hold about a player, in one file. Their own contact details, yes; tokens and manage links, never. */
export async function exportPlayerData(db: Db, player: Player, base: string, now = new Date()) {
  const [{ upcoming, past }, groups, clubs] = await Promise.all([getPlayerEvents(db, player.id, now), getPlayerGroups(db, player.id), listClubsClaimedBy(db, player.id)]);
  const match = (m: MyEvent) => ({
    code: m.event.code,
    url: `${base}/${m.event.code}`,
    type: m.event.type,
    format: m.event.format,
    title: m.event.title,
    startsAt: m.event.startsAt,
    tz: m.event.tz,
    venue: m.event.venueName,
    status: m.event.status,
    organizer: m.event.creatorPlayerId === player.id,
    seat: m.slot.position > 0 && m.slot.position <= m.event.capacity ? m.slot.position : null,
    waitlisted: m.slot.position > m.event.capacity,
    team: m.slot.team,
    outcome: m.outcome,
  });
  const stats = statsFromEvents(player, past);
  return {
    exportedAt: now.toISOString(),
    format: "kicksmash-export/1",
    player: {
      displayName: player.displayName,
      email: player.email,
      phone: player.phone,
      locale: player.locale,
      level: player.level,
      levelSource: player.levelSource,
      levelUpdatedAt: player.levelUpdatedAt,
      levelVerifiedAt: player.levelVerifiedAt,
      levelLog: player.levelLog ?? [],
      rankingOptIn: player.rankingOptIn,
      publicProfile: player.publicProfile,
      publicUrl: player.publicProfile && player.publicSlug ? `${base}/u/${player.publicSlug}` : null,
      telegram: player.telegramUsername,
      discord: player.discordUsername,
      createdAt: player.createdAt,
    },
    stats: { played: stats.played, won: stats.won, decided: stats.decided, podiums: stats.podiums },
    matches: { upcoming: upcoming.map(match), past: past.map(match) },
    groups: groups.map((g) => ({ code: g.group.code, name: g.group.name, url: `${base}/g/${g.group.code}` })),
    clubs: clubs.map((c) => ({ slug: c.slug, name: c.name, status: clubStatus(c), url: `${base}/v/${c.slug}` })),
    passport: await issuePassport(player, stats, base, now),
  };
}
