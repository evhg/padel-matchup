"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { setCourtBookedAction } from "@/actions/slots";
import { errorLine } from "@/lib/errorLine";

/**
 * The court on the match page: "Book this court" for the organiser and the players, the chosen day,
 * hour, length and court beside it, and "I booked it" once a player has booked and paid in the club's
 * own app (DECIDING rule 36). Booked, everyone reads "Court booked ✓ (by Ana)", and a player can take it
 * back with "Undo" ("Undo: mark the court as not booked"). The link opens in the player's browser; it
 * carries nobody's identity and signs nobody in.
 *
 * `book.checkout` is the platform's name when the link is its checkout, filled in (the owner, 11 October
 * 2026, "Playtomic checkout, filled"): the button says "Book and pay on Playtomic", the one place the
 * platform is named (the owner the same day: "the name shows only at the booking step"), and one line
 * says the platform may ask for its sign-in first, because its sign-in page shows no court and no time.
 * Only "may": a player signed in there already skips it, and nobody saw what the platform shows after
 * its sign-in (review, 11 October 2026).
 */
export function CourtBooking({ code, book, slotLine, booked, canMark }: { code: string; book: { url: string; checkout: string | null } | null; slotLine: string; booked: { name: string | null } | null; canMark: boolean }) {
  const t = useTranslations("event");
  const tr = useTranslations();
  const [pending, start] = useTransition();
  // "I booked it" and "Undo" say why when they are refused (`errors.<code>`), never nothing.
  const [error, setError] = useState<string | null>(null);
  const mark = (v: boolean) => {
    setError(null);
    start(async () => {
      const r = await setCourtBookedAction(code, v);
      if (!r.ok) setError(tr(`errors.${errorLine(r.error)}`));
    });
  };
  const said = error && (
    <p className="basis-full text-sm font-semibold text-danger" role="status">
      {error}
    </p>
  );

  if (booked) {
    return (
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3" data-testid="court-booked">
        <span className="text-[0.9375rem] font-bold text-ok">{booked.name ? t("courtBookedBy", { name: booked.name }) : t("courtBooked")}</span>
        {/* An action that says what it does, never a second status beside the first: "Not booked" beside
            "Court booked ✓" read as two states (the owner, 12 October 2026). Any player may still undo it.
            Its name starts with the words it shows, so "tap Undo" finds it by voice (WCAG 2.5.3), and in
            Russian it takes the mark off ("Снять отметку"): "Отменить" read as cancelling the booking. */}
        {canMark && (
          <button type="button" className="min-h-11 shrink-0 px-1 text-[0.9375rem] text-court" disabled={pending} onClick={() => mark(false)} aria-label={t("courtBookedUndoName")} title={t("courtBookedUndoName")} data-testid="court-booked-undo">
            {t("courtBookedUndoMark")}
          </button>
        )}
        {said}
      </div>
    );
  }
  if (!canMark) return null;
  return (
    // One row of the hero, under a hairline, as a row of the iPhone's Settings: what to do on the left, the
    // action on the right. It was a box with a border inside the card, with a bordered button and a footnote
    // beside it, and the owner, 24 November 2026: "'I've booked it' looks like it has no design thought at all".
    <div className="mt-4 border-t border-line pt-3" data-testid="court-booking">
      {book && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span className="text-[0.9375rem] tabular-nums text-muted" data-testid="book-slot">
            {slotLine}
          </span>
          <a href={book.url} target="_blank" rel="noopener noreferrer" className="btn-secondary btn-sm" data-testid="book-court">
            {book.checkout ? t("bookAndPayOn", { platform: book.checkout }) : t("bookCourt")}
          </a>
          {book.checkout && (
            <span className="basis-full text-xs text-muted" data-testid="book-checkout-hint">
              {t("checkoutSignIn", { platform: book.checkout })}
            </span>
          )}
        </div>
      )}
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 text-[0.9375rem] text-muted">{t("bookYourself")}</span>
        <button type="button" className="btn-secondary btn-sm shrink-0" disabled={pending} onClick={() => mark(true)} data-testid="court-booked-mark">
          {t("bookedIt")}
        </button>
      </div>
      {said}
    </div>
  );
}
