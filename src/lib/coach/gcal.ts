import { googleAccessToken, serviceAccount } from "@/lib/search/console";

/**
 * The coach's own Google Calendar, reached the way a colleague would be: the coach shares
 * it with our service account's address with "make changes to events". No consent screen,
 * no app review, nothing moves. We read what the coach writes there as busy time and write
 * lessons back with a private tag so we recognise our own events.
 */

export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";
export const KICKSMASH_TAG = "kicksmash_lesson";
const API = "https://www.googleapis.com/calendar/v3";

export const serviceAccountEmail = (): string | null => serviceAccount()?.client_email ?? null;

export type GcalEvent = {
  id: string;
  status?: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  transparency?: string;
  extendedProperties?: { private?: Record<string, string> };
};

export type CalendarAccess = { ok: true; summary: string; timeZone: string | null } | { ok: false; reason: "no_service_account" | "no_access" | "not_found" | "error"; detail?: string };

async function call<T>(path: string, init: RequestInit, fetchImpl: typeof fetch): Promise<{ ok: true; body: T } | { ok: false; status: number; detail: string }> {
  const token = await googleAccessToken([CALENDAR_SCOPE], fetchImpl);
  if (!token) return { ok: false, status: 0, detail: "no token" };
  const res = await fetchImpl(`${API}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(12_000) });
  if (res.status === 204) return { ok: true, body: undefined as T };
  const json = (await res.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
  if (!res.ok) return { ok: false, status: res.status, detail: json?.error?.message ?? `HTTP ${res.status}` };
  return { ok: true, body: json as T };
}

/** Can we see the calendar the coach named? Answers with its own summary and zone when yes. */
export async function checkCalendarAccess(calendarId: string, fetchImpl: typeof fetch = fetch): Promise<CalendarAccess> {
  if (!serviceAccount()) return { ok: false, reason: "no_service_account" };
  const r = await call<{ summary?: string; timeZone?: string }>(`/calendars/${encodeURIComponent(calendarId)}`, { method: "GET" }, fetchImpl);
  if (r.ok) return { ok: true, summary: r.body.summary ?? calendarId, timeZone: r.body.timeZone ?? null };
  if (r.status === 404) return { ok: false, reason: "not_found", detail: r.detail };
  if (r.status === 403 || r.status === 401) return { ok: false, reason: "no_access", detail: r.detail };
  return { ok: false, reason: "error", detail: r.detail };
}

/** Every event in a window, deleted ones included so a lesson the coach removed there can be noticed. */
export async function listCalendarEvents(calendarId: string, timeMin: Date, timeMax: Date, fetchImpl: typeof fetch = fetch): Promise<GcalEvent[] | null> {
  const out: GcalEvent[] = [];
  let pageToken: string | null = null;
  for (let i = 0; i < 10; i++) {
    const params = new URLSearchParams({ timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(), singleEvents: "true", showDeleted: "true", maxResults: "250", orderBy: "startTime" });
    if (pageToken) params.set("pageToken", pageToken);
    const r = await call<{ items?: GcalEvent[]; nextPageToken?: string }>(`/calendars/${encodeURIComponent(calendarId)}/events?${params}`, { method: "GET" }, fetchImpl);
    if (!r.ok) return null;
    out.push(...(r.body.items ?? []));
    pageToken = r.body.nextPageToken ?? null;
    if (!pageToken) break;
  }
  return out;
}

export type NewCalendarEvent = { summary: string; description?: string; location?: string; start: Date; end: Date; lessonId: string };

export async function insertCalendarEvent(calendarId: string, ev: NewCalendarEvent, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const r = await call<{ id?: string }>(
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: "POST",
      body: JSON.stringify({
        summary: ev.summary,
        description: ev.description,
        location: ev.location,
        start: { dateTime: ev.start.toISOString() },
        end: { dateTime: ev.end.toISOString() },
        extendedProperties: { private: { [KICKSMASH_TAG]: ev.lessonId } },
        reminders: { useDefault: true },
      }),
    },
    fetchImpl,
  );
  return r.ok ? (r.body.id ?? null) : null;
}

export async function deleteCalendarEvent(calendarId: string, eventId: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const r = await call<undefined>(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: "DELETE" }, fetchImpl);
  return r.ok || r.status === 404 || r.status === 410;
}

/** Start and end instants of an event; all-day events span their dates in UTC (good enough for a block). */
export function eventSpan(ev: GcalEvent): { start: Date; end: Date } | null {
  const s = ev.start?.dateTime ?? (ev.start?.date ? `${ev.start.date}T00:00:00Z` : null);
  const e = ev.end?.dateTime ?? (ev.end?.date ? `${ev.end.date}T00:00:00Z` : null);
  if (!s || !e) return null;
  const start = new Date(s);
  const end = new Date(e);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null;
  return { start, end };
}

export const isOurs = (ev: GcalEvent): string | null => ev.extendedProperties?.private?.[KICKSMASH_TAG] ?? null;
