import { EVENT_DURATION_MS } from "@/lib/config";
import { icsStamp } from "@/lib/dates";
import { eventTitleLine, venueWithCourt } from "@/lib/labels";
import { lineupComplete, withCompleteSuffix } from "@/lib/lineup";
import type { Event, Slot } from "@/db/schema";

export type CalendarEvent = Pick<Event, "id" | "code" | "title" | "startsAt" | "venueName" | "venueMapUrl" | "court" | "note" | "type" | "icsSequence" | "status">;

export function calendarTitle(ev: Pick<Event, "title" | "type">, fallback: string): string {
  return ev.title?.trim() || fallback;
}

/** Google Calendar "render" URL — works with zero email. */
export function googleCalendarUrl(ev: CalendarEvent, opts: { title: string; url: string; tz: string; venueLabel?: string; location?: string }): string {
  const end = new Date(ev.startsAt.getTime() + EVENT_DURATION_MS);
  const details = [ev.note, opts.url].filter(Boolean).join("\n\n");
  const venue = opts.location ?? ev.venueName ?? opts.venueLabel ?? "";
  const location = ev.venueMapUrl ? `${venue} (${ev.venueMapUrl})` : venue;
  const p = new URLSearchParams({
    action: "TEMPLATE",
    text: opts.title,
    dates: `${icsStamp(ev.startsAt)}/${icsStamp(end)}`,
    details,
    location,
    ctz: opts.tz,
  });
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}

function icsEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function fold(line: string): string {
  // RFC 5545: lines ≤ 75 octets, continuation lines start with a space.
  const out: string[] = [];
  let cur = "";
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > 73) {
      out.push(cur);
      cur = " " + ch;
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.join("\r\n");
}

export type IcsInput = {
  event: CalendarEvent;
  title: string;
  url: string;
  organizer: { name: string; email: string };
  attendee?: { name: string; email: string };
  method: "REQUEST" | "CANCEL" | "PUBLISH";
  domain: string;
  /** Extra lines appended to DESCRIPTION (e.g. the recipient's personal link). */
  extraDescription?: string[];
  location?: string;
};

type Translate = (key: string, values?: Record<string, string | number>) => string;
type RosterSlot = Pick<Slot, "status" | "position" | "invitedName"> & { player: { displayName: string } | null };

/**
 * What a calendar entry says about a match: the title ("- COMPLETE" once every spot is taken), the
 * place with its court, and the line naming who plays. The emailed invitation and the player's own
 * feed both take these from here, so one match reads the same in the two places it can land.
 */
export function inviteFields(ev: Pick<Event, "title" | "type" | "venueName" | "court" | "capacity">, roster: RosterSlot[], t: Translate) {
  const courtNumber = (n: string) => t("event.courtNumber", { n });
  const location = venueWithCourt(ev, { venueTbd: t("event.venueTbd"), courtNumber });
  const complete = lineupComplete(roster, ev.capacity);
  const names = roster.filter((s) => s.position <= ev.capacity && (s.status === "joined" || s.status === "confirmed")).map((s) => s.player?.displayName ?? s.invitedName ?? "?");
  const title = withCompleteSuffix(eventTitleLine(ev, { fallback: t(ev.type === "match" ? "event.match" : "event.tournament"), courtNumber }), complete, t("calendar.completeSuffix"));
  const playersLine = names.length ? t("calendar.players", { names: names.join(", ") }) : null;
  return { title, location, complete, names, playersLine };
}

/** Stable UID per event so updates/cancellations replace the original entry. */
export const icsUid = (eventId: string, domain: string) => `${eventId}@${domain}`;

export function buildIcs(input: IcsInput): string {
  const { event, title, url, organizer, attendee, method, domain } = input;
  const location = input.location ?? event.venueName ?? "";
  const end = new Date(event.startsAt.getTime() + EVENT_DURATION_MS);
  const cancelled = method === "CANCEL" || event.status === "cancelled";
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Kicksmash//Padel Match-Up//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${method}`,
    "BEGIN:VEVENT",
    `UID:${icsUid(event.id, domain)}`,
    `SEQUENCE:${event.icsSequence}`,
    `DTSTAMP:${icsStamp(new Date())}`,
    `DTSTART:${icsStamp(event.startsAt)}`,
    `DTEND:${icsStamp(end)}`,
    `SUMMARY:${icsEscape(title)}`,
    ...(location ? [`LOCATION:${icsEscape(location)}`] : []),
    `DESCRIPTION:${icsEscape([event.note, url, ...(input.extraDescription ?? [])].filter(Boolean).join("\n\n"))}`,
    `URL:${url}`,
    `STATUS:${cancelled ? "CANCELLED" : "CONFIRMED"}`,
    `ORGANIZER;CN=${icsEscape(organizer.name)}:mailto:${organizer.email}`,
  ];
  if (event.venueMapUrl) lines.push(`X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-TITLE=${icsEscape(event.venueName ?? "")}:${event.venueMapUrl}`);
  if (attendee) {
    lines.push(`ATTENDEE;CN=${icsEscape(attendee.name)};ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:${attendee.email}`);
  }
  lines.push("BEGIN:VALARM", "TRIGGER:-PT2H", "ACTION:DISPLAY", `DESCRIPTION:${icsEscape(title)}`, "END:VALARM");
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}


export type FeedEntry = { event: CalendarEvent; title: string; url: string; location?: string; /** Lines after the link in DESCRIPTION, as the invitation's `extraDescription`. */ extra?: string[] };

/** A subscribable calendar (METHOD:PUBLISH) with one VEVENT per match: group and venue feeds. */
export function buildFeed(input: { name: string; domain: string; entries: FeedEntry[]; description?: string }): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Kicksmash//Padel Match-Up//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEscape(input.name)}`,
    ...(input.description ? [`X-WR-CALDESC:${icsEscape(input.description)}`] : []),
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];
  const stamp = icsStamp(new Date());
  for (const { event, title, url, location, extra } of input.entries) {
    const end = new Date(event.startsAt.getTime() + EVENT_DURATION_MS);
    const loc = location ?? event.venueName ?? "";
    lines.push(
      "BEGIN:VEVENT",
      `UID:${icsUid(event.id, input.domain)}`,
      `SEQUENCE:${event.icsSequence}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsStamp(event.startsAt)}`,
      `DTEND:${icsStamp(end)}`,
      `SUMMARY:${icsEscape(title)}`,
      ...(loc ? [`LOCATION:${icsEscape(loc)}`] : []),
      `DESCRIPTION:${icsEscape([event.note, url, ...(extra ?? [])].filter(Boolean).join("\n\n"))}`,
      `URL:${url}`,
      `STATUS:${event.status === "cancelled" ? "CANCELLED" : "CONFIRMED"}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
