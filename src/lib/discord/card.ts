import { createHash } from "node:crypto";
import { formatEventDay, formatEventTime } from "@/lib/dates";
import { isOccupied } from "@/lib/domain/events";
import { formatLevel, formatRange, hasRange } from "@/lib/domain/levels";
import type { EventDetail } from "@/lib/domain/queries";
import { lineupComplete } from "@/lib/lineup";
import { cardTitle, strings, whereLine, type BotLocale } from "@/lib/telegram/card";
import { md, type DcActionRow, type DcEmbed } from "./api";

/**
 * The one message per match the bot keeps edited in a Discord channel: an
 * embed plus two buttons. Copy is shared with the Telegram card (same two
 * languages, same words), only the markup differs.
 */
const MAX_LINES = 16;
const COLOR = { open: 0x22c55e, full: 0x64748b, cancelled: 0xef4444, past: 0x94a3b8 } as const;

export type DiscordCard = { embeds: DcEmbed[]; components: DcActionRow[]; complete: boolean; hash: string };

export function renderDiscordCard(detail: EventDetail, base: string, locale: BotLocale): DiscordCard {
  const ev = detail.event;
  const s = strings(locale);
  const url = `${base}/${ev.code}`;
  const seats = detail.roster.filter((x) => x.position <= ev.capacity).sort((a, b) => a.position - b.position);
  const occupied = seats.filter(isOccupied).length;
  const complete = lineupComplete(detail.roster, ev.capacity);
  const cancelled = ev.status === "cancelled";
  const past = ev.status === "past";
  const head: string[] = [];
  head.push(`📅 ${formatEventDay(ev.startsAt, ev.tz, locale)} · ${formatEventTime(ev.startsAt, ev.tz, locale)}`);
  head.push(`📍 ${md(whereLine(detail, locale))}`);
  const range = { min: ev.levelMin, max: ev.levelMax };
  if (hasRange(range)) head.push(`🎚 ${s.level} ${formatRange(range, { between: (a, b) => `${a}–${b}`, plus: (a) => `${a}+`, upTo: (b) => `≤ ${b}` })}`);
  const lines: string[] = [];
  const shown = seats.slice(0, MAX_LINES);
  for (const seat of shown) {
    if (isOccupied(seat)) {
      const name = seat.player?.displayName ?? seat.invitedName ?? "?";
      const level = seat.player?.level != null ? ` *${formatLevel(seat.player.level)}*` : "";
      const org = seat.playerId === ev.creatorPlayerId ? ` · ${s.organizer}` : "";
      lines.push(`${seat.position}. ${md(name)}${level}${org}`);
    } else if (seat.status === "invited") {
      lines.push(`${seat.position}. ${md(seat.invitedName ?? "?")} *(${s.reserved})*`);
    } else {
      lines.push(`${seat.position}. —`);
    }
  }
  if (seats.length > shown.length) lines.push(`… +${seats.length - shown.length}`);
  if (detail.waitlist.length > 0) lines.push(s.waitlist(detail.waitlist.length));
  const spotsLeft = Math.max(0, ev.capacity - occupied - seats.filter((x) => x.status === "invited").length);
  const status = cancelled ? `❌ **${s.cancelled}**` : past ? s.past : complete ? `**${s.complete}**` : spotsLeft > 0 ? `**${s.spots(spotsLeft)}**` : ev.whenFull === "waitlist" ? s.full : s.closed;
  const embed: DcEmbed = {
    title: `🎾 ${cardTitle(detail, locale)}`,
    url,
    color: cancelled ? COLOR.cancelled : past ? COLOR.past : complete || spotsLeft === 0 ? COLOR.full : COLOR.open,
    description: head.join("\n"),
    fields: [{ name: `${s.players} ${occupied}/${ev.capacity}`, value: lines.join("\n") || "—" }],
    footer: { text: status.replace(/\*\*/g, "") },
  };
  const components: DcActionRow[] =
    cancelled || past
      ? [{ type: 1, components: [{ type: 2, style: 5, label: s.open, url }] }]
      : [
          {
            type: 1,
            components: [
              { type: 2, style: 3, label: s.in, custom_id: `j:${ev.code}` },
              { type: 2, style: 2, label: s.out, custom_id: `l:${ev.code}` },
              { type: 2, style: 5, label: s.open, url },
            ],
          },
        ];
  const hash = createHash("sha256").update(JSON.stringify(embed)).update(JSON.stringify(components)).digest("hex");
  return { embeds: [embed], components, complete, hash };
}
