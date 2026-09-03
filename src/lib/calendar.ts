import { EVENT_DURATION_MS } from "@/lib/config";
import { icsStamp } from "@/lib/dates";
import type { Event } from "@/db/schema";

export type CalendarEvent = Pick<Event, "id" | "code" | "title" | "startsAt" | "venueName" | "venueMapUrl" | "note" | "type" | "icsSequence" | "status">;

export function calendarTitle(ev: Pick<Event, "title" | "type">, fallback: string): string {
  return ev.title?.trim() || fallback;
}

/** Google Calendar "render" URL — works with zero email. */
export function googleCalendarUrl(ev: CalendarEvent, opts: { title: string; url: string; tz: string; venueLabel?: string }): string {
  const end = new Date(ev.startsAt.getTime() + EVENT_DURATION_MS);
  const details = [ev.note, opts.url].filter(Boolean).join("\n\n");
  const venue = ev.venueName ?? opts.venueLabel ?? "";
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
  method: "REQUEST" | "CANCEL";
  domain: string;
};

/** Stable UID per event so updates/cancellations replace the original entry. */
export const icsUid = (eventId: string, domain: string) => `${eventId}@${domain}`;

export function buildIcs(input: IcsInput): string {
  const { event, title, url, organizer, attendee, method, domain } = input;
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
    ...(event.venueName ? [`LOCATION:${icsEscape(event.venueName)}`] : []),
    `DESCRIPTION:${icsEscape([event.note, url].filter(Boolean).join("\n\n"))}`,
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
