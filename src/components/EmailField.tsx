"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { setEmailNotificationsAction, updateMyEmail } from "@/actions/identity";
import { setCreatorEmailAction, setCreatorEmailNotificationsAction } from "@/actions/events";
import { RestoreWithEmail } from "./RestoreWithEmail";

/**
 * Decision 9: email is optional, never required, and always explained with the
 * reward note next to the field.
 */
export function EmailField({
  initial,
  mode,
  code,
  title,
  help,
  emailEnabled,
  notifyOn = true,
}: {
  initial: string | null;
  mode: "me" | "creator";
  code: string;
  title?: string;
  help?: string;
  emailEnabled: boolean;
  /** Activity emails switch (on by default once an email exists). */
  notifyOn?: boolean;
}) {
  const t = useTranslations();
  const [email, setEmail] = useState(initial ?? "");
  const [saved, setSaved] = useState(false);
  const [knownElsewhere, setKnownElsewhere] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [editing, setEditing] = useState(!initial);
  const [notify, setNotify] = useState(notifyOn);
  const [pending, start] = useTransition();
  const toggleNotify = () => {
    const next = !notify;
    setNotify(next);
    start(async () => {
      const r = mode === "creator" ? await setCreatorEmailNotificationsAction(code, next) : await setEmailNotificationsAction(next);
      if (!r.ok) setNotify(!next);
    });
  };
  if (!emailEnabled) return null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      if (mode === "creator") {
        const r = await setCreatorEmailAction(code, email);
        if (r.ok) {
          setSaved(true);
          setEditing(!email);
        }
        return;
      }
      const r = await updateMyEmail(email, code);
      if (r.ok) {
        setSaved(true);
        setEditing(!email);
        setKnownElsewhere(r.data.knownElsewhere);
      }
    });
  };

  const restoreBlock = saved && knownElsewhere && (
    <div className="rounded-2xl bg-bg p-3">
      <p className="text-sm text-muted">{t("identity.knownElsewhere")}</p>
      {restoring ? (
        <div className="mt-2">
          <RestoreWithEmail initialEmail={email} compact />
        </div>
      ) : (
        <button type="button" className="mt-1 text-sm link" onClick={() => setRestoring(true)}>
          {t("identity.restoreIt")} →
        </button>
      )}
    </div>
  );

  // Known email: show it, never ask again. Edit on demand.
  if (!editing) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-bold uppercase tracking-wider text-faint">{t("event.yourEmail")}</div>
            <div className="truncate font-semibold">✉️ {email}</div>
            {saved && <p className="text-sm font-semibold text-ok">{mode === "creator" ? t("share.emailSaved") : t("event.emailSaved")}</p>}
          </div>
          <button type="button" className="btn-ghost btn-sm shrink-0" onClick={() => setEditing(true)}>
            {t("common.edit")}
          </button>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-muted">{mode === "creator" ? t("creator.notifications") : t("event.notifyMe")}</span>
          <button
            type="button"
            role="switch"
            aria-checked={notify}
            aria-label={mode === "creator" ? t("creator.notifications") : t("event.notifyMe")}
            onClick={toggleNotify}
            className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition ${notify ? "bg-ink" : "bg-line-strong"}`}
          >
            <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transition ${notify ? "translate-x-6" : "translate-x-1"}`} />
          </button>
        </div>
        {restoreBlock}
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <span aria-hidden className="mt-0.5 inline-grid h-6 w-6 shrink-0 place-items-center rounded-full bg-court-soft text-court text-xs font-black">
          i
        </span>
        <div>
          {title && <div className="font-bold">{title}</div>}
          <p className="text-sm text-muted">{help ?? t("event.emailReward")}</p>
        </div>
      </div>
      <div className="flex gap-2">
        <input
          type="email"
          inputMode="email"
          autoComplete="email"
          className="input"
          placeholder={t("share.emailPlaceholder")}
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setSaved(false);
            setKnownElsewhere(false);
            setRestoring(false);
          }}
        />
        <button type="submit" className="btn-secondary shrink-0" disabled={pending || (!email && !initial)}>
          {pending ? "…" : t("common.save")}
        </button>
        {initial && (
          <button
            type="button"
            className="btn-ghost shrink-0"
            onClick={() => {
              setEmail(initial);
              setEditing(false);
            }}
          >
            {t("common.cancel")}
          </button>
        )}
      </div>
      {saved && <p className="text-sm font-semibold text-ok">{mode === "creator" ? t("share.emailSaved") : email ? t("event.emailSaved") : t("event.emailSavedNoMail")}</p>}
      {restoreBlock}
    </form>
  );
}
