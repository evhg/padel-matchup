import type { Db } from "@/db";
import type { EventDetail } from "@/lib/domain/queries";
import type { BotLocale } from "@/lib/telegram/card";

/**
 * A card channel is a place where one card per match lives and is kept true: a Telegram chat, a Discord
 * channel, a LINE group. The algorithm (post once, edit in place, note a complete line-up once, remind
 * once, post the result once) lives in `cards.ts` and is the same for every channel; a channel supplies
 * its rooms, its rendering, its transport and its storage. Adding a channel is one adapter that
 * implements this interface, one entry in the registry and one browser suite.
 */
export type ChannelName = "telegram" | "discord" | "line";
export type MessageId = string | number;

/** A place a card lives. `raw` is the channel's own row (a Telegram chat, a Discord channel). */
export type Room<R = unknown> = { id: string; locale: BotLocale; groupId: string | null; raw: R };
/** A card the channel keeps: the live match card, or the result posted once. */
export type Card<C = unknown> = { id: string; kind: string; messageId: MessageId; rendered: string | null; completeNotedAt: Date | null; raw: C };
/** A rendered card: the channel's payload, a hash of it, and whether the line-up is complete. */
export type Rendered<P> = { payload: P; hash: string; complete: boolean };
export type PostOptions = { replyTo?: MessageId | null; threadId?: number | null; silent?: boolean };
export type Sent = { ok: true; messageId: MessageId } | { ok: false };

/** The result of a match, in the room's language, for the channel to lay out as a photo, an embed or a text. */
export type ResultSummary = {
  locale: BotLocale;
  /** "Result · Thu 19:00 at Rawai", already localised. */
  title: string;
  /** "6-4 6-3", or null when no sets were recorded. */
  score: string | null;
  /** The winners line and the praise line, localised, or null when the teams are unknown or it was a draw. */
  winners: string | null;
  praise: string | null;
  /** A tournament's top three, localised, or null for a match. */
  podium: string | null;
  url: string;
  imageUrl: string;
  /** "Same time next week?" turns the crew into a group: the match code to offer it for, or null. */
  sameTimeCode: string | null;
};

export interface CardChannel<P = unknown, R = unknown, C = unknown> {
  readonly name: ChannelName;
  enabled(): boolean;
  /** A channel that cannot edit a sent message (LINE) gets a fresh card only when the roster changes materially. */
  readonly canEdit: boolean;
  /** Rooms tied to a group: its matches land there by themselves. */
  roomsOfGroup(db: Db, groupId: string): Promise<Room<R>[]>;
  /** The cards of an event with their rooms, rooms the bot has left excluded. */
  cardsOf(db: Db, eventId: string, kinds?: string[]): Promise<{ card: Card<C>; room: Room<R> }[]>;
  render(detail: EventDetail, locale: BotLocale, now: Date): Rendered<P>;
  post(db: Db, room: Room<R>, payload: P, o?: PostOptions): Promise<Sent>;
  /** Edits a card in place; false when the channel refused, in which case the channel has noted why. */
  edit(db: Db, room: Room<R>, card: Card<C>, payload: P): Promise<boolean>;
  note(db: Db, room: Room<R>, text: string, o?: PostOptions): Promise<boolean>;
  result(db: Db, room: Room<R>, summary: ResultSummary, o?: PostOptions): Promise<Sent>;
  saveCard(db: Db, eventId: string, room: Room<R>, messageId: MessageId, kind: "card" | "result", rendered: string | null): Promise<void>;
  markRendered(db: Db, card: Card<C>, rendered: string): Promise<void>;
  markCompleteNoted(db: Db, card: Card<C>): Promise<void>;
  /** Ties the room to the group behind its first group match, where the channel allows it. */
  bindGroup(db: Db, room: Room<R>, groupId: string): Promise<void>;
  /** Events starting between now and soon that carry a card here and were not reminded yet. */
  remindersDue(db: Db, now: Date, soon: Date): Promise<{ id: string; code: string }[]>;
  markReminded(db: Db, eventId: string, now: Date): Promise<void>;
  /** Cards kept outside rooms (Telegram's inline cards), edited on sync. */
  syncExtra?(db: Db, detail: EventDetail, now: Date): Promise<number>;
  /** Every few minutes: cards of matches that just started grow their Result button. */
  refreshStarted?(db: Db, now: Date): Promise<number>;
}
