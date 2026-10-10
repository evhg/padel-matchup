import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { players, type Player } from "@/db/schema";

/**
 * Characters that change a name without showing: zero-width spaces and non-joiners, direction marks,
 * the word joiner, the byte-order mark, the soft hyphen, and a zero-width joiner anywhere but inside an
 * emoji (where it is part of the picture). With them, "Ana" could be two names that look like one.
 */
const INVISIBLE = /[\u200B\u200C\u200E\u200F\u2060\uFEFF\u00AD]|(?<!\p{Extended_Pictographic}\uFE0F?)\u200D|\u200D(?!\p{Extended_Pictographic})/gu;

/** A name as it is stored: composed (NFC, so "José" typed two ways is one spelling), nothing invisible, one space between words, at most 40 characters. */
export function normalizeName(raw: string): string {
  return raw.normalize("NFC").replace(INVISIBLE, "").replace(/\s+/g, " ").trim().slice(0, 40);
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return null;
  return v.slice(0, 254);
}

export function normalizePhone(raw: string | null | undefined): string | null {
  const v = (raw ?? "").replace(/[^\d+]/g, "").trim();
  if (!v) return null;
  return v.slice(0, 20);
}

export async function createPlayer(db: Db, input: { displayName: string; locale: string; email?: string | null; phone?: string | null }): Promise<Player> {
  const [p] = await db
    .insert(players)
    .values({
      displayName: normalizeName(input.displayName) || "Player",
      locale: input.locale === "ru" ? "ru" : "en",
      email: normalizeEmail(input.email),
      phone: normalizePhone(input.phone),
    })
    .returning();
  return p;
}

export async function getPlayer(db: Db, id: string): Promise<Player | null> {
  const [p] = await db.select().from(players).where(eq(players.id, id)).limit(1);
  return p ?? null;
}

export async function updatePlayer(
  db: Db,
  id: string,
  patch: { displayName?: string; email?: string | null; phone?: string | null; locale?: string },
): Promise<Player | null> {
  const set: Partial<typeof players.$inferInsert> = {};
  if (patch.displayName !== undefined) set.displayName = normalizeName(patch.displayName) || "Player";
  if (patch.email !== undefined) set.email = normalizeEmail(patch.email);
  if (patch.phone !== undefined) set.phone = normalizePhone(patch.phone);
  if (patch.locale !== undefined) set.locale = patch.locale === "ru" ? "ru" : "en";
  if (Object.keys(set).length === 0) return getPlayer(db, id);
  const [p] = await db.update(players).set(set).where(eq(players.id, id)).returning();
  return p ?? null;
}
