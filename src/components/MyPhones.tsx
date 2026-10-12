"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { startTransition, useState, useTransition } from "react";
import { removePasskeyAction } from "@/actions/passkeys";
import { savePasskeyHere, usePlatformPasskey, type SaveOutcome } from "./RememberPhone";

/** One passkey as My matches shows it: an opaque handle (never the credential id), the words it was saved under, two dates already written out. */
export type PhoneRow = { handle: string; label: string | null; saved: string; used: string | null };

/**
 * "Phones that remember you" on My matches (DECIDING rule 39): each passkey with the browser that saved
 * it and its dates, and "Remove" for a session that may (`canSave`, from the server: not a session by
 * name). A record with no passkey gets no list: My matches shows the quiet `RememberPhone` card there
 * instead, with its "Not now". A record that has one gets no second offer, only the small link "Also
 * remember this phone" under the list, where the phone can keep one, so a second phone can still save one.
 */
export function MyPhones({ rows, canSave }: { rows: PhoneRow[]; canSave: boolean }) {
  const t = useTranslations();
  const router = useRouter();
  const platform = usePlatformPasskey();
  const [outcome, setOutcome] = useState<SaveOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (rows.length === 0) return null;

  const save = () =>
    start(async () => {
      setError(null);
      const r = await savePasskeyHere();
      startTransition(() => {
        setOutcome(r);
        if (r === "saved") router.refresh();
      });
    });
  const remove = (handle: string) =>
    start(async () => {
      setError(null);
      const r = await removePasskeyAction(handle);
      startTransition(() => {
        if (!r.ok) setError(t("errors.generic"));
        else router.refresh();
      });
    });

  return (
    <section className="card" data-testid="my-phones">
      <h2 className="text-lg font-extrabold">{t("identity.phonesTitle")}</h2>
      <p className="mt-1 text-sm text-muted">{t("identity.phonesHelp")}</p>
      <ul className="mt-3 flex flex-col gap-2">
        {rows.map((r) => {
          const label = r.label ?? t("identity.phoneUnknown");
          return (
            <li key={r.handle} className="flex items-center justify-between gap-3 rounded-2xl border border-line px-4 py-3" data-testid="my-phone">
              <div className="min-w-0">
                <div className="truncate font-bold">{label}</div>
                <div className="text-xs text-muted">{[t("identity.phoneSaved", { date: r.saved }), r.used ? t("identity.phoneUsed", { date: r.used }) : null].filter(Boolean).join(" · ")}</div>
              </div>
              {canSave && (
                <button type="button" className="btn-ghost btn-sm shrink-0" disabled={pending} aria-label={t("identity.phoneRemoveNamed", { label })} onClick={() => remove(r.handle)}>
                  {t("identity.phoneRemove")}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {canSave && <p className="mt-2 text-xs text-faint">{t("identity.phoneRemoveHelp")}</p>}
      {canSave && platform && outcome !== "saved" && outcome !== "already" && (
        <button type="button" className="link mt-3 text-sm font-semibold" disabled={pending} onClick={save} data-testid="remember-also">
          {pending ? t("identity.passkeyWorking") : t("identity.rememberAlso")}
        </button>
      )}
      {(outcome === "saved" || outcome === "already") && <p className="mt-3 text-sm font-semibold text-ok">✓ {t(outcome === "saved" ? "identity.rememberDone" : "identity.rememberAlready")}</p>}
      {(outcome === "failed" || outcome === "too_many" || error) && (
        <p role="status" className="mt-2 text-sm font-semibold text-danger">
          {error ?? (outcome === "too_many" ? t("errors.too_many") : t("identity.rememberNo"))}
        </p>
      )}
    </section>
  );
}
