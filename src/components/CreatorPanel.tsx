"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { cancelEventAction, updateEventAction } from "@/actions/events";
import { EmailField } from "./EmailField";
import { EventFields, type EventFormValues } from "./EventFields";
import { PlayAgainButton } from "./PlayAgainButton";
import { ReserveForm, type RolodexItem } from "./ReserveForm";
import { CopyButton, ShareButtons } from "./ShareSheet";
import type { VenueOption } from "./VenueCombobox";

export function CreatorPanel({
  code,
  initial,
  venues,
  rolodex,
  canReserve,
  creatorEmail,
  emailEnabled,
  manageUrl,
  inviteTextTemplate,
  isCancelled,
  groupInvite,
}: {
  code: string;
  initial: EventFormValues;
  venues: VenueOption[];
  rolodex: RolodexItem[];
  canReserve: boolean;
  creatorEmail: string | null;
  emailEnabled: boolean;
  manageUrl: string;
  inviteTextTemplate: string;
  isCancelled: boolean;
  groupInvite: { text: string; count: number; url: string } | null;
}) {
  const t = useTranslations();
  const [values, setValues] = useState<EventFormValues>(initial);
  const [editOpen, setEditOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const save = () =>
    start(async () => {
      setError(null);
      const r = await updateEventAction(code, {
        title: values.title,
        date: values.date,
        time: values.time,
        tz: values.tz,
        venueName: values.venueName,
        venueMapUrl: values.venueMapUrl,
        note: values.note,
        whenFull: values.whenFull,
        capacity: values.type === "tournament" ? values.capacity : undefined,
      });
      if (!r.ok) {
        setError(t("errors.invalid"));
        return;
      }
      setEditOpen(false);
    });

  const cancel = () => {
    if (!confirm(t("creator.cancelEventConfirm"))) return;
    start(async () => {
      await cancelEventAction(code);
    });
  };

  return (
    <section className="card border-ink/15">
      <div className="flex items-center gap-2">
        <span className="chip bg-ink text-white">{t("common.organizer")}</span>
        <h2 className="text-lg font-extrabold">{t("creator.tools")}</h2>
      </div>

      {!isCancelled && (
        <div className="mt-4 border-t border-line pt-4">
          <ReserveForm code={code} rolodex={rolodex} canReserve={canReserve} inviteTextTemplate={inviteTextTemplate} emailEnabled={emailEnabled} />
          {groupInvite && groupInvite.count > 1 && (
            <div className="mt-4 rounded-2xl bg-bg p-3">
              <div className="font-bold">{t("creator.inviteAll")}</div>
              <p className="mb-2 text-sm text-muted">{t("creator.inviteAllHelp")}</p>
              <ShareButtons url={groupInvite.url} text={groupInvite.text} size="sm" />
            </div>
          )}
        </div>
      )}

      {emailEnabled && (
        <div className="mt-4 border-t border-line pt-4">
          <EmailField initial={creatorEmail} mode="creator" code={code} title={t("creator.notifications")} help={t("share.emailHelp")} emailEnabled={emailEnabled} />
        </div>
      )}

      {!isCancelled && (
        <div className="mt-4 border-t border-line pt-4">
          {editOpen ? (
            <div className="flex flex-col gap-4 animate-pop">
              <h3 className="font-extrabold">{t("creator.edit")}</h3>
              <EventFields values={values} onChange={(p) => setValues((v) => ({ ...v, ...p }))} venues={venues} showType={false} />
              {error && <p className="text-sm font-semibold text-danger">{error}</p>}
              <div className="flex gap-2">
                <button type="button" className="btn-primary flex-1" disabled={pending} onClick={save}>
                  {pending ? t("common.saving") : t("creator.saveChanges")}
                </button>
                <button type="button" className="btn-ghost" onClick={() => setEditOpen(false)}>
                  {t("common.cancel")}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-ghost btn-sm" onClick={() => setEditOpen(true)}>
                ✎ {t("creator.edit")}
              </button>
              <button type="button" className="btn-danger btn-sm" disabled={pending} onClick={cancel}>
                {t("creator.cancelEvent")}
              </button>
            </div>
          )}
        </div>
      )}

      <div className="mt-4 border-t border-line pt-4">
        <PlayAgainButton code={code} className="btn-ghost w-full" />
      </div>

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
