"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { readBookingAction } from "@/actions/events";

/**
 * "Booked already? Paste it": the landing page's door for a court already booked in a platform's app
 * (the owner, 11 October 2026: "how do I turn this into a match and match card/link by just copy and
 * pasting the link?"). One quiet line beside "Find a game"; a tap opens one box under it for the link,
 * the share text or both, and "Read my booking" sends it to `readBookingAction` and opens the create
 * form filled with what the booking said (`bookingHref`). Nothing is created until the organiser taps
 * the form's own button. A paste is one request: thirty a day from one address, and at most one read
 * of the pasted link (DECIDING rule 35).
 *
 * No `<form>`: this sits beside the create form, and a form inside a form is the bug that once left
 * the landing page's way back in dead (e2e/core.mjs counts nested forms).
 */
export function PasteBooking({ max }: { max: number }) {
  const t = useTranslations("landing");
  const router = useRouter();
  const box = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const read = () => {
    setNote(null);
    if (!text.trim()) return setNote(t("pasteEmpty"));
    start(async () => {
      const zone = (() => {
        try {
          return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
        } catch {
          return undefined;
        }
      })();
      const r = await readBookingAction({ text, tz: zone }).catch(() => null);
      if (!r) return setNote(t("pasteFailed"));
      if (!r.ok) return setNote(r.reason === "limit" ? t("pasteLimit") : t("pasteEmpty"));
      setOpen(false);
      setText("");
      router.push(r.href);
    });
  };

  return (
    <>
      <button type="button" className="link text-sm font-semibold" aria-expanded={open} aria-controls={box} onClick={() => setOpen((o) => !o)} data-testid="paste-door">
        📋 {t("pasteDoor")}
      </button>
      {open && (
        <div id={box} className="card basis-full animate-pop" data-testid="paste-sheet">
          <label htmlFor={`${box}-text`} className="text-sm font-semibold">
            {t("pasteHint")}
          </label>
          <textarea id={`${box}-text`} className="textarea mt-2" rows={4} maxLength={max} value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" spellCheck={false} data-testid="paste-text" />
          {note && (
            <p className="mt-2 text-sm font-semibold text-warn" role="status" data-testid="paste-note">
              {note}
            </p>
          )}
          <button type="button" className="btn-primary mt-3 w-full" disabled={pending} onClick={read} data-testid="paste-read">
            {pending ? t("pasteReading") : t("pasteRead")}
          </button>
        </div>
      )}
    </>
  );
}
