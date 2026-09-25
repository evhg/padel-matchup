import { createHash } from "node:crypto";
import { formatEventDay, formatEventTime } from "@/lib/dates";
import { lateExitLine } from "@/lib/domain/banter";
import { isOccupied } from "@/lib/domain/events";
import { formatLevel, formatRange, hasRange } from "@/lib/domain/levels";
import type { EventDetail } from "@/lib/domain/queries";
import { lineupComplete } from "@/lib/lineup";
import { cardTitle, strings, whereLine, type BotLocale } from "@/lib/telegram/card";
import type { FlexBubble, LineMessage } from "./api";

/**
 * The match card as a LINE Flex bubble. The words are the same ones the Telegram and Discord cards
 * use — `strings()`, `cardTitle()`, `whereLine()` — so a match reads identically wherever somebody
 * sees it; only the markup is LINE's.
 *
 * The roster is capped because a bubble that scrolls is a bubble nobody reads, and because on a
 * channel that cannot edit, every version of this is a new message somebody has to scroll past.
 */
const MAX_LINES = 12;

export type LineCardRender = { messages: LineMessage[]; complete: boolean; hash: string };

const text = (value: string, o: Record<string, unknown> = {}) => ({ type: "text", text: value || " ", wrap: true, size: "sm", ...o });

export function renderLineCard(detail: EventDetail, base: string, locale: BotLocale): LineCardRender {
  const ev = detail.event;
  const s = strings(locale);
  const url = `${base}/${ev.code}`;
  const seats = detail.roster.filter((x) => x.position <= ev.capacity).sort((a, b) => a.position - b.position);
  const occupied = seats.filter(isOccupied).length;
  const complete = lineupComplete(detail.roster, ev.capacity);
  const cancelled = ev.status === "cancelled";
  const past = ev.status === "past";

  const head: string[] = [`📅 ${formatEventDay(ev.startsAt, ev.tz, locale)} · ${formatEventTime(ev.startsAt, ev.tz, locale)}`, `📍 ${whereLine(detail, locale)}`];
  const range = { min: ev.levelMin, max: ev.levelMax };
  if (hasRange(range)) head.push(`🎚 ${s.level} ${formatRange(range, { between: (a, b) => `${a}–${b}`, plus: (a) => `${a}+`, upTo: (b) => `≤ ${b}` })}`);
  if (ev.cost) head.push(`💸 ${ev.cost}${ev.payNote ? ` · ${ev.payNote}` : ""}`);

  const lines: string[] = [];
  for (const seat of seats.slice(0, MAX_LINES)) {
    if (isOccupied(seat)) {
      const name = seat.player?.displayName ?? seat.invitedName ?? "?";
      const level = seat.player?.level != null ? ` ${formatLevel(seat.player.level)}` : "";
      const org = seat.playerId === ev.creatorPlayerId ? ` · ${s.organizer}` : "";
      lines.push(`${seat.position}. ${name}${level}${org}`);
    } else if (seat.status === "invited") {
      lines.push(`${seat.position}. ${seat.invitedName ?? "?"} (${s.reserved})`);
    } else {
      lines.push(`${seat.position}. —`);
    }
  }
  if (seats.length > MAX_LINES) lines.push(`… +${seats.length - MAX_LINES}`);
  if (detail.waitlist.length > 0) lines.push(s.waitlist(detail.waitlist.length));

  const spotsLeft = Math.max(0, ev.capacity - occupied - seats.filter((x) => x.status === "invited").length);
  const status = cancelled ? `❌ ${s.cancelled}` : past ? s.past : complete ? s.complete : spotsLeft > 0 ? s.spots(spotsLeft) : ev.whenFull === "waitlist" ? s.full : s.closed;

  const open = { type: "button", style: "link", height: "sm", action: { type: "uri", label: s.open, uri: url } };
  const footer =
    cancelled || past
      ? [open]
      : [
          { type: "button", style: "primary", height: "sm", action: { type: "postback", label: s.in, data: `j:${ev.code}`, displayText: s.in } },
          { type: "button", style: "secondary", height: "sm", action: { type: "postback", label: s.out, data: `l:${ev.code}`, displayText: s.out } },
          open,
        ];

  const bubble: FlexBubble = {
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        text(`🎾 ${cardTitle(detail, locale)}`, { weight: "bold", size: "md" }),
        ...head.map((h) => text(h, { color: "#5B6470" })),
        { type: "separator", margin: "md" },
        text(`${s.players} ${occupied}/${ev.capacity}`, { weight: "bold", margin: "md" }),
        ...lines.map((l) => text(l)),
        text(status, { weight: "bold", margin: "md" }),
        // Banter: the late pull-out that opened this spot, while it is open (set by the card sync alone).
        ...(detail.lateExit && !cancelled && !past && spotsLeft > 0 ? [text(lateExitLine(locale, ev.code, detail.lateExit), { color: "#5B6470" })] : []),
      ],
    },
    footer: { type: "box", layout: "vertical", spacing: "sm", contents: footer },
  };

  // Alt text is what LINE shows in the chat list and in a notification, so it carries the answer to
  // "is this worth opening": when, where, and how many seats are left.
  const altText = `${cardTitle(detail, locale)} · ${formatEventDay(ev.startsAt, ev.tz, locale)} ${formatEventTime(ev.startsAt, ev.tz, locale)} · ${status}`.slice(0, 400);
  const hash = createHash("sha256").update(JSON.stringify(bubble)).digest("hex");
  return { messages: [{ type: "flex", altText, contents: bubble }], complete, hash };
}
