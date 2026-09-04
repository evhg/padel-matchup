import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { createHash, randomInt } from "node:crypto";
import { customAlphabet } from "nanoid";
import type { Db } from "@/db";
import { emailCodes, players, type Player } from "@/db/schema";
import { CODE_ALPHABET } from "@/lib/codes";
import { DomainError } from "./errors";
import { mergePlayers } from "./merge";
import { normalizeEmail } from "./players";

/**
 * Cross-device identity without accounts:
 *  - a personal link (/p/{token}) that signs the player in on any device
 *  - one-time email codes that prove ownership of an email and merge every
 *    identity carrying that email into one
 */

/** 12 chars of a 57-symbol alphabet ≈ 2^70: unguessable, yet short enough for a calendar line. */
export const TOKEN_LENGTH = 12;
const newToken = customAlphabet(CODE_ALPHABET, TOKEN_LENGTH);
export const CODE_TTL_MS = 10 * 60 * 1000;
export const CODE_MAX_ATTEMPTS = 5;
export const CODES_PER_HOUR = 5;

export const isValidPersonalToken = (s: string) => s.length >= TOKEN_LENGTH && s.length <= 32 && new RegExp(`^[${CODE_ALPHABET}]+$`).test(s);

/**
 * The player's current token. Tokens issued at the old 32-char length are
 * shortened on first use; the long one stays valid as `previousToken`.
 */
export async function getOrCreatePersonalToken(db: Db, playerId: string): Promise<string> {
  const [p] = await db.select({ token: players.personalToken }).from(players).where(eq(players.id, playerId));
  if (!p) throw new DomainError("not_found");
  if (p.token && p.token.length === TOKEN_LENGTH) return p.token;
  return rotatePersonalToken(db, playerId, { keepPrevious: Boolean(p.token) });
}

/** New token. `keepPrevious` (lazy shortening) keeps the old one working; a user-requested reset does not. */
export async function rotatePersonalToken(db: Db, playerId: string, o: { keepPrevious?: boolean } = {}): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const token = newToken();
    const [clash] = await db
      .select({ id: players.id })
      .from(players)
      .where(sql`${players.personalToken} = ${token} or ${players.previousToken} = ${token}`)
      .limit(1);
    if (clash) continue;
    await db
      .update(players)
      .set({ personalToken: token, previousToken: o.keepPrevious ? sql`${players.personalToken}` : null })
      .where(eq(players.id, playerId));
    return token;
  }
  throw new Error("Could not allocate a personal token");
}

export async function findPlayerByPersonalToken(db: Db, token: string): Promise<Player | null> {
  if (!isValidPersonalToken(token)) return null;
  const [p] = await db
    .select()
    .from(players)
    .where(sql`${players.personalToken} = ${token} or ${players.previousToken} = ${token}`)
    .limit(1);
  return p ?? null;
}

const hashCode = (email: string, code: string) => createHash("sha256").update(`${email}:${code}`).digest("hex");

export async function playersWithEmail(db: Db, email: string): Promise<Player[]> {
  return db.select().from(players).where(eq(players.email, email)).orderBy(asc(players.createdAt));
}

/**
 * Issues a 6-digit code for `email`. Returns null when rate-limited.
 * The caller decides whether the email is known and whether to send anything.
 */
export async function issueEmailCode(db: Db, rawEmail: string, now = new Date()): Promise<{ email: string; code: string } | null> {
  const email = normalizeEmail(rawEmail);
  if (!email) throw new DomainError("invalid", "email");
  const since = new Date(now.getTime() - 60 * 60 * 1000);
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(emailCodes)
    .where(and(eq(emailCodes.email, email), gt(emailCodes.createdAt, since)));
  if (Number(n) >= CODES_PER_HOUR) return null;
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await db.insert(emailCodes).values({ email, codeHash: hashCode(email, code), expiresAt: new Date(now.getTime() + CODE_TTL_MS) });
  return { email, code };
}

/** Consumes a valid code; throws DomainError("invalid") on a wrong/expired one. */
export async function consumeEmailCode(db: Db, rawEmail: string, code: string, now = new Date()): Promise<string> {
  const email = normalizeEmail(rawEmail);
  if (!email) throw new DomainError("invalid", "email");
  const clean = code.replace(/\D/g, "");
  const candidates = await db
    .select()
    .from(emailCodes)
    .where(and(eq(emailCodes.email, email), isNull(emailCodes.consumedAt), gt(emailCodes.expiresAt, now)))
    .orderBy(asc(emailCodes.createdAt));
  const live = candidates.filter((c) => c.attempts < CODE_MAX_ATTEMPTS);
  if (live.length === 0) throw new DomainError("invalid", "code_expired");
  const match = clean.length === 6 ? live.find((c) => c.codeHash === hashCode(email, clean)) : undefined;
  if (!match) {
    // Counted outside any transaction so a wrong guess is never rolled back.
    await db
      .update(emailCodes)
      .set({ attempts: sql`${emailCodes.attempts} + 1` })
      .where(
        inArray(
          emailCodes.id,
          live.map((c) => c.id),
        ),
      );
    throw new DomainError("invalid", "code_wrong");
  }
  await db.update(emailCodes).set({ consumedAt: now }).where(and(eq(emailCodes.email, email), isNull(emailCodes.consumedAt)));
  return email;
}

/**
 * Folds every player in `from` into `into`: events organized, slots, scores,
 * activity, venues, tournament pairings and standings. Duplicate membership
 * in the same event keeps `into`'s slot and frees the other.
 */

/**
 * After a code is verified: choose the canonical player for `email`, fold
 * every other player with that email plus the current device identity into
 * it, and mark the email verified. Returns the canonical player.
 */
export async function restoreByEmail(db: Db, email: string, currentPlayerId: string | null, now = new Date()): Promise<Player> {
  const owners = await playersWithEmail(db, email);
  const current = currentPlayerId ? ((await db.select().from(players).where(eq(players.id, currentPlayerId)).limit(1))[0] ?? null) : null;
  const pool = [...owners];
  if (current && !pool.some((p) => p.id === current.id)) pool.push(current);
  if (pool.length === 0) throw new DomainError("not_found");
  const canonical = pool.find((p) => p.emailVerifiedAt && p.email === email) ?? pool.find((p) => p.email === email) ?? pool[0];
  await mergePlayers(
    db,
    canonical.id,
    pool.map((p) => p.id),
  );
  const [updated] = await db.update(players).set({ email, emailVerifiedAt: canonical.emailVerifiedAt ?? now }).where(eq(players.id, canonical.id)).returning();
  return updated;
}

export { mergePlayers };
