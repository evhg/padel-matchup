import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { passkeys, players, type Passkey, type Player } from "@/db/schema";
import { browserClass } from "./browserClass";
import { safeToMerge, type MergeCandidate } from "./dupes";
import { recordFact } from "./facts";
import { mergePlayers } from "./merge";
import type { MergeCounter } from "./signins";
import { isDeletedPlayer } from "./result";
import { heldBack, settleFoldSeats, thatsMeRows, type SeatChange, type ThatsMeMatch, type ThatsMeRefusal } from "./thatsMe";

/**
 * Passkeys: Face ID or a fingerprint signs a player in from any browser on their phone (DECIDING rule 39).
 *
 * Why. A link tapped in a WhatsApp group opens the phone's default browser, and Kicksmash knows a player
 * only by the cookie of one browser (src/lib/session.ts). Safari, Chrome, Samsung Internet, a private
 * tab, the home-screen icon and Gmail's own browser each keep their own cookies, so a player whose
 * cookie lives in another one is a stranger there, and Join makes a second record. Six of the eight
 * active players have an email, so "That's me" (rule 34) never helps them, and the 6-digit code is
 * their only way back. A passkey lives in the phone's password manager (Apple Passwords, Google
 * Password Manager), which every browser on the phone can use.
 *
 * The owner decided on 12 October 2026, three questions in one:
 *   - "Passkeys (Recommended)": "One Face ID makes any browser on the phone know the player. It also
 *     replaces the email code. It needs a migration (a new passkeys table)."
 *   - "Only a proved browser (Recommended)": "Only the browser that made the record, or that proved it
 *     by email code, Telegram or the personal link. A sign-in by name never becomes a permanent key."
 *     That is `mayRegister`.
 *   - "Own record only (Recommended)": "It signs in its own record and joins the new record that this
 *     browser made into that record. Nothing more." That is `passkeyFold`: never `proved` for "Are
 *     these yours?" (`foldSameNameRows` is not called), never a record that could be another person.
 *
 * The ceremony itself (the challenge, the signature, @simplewebauthn/server) is src/lib/passkeys/; this
 * file holds the rules and the rows, and imports nothing of it.
 */

/** The browser's session as its cookie says it: whose, and whether it came in by name ("That's me", a held link). */
export type PasskeySession = { playerId: string | null; byName: boolean };

/**
 * May this browser save a passkey for its record? Only a session that is not by name: the browser made
 * the record, or proved it by an email code, Telegram, the personal link or a passkey. A session by
 * name ("That's me", a held place's link) never may, also after its record proved something elsewhere,
 * because the browser itself proved nothing. A deleted account never may. Pure.
 */
export function mayRegister(session: PasskeySession, player: Pick<Player, "id" | "displayName" | "personalToken"> | null): boolean {
  if (!session.playerId || session.byName || !player || player.id !== session.playerId) return false;
  return !isDeletedPlayer(player);
}

/** Why a sign-in by passkey only switches the session, and folds nothing. */
export type FoldRefusal = "no_session" | "by_name" | "same_record" | "gone" | "not_same_person" | ThatsMeRefusal;

/**
 * Does a sign-in by passkey fold the record the browser held before into the passkey's own record?
 * Only when every one of these holds; else the browser simply becomes the passkey's record, and the
 * other record stays as it was, because a record that could be another person is never merged:
 *   - the browser had a session, and it was not by name (a name is no proof that the two are one);
 *   - it is a different record, and it still exists;
 *   - it has nothing that proves or reaches it, by the very list "That's me" reads (`heldBack`: an
 *     email, a recovery email, a phone, Telegram, Discord, LINE, a push subscription, a passkey, a
 *     coach's book or a place on one, a claimed club, a public profile, and what it runs for others);
 *   - the merge is safe by the test every fold takes (`safeToMerge`: here, the same name).
 * Pure.
 */
