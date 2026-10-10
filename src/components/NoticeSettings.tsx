"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition, type FormEvent } from "react";
import { saveNoticeSettingsAction } from "@/actions/notices";
import { hhmm, NOTICE_KINDS, type NoticeKind } from "@/lib/domain/noticeKinds";

/**
 * "Notices" on My matches: one line that says what is set ("6 of 7 on · quiet 22:00–08:00"), and
 * behind it a switch for each kind with one short line each, and quiet hours (the owner's decision D).
 * One line on the screen, so the screen keeps its budget (`docs/DECIDING.md` rule 1).
 *
 * Uncontrolled on purpose: a form a person can reach before the page is interactive keeps what they
 * ticked (`defaultChecked`), and the values are read once, on save. The browser's own zone goes with
 * them, so quiet hours mean the player's night and not the server's.
 */
export function NoticeSettings({ on, quietFrom, quietTo, summary }: { on: Record<NoticeKind, boolean>; quietFrom: number | null; quietTo: number | null; summary: string }) {
  const t = useTranslations("notices");
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState<boolean | null>(null);
  // Whole hours, and whatever is stored if it is not one (nothing writes that today, but a value the list lacks would read as "Off").
  const hours = (stored: number | null) => [...new Set([...Array.from({ length: 24 }, (_, h) => h * 60), ...(stored !== null ? [stored] : [])])].sort((a, b) => a - b);

  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setSaved(null);
    start(async () => {
      let tz = "";
      try {
        tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
      } catch {
        /* an old browser: the match's zone is used instead */
      }
      const r = await saveNoticeSettingsAction({ on: f.getAll("kind").map(String), quietFrom: String(f.get("quietFrom") ?? ""), quietTo: String(f.get("quietTo") ?? ""), tz });
      setSaved(r.ok);
    });
  };

  return (
    <details className="card" data-testid="notice-settings">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
        <span className="font-bold">{t("title")}</span>
        <span className="min-w-0 truncate text-sm text-muted" data-testid="notice-summary">
          {summary}
        </span>
      </summary>
      <form onSubmit={save} className="mt-3 flex flex-col gap-3">
        <p className="text-sm text-muted">{t("help")}</p>
        {NOTICE_KINDS.map((k) => (
          // The line sits beside the label, not in it: the label names exactly what the reader sees in bold.
          <div key={k} className="flex items-start gap-3">
            <input id={`notice-${k}`} type="checkbox" name="kind" value={k} defaultChecked={on[k]} className="mt-1 h-5 w-5 shrink-0 accent-ink" />
            <div className="min-w-0">
              <label htmlFor={`notice-${k}`} className="font-semibold">
                {t(`kind_${k}`)}
              </label>
              <p className="text-sm text-muted">{t(`line_${k}`)}</p>
            </div>
          </div>
        ))}
        <fieldset className="border-t border-line pt-3">
          <legend className="font-semibold">{t("quietTitle")}</legend>
          <p className="text-sm text-muted">{t("quietHelp")}</p>
          <div className="mt-2 flex gap-3">
            {(
              [
                ["quietFrom", quietFrom, t("quietFrom")],
                ["quietTo", quietTo, t("quietTo")],
              ] as const
            ).map(([name, value, label]) => (
              <div key={name} className="flex flex-1 flex-col gap-1">
                <label htmlFor={`notice-${name}`} className="text-sm font-semibold">
                  {label}
                </label>
                <select id={`notice-${name}`} name={name} defaultValue={value !== null ? hhmm(value) : ""} className="input min-h-11 text-sm">
                  <option value="">{t("quietOff")}</option>
                  {hours(value).map((m) => (
                    <option key={m} value={hhmm(m)}>
                      {hhmm(m)}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </fieldset>
        <button type="submit" className="btn-primary" disabled={pending}>
          {t("save")}
        </button>
        {saved === true && (
          <p role="status" className="text-sm font-semibold text-ok">
            ✓ {t("saved")}
          </p>
        )}
      </form>
    </details>
  );
}
