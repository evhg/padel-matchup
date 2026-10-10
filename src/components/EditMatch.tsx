"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition, type ReactNode } from "react";
import { updateEventAction } from "@/actions/events";
import { EventFields, type EventFormValues } from "./EventFields";
import type { VenueOption } from "./VenueCombobox";

/**
 * The "Edit match" button and the form behind it. The organiser has it inside their tools; every
 * player with a seat has it too (`canEditMatchDetails`), because whoever books the court is often
 * not whoever made the match. `beside` sits next to the button when the form is shut - the
 * organiser's Cancel match.
 */
export function EditMatch({ code, initial, venues, beside }: { code: string; initial: EventFormValues; venues: VenueOption[]; beside?: ReactNode }) {
  const t = useTranslations();
  const [values, setValues] = useState<EventFormValues>(initial);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const save = () =>
    start(async () => {
      setError(null);
      const r = await updateEventAction(code, {
        title: values.title,
        date: values.date,
        time: values.time,
        durationMinutes: values.durationMinutes,
        tz: values.tz,
        venueName: values.venueName,
        venueMapUrl: values.venueMapUrl,
        court: values.court,
        note: values.note,
        whenFull: values.whenFull,
        // Only a changed field: round 1 can leave a tournament at ten, which is no new capacity to check.
        capacity: values.type === "tournament" && values.capacity !== initial.capacity ? values.capacity : undefined,
        levelMin: values.levelMin,
        levelMax: values.levelMax,
        levelVerifiedOnly: values.levelVerifiedOnly,
        category: values.category,
        ageMin: values.ageMin,
        publicListing: values.publicListing,
        bookingUrl: values.bookingUrl,
        cost: values.cost,
        payNote: values.payNote,
      });
      if (!r.ok) {
        setError(t("errors.invalid"));
        return;
      }
      setOpen(false);
    });

  if (open)
    return (
      <div className="flex flex-col gap-4 animate-pop">
        <h3 className="font-extrabold">{t("creator.edit")}</h3>
        <EventFields values={values} onChange={(p) => setValues((v) => ({ ...v, ...p }))} venues={venues} showType={false} />
        {error && <p className="text-sm font-semibold text-danger">{error}</p>}
        <div className="flex gap-2">
          <button type="button" className="btn-primary flex-1" disabled={pending} onClick={save}>
            {pending ? t("common.saving") : t("creator.saveChanges")}
          </button>
          <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
            {t("common.cancel")}
          </button>
        </div>
      </div>
    );
  return (
    <div className="flex flex-wrap gap-2">
      <button type="button" className="btn-ghost btn-sm" onClick={() => setOpen(true)}>
        ✎ {t("creator.edit")}
      </button>
      {beside}
    </div>
  );
}