export function passkeyFold(o: { owner: MergeCandidate; current: (MergeCandidate & { deleted: boolean }) | null; byName: boolean; held: ThatsMeRefusal | null }): { fold: true } | { fold: false; why: FoldRefusal } {
  if (!o.current) return { fold: false, why: "no_session" };
  if (o.byName) return { fold: false, why: "by_name" };
  if (o.current.id === o.owner.id) return { fold: false, why: "same_record" };
  if (o.current.deleted) return { fold: false, why: "gone" };
  if (o.held) return { fold: false, why: o.held };
  if (!safeToMerge(o.owner, o.current).ok) return { fold: false, why: "not_same_person" };
  return { fold: true };
}

/**
 * The words a passkey is listed under on My matches: the phone and the browser that saved it, from its
 * user agent (`browserClass`), in names that need no translation ("iPhone, Safari"). Null where the
 * agent names neither; the page then says "This device" in the reader's language. Pure.
 */
export function passkeyLabel(ua: string | null | undefined): string | null {
  const s = ua ?? "";
  const label: Record<string, string | null> = {
    ios_safari: "iPhone, Safari",
    ios_chrome: "iPhone, Chrome",
    ios_other: "iPhone",
    ios_webview: "iPhone",
    android_chrome: "Android, Chrome",
    android_samsung: "Android, Samsung Internet",
    android_webview: "Android",
    android_other: "Android",
    app_whatsapp: "WhatsApp",
    app_telegram: "Telegram",
    app_instagram: "Instagram",
    app_facebook: "Facebook",
    app_line: "LINE",
    other: null,
  };
  const cls = browserClass(s);
  if (cls !== "desktop") return label[cls] ?? null;
  const os = /Macintosh/.test(s) ? "Mac" : /Windows NT/.test(s) ? "Windows" : /CrOS/.test(s) ? "Chromebook" : /Linux|X11/.test(s) ? "Linux" : null;
  const browser = /Edg\//.test(s) ? "Edge" : /Firefox\//.test(s) ? "Firefox" : /Chrome\//.test(s) ? "Chrome" : /Safari\//.test(s) ? "Safari" : null;
  return [os, browser].filter(Boolean).join(", ") || null;
}

/** The passkeys of one player, oldest first, for My matches: one read down `passkeys_player_idx`. Never sent anywhere whole: the screen takes a label and a date. */
export async function passkeysOf(db: Db, playerId: string): Promise<Passkey[]> {
  return db.select().from(passkeys).where(eq(passkeys.playerId, playerId)).orderBy(asc(passkeys.createdAt)).limit(20);
}

/** Whether the player has saved one at all: one lookup down `passkeys_player_idx`, for the offer "Remember me on this phone". */
export async function hasPasskey(db: Db, playerId: string): Promise<boolean> {
  const [row] = await db.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.playerId, playerId)).limit(1);
  return Boolean(row);
}

/** One passkey by the id the phone sent: the primary key, one read. */
export async function passkeyById(db: Db, id: string): Promise<Passkey | null> {
  if (typeof id !== "string" || !id || id.length > 1364) return null;
  const [row] = await db.select().from(passkeys).where(eq(passkeys.id, id)).limit(1);
  return row ?? null;
}

/** A passkey the phone just made, for the player whose browser asked. A second save of the same credential keeps the first row's owner and dates. */
export async function savePasskey(db: Db, row: { id: string; playerId: string; publicKey: string; counter: number; transports: string[]; deviceType: string; backedUp: boolean; label: string | null; now?: Date }): Promise<boolean> {
  const saved = await db
    .insert(passkeys)
    .values({ id: row.id, playerId: row.playerId, publicKey: row.publicKey, counter: row.counter, transports: row.transports, deviceType: row.deviceType, backedUp: row.backedUp, label: row.label, createdAt: row.now ?? new Date() })
    .onConflictDoNothing()
    .returning({ id: passkeys.id });
  return saved.length === 1;
}

/** "Remove" on My matches: a player removes their own passkey, never another's. True when one went. */
export async function removePasskey(db: Db, playerId: string, id: string): Promise<boolean> {
  if (typeof id !== "string" || !id || id.length > 1364) return false;
  const gone = await db
    .delete(passkeys)
    .where(and(eq(passkeys.id, id), eq(passkeys.playerId, playerId)))
    .returning({ id: passkeys.id });
  return gone.length === 1;
}

