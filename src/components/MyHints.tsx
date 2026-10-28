"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { startTransition, useState, useTransition } from "react";
import { forgetHintAction, hintsOffAction } from "@/actions/deviceHints";
import type { ProofDoors } from "./DeleteAccount";

/** One device hint as My matches shows it: the row's id, the label kept, two days already written out. Never the key. */
export type HintRow = { id: string; label: string; first: string; last: string };

/**
 * "Phones we recognise" on My matches (device hints, the owner's decision of 28 October 2026): beside the
 * passkeys, each remembered phone with its label and its first and last day, and "Forget this phone" for
 * one row. The account deletion at the bottom of the page forgets them all.
 *
 * Under the list, "Don't recognise my phones" (`off`, from `players.hints_off`): the player's lasting
 * objection to the key (Thai PDPA s.32, DECIDING rule 40). On, every phone goes at once and no door keeps a
 * key; off, the next join or sign-in keeps one again. A session by name that proved nothing sees the
 * switch locked and a line that says why and which door below proves it (`locked`, `doors`, the same
 * `ProofDoors` as the deletion's line); the server
 * refuses it too (`hintsOffAction`).
 *
 * The switch shows with no phone too while the deployment keeps keys (`enabled`, from `DEVICE_HINTS` not
 * `off`): the privacy page sends the player here to object, at any time, and that holds before the first
 * key and after "Forget this phone" took the last one. With the switch `off`, a record with no phone and no
 * mark sees nothing, unless this browser just cleared the mark: the block stays until the page is left, so
 * the switch does not vanish under the tap.
 */
export function MyHints({ rows, off = false, locked = false, doors = "other", enabled = false }: { rows: HintRow[]; off?: boolean; locked?: boolean; doors?: ProofDoors; enabled?: boolean }) {
  const t = useTranslations();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [touched, setTouched] = useState(false);
  if (rows.length === 0 && !off && !touched && !enabled) return null;
  const lockedLine = t("identity.hintsOffLocked", { doors });
  const labelOf = (label: string) => (label === "Android phone" ? t("identity.hintAndroid") : label === "iPhone" || label === "iPad" ? label : t("identity.hintOther"));
  const forget = (id: string) =>
    start(async () => {
      setError(null);
      const r = await forgetHintAction(id);
      startTransition(() => {
        if (!r.ok) setError(t("errors.generic"));
        else router.refresh();
      });
    });
  const toggle = () =>
    start(async () => {
      setError(null);
      setTouched(true);
      const r = await hintsOffAction(!off);
      startTransition(() => {
        if (!r.ok) setError(r.error === "forbidden" ? lockedLine : t("errors.generic"));
        else router.refresh();
      });
    });
  return (
    <section className="card" data-testid="my-hints">
      <h2 className="text-lg font-extrabold">{t("identity.hintsTitle")}</h2>
      {rows.length > 0 && (
        <>
          <p className="mt-1 text-sm text-muted">{t("identity.hintsHelp")}</p>
          <ul className="mt-3 flex flex-col gap-2">
            {rows.map((r) => {
              const label = labelOf(r.label);
              return (
                <li key={r.id} className="flex items-center justify-between gap-3 rounded-2xl border border-line px-4 py-3" data-testid="my-hint">
                  <div className="min-w-0">
                    <div className="truncate font-bold">{label}</div>
                    <div className="text-xs text-muted">{t("identity.hintSeen", { first: r.first, last: r.last })}</div>
                  </div>
                  <button type="button" className="btn-ghost btn-sm shrink-0" disabled={pending} aria-label={t("identity.hintForgetNamed", { label })} onClick={() => forget(r.id)}>
                    {t("identity.hintForget")}
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-xs text-faint">{t("identity.hintsDelete")}</p>
        </>
      )}
      <div className={rows.length > 0 ? "mt-4 border-t border-line pt-4" : "mt-2"}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="font-bold">{t("identity.hintsOff")}</div>
            <p className="text-sm text-muted" data-testid="hints-off-state">
              {off ? t("identity.hintsOffOn") : t("identity.hintsOffHelp")}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={off}
            aria-label={t("identity.hintsOff")}
            disabled={locked || pending}
            onClick={toggle}
            data-testid="hints-off-switch"
            className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition disabled:opacity-50 ${off ? "bg-ink" : "bg-line-strong"}`}
          >
            <span className={`inline-block h-5 w-5 rounded-full shadow transition ${off ? "translate-x-6 bg-on-ink" : "translate-x-1 bg-knob-off"}`} />
          </button>
        </div>
        {locked && (
          <p className="mt-2 text-xs text-muted" data-testid="hints-off-locked">
            {lockedLine}
          </p>
        )}
      </div>
      {error && (
        <p role="status" className="mt-2 text-sm font-semibold text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
