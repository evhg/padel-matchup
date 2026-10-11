import { and, count, eq, gte, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import type { Db } from "@/db";
import { events, groups, telegramChats, type Group, type TelegramChat } from "@/db/schema";
import { chatLocale } from "@/lib/channels/telegram";
import { formatEventDay, formatEventTime } from "@/lib/dates";
import { BEST_TIMES } from "@/lib/domain/bestTimes";
import { bestTimesForChat } from "@/lib/domain/freeCourts";
import { nextGroupSlot } from "@/lib/domain/groups";
import { eventEnd, LONGEST_LENGTH } from "@/lib/domain/matchLength";
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
 * that hour and club is its join (`j:<code>`); any other time that overlaps a game of the crew is left
 * out; anything else makes the match like a "times?" button (`bt:`, `handleTimesCallback`). Nothing when no court is free, nothing when the slot's game has its
 * court booked already, and once a slot at most: the claim is the slot's own row (`takeRate` keyed by
 * the group and the slot, dated on the slot's day, so a late tick or a second instance never posts twice).
 *
 * Cost (AGENTS.md rule 12): one read an hour of the listening crew groups whose slot falls on a day that
 * can be due (`dueWeekdays`: three or four days of seven), a join on the group's primary key in a fixed
 * order, two hundred rows at most; past that, one count, and the counter `tg_weekly_times_cut` says how
 * many it left out. For a group whose post is due, once a week, one claim, one bounded read of the
 * crew's games around the slot, the best times' own reads, and one message.
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

/**
 * The weekdays a slot due now can fall on, in any zone: the UTC days of the window's two ends, and the
 * day before and after each, because a zone is at most 14 hours from UTC. So the hourly read leaves out
 * the crews of the other three or four days in SQL (review, 11 October 2026). Pure.
 */
export function dueWeekdays(now: Date): number[] {
  const days = new Set<number>();
  for (const t of [now.getTime() + WEEKLY_TIMES.leadMs - WEEKLY_TIMES.windowMs, now.getTime() + WEEKLY_TIMES.leadMs]) {
    const d = new Date(t).getUTCDay();
    for (const k of [6, 0, 1]) days.add((d + k) % 7);
  }
  return [...days].sort((a, b) => a - b);
}

const label = (start: Date, tz: string, name: string, locale: BotLocale) => `${formatEventDay(start, tz, locale)} ${formatEventTime(start, tz, locale)} · ${name}`.slice(0, 60);

/**
 * The hourly job's step: every listening crew group whose post is due gets it, once. Returns how many
 * were posted, why the others were not, and how many groups the cap left out (`cut`, also the day
 * counter `tg_weekly_times_cut`, so a cut never passes in silence).
 */
export async function postWeeklyTimes(db: Db, now = new Date(), o: { maxGroups?: number } = {}): Promise<{ posted: number; none: number; booked: number; cut: number }> {
  const out = { posted: 0, none: 0, booked: 0, cut: 0 };
  if (!telegramEnabled()) return out;
  const max = o.maxGroups ?? WEEKLY_TIMES.maxGroups;
  // Only the crews whose slot can be due now (`dueWeekdays`), in a fixed order.
  const where = and(isNotNull(telegramChats.listeningSince), isNull(telegramChats.leftAt), inArray(groups.recurDow, dueWeekdays(now)), isNotNull(groups.recurTime), isNull(groups.archivedAt));
  const rows = await db.select({ chat: telegramChats, group: groups }).from(telegramChats).innerJoin(groups, eq(groups.id, telegramChats.groupId)).where(where).orderBy(groups.id, telegramChats.chatId).limit(max + 1);
  if (rows.length > max) {
    // Only past the cap: one count of the same rows, so the counter says how many were left out.
    const [{ n }] = await db.select({ n: count() }).from(telegramChats).innerJoin(groups, eq(groups.id, telegramChats.groupId)).where(where);
    out.cut = Number(n) - max;
    await bumpMetric(db, "tg_weekly_times_cut", out.cut).catch(() => undefined);
  }
  for (const { chat, group } of rows.slice(0, max)) {
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
  // The crew's games that a free time near the slot can overlap: one read down `events_group_idx`.
  const reach = WEEKLY_TIMES.nearMs + LONGEST_LENGTH * 60_000;
  const games = await db
    .select({ code: events.code, startsAt: events.startsAt, durationMinutes: events.durationMinutes, venueSlug: events.venueSlug, courtBookedAt: events.courtBookedAt, bookingUrl: events.bookingUrl })
    .from(events)
    .where(and(eq(events.groupId, group.id), inArray(events.status, ["open", "full"]), gte(events.startsAt, new Date(slot.getTime() - reach)), lte(events.startsAt, new Date(slot.getTime() + reach))))
    .limit(10);
  // The slot's game has its court already: nothing to propose.
  if (games.some((g) => g.startsAt.getTime() === slot.getTime() && (g.courtBookedAt || g.bookingUrl))) return "booked";
  const { times, lengthMinutes } = await bestTimesForChat(db, { groupId: group.id, playerId: null, venueName: chat.venueName, tz: chat.tz, around: { at: slot, withinMs: WEEKLY_TIMES.nearMs } }, now, BEST_TIMES.limit * 2);
  const locale = chatLocale(chat);
  const buttons: InlineKeyboard["inline_keyboard"][number] = [];
  for (const b of times) {
    if (buttons.length >= BEST_TIMES.limit) break;
    const from = b.start.getTime();
    const to = from + lengthMinutes * 60_000;
    const overlapping = games.filter((g) => g.startsAt.getTime() < to && from < eventEnd(g).getTime());
    // The crew plays then already: at that game's own club and start, the card's own join; any other
    // time that overlaps a game of theirs is not a choice, because its tap would make a second game at
    // once (review, 11 October 2026: Chalong at 19:30 beside the crew's game at Rawai at 19:00).
    if (overlapping.length) {
      const same = overlapping.find((g) => g.startsAt.getTime() === from && g.venueSlug === b.slug);
      if (same) buttons.push({ text: label(b.start, b.tz, b.name, locale), callback_data: `j:${same.code}` });
      continue;
    }
    const data = `bt:${Math.round(b.start.getTime() / 60_000).toString(36)}:${lengthMinutes}:${b.slug}`;
    if (data.length <= 64) buttons.push({ text: label(b.start, b.tz, b.name, locale), callback_data: data });
  }
  if (buttons.length === 0) return "none";
  const s = strings(locale);
  const when = `${formatEventDay(slot, group.tz, locale)} ${formatEventTime(slot, group.tz, locale)}`;
  const sent = await sendMessage(chat.chatId, esc(s.weeklyTimes(when)), { keyboard: { inline_keyboard: buttons.map((b) => [b]) }, silent: true });
  return sent.ok ? "posted" : "failed";
}