/**
 * An account deletion takes the player's passkeys (`anonymizePlayer`). The row survives as "Deleted
 * player", so the cascade never fires, and a passkey left behind would sign a phone into the emptied
 * record. The 14-day removal of disposable rows deletes the row itself, so the cascade covers it there.
 */
export async function dropPasskeysFor(db: Db, playerId: string): Promise<void> {
  await db.delete(passkeys).where(eq(passkeys.playerId, playerId));
}

/** The match no record is in: `thatsMeRows` over it reads the one record named as `viewerId`, with every fact, and nobody else. */
const NO_MATCH: ThatsMeMatch = { id: "00000000-0000-0000-0000-000000000000", groupId: null, creatorPlayerId: "00000000-0000-0000-0000-000000000000" };

/** What stands in the way of folding this record, by the "That's me" read itself (one bounded read): null for nothing, `gone` for a record that no longer exists or was deleted. */
export async function heldBackOf(db: Db, playerId: string, now = new Date()): Promise<ThatsMeRefusal | "gone" | null> {
  const row = (await thatsMeRows(db, NO_MATCH, { viewerId: playerId, now })).find((r) => r.id === playerId);
  return row ? heldBack(row) : "gone";
}

export type PasskeySignIn = { ok: true; player: Player; folded: boolean; seats: SeatChange[] } | { ok: false };

/**
 * After the signature checked out (src/lib/passkeys/webauthn.ts): the passkey's counter and last use
 * move, and the browser becomes the passkey's own record. When `passkeyFold` says so, the record the
 * browser held before folds into it: where both hold a place in one match, the passkey's record keeps
 * the better one and the other goes the way a leave goes (`settleFoldSeats`), then `mergePlayers`,
 * never `proved`, counted as `merge_passkey` through the `counter` the request hands in (`mergesLater`).
 * A deleted or vanished record answers no. The fact `player.passkey` holds no name.
 */
export async function completePasskeySignIn(db: Db, input: { passkey: Passkey; newCounter: number; session: PasskeySession; now?: Date; counter?: MergeCounter }): Promise<PasskeySignIn> {
  const now = input.now ?? new Date();
  const [owner] = await db.select().from(players).where(eq(players.id, input.passkey.playerId)).limit(1);
  if (!owner || isDeletedPlayer(owner)) return { ok: false };
  await db.update(passkeys).set({ counter: input.newCounter, lastUsedAt: now }).where(eq(passkeys.id, input.passkey.id));
  const currentId = input.session.playerId && input.session.playerId !== owner.id ? input.session.playerId : null;
  const [current] = currentId ? await db.select().from(players).where(eq(players.id, currentId)).limit(1) : [];
  const held = current && !input.session.byName ? await heldBackOf(db, current.id, now) : null;
  const verdict = passkeyFold({
    owner,
    current: input.session.playerId === owner.id ? { ...owner, deleted: false } : current ? { ...current, deleted: isDeletedPlayer(current) || held === "gone" } : null,
    byName: input.session.byName,
    held: held === "gone" ? null : held,
  });
  const seats: SeatChange[] = [];
  if (verdict.fold && current) {
    // The matches both records hold a place in: a few rows, down `slots_player_idx` for each.
    const shared = await db.execute(sql`select distinct a.event_id as id from slots a join slots b on b.event_id = a.event_id where a.player_id = ${owner.id} and b.player_id = ${current.id} limit 20`);
    const ids = (Array.isArray(shared) ? shared : ((shared as { rows?: { id: string }[] }).rows ?? [])) as { id: string }[];
    for (const { id } of ids) {
      const change = await settleFoldSeats(db, String(id), owner.id, current.id);
      if (change) seats.push(change);
    }
    await mergePlayers(db, owner.id, [current.id], { door: "passkey", counter: input.counter });
  }
  await recordFact(db, { kind: "player.passkey", channel: "web", actorPlayerId: owner.id, subject: { type: "player", id: owner.id }, data: { folded: verdict.fold }, at: now });
  const [fresh] = await db.select().from(players).where(eq(players.id, owner.id)).limit(1);
  return { ok: true, player: fresh ?? owner, folded: verdict.fold, seats };
}
