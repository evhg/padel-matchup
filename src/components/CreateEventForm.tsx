"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, useTransition } from "react";
import { createEventAction } from "@/actions/events";
import { nextOccurrence, tomorrowAt } from "@/lib/dates";
import { EventFields, type EventFormValues, type TimePatternInput } from "./EventFields";
import type { VenueOption } from "./VenueCombobox";

export function CreateEventForm({
  defaultTz,
  tzFromHeader,
  venues,
  hasIdentity,
  patterns = [],
  hasLevel = false,
  initialType = "match",
  initialCapacity,
  groupCode,
  initialValues,
}: {
  defaultTz: string;
  tzFromHeader: boolean;
  venues: VenueOption[];
  hasIdentity: boolean;
  /** The organizer's usual weekday/time slots (quick picks + default). */
  patterns?: TimePatternInput[];
  /** The organizer already has a level (a range then doesn't ask for theirs). */
  hasLevel?: boolean;
  /** Prefill from the URL (the americano generator links here). */
  initialType?: "match" | "tournament";
  initialCapacity?: number;
  /** Creating the next match of a group: its members get notified. */
  groupCode?: string;
  /** Field overrides (a group's usual settings). */
  initialValues?: Partial<EventFormValues>;
}) {
  const t = useTranslations();
  // Default to the organizer's most usual slot; tomorrow 18:00 only for first-timers.
  const defaultFor = (tz: string) => (patterns[0] ? nextOccurrence(patterns[0].dow, patterns[0].time, tz) : tomorrowAt(tz));
  const initial = defaultFor(defaultTz);
  const cap = initialCapacity && Number.isInteger(initialCapacity) && initialCapacity >= 4 && initialCapacity <= 64 && initialCapacity % 4 === 0 ? initialCapacity : 8;
  const [values, setValues] = useState<EventFormValues>({
    type: initialType,
    title: "",
    date: initial.date,
    time: initial.time,
    tz: defaultTz,
    venueName: venues[0]?.name ?? "",
    venueMapUrl: venues[0]?.mapUrl ?? "",
    court: "",
    note: "",
    capacity: cap,
    whenFull: "waitlist",
    courts: null,
    pointsPerMatch: null,
    levelMin: null,
    levelMax: null,
    myLevel: null,
    publicListing: false,
    bookingUrl: "",
    ...initialValues,
  });
  const touched = useRef(Boolean(initialValues?.date));
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // No Vercel geo header (local dev / non-Vercel host): fall back to the browser's zone.
  useEffect(() => {
    if (tzFromHeader || touched.current) return;
    try {
      const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (browserTz && browserTz !== defaultTz) {
        const d = defaultFor(browserTz);
        setValues((v) => ({ ...v, tz: browserTz, date: d.date, time: d.time }));
      }
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tzFromHeader, defaultTz]);

  const onChange = (patch: Partial<EventFormValues>) => {
    touched.current = true;
    setValues((v) => ({ ...v, ...patch }));
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!hasIdentity && !name.trim()) return setError(t("identity.nameRequired"));
    start(async () => {
      const r = await createEventAction({
        name: hasIdentity ? undefined : name,
        type: values.type,
        title: values.title || undefined,
        date: values.date,
        time: values.time,
        tz: values.tz,
        venueName: values.venueName || undefined,
        venueMapUrl: values.venueMapUrl || undefined,
        court: values.court || undefined,
        note: values.note || undefined,
        capacity: values.type === "tournament" ? values.capacity : undefined,
        whenFull: values.whenFull,
        courts: values.type === "tournament" ? values.courts : null,
        pointsPerMatch: values.type === "tournament" ? values.pointsPerMatch : null,
        levelMin: values.levelMin,
        levelMax: values.levelMax,
        myLevel: values.myLevel,
        groupCode,
        publicListing: values.publicListing,
        bookingUrl: values.bookingUrl || undefined,
      });
      // On success the action redirects to the share screen.
      if (r && !r.ok) setError(r.error === "invalid" ? t("create.errDate") : r.error === "name_required" ? t("identity.nameRequired") : t("common.somethingWrong"));
    });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      {!hasIdentity && (
        <div className="card bg-accent-soft border-accent">
          <label className="label text-ink">{t("identity.whatsYourName")}</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("identity.namePlaceholder")} autoComplete="given-name" maxLength={40} />
          <p className="mt-1.5 text-sm text-muted">{t("identity.nameHelp")}</p>
        </div>
      )}
      <div className="card">
        <EventFields values={values} onChange={onChange} venues={venues} patterns={patterns} hasLevel={hasLevel} />
      </div>
      {error && <p className="text-sm font-semibold text-danger">{error}</p>}
      <button type="submit" className="btn-primary w-full text-lg" disabled={pending}>
        {pending ? t("create.creating") : t("create.submit")}
      </button>
    </form>
  );
}
