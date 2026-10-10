import type { Coach, Event, Player, Series } from "@/db/schema";
import type { SeriesPage } from "@/lib/domain/series";
import { eventEnd } from "@/lib/domain/matchLength";
import { isClaimable, isOccupied } from "@/lib/domain/events";
import { isClubLive } from "@/lib/domain/clubs";
import type { GroupDetail } from "@/lib/domain/groups";
import { cleanAgeMin, cleanCategory, type AgeMin, type EventCategory } from "@/lib/domain/eventTags";
import { memberLevelFor, type GroupViewer } from "@/lib/domain/groupAccess";
import { formatOf } from "@/lib/domain/formats";
import { seatUnits } from "@/lib/domain/fixedPairs";
import { hasRange, presetFor } from "@/lib/domain/levels";
import type { Club } from "@/db/schema";
import { platformById } from "@/lib/booking/platforms";
import { freeCourtsState, slotDay, todaySlots } from "@/lib/booking/availability";
import type { EventDetail } from "@/lib/domain/queries";
import { matchResult } from "@/lib/domain/result";
import type { VenueBoard } from "@/lib/domain/venueBoard";

/**
 * Public shapes. Exactly what the public web pages show, never more:
 * first names and levels, never emails, phones, tokens or manage links.
 */
export type PublicPlayer = { name: string; level: number | null; organizer: boolean; status: "joined" | "confirmed" | "invited" };
/** A fixed-pairs night's pair as it is listed: two first names, or one with `partnerNeeded`. */
export type PublicPair = { names: string[]; partnerNeeded: boolean };
export type PublicVenue = { name: string; slug: string | null; mapUrl: string | null; court: string | null; boardUrl: string | null };
export type PublicMatch = {
  code: string;
  url: string;
  type: "match" | "tournament";
  /** Tournaments only: americano, mexicano or king (King of the Court). */
  format: "americano" | "mexicano" | "king" | null;
  /** Tournaments only: two partners play every round together (fixed pairs) instead of rotating. */
  fixedPairs: boolean | null;
  /** A fixed-pairs night's list as pairs, in order: two names each, or one name that needs a partner. Null otherwise. */
  pairs: PublicPair[] | null;
  title: string | null;
  status: "open" | "full" | "cancelled" | "past";
  startsAt: string;
  /** startsAt plus durationMinutes. */
  endsAt: string;
  /** How long the organiser booked: 60, 90 or 120 minutes. */
  durationMinutes: number;
  tz: string;
  venue: PublicVenue | null;
  capacity: number;
  players: PublicPlayer[];
  spotsLeft: number;
  waitlist: number;
  whenFull: "waitlist" | "closed";
  level: { min: number | null; max: number | null; preset: string | null; /** Only confirmed levels walk in; declared ones ask. */ verifiedOnly?: boolean } | null;
  /** Who it is for: men, women or mixed; null for anyone. Information only, nobody is checked at join. */
  category: EventCategory | null;
  /** 35, 45 or 55 for an age tag (35+, 45+, 55+); null for any age. */
  ageMin: AgeMin | null;
  group: { code: string; name: string; url: string } | null;
  listed: boolean;
  bookingUrl: string | null;
  /** What each player pays, free text. How to pay stays between the players. */
  cost: string | null;
  note: string | null;
  result: { sets: { a: number; b: number }[]; teamA: string[]; teamB: string[]; winner: "a" | "b" | "draw"; confirmed: boolean } | null;
  createdAt: string;
};

/** The tag as every public shape carries it, cleaned again so a row holding anything else reads as none. */
const tagOf = (r: { category: string | null; ageMin: number | null }): { category: EventCategory | null; ageMin: AgeMin | null } => ({ category: cleanCategory(r.category), ageMin: cleanAgeMin(r.ageMin) });

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
    fixedPairs: ev.type === "tournament" ? ev.fixedPairs : null,
    pairs:
      ev.type === "tournament" && ev.fixedPairs
        ? seatUnits(detail.roster).map((u) => (u.kind === "pair" ? { names: u.seats.map((x) => playerName(x.player, x.invitedName)), partnerNeeded: false } : { names: [playerName(u.seat.player, u.seat.invitedName)], partnerNeeded: true }))
        : null,
    title: ev.title,
    status: ev.status,
    startsAt: ev.startsAt.toISOString(),
    endsAt: eventEnd(ev).toISOString(),
    durationMinutes: ev.durationMinutes,
    tz: ev.tz,
    venue: ev.venueName ? { name: ev.venueName, slug: ev.venueSlug, mapUrl: ev.venueMapUrl, court: ev.court, boardUrl: ev.venueSlug ? `${base}/v/${ev.venueSlug}` : null } : null,
    capacity: ev.capacity,
    players,
    spotsLeft: detail.roster.filter(isClaimable).length,
    waitlist: detail.waitlist.filter((s) => s.status === "joined").length,
    whenFull: ev.whenFull,
    level: hasRange(range) ? { min: range.min, max: range.max, preset: presetFor(range), verifiedOnly: ev.levelVerifiedOnly } : null,
    ...tagOf(ev),
    group: group ? { code: group.code, name: group.name, url: `${base}/g/${group.code}` } : null,
    listed: ev.publicListing,
    bookingUrl: ev.bookingUrl,
    cost: ev.cost,
    note: ev.note,
    result: res ? { sets: res.sets.map((s) => ({ a: s.sideA, b: s.sideB })), teamA: res.a, teamB: res.b, winner: res.winner, confirmed: ev.scoreLockedByCreator } : null,
    createdAt: ev.createdAt.toISOString(),
  };
}

