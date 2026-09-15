import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { players, type Player } from "@/db/schema";
import { createPlayer, normalizePhone } from "@/lib/domain/players";

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
export async function findOrCreateWhatsappPlayer(db: Db, waId: string, profileName?: string | null): Promise<Player> {
  // Meta sends the number without a plus; every other phone we hold is stored as typed, so both are
  // tried rather than assuming which shape a row happens to be in.
  const digits = normalizePhone(waId);
  if (!digits) throw new Error("whatsapp: no number");
  const plus = digits.startsWith("+") ? digits : `+${digits}`;
  for (const candidate of [plus, digits]) {
    const [hit] = await db.select().from(players).where(eq(players.phone, candidate)).limit(1);
    if (hit) return hit;
  }
  const name = (profileName ?? "").trim().slice(0, 40) || plus;
  return createPlayer(db, { displayName: name, locale: "en", phone: plus });
}
