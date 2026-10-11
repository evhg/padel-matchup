"use client";

import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { setCourtBookedAction } from "@/actions/slots";

/**
 * The court on the match page: "Book this court" for the organiser and the players, the chosen day,
 * hour, length and court beside it, and "I booked it" once a player has booked and paid in the club's
 * own app (DECIDING rule 36). Booked, everyone reads "Court booked ✓ (by Ana)", and a player can take it
 * back. The link opens in the player's browser; it carries nobody's identity and signs nobody in.
 *
 * `book.checkout` is the platform's name when the link is its checkout, filled in (the owner, 11 October
 * 2026, "Playtomic checkout, filled"): the button says "Book and pay on Playtomic", the one place the
 * platform is named (the owner the same day: "the name shows only at the booking step"), and one line
 * says the platform asks for its sign-in first, because its sign-in page shows no court and no time.
 */
export function CourtBooking({ code, book, slotLine, booked, canMark }: { code: string; book: { url: string; checkout: string | null } | null; slotLine: string; booked: { name: string | null } | null; canMark: boolean }) {
  const t = useTranslations("event");
  const [pending, start] = useTransition();
  const mark = (v: boolean) => start(async () => void (await setCourtBookedAction(code, v)));

  if (booked) {
    return (
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-ok-soft px-4 py-2.5" data-testid="court-booked">
        <span className="text-sm font-bold text-ok">{booked.name ? t("courtBookedBy", { name: booked.name }) : t("courtBooked")}</span>
        {canMark && (
          <button type="button" className="btn-ghost btn-sm" disabled={pending} onClick={() => mark(false)} data-testid="court-booked-undo">
            {t("courtBookedUndo")}
          </button>
        )}
      </div>
    );
  }
  if (!canMark) return null;
  return (
    <div className="mt-3 rounded-2xl border border-line px-4 py-3" data-testid="court-booking">
      {book && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <a href={book.url} target="_blank" rel="noopener noreferrer" className="btn-secondary btn-sm" data-testid="book-court">
            🎟 {book.checkout ? t("bookAndPayOn", { platform: book.checkout }) : t("bookCourt")}
          </a>
          <span className="text-sm font-semibold tabular-nums text-muted" data-testid="book-slot">
            {slotLine}
          </span>
          {book.checkout && (
            <span className="basis-full text-xs text-muted" data-testid="book-checkout-hint">
              {t("checkoutHint", { platform: book.checkout })}
            </span>
          )}
        </div>
      )}
      <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 ${book ? "mt-2" : ""}`}>
        <button type="button" className="btn-ghost btn-sm" disabled={pending} onClick={() => mark(true)} data-testid="court-booked-mark">
          {t("bookedIt")}
        </button>
        <span className="text-xs text-muted">{t("bookYourself")}</span>
      </div>
    </div>
  );
}
