"use client";

import Link from "next/link";
import { useState } from "react";
import { FeedbackForm } from "./FeedbackForm";
import type { FeedbackLabels } from "./feedbackLabels";

/**
 * "Tell us what should change" at the foot of every screen (the owner, 25 November 2026: "every screen should
 * have the Tell us what should Change like the match page has, but it actually should be larger and a call to
 * action button but work the same"). One grey button at full width: never lime, because a screen keeps its one
 * lime button for its own job (docs/DESIGN.md). The tap opens the form in place, with no navigation and no popup,
 * and the note carries the screen it was sent from (`FeedbackForm` sends the path, `screenOf` blanks any key in it).
 * It replaced the footer's small "Feedback" link and the inline doors that ten pages carried.
 */
export function FeedbackCta({
  labels,
  signedInVia,
  note,
  shipped,
}: {
  labels: FeedbackLabels;
  signedInVia: "telegram" | "none";
  /** One quiet line under the button, where a page has something to say about it (the landing page). */
  note?: string;
  /** "12 player ideas are in the app already. See what they changed", where a page counted them. */
  shipped?: { line: string; link: string };
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2" data-testid="feedback-cta">
      {open ? (
        <div className="animate-pop text-left text-base text-ink">
          <FeedbackForm signedInVia={signedInVia} labels={labels} />
        </div>
      ) : (
        <button type="button" className="btn-secondary w-full" onClick={() => setOpen(true)}>
          {labels.title}
        </button>
      )}
      {note && <p className="text-center">{note}</p>}
      {shipped && (
        <p className="text-center" data-testid="feedback-shipped">
          {shipped.line}{" "}
          <Link href="/built" prefetch={false} className="link" data-testid="feedback-built-link">
            {shipped.link}
          </Link>
        </p>
      )}
    </div>
  );
}
