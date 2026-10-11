import { and, eq, gte, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import type { Db } from "@/db";
import { events, groups, telegramChats, type Group, type TelegramChat } from "@/db/schema";
import { chatLocale } from "@/lib/channels/telegram";
import { formatEventDay, formatEventTime } from "@/lib/dates";
import { BEST_TIMES } from "@/lib/domain/bestTimes";
import { bestTimesForChat } from "@/lib/domain/freeCourts";
import { nextGroupSlot } from "@/lib/domain/groups";
import { bumpMetric } from "@/lib/domain/metrics";
import { takeRate } from "@/lib/domain/ratelimit";
import { esc, sendMessage, telegramEnabled, type InlineKeyboard } from "./api";
import { strings, type BotLocale } from "./card";

/**
 * The weekly best times in a crew's own Telegram group (the owner's decision of 11 October 2026,
 * "Weekly best times in the group", DECIDING rules 5 and 36): "Once a week, before the weekly slot, the
 * bot posts the best free times in a crew group that opted in, with no question asked. ... it is the one
 * exception to the rule that the bot speaks in a group only when asked."
 *
 * Where: a group a crew's admin tied to the crew and where the bot listens (`listening_since`, DECIDING
 * rule 31), so /quiet, a lost right to pin or the bot's removal stops it at once; the crew has a weekly
 * slot. When: 24 hours before the slot, or in the four hours after that when the hourly job comes late
 * (`WEEKLY_TIMES`; a session chose the 24 hours on 11 October 2026). What: one silent message with up
 * to three free courts within two hours of the slot (`bestTimesForChat` with `around`), the crew's own
 * clubs first, and no platform's name. Each button is the card's own way: the crew's game already at
 * that hour and club is its join (`j:<code>`), anything else makes the match like a "times?" button
 * (`bt:`, `handleTimesCallback`). Nothing when no court is free, nothing when the slot's game has its
 * court booked already, and once a slot at most: the claim is the slot's own row (`takeRate` keyed by
 * the group and the slot, dated on the slot's day, so a late tick or a second instance never posts twice).
 *
 * Cost (AGENTS.md rule 12): one read an hour of the listening crew groups with a slot (a join on the
 * group's primary key, two hundred rows at most); for a group whose post is due, once a week, one claim,
 * one bounded read of the crew's games around the slot, the best times' own reads, and one message.
 */
export const WEEKLY_TIMES = {
  /** The post goes out this long before the slot. */
  leadMs: 24 * 3600_000,
  /** And still in the hours after that, for an hourly job that comes late; never closer to the slot. */
  windowMs: 4 * 3600_000,
  /** A free court counts when it starts this close to the slot, before or after it. */
  nearMs: 2 * 3600_000,
  /** The most listening crew groups one run reads. */
  maxGroups: 200,
} as const;

/** Is this slot's post due now? The slot's start when it is, else null. Pure. */
export function weeklyTimesDue(group: Pick<Group, "recurDow" | "recurTime" | "tz" | "archivedAt">, now: Date): Date | null {
  if (group.archivedAt) return null;
  const slot = nextGroupSlot(group, now);
  if (!slot) return null;
  const ahead = slot.startsAt.getTime() - now.getTime();
  return ahead <= WEEKLY_TIMES.leadMs && ahead > WEEKLY_TIMES.leadMs - WEEKLY_TIMES.windowMs ? slot.startsAt : null;
}

const label = (start: Date, tz: string, name: string, locale: BotLocale) => `${formatEventDay(start, tz, locale)} ${formatEventTime(start, tz, locale)} · ${name}`.slice(0, 60);

/** The hourly job's step: every listening crew group whose post is due gets it, once. Returns how many were posted, and why the others were not. */
export async function postWeeklyTimes(db: Db, now = new Date()): Promise<{ posted: number; none: number; booked: number }> {
  const out = { posted: 0, none: 0, booked: 0 };
  if (!telegramEnabled()) return out;
  const rows = await db
    .select({ chat: telegramChats, group: groups })
    .from(telegramChats)
    .innerJoin(groups, eq(groups.id, telegramChats.groupId))
    .where(and(isNotNull(telegramChats.listeningSince), isNull(telegramChats.leftAt), isNotNull(groups.recurDow), isNotNull(groups.recurTime), isNull(groups.archivedAt)))
    .limit(WEEKLY_TIMES.maxGroups);
  for (const { chat, group } of rows) {
    const slot = weeklyTimesDue(group, now);
    if (!slot) continue;
    // Once a slot: the claim is dated on the slot's own day, so it holds however late the job runs.
    if (!(await takeRate(db, "weekly_times", `${group.id}:${Math.round(slot.getTime() / 60_000)}`, 1, "day", slot))) continue;
    const outcome = await postForSlot(db, chat, group, slot, now).catch(() => "failed" as const);
    if (outcome === "posted") out.posted++;
    else if (outcome === "booked") out.booked++;
    else out.none++;
    await bumpMetric(db, outcome === "posted" ? "tg_weekly_times" : `tg_weekly_times_${outcome}`).catch(() => undefined);
  }
  return out;
}

async function postForSlot(db: Db, chat: TelegramChat, group: Group, slot: Date, now: Date): Promise<"posted" | "none" | "booked" | "failed"> {
  // The crew's games around the slot: one read down `events_group_idx`.
  const games = await db
    .select({ code: events.code, startsAt: events.startsAt, venueSlug: events.venueSlug, courtBookedAt: events.courtBookedAt, bookingUrl: events.bookingUrl })
    .from(events)
    .where(and(eq(events.groupId, group.id), inArray(events.status, ["open", "full"]), gte(events.startsAt, new Date(slot.getTime() - WEEKLY_TIMES.nearMs)), lte(events.startsAt, new Date(slot.getTime() + WEEKLY_TIMES.nearMs))))
    .limit(10);
  // The slot's game has its court already: nothing to propose.
  if (games.some((g) => g.startsAt.getTime() === slot.getTime() && (g.courtBookedAt || g.bookingUrl))) return "booked";
  const { times, lengthMinutes } = await bestTimesForChat(db, { groupId: group.id, playerId: null, venueName: chat.venueName, tz: chat.tz, around: { at: slot, withinMs: WEEKLY_TIMES.nearMs } }, now, BEST_TIMES.limit * 2);
  const locale = chatLocale(chat);
  const buttons: InlineKeyboard["inline_keyboard"][number] = [];
  for (const b of times) {
    if (buttons.length >= BEST_TIMES.limit) break;
    const there = games.filter((g) => g.startsAt.getTime() === b.start.getTime());
    // The crew plays then already: at this club, the card's own join; at another club, not a choice.
    if (there.some((g) => g.venueSlug === b.slug)) {
      buttons.push({ text: label(b.start, b.tz, b.name, locale), callback_data: `j:${there.find((g) => g.venueSlug === b.slug)!.code}` });
      continue;
    }
    if (there.length) continue;
    const data = `bt:${Math.round(b.start.getTime() / 60_000).toString(36)}:${lengthMinutes}:${b.slug}`;
    if (data.length <= 64) buttons.push({ text: label(b.start, b.tz, b.name, locale), callback_data: data });
  }
  if (buttons.length === 0) return "none";
  const s = strings(locale);
  const when = `${formatEventDay(slot, group.tz, locale)} ${formatEventTime(slot, group.tz, locale)}`;
  const sent = await sendMessage(chat.chatId, esc(s.weeklyTimes(when)), { keyboard: { inline_keyboard: buttons.map((b) => [b]) }, silent: true });
  return sent.ok ? "posted" : "failed";
}
