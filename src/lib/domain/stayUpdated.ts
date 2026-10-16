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

/**
 * What a newly saved address gets at once (`welcomeEmail` in src/lib/notify.ts), decided before
 * anything goes, so the card can say only what went (15 October 2026: on the waiting list it said
 * "Calendar invite sent" while the email held only the personal link):
 *   - `invite`: the match's calendar invitation, for a seat in a match that is not called off;
 *   - `link`: the personal-link email, for anybody else (the waiting list included: a place that opens
 *     brings the invitation then);
 *   - null: nothing, where the deployment sends no mail or the player has no address, and for a session
 *     by name that proved nothing, because both carry the personal link (DECIDING rule 34).
 */
export type WelcomeKind = "invite" | "link";

export function welcomeKind(o: { emailOn: boolean; seated: boolean; cancelled: boolean; byNameOnly: boolean }): WelcomeKind | null {
  if (!o.emailOn || o.byNameOnly) return null;
  return o.seated && !o.cancelled ? "invite" : "link";
}

/**
 * What a card says about the address on file, and nothing more: the "Stay updated" card on the match
 * page and `CalendarEmail` on the invitation page ask this one rule (15 October 2026: the invitation
 * page still said "Calendar invite sent" after a save that sent none).
 *   - before a save on the card (`welcome` undefined): `invite` only where the page says the address
 *     brought the invitation (`invited`: a seat, mail on, not a session by name), else nothing;
 *   - after a save: what the save answered (`updateMyEmail`'s `welcome`): `invite`, `link` or nothing.
 * `invite` is the "📅 Calendar invite sent" line (and "Send it again" for a seat), `link` the line
 * that the personal link went, null no mail line at all.
 */
export function mailLine(o: { sentTo: string | null; invited: boolean; welcome: WelcomeKind | null | undefined }): WelcomeKind | null {
  if (!o.sentTo) return null;
  if (o.welcome === undefined) return o.invited ? "invite" : null;
  return o.welcome;
}
