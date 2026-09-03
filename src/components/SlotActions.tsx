"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { removeAction } from "@/actions/slots";
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
}) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();

  const remove = () => {
    const msg = kind === "invited" ? t("creator.cancelInviteConfirm", { name }) : t("creator.removeConfirm", { name });
    if (!confirm(msg)) return;
    start(async () => {
      await removeAction(code, slotId);
    });
  };

  return (
    <div className="mt-2 flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {kind === "invited" && inviteUrl && (
          <button type="button" className={`btn-xs ${stale ? "btn-primary" : "btn-secondary"}`} onClick={() => setOpen((o) => !o)}>
            {stale ? t("creator.nudge") : t("creator.forward")}
          </button>
        )}
        <button type="button" className="btn-danger btn-xs" disabled={pending} onClick={remove}>
          {kind === "invited" ? t("creator.cancelInvite") : t("creator.remove")}
        </button>
      </div>
      {open && inviteUrl && (
        <div className="rounded-2xl bg-bg p-3 animate-pop">
          <ShareButtons url={inviteUrl} text={(stale ? nudgeText : forwardText) ?? inviteUrl} phone={phone} size="sm" />
        </div>
      )}
    </div>
  );
}
