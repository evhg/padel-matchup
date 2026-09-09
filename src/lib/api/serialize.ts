import type { Coach, Event, Player, Series } from "@/db/schema";
import type { SeriesPage } from "@/lib/domain/series";
import { EVENT_DURATION_MS } from "@/lib/config";
import { isClaimable, isOccupied } from "@/lib/domain/events";
import type { GroupDetail } from "@/lib/domain/groups";
import { formatOf } from "@/lib/domain/formats";
import { hasRange, presetFor } from "@/lib/domain/levels";
import type { Club } from "@/db/schema";
import { platformById } from "@/lib/booking/platforms";
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
  level: { min: number | null; max: number | null; preset: string | null; /** Only confirmed levels walk in; declared ones ask. */ verifiedOnly?: boolean } | null;
  group: { code: string; name: string; url: string } | null;
  listed: boolean;
  bookingUrl: string | null;
  /** What each player pays, free text. How to pay stays between the players. */
  cost: string | null;
  note: string | null;
  result: { sets: { a: number; b: number }[]; teamA: string[]; teamB: string[]; winner: "a" | "b" | "draw"; confirmed: boolean } | null;
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
    level: hasRange(range) ? { min: range.min, max: range.max, preset: presetFor(range), verifiedOnly: ev.levelVerifiedOnly } : null,
    group: group ? { code: group.code, name: group.name, url: `${base}/g/${group.code}` } : null,
    listed: ev.publicListing,
    bookingUrl: ev.bookingUrl,
    cost: ev.cost,
    note: ev.note,
    result: res ? { sets: res.sets.map((s) => ({ a: s.sideA, b: s.sideB })), teamA: res.a, teamB: res.b, winner: res.winner, confirmed: ev.scoreLockedByCreator } : null,
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
      return { code: ev.code, url: `${base}/${ev.code}`, type: ev.type, title: ev.title, startsAt: ev.startsAt.toISOString(), tz: ev.tz, capacity: ev.capacity, players: occupied, spotsLeft, level: hasRange(range) ? { min: range.min, max: range.max, preset: presetFor(range), verifiedOnly: ev.levelVerifiedOnly } : null };
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

export type PublicCoach = {
  handle: string;
  name: string;
  url: string;
  bookUrl: string;
  city: string | null;
  tz: string;
  clubs: string[];
  lessonMinutes: number;
  languages: string[];
  bio: string | null;
  rules: { cutoffHours: number; latePasses: number; minNoticeHours: number };
  /** Next free starts (ISO), when asked for. */
  nextSlots?: string[];
};

/** A listed coach: what they put on their page and the rules students book under. Never a phone, an email or a payment id. */
export function coachToPublic(c: Coach, base: string, extra: { city?: string | null; slots?: Date[] } = {}): PublicCoach {
  return {
    handle: c.handle,
    name: c.displayName,
    url: `${base}/c/${c.handle}`,
    bookUrl: `${base}/c/${c.handle}`,
    city: extra.city ?? null,
    tz: c.tz,
    clubs: c.clubNames,
    lessonMinutes: c.lessonMinutes,
    languages: c.languages,
    bio: c.bio,
    rules: { cutoffHours: c.cutoffHours, latePasses: c.latePasses, minNoticeHours: c.minNoticeHours },
    ...(extra.slots ? { nextSlots: extra.slots.map((d) => d.toISOString()) } : {}),
  };
}

export type PublicClub = {
  slug: string;
  name: string;
  url: string;
  city: string | null;
  mapUrl: string | null;
  website: string | null;
  booking: { url: string; platform: string | null; platformName: string | null } | null;
  courts: number | null;
  about: string | null;
  founding: boolean;
  /** Today's free court-hours from the club's own feed, or null when the club shares none. */
  freeCourts: { day: string; tz: string; fetchedAt: string; slots: { start: string; end: string; free: number }[] } | null;
  boardUrl: string;
  rankingUrl: string;
  calendarUrl: string;
};

/** A live club: what the club chose to publish, nothing private (the manage token never leaves the server). */
export function clubToPublic(c: Club, base: string): PublicClub {
  const platform = platformById(c.bookingPlatform);
  const a = c.availability && !c.availability.error ? c.availability : null;
  return {
    slug: c.slug,
    name: c.name,
    url: `${base}/v/${c.slug}`,
    city: c.city,
    mapUrl: c.mapUrl,
    website: c.website,
    booking: c.bookingUrl ? { url: c.bookingUrl, platform: platform?.id ?? null, platformName: platform?.name ?? null } : null,
    courts: c.courts,
    about: c.about,
    founding: c.founding,
    freeCourts: a ? { day: a.day, tz: a.tz, fetchedAt: a.fetchedAt, slots: a.slots } : null,
    boardUrl: `${base}/v/${c.slug}`,
    rankingUrl: `${base}/v/${c.slug}/ranking`,
    calendarUrl: `${base}/v/${c.slug}/calendar.ics`,
  };
}

export type PublicSeries = {
  slug: string;
  name: string;
  url: string;
  organizer: string | null;
  format: string;
  rhythm: { every: string; weekday: number; time: string; nth: number | null; tz: string };
  venue: { name: string; slug: string | null; mapUrl: string | null } | null;
  level: { min: number | null; max: number | null; verifiedOnly: boolean };
  capacity: number;
  cost: string | null;
  active: boolean;
  next: { code: string; url: string; startsAt: string; spotsLeft?: number } | null;
};
export type PublicSeriesPage = PublicSeries & { editions: number; past: { code: string; url: string; startsAt: string; podium: { name: string; rank: number }[] }[] };

/** A series as the API and MCP show it: the template, the rhythm, the next edition; never a payment note. */
export function seriesToPublic(s: Series, next: Event | null, base: string, organizer: string | null = null): PublicSeries {
  return {
    slug: s.slug,
    name: s.name,
    url: `${base}/s/${s.slug}`,
    organizer,
    format: s.format,
    rhythm: { every: s.every, weekday: s.dow, time: s.time, nth: s.nth, tz: s.tz },
    venue: s.venueName ? { name: s.venueName, slug: s.venueSlug, mapUrl: s.venueMapUrl } : null,
    level: { min: s.levelMin, max: s.levelMax, verifiedOnly: s.levelVerifiedOnly },
    capacity: s.capacity,
    cost: s.cost,
    active: s.active,
    next: next ? { code: next.code, url: `${base}/${next.code}`, startsAt: next.startsAt.toISOString() } : null,
  };
}

export function seriesPageToPublic(page: SeriesPage, base: string): PublicSeriesPage {
  const head = seriesToPublic(page.series, page.next?.event ?? null, base, page.organizerName || null);
  return {
    ...head,
    next: page.next && head.next ? { ...head.next, spotsLeft: page.next.spotsLeft } : null,
    editions: page.editions,
    past: page.past.map((e) => ({ code: e.event.code, url: `${base}/${e.event.code}`, startsAt: e.event.startsAt.toISOString(), podium: e.podium.map((p) => ({ name: p.name, rank: p.rank })) })),
  };
}
