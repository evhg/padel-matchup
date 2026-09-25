import type { Player } from "@/db/schema";

/**
 * The "stay updated" card a player meets on the match page the moment they join.
 *
 * The owner, 25 September 2026: "When a player joins a game, we need to capture a channel to contact
 * them right away in a very smooth way and give something in return, only whatsapp or telegram and/or
 * email, push notification don't count." SMS is not a channel either. What is given in return is the
 * point of the card: the match's changes, a free spot and the result reach them there, and their
 * calendar updates itself.
 *
 * Three answers, and nothing else:
 *   - `ask` while the player has none of the three: the choices this deployment runs, in the owner's
 *     order (WhatsApp, Telegram, email);
 *   - `reached` once they have one: where it goes, and how their calendar keeps up. An email carries
 *     an invitation per match, which updates itself; a chat does not, so a chat-only player gets the
 *     subscribable feed instead. Both at once would put every match in the calendar twice;
 *   - `hidden` when the deployment runs none of the three, which is what rule 4 asks of an empty
 *     environment.
 *
 * A channel counts only where the deployment runs it: an address on a deployment without email
 * reaches nobody, and saying "updates reach you by email" there would be a sentence that is false.
 * Once reached, the card never asks again.
 */
export const STAY_CHANNELS = ["whatsapp", "telegram", "email"] as const;
export type StayChannel = (typeof STAY_CHANNELS)[number];

export type StayState = { kind: "hidden" } | { kind: "ask"; choices: StayChannel[] } | { kind: "reached"; via: StayChannel[]; calendar: "invite" | "feed" };

/** Whether the player carries this channel's address. WhatsApp's is the phone number the thread arrived from (`players.phone`, written only there). */
const holds = (p: Pick<Player, "email" | "telegramId" | "phone">, c: StayChannel): boolean => (c === "email" ? Boolean(p.email) : c === "telegram" ? p.telegramId != null : Boolean(p.phone));

export function stayUpdated(p: Pick<Player, "email" | "telegramId" | "phone">, runs: Record<StayChannel, boolean>): StayState {
  const via = STAY_CHANNELS.filter((c) => runs[c] && holds(p, c));
  if (via.length > 0) return { kind: "reached", via, calendar: via.includes("email") ? "invite" : "feed" };
  const choices = STAY_CHANNELS.filter((c) => runs[c]);
  return choices.length > 0 ? { kind: "ask", choices } : { kind: "hidden" };
}
