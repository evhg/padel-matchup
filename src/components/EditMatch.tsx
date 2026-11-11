"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition, type ReactNode } from "react";
import { updateEventAction } from "@/actions/events";
import { editErrorKey, editPatch, noBookingLink, shownStart } from "@/lib/editMatchForm";
import { EventFields, type EventFormValues } from "./EventFields";
import type { VenueOption } from "./VenueCombobox";

/**
 * The "Edit match" button and the form behind it. The organiser has it inside their tools; every
 * player with a seat has it too (`canEditMatchDetails`), because whoever books the court is often
 * not whoever made the match. `beside` sits next to the button when the form is shut - the
 * organiser's Cancel match. `startLocked`: the match has started and this viewer is not the organiser
 * (`mayMoveStart`), so the day, the time and the zone show and do not change, and one line says why.
 * `playerFields`: a seated player who is not the organiser, so the form holds only the fields a player
 * may change (`PLAYER_EDIT_FIELDS`, the owner's decision of 9 November 2026).
 */
export function EditMatch({ code, initial, venues, beside, startLocked = false, playerFields = false }: { code: string; initial: EventFormValues; venues: VenueOption[]; beside?: ReactNode; startLocked?: boolean; playerFields?: boolean }) {
  const t = useTranslations();
  const [values, setValues] = useState<EventFormValues>(initial);
  // The page's values when the form opened: a save sends only what the person changed since (`editPatch`).
  const [opened, setOpened] = useState<EventFormValues>(initial);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bookingError, setBookingError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  // A locked viewer's day, time and zone are the page's own, never older ones the form kept (`shownStart`).
  const shown = shownStart(values, initial, startLocked);

  // Open and Cancel both start from what the page shows now: an edit left behind never comes back with the next open.
  const openForm = () => {
    setValues(initial);
    setOpened(initial);
    setError(null);
    setOpen(true);
  };
  const cancel = () => {
    setValues(initial);
    setError(null);
    setOpen(false);
  };

  const save = () =>
    start(async () => {
      setError(null);
      setBookingError(null);
      const r = await updateEventAction(code, editPatch(values, opened, startLocked));
      if (!r.ok) {
        if (noBookingLink(r)) setBookingError(t("create.bookingUrlNoLink"));
        else setError(t(editErrorKey(r)));
        return;
      }
      setOpen(false);
    });

  if (open)
    return (
      <div className="flex flex-col gap-4 animate-pop">
        <h3 className="font-extrabold">{t("creator.edit")}</h3>
        <EventFields values={shown} onChange={(p) => setValues((v) => ({ ...v, ...p }))} venues={venues} showType={false} startLocked={startLocked} bookingError={bookingError} playerFields={playerFields} />
        {error && <p className="text-sm font-semibold text-danger">{error}</p>}
        <div className="flex gap-2">
          <button type="button" className="btn-primary flex-1" disabled={pending} onClick={save}>
            {pending ? t("common.saving") : t("creator.saveChanges")}
          </button>
          <button type="button" className="btn-ghost" onClick={cancel}>
            {t("common.cancel")}
          </button>
        </div>
      </div>
    );
  return (
    <div className="flex flex-wrap gap-2">
      <button type="button" className="btn-ghost btn-sm" onClick={openForm}>
        ✎ {t("creator.edit")}
      </button>
      {beside}
    </div>
  );
}
