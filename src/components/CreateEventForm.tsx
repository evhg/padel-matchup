"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, useTransition } from "react";
import { createEventAction } from "@/actions/events";
import { tomorrowAt } from "@/lib/dates";
import { EventFields, type EventFormValues } from "./EventFields";
import type { VenueOption } from "./VenueCombobox";

export function CreateEventForm({
  defaultTz,
  tzFromHeader,
  venues,
  hasIdentity,
}: {
  defaultTz: string;
  tzFromHeader: boolean;
  venues: VenueOption[];
  hasIdentity: boolean;
}) {
  const t = useTranslations();
  const initial = tomorrowAt(defaultTz);
  const [values, setValues] = useState<EventFormValues>({
    type: "match",
    title: "",
    date: initial.date,
    time: initial.time,
    tz: defaultTz,
    venueName: venues[0]?.name ?? "",
    venueMapUrl: venues[0]?.mapUrl ?? "",
    note: "",
    capacity: 8,
    whenFull: "waitlist",
    courts: null,
    pointsPerMatch: null,
  });
  const touched = useRef(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // No Vercel geo header (local dev / non-Vercel host): fall back to the browser's zone.
  useEffect(() => {
    if (tzFromHeader || touched.current) return;
    try {
      const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (browserTz && browserTz !== defaultTz) {
        const d = tomorrowAt(browserTz);
        setValues((v) => ({ ...v, tz: browserTz, date: d.date, time: d.time }));
      }
    } catch {
      /* ignore */
    }
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
        note: values.note || undefined,
        capacity: values.type === "tournament" ? values.capacity : undefined,
        whenFull: values.whenFull,
        courts: values.type === "tournament" ? values.courts : null,
        pointsPerMatch: values.type === "tournament" ? values.pointsPerMatch : null,
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
        <EventFields values={values} onChange={onChange} venues={venues} />
      </div>
      {error && <p className="text-sm font-semibold text-danger">{error}</p>}
      <button type="submit" className="btn-primary w-full text-lg" disabled={pending}>
        {pending ? t("create.creating") : t("create.submit")}
      </button>
    </form>
  );
}
