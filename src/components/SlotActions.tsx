"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { attachHeldRecordAction, removeAction } from "@/actions/slots";
import { ShareButtons } from "./ShareSheet";

export function SlotActions({
  code,
  slotId,
  kind,
  name,
  inviteUrl,
  phone,
  forwardText,
  nudgeText,
  stale,
  defaultOpen = false,
  emailedTo = null,
  keepRecord = null,
}: {
  code: string;
  slotId: string;
  kind: "invited" | "member";
  name: string;
  inviteUrl?: string;
  phone?: string | null;
  forwardText?: string;
  nudgeText?: string;
  stale?: boolean;
  /** Just reserved: show the forward buttons right away, no extra tap. */
  defaultOpen?: boolean;
  /** The invite went out by email to this address. */
  emailedTo?: string | null;
  /**
   * A place held by name, and the organiser played with one record of that name: "Keep Danny's
   * matches" hands the place that record, so the personal link signs Danny in as it (the owner, 11
   * October 2026: "Yes, keep the record"). The name, never an id: the server finds the record again.
   */
  keepRecord?: string | null;
}) {
  const t = useTranslations();
  const [open, setOpen] = useState(defaultOpen);
  const [pending, start] = useTransition();

  const remove = () => {
    const msg = kind === "invited" ? t("creator.cancelInviteConfirm", { name }) : t("creator.removeConfirm", { name });
    if (!confirm(msg)) return;
    start(async () => {
      await removeAction(code, slotId);
    });
  };

  const keep = () =>
    start(async () => {
      await attachHeldRecordAction(code, slotId);
    });

  return (
    <div className="mt-2 flex flex-col gap-2">
      {emailedTo && <div className="text-sm font-semibold text-ok">✓ {t("creator.inviteEmailed", { email: emailedTo })}</div>}
      <div className="flex flex-wrap gap-2">
        {kind === "invited" && inviteUrl && (
          <button type="button" className={`btn-xs ${stale ? "btn-primary" : "btn-secondary"}`} onClick={() => setOpen((o) => !o)}>
            {stale ? t("creator.nudge") : t("creator.forward")}
          </button>
        )}
        {kind === "invited" && keepRecord && (
          <button type="button" className="btn-ghost btn-xs" disabled={pending} onClick={keep} data-testid="keep-record">
            {t("creator.keepRecord", { name: keepRecord })}
          </button>
        )}
        <button type="button" className="btn-danger btn-xs" disabled={pending} onClick={remove}>
          {kind === "invited" ? t("creator.cancelInvite") : t("creator.remove")}
        </button>
      </div>
      {open && inviteUrl && (
        <div className="rounded-2xl bg-bg p-3 animate-pop">
          <div className="mb-2 text-sm font-bold">{t("creator.sendTheirLink")}</div>
          <ShareButtons url={inviteUrl} text={(stale ? nudgeText : forwardText) ?? inviteUrl} phone={phone} size="sm" />
        </div>
      )}
    </div>
  );
}