export type PublicBoard = { slug: string; name: string; url: string; mapUrl: string | null; calendarUrl: string; matches: { code: string; url: string; type: string; title: string | null; startsAt: string; tz: string; capacity: number; players: number; spotsLeft: number; level: PublicMatch["level"]; category: PublicMatch["category"]; ageMin: PublicMatch["ageMin"] }[] };

export function boardToPublic(board: VenueBoard, base: string): PublicBoard {
  return {
    slug: board.slug,
    name: board.name,
    url: `${base}/v/${board.slug}`,
    mapUrl: board.mapUrl,
    calendarUrl: `${base}/v/${board.slug}/calendar.ics`,
    matches: board.events.map(({ event: ev, occupied, spotsLeft }) => {
      const range = { min: ev.levelMin, max: ev.levelMax };
      return { code: ev.code, url: `${base}/${ev.code}`, type: ev.type, title: ev.title, startsAt: ev.startsAt.toISOString(), tz: ev.tz, capacity: ev.capacity, players: occupied, spotsLeft, level: hasRange(range) ? { min: range.min, max: range.max, preset: presetFor(range), verifiedOnly: ev.levelVerifiedOnly } : null, ...tagOf(ev) };
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
  /** New people ask and an admin approves (decision E); off, anyone with the link joins. */
  askToJoin: boolean;
  memberCount: number;
  /** First names, and a level only for a viewer inside the group (`canSeeMemberLevels`): never in the API or the MCP server, which read anonymously. */
  members: { name: string; level: number | null; admin: boolean }[];
  upcoming: { code: string; url: string; startsAt: string; title: string | null; category: PublicMatch["category"]; ageMin: PublicMatch["ageMin"] }[];
};

/**
 * A group as the public may see it. `viewer` is who is reading, as the group sees them; every
 * public caller (the API, the MCP server) passes nobody, so members' levels are null there: the
 * owner's decision E, "names visible, levels hidden". The group's own range stays — it describes
 * the crew, not a person.
 */
export function groupToPublic(detail: GroupDetail, base: string, viewer: GroupViewer = null): PublicGroup {
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
    askToJoin: g.askToJoin,
    memberCount: detail.members.length,
    members: detail.members.map((m) => ({ name: m.player.displayName, level: memberLevelFor(m.player.level, viewer), admin: m.role === "admin" })),
    upcoming: detail.upcoming.map((e: Event) => ({ code: e.code, url: `${base}/${e.code}`, startsAt: e.startsAt.toISOString(), title: e.title, ...tagOf(e) })),
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
  /** The place as the club named it, and its country as ISO 3166-1 alpha-2; null when the club said neither. */
  country: string | null;
  province: string | null;
  mapUrl: string | null;
  website: string | null;
  booking: { url: string; platform: string | null; platformName: string | null } | null;
  courts: number | null;
  /** The split of the total, when the club said; null means unknown, 0 means none. */
  courtsIndoor: number | null;
  courtsOutdoor: number | null;
  /** The courts by name, as the club listed them; empty until it does. */
  courtNames: string[];
  about: string | null;
  /**
   * Does a manager run this page? A club that claimed its page and was approved says true. A club
   * Kicksmash listed from public sources says false: its courts, hours and links are our reading of
   * what is public, not the club's own word, and they may be out of date.
   */
  claimed: boolean;
  founding: boolean;
  /**
   * Today's free courts, still to come, in the club's zone; null when there is nothing current to say.
   * `source` says where they come from: "club" is a feed the club shares, "platform" is a read of the
   * booking platform's public page (`platform` names it), refreshed up to every 15 minutes and dropped
   * after two hours without a clean read. `free` courts are free for the whole of each slot, and a
   * platform's slots never overlap. Times read from a platform are not ours to license (not CC BY 4.0).
   */
  freeCourts: { day: string; tz: string; fetchedAt: string; source: "club" | "platform"; platform: string | null; slots: { start: string; end: string; free: number }[] } | null;
  boardUrl: string;
  rankingUrl: string;
  calendarUrl: string;
};

/** A club page: what the club chose to publish, nothing private (the manage token never leaves the server). */
export function clubToPublic(c: Club, base: string, courtNames?: string[], now = new Date()): PublicClub {
  const platform = platformById(c.bookingPlatform);
  // The same answer the club page gives (`freeCourtsState`): the club's feed, or a clean read from the last two hours, never an old one.
  const free = freeCourtsState(c, now);
  const a = free.kind === "platform" ? free.a : free.kind === "feed" && free.a && !free.a.error ? free.a : null;
  return {
    slug: c.slug,
    name: c.name,
    url: `${base}/v/${c.slug}`,
    city: c.city,
    country: c.country,
    province: c.province,
    mapUrl: c.mapUrl,
    website: c.website,
    booking: c.bookingUrl ? { url: c.bookingUrl, platform: platform?.id ?? null, platformName: platform?.name ?? null } : null,
    courts: c.courts,
    courtsIndoor: c.courtsIndoor,
    courtsOutdoor: c.courtsOutdoor,
    courtNames: courtNames ?? [],
    about: c.about,
    claimed: isClubLive(c),
    founding: c.founding,
    // Today in the club's zone, as the page shows it: a read from a booking platform holds several days.
    freeCourts: a ? { day: slotDay(now.toISOString(), a.tz), tz: a.tz, fetchedAt: a.fetchedAt, source: free.kind === "platform" ? "platform" : "club", platform: a.platform ?? null, slots: todaySlots(a, now).map((s) => ({ start: s.start, end: s.end, free: s.free })) } : null,
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
  /** The tag every edition carries; null for anyone and any age. */
  category: EventCategory | null;
  ageMin: AgeMin | null;
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
    ...tagOf(s),
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
