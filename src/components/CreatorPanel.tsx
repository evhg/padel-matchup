"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { cancelEventAction, setBanterAction } from "@/actions/events";
import { EmailField } from "./EmailField";
import { EditMatch } from "./EditMatch";
import type { EventFormValues } from "./EventFields";
import { CopyButton, ShareButtons } from "./ShareSheet";
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
  groupInvite,
}: {
  code: string;
  initial: EventFormValues;
  venues: VenueOption[];
  creatorEmail: string | null;
  creatorNotify: boolean;
  /** Banter on the organiser's matches (`players.banter`): one tap turns it off, one turns it on again. */
  banter: boolean;
  emailEnabled: boolean;
  manageUrl: string;
  isCancelled: boolean;
  groupInvite: { text: string; count: number; url: string } | null;
}) {
  const t = useTranslations();
  const [pending, start] = useTransition();
  const [banter, setBanter] = useState(banterInitial);
  const toggleBanter = () => {
    const next = !banter;
    setBanter(next);
    start(async () => {
      const r = await setBanterAction(code, next);
      if (!r.ok) setBanter(!next);
    });
  };

  const cancel = () => {
    if (!confirm(t("creator.cancelEventConfirm"))) return;
    start(async () => {
      await cancelEventAction(code);
    });
  };

  return (
    <section className="card border-ink/15">
      <div className="flex items-center gap-2">
        <span className="chip bg-ink text-on-ink">{t("common.organizer")}</span>
        <h2 className="text-lg font-extrabold">{t("creator.tools")}</h2>
      </div>

      {!isCancelled && groupInvite && groupInvite.count > 1 && (
        <div className="mt-4 border-t border-line pt-4">
          <div className="font-bold">{t("creator.inviteAll")}</div>
          <p className="mb-2 text-sm text-muted">{t("creator.inviteAllHelp")}</p>
          <ShareButtons url={groupInvite.url} text={groupInvite.text} size="sm" />
        </div>
      )}

      {emailEnabled && (
        <div className="mt-4 border-t border-line pt-4">
          <EmailField initial={creatorEmail} mode="creator" code={code} title={t("creator.notifications")} help={t("share.emailHelp")} emailEnabled={emailEnabled} notifyOn={creatorNotify} />
        </div>
      )}

      {!isCancelled && (
        <div className="mt-4 flex items-center justify-between gap-3 border-t border-line pt-4">
          <div className="min-w-0">
            <div className="font-bold">{t("creator.banter")}</div>
            <p className="text-sm text-muted">{t("creator.banterHelp")}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={banter}
            aria-label={t("creator.banter")}
            onClick={toggleBanter}
            data-testid="banter-switch"
            className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition ${banter ? "bg-ink" : "bg-line-strong"}`}
          >
            <span className={`inline-block h-5 w-5 rounded-full bg-on-ink shadow transition ${banter ? "translate-x-6" : "translate-x-1"}`} />
          </button>
        </div>
      )}

      {!isCancelled && (
        <div className="mt-4 border-t border-line pt-4">
          <EditMatch
            code={code}
            initial={initial}
            venues={venues}
            beside={
              <button type="button" className="btn-danger btn-sm" disabled={pending} onClick={cancel}>
                {t("creator.cancelEvent")}
              </button>
            }
          />
        </div>
      )}

      <div className="mt-4 border-t border-line pt-4">
        <h3 className="font-extrabold">{t("creator.manageLinkTitle")}</h3>
        <p className="mt-0.5 text-sm text-muted">{t("share.manageHint")}</p>
        <div className="mt-2 flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-xl bg-bg px-3 py-2.5 text-xs">{manageUrl}</code>
          <CopyButton value={manageUrl} label={t("common.copy")} className="btn-ghost btn-sm" />
        </div>
      </div>
    </section>
  );
}
