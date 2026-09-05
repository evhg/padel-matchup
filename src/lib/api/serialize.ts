import type { Event, Player } from "@/db/schema";
import { EVENT_DURATION_MS } from "@/lib/config";
import { isClaimable, isOccupied } from "@/lib/domain/events";
import type { GroupDetail } from "@/lib/domain/groups";
import { formatOf } from "@/lib/domain/formats";
import { hasRange, presetFor } from "@/lib/domain/levels";
import type { EventDetail } from "@/lib/domain/queries";
import { matchResult } from "@/lib/domain/result";
import type { VenueBoard } from "@/lib/domain/venueBoard";

/**
 * Public shapes. Exactly what the public web pages show, never more:
 * first names and levels, never emails, phones, tokens or manage links.
 */
export type PublicPlayer = { name: string; level: number | null; organizer: boolean; status: "joined" | "confirmed" | "invited" };
export type PublicVenue = { name: string; slug: string | null; mapUrl: string | null; court: string | null; boardUrl: string | null };
export type PublicMatch = {
  code: string;
  url: string;
  type: "match" | "tournament";
  /** Tournaments only: americano, mexicano or king (King of the Court). */
  format: "americano" | "mexicano" | "king" | null;
  title: string | null;
  status: "open" | "full" | "cancelled" | "past";
  startsAt: string;
  endsAt: string;
  tz: string;
  venue: PublicVenue | null;
  capacity: number;
  players: PublicPlayer[];
  spotsLeft: number;
  waitlist: number;
  whenFull: "waitlist" | "closed";
  level: { min: number | null; max: number | null; preset: string | null } | null;
  group: { code: string; name: string; url: string } | null;
  listed: boolean;
  bookingUrl: string | null;
  note: string | null;
  result: { sets: { a: number; b: number }[]; teamA: string[]; teamB: string[]; confirmed: boolean } | null;
  createdAt: string;
};

export function playerName(p: Player | null, invitedName: string | null): string {
  return p?.displayName ?? invitedName ?? "?";
}

export function matchToPublic(detail: EventDetail, base: string, group?: { code: string; name: string } | null): PublicMatch {
  const ev = detail.event;
  const players: PublicPlayer[] = detail.roster
    .filter((s) => isOccupied(s) || s.status === "invited")
    .map((s) => ({ name: playerName(s.player, s.invitedName), level: s.player?.level ?? null, organizer: s.playerId === ev.creatorPlayerId, status: s.status as PublicPlayer["status"] }));
  const range = { min: ev.levelMin, max: ev.levelMax };
  const res = ev.type === "match" ? matchResult(detail.scores, detail.roster.map((s) => ({ team: s.team, status: s.status, name: playerName(s.player, s.invitedName) }))) : null;
  return {
    code: ev.code,
    url: `${base}/${ev.code}`,
    type: ev.type,
    format: ev.type === "tournament" ? formatOf(ev.format) : null,
    title: ev.title,
    status: ev.status,
    startsAt: ev.startsAt.toISOString(),
    endsAt: new Date(ev.startsAt.getTime() + EVENT_DURATION_MS).toISOString(),
    tz: ev.tz,
    venue: ev.venueName ? { name: ev.venueName, slug: ev.venueSlug, mapUrl: ev.venueMapUrl, court: ev.court, boardUrl: ev.venueSlug ? `${base}/v/${ev.venueSlug}` : null } : null,
    capacity: ev.capacity,
    players,
    spotsLeft: detail.roster.filter(isClaimable).length,
    waitlist: detail.waitlist.filter((s) => s.status === "joined").length,
    whenFull: ev.whenFull,
    level: hasRange(range) ? { min: range.min, max: range.max, preset: presetFor(range) } : null,
    group: group ? { code: group.code, name: group.name, url: `${base}/g/${group.code}` } : null,
    listed: ev.publicListing,
    bookingUrl: ev.bookingUrl,
    note: ev.note,
    result: res ? { sets: res.sets.map((s) => ({ a: s.sideA, b: s.sideB })), teamA: res.a, teamB: res.b, confirmed: ev.scoreLockedByCreator } : null,
    createdAt: ev.createdAt.toISOString(),
  };
}

export type PublicBoard = { slug: string; name: string; url: string; mapUrl: string | null; calendarUrl: string; matches: { code: string; url: string; type: string; title: string | null; startsAt: string; tz: string; capacity: number; players: number; spotsLeft: number; level: PublicMatch["level"] }[] };

export function boardToPublic(board: VenueBoard, base: string): PublicBoard {
  return {
    slug: board.slug,
    name: board.name,
    url: `${base}/v/${board.slug}`,
    mapUrl: board.mapUrl,
    calendarUrl: `${base}/v/${board.slug}/calendar.ics`,
    matches: board.events.map(({ event: ev, occupied, spotsLeft }) => {
      const range = { min: ev.levelMin, max: ev.levelMax };
      return { code: ev.code, url: `${base}/${ev.code}`, type: ev.type, title: ev.title, startsAt: ev.startsAt.toISOString(), tz: ev.tz, capacity: ev.capacity, players: occupied, spotsLeft, level: hasRange(range) ? { min: range.min, max: range.max, preset: presetFor(range) } : null };
    }),
  };
}

export type PublicGroup = {
  code: string;
  name: string;
  url: string;
  calendarUrl: string;
  venue: { name: string | null; mapUrl: string | null; court: string | null };
  tz: string;
  type: "match" | "tournament";
  capacity: number;
  level: PublicMatch["level"];
  weekly: { weekday: number; time: string; leadDays: number } | null;
  members: { name: string; level: number | null; admin: boolean }[];
  upcoming: { code: string; url: string; startsAt: string; title: string | null }[];
};

export function groupToPublic(detail: GroupDetail, base: string): PublicGroup {
  const g = detail.group;
  const range = { min: g.levelMin, max: g.levelMax };
  return {
    code: g.code,
    name: g.name,
    url: `${base}/g/${g.code}`,
    calendarUrl: `${base}/g/${g.code}/calendar.ics`,
    venue: { name: g.venueName, mapUrl: g.venueMapUrl, court: g.court },
    tz: g.tz,
    type: g.type,
    capacity: g.capacity,
    level: hasRange(range) ? { min: range.min, max: range.max, preset: presetFor(range) } : null,
    weekly: g.recurDow != null && g.recurTime ? { weekday: g.recurDow, time: g.recurTime, leadDays: g.recurLeadDays } : null,
    members: detail.members.map((m) => ({ name: m.player.displayName, level: m.player.level, admin: m.role === "admin" })),
    upcoming: detail.upcoming.map((e: Event) => ({ code: e.code, url: `${base}/${e.code}`, startsAt: e.startsAt.toISOString(), title: e.title })),
  };
}
