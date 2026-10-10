"use client";

import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { setCourtBookedAction } from "@/actions/slots";

/**
 * The court on the match page: "Book this court" for the organiser and the players, the chosen day,
 * hour, length and court beside it, and "I booked it" once a player has booked and paid in the club's
 * own app (DECIDING rule 34). Booked, everyone reads "Court booked ✓ (by Ana)", and a player can take it
 * back. The link opens in the player's browser; it carries nobody's identity and signs nobody in.
 */
export function CourtBooking({ code, book, slotLine, booked, canMark }: { code: string; book: { url: string; checkout: boolean } | null; slotLine: string; booked: { name: string | null } | null; canMark: boolean }) {
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
            🎟 {book.checkout ? t("bookAndPay") : t("bookCourt")}
          </a>
          <span className="text-sm font-semibold tabular-nums text-muted" data-testid="book-slot">
            {slotLine}
          </span>
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
