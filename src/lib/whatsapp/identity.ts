import { and, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "@/db";
import { players, type Player } from "@/db/schema";
import { mergePlayers } from "@/lib/domain/merge";
import { createPlayer, normalizePhone } from "@/lib/domain/players";
import { foldSameNameRows } from "@/lib/domain/sameName";

/**
 * Who is on the other end of a WhatsApp thread.
 *
 * The number arrives with the first inbound message and not before — which is the whole reason this
 * channel needs nothing collected in advance. A person taps a link somebody pasted in their own group
 * chat, presses send, and that single act hands over both the number and the permission to use it.
 * Nothing here ever messages a number that has not written to us first.
 *
 * Still no account and no password (rule 5): the number is an address, the same way an email address
 * is, and it identifies a player row that already existed or a new one named by their own profile.
 */

/** Meta sends the number without a plus; every other phone we hold is stored as typed, so both shapes are tried rather than assuming which one a row is in. */
function shapes(waId: string): { plus: string; digits: string } {
  const digits = normalizePhone(waId);
  if (!digits) throw new Error("whatsapp: no number");
  return { plus: digits.startsWith("+") ? digits : `+${digits}`, digits };
}

/** Whether a stored phone is this WhatsApp number, in either shape. */
export function sameNumber(phone: string | null | undefined, waId: string): boolean {
  if (!phone) return false;
  const { plus, digits } = shapes(waId);
  return phone === plus || phone === digits;
}

export async function findOrCreateWhatsappPlayer(db: Db, waId: string, profileName?: string | null): Promise<Player> {
  const { plus, digits } = shapes(waId);
  for (const candidate of [plus, digits]) {
    const [hit] = await db.select().from(players).where(eq(players.phone, candidate)).limit(1);
    if (hit) return hit;
  }
  const name = (profileName ?? "").trim().slice(0, 40) || plus;
  return createPlayer(db, { displayName: name, locale: "en", phone: plus });
}

/**
 * Links a WhatsApp number to a player who signed in on the web, as `linkTelegram` links a Telegram
 * account: a row this number already had (somebody who once joined through JOIN-) folds into the web
 * player with `mergePlayers`, which keeps one seat where both held one, and the web player takes the
 * number. No row is created on the way, so linking never makes a second player.
 */
export async function linkWhatsapp(db: Db, playerId: string, waId: string): Promise<Player> {
  const { plus, digits } = shapes(waId);
  const others = await db
    .select({ id: players.id })
    .from(players)
    .where(and(inArray(players.phone, [plus, digits]), ne(players.id, playerId)));
  if (others.length > 0) await mergePlayers(db, playerId, others.map((o) => o.id));
  const [p] = await db.update(players).set({ phone: plus }).where(eq(players.id, playerId)).returning();
  // A number that wrote to us is proof, as a linked Telegram account is (`foldSameNameRows`). Never throws.
  await foldSameNameRows(db, p.id);
  return p;
}
