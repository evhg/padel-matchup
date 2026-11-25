"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition, type ReactNode } from "react";
import { cancelEventAction, setBanterAction } from "@/actions/events";
import { leaveAction } from "@/actions/slots";
import { errorLine } from "@/lib/errorLine";
import { EmailField } from "./EmailField";
import { EditMatch } from "./EditMatch";
import { PasteNames } from "./PasteNames";
import type { PastView } from "@/lib/domain/pastAsk";
import type { EventFormValues } from "./EventFields";
import { CopyButton } from "./ShareSheet";
import type { VenueOption } from "./VenueCombobox";

export function CreatorPanel({
  code,
  initial,
  venues,
  creatorEmail,
  creatorNotify,
  banter: banterInitial,
  emailEnabled,
  manageUrl,
  isCancelled,
  isOver = false,
  paste = null,
  leave = null,
  listOnBoard = null,
}: {
  code: string;
  initial: EventFormValues;
  venues: VenueOption[];
  creatorEmail: string | null;
  creatorNotify: boolean;
  /** Banter on the organiser's matches (`players.banter`): one tap turns it off, one turns it on again. */
  banter: boolean;
  emailEnabled: boolean;
  /** Null for a session by name that proved nothing (`manageUrlFor`): the link is a lasting credential. */
  manageUrl: string | null;
  isCancelled: boolean;
  /** The match is over: it can no longer be called off (`cancelEvent` refuses it), so "Cancel match" is not offered. */
  isOver?: boolean;
  /** The names already in the match and the open spots, while there are any: "Paste the names from the group". */
  /** `past`: the organiser's past players as names, days and clubs, for "Is this Danny…?" before a pasted name is held. */
  paste?: { namesHere: readonly string[]; spots: number; past?: readonly PastView[] } | null;
  /**
   * The organiser's own seat, before the match: "Give up my place" (the owner, 9 November 2026: the
   * organiser's "Leave" moves out of the bottom bar, which carries the one share). `question` is the
   * confirmation the bar's Leave asked, worded on the page (a fixed-pairs night names the partner).
   */
  leave?: { question: string } | null;
  /** "Show on the … board", the one tap onto the venue's board, while the match is not listed (`ListOnBoard`). */
  listOnBoard?: ReactNode;
}) {
  const t = useTranslations();
  const [pending, start] = useTransition();
  const [banter, setBanter] = useState(banterInitial);
  // A refused banter switch or cancel says why, under its own control (`errors.<code>`).
  const [banterError, setBanterError] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const giveUp = () => {
    if (!leave || !confirm(leave.question)) return;
    setLeaveError(null);
    start(async () => {
      const r = await leaveAction(code);
      if (!r.ok) setLeaveError(t(`errors.${errorLine(r.error)}`));
    });
  };
  const toggleBanter = () => {
    const next = !banter;
    setBanter(next);
    setBanterError(null);
    start(async () => {
      const r = await setBanterAction(code, next);
      if (!r.ok) {
        setBanter(!next);
        setBanterError(t(`errors.${errorLine(r.error)}`));
      }
    });
  };

  const cancel = () => {
    if (!confirm(t("creator.cancelEventConfirm"))) return;
    setCancelError(null);
    start(async () => {
      const r = await cancelEventAction(code);
      if (!r.ok) setCancelError(t(`errors.${errorLine(r.error)}`));
    });
  };

  return (
    // The tools an organiser uses often stay open (paste the names, edit, cancel); the ones a match needs once,
    // if ever, wait behind one "More" row (the owner, 25 November 2026: "If you need to explain things with
    // sentences you have failed in making the ui intuitive"). Their help sentences went; the manage link keeps
    // its one line, because it warns that the link is a key.
    <section className="card">
      <h2 className="text-lg font-extrabold">{t("creator.tools")}</h2>
      {listOnBoard && <div className="mt-3">{listOnBoard}</div>}

      {!isCancelled && paste && paste.spots > 0 && <PasteNames code={code} namesHere={paste.namesHere} spots={paste.spots} past={paste.past} />}

      {!isCancelled && (
        <div className="mt-4 border-t border-line pt-4">
          <EditMatch
            code={code}
            initial={initial}
            venues={venues}
            beside={
              isOver ? undefined : (
                <button type="button" className="btn-danger btn-sm" disabled={pending} onClick={cancel}>
                  {t("creator.cancelEvent")}
                </button>
              )
            }
          />
          {cancelError && <p className="mt-2 text-sm font-semibold text-danger">{cancelError}</p>}
        </div>
      )}

      <details className="group mt-4 border-t border-line pt-1" data-testid="organiser-more">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3">
          <span className="text-[0.9375rem]">{t("common.more")}</span>
          <span className="shrink-0 text-faint transition group-open:rotate-90" aria-hidden>
            ›
          </span>
        </summary>
        {emailEnabled && (
          <div className="mt-4 border-t border-line pt-4">
            {/* The one email switch for the organiser (the owner, 9 November 2026). Keyed by the address, so an email saved elsewhere on the page (Stay updated) shows here as the switch at once. */}
            <EmailField key={creatorEmail ?? ""} initial={creatorEmail} mode="creator" code={code} title={t("creator.notifications")} help="" emailEnabled={emailEnabled} notifyOn={creatorNotify} />
          </div>
        )}

        {!isCancelled && (
          <div className="mt-4 flex items-center justify-between gap-3 border-t border-line pt-4">
            <div className="min-w-0 font-bold">{t("creator.banter")}</div>
            <button
              type="button"
              role="switch"
              aria-checked={banter}
              aria-label={t("creator.banter")}
              onClick={toggleBanter}
              data-testid="banter-switch"
              className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition ${banter ? "bg-ink" : "bg-line-strong"}`}
            >
              <span className={`inline-block h-5 w-5 rounded-full shadow transition ${banter ? "translate-x-6 bg-on-ink" : "translate-x-1 bg-knob-off"}`} />
            </button>
          </div>
        )}
        {!isCancelled && banterError && <p className="mt-1 text-sm font-semibold text-danger">{banterError}</p>}

        {!isCancelled && leave && (
          <div className="mt-4 flex items-center justify-between gap-3 border-t border-line pt-4" data-testid="organiser-leave">
            <button type="button" className="btn-ghost btn-sm shrink-0 px-0" disabled={pending} onClick={giveUp}>
              {t("creator.leaveSeat")}
            </button>
          </div>
        )}
        {leaveError && <p className="mt-1 text-sm font-semibold text-danger">{leaveError}</p>}

        {manageUrl && (
          <div className="mt-4 border-t border-line pt-4">
            <h3 className="font-extrabold">{t("creator.manageLinkTitle")}</h3>
            <p className="mt-0.5 text-sm text-muted">{t("share.manageHint")}</p>
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-xl bg-bg px-3 py-2.5 text-xs">{manageUrl}</code>
              <CopyButton value={manageUrl} label={t("common.copy")} className="btn-ghost btn-sm" />
            </div>
          </div>
        )}
      </details>
    </section>
  );
}
