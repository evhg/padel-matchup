/** Shared, framework-free formatting helpers for venue, court and titles. */

type CourtNumber = (n: string) => string;

/** "3" → "Court 3" (localized); "Centre court" stays as typed. */
export function courtLabel(court: string | null | undefined, courtNumber: CourtNumber): string | null {
  const c = (court ?? "").trim();
  if (!c) return null;
  return /^\d{1,3}[a-zA-Z]?$/.test(c) ? courtNumber(c) : c;
}

/** "Padel Indoor BCN · Court 3", or the TBD label when there is no venue. */
export function venueWithCourt(
  ev: { venueName: string | null; court: string | null },
  o: { venueTbd: string; courtNumber: CourtNumber },
): string {
  const court = courtLabel(ev.court, o.courtNumber);
  const venue = ev.venueName ?? o.venueTbd;
  return court ? `${venue} · ${court}` : venue;
}

/** Calendar / email title: "Thursday padel · Padel Indoor BCN · Court 3". */
export function eventTitleLine(
  ev: { title: string | null; venueName: string | null; court: string | null },
  o: { fallback: string; courtNumber: CourtNumber },
): string {
  return [ev.title?.trim() || o.fallback, ev.venueName, courtLabel(ev.court, o.courtNumber)].filter(Boolean).join(" · ");
}
