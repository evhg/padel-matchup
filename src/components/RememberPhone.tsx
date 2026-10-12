"use client";

import { useTranslations } from "next-intl";
import { startTransition, useEffect, useState, useTransition } from "react";
import { passkeySaveAction, passkeySaveOptionsAction } from "@/actions/passkeys";
import { PasskeySignIn } from "./PasskeySignIn";

/** The browser's own "not now" for the offer: per browser, never a row (a convenience, not a setting). */
const NOT_NOW = "km_passkey_not_now";

/** Whether this browser can keep a passkey on the phone itself (Face ID, a fingerprint, the phone's lock). */
export function usePlatformPasskey(): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    let live = true;
    import("@simplewebauthn/browser")
      .then((w) => w.platformAuthenticatorIsAvailable())
      .then((yes) => live && setOk(Boolean(yes)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return ok;
}

export type SaveOutcome = "saved" | "already" | "failed" | "too_many";

/** The save, as both screens run it: the options, the phone's Face ID or fingerprint, the answer. A phone that remembers the player already says so; that is no failure. */
export async function savePasskeyHere(): Promise<SaveOutcome> {
  const opts = await passkeySaveOptionsAction();
  if (!opts.ok) return opts.error === "too_many" ? "too_many" : "failed";
  let answer: unknown;
  try {
    const { startRegistration } = await import("@simplewebauthn/browser");
    answer = await startRegistration({ optionsJSON: opts.data });
  } catch (e) {
    const code = (e as { code?: string; name?: string } | null)?.code;
    return code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" || (e as { name?: string } | null)?.name === "InvalidStateError" ? "already" : "failed";
  }
  const r = await passkeySaveAction(answer);
  return r.ok ? "saved" : r.error === "too_many" ? "too_many" : "failed";
}

/**
 * "Remember me on this phone" (DECIDING rule 39): a quiet card after a join, or after a sign-in this
 * browser proved, for a session that may save a passkey (the page renders it only then) and a record
 * that has none (`offer`). It shows only where the phone can keep one, and "Not now" hides it in this browser. Under it,
 * "Saved on this phone before?": a browser that just made a new record of a player whose phone keeps a
 * passkey signs in with it, and the new record folds into the old one.
 */
export function RememberPhone({ offer }: { offer: boolean }) {
  const t = useTranslations();
  const platform = usePlatformPasskey();
  const [hidden, setHidden] = useState(true);
  const [outcome, setOutcome] = useState<SaveOutcome | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    try {
      setHidden(Boolean(localStorage.getItem(NOT_NOW)));
    } catch {
      setHidden(false);
    }
  }, []);

  if (!platform || hidden) return null;
  if (outcome === "saved" || outcome === "already")
    return (
      <p className="mt-3 rounded-2xl bg-ok-soft px-4 py-3 text-sm font-semibold text-ok" data-testid="remember-phone-done">
        ✓ {t(outcome === "saved" ? "identity.rememberDone" : "identity.rememberAlready")}
      </p>
    );
  // The record has a passkey: nothing to offer, unless this card just saved it (above).
  if (!offer) return null;

  const save = () =>
    start(async () => {
      const r = await savePasskeyHere();
      // No refresh: the page renders again anyway, because the action changes a cookie, and it keeps this
      // card mounted with `offer` false, so the confirmation stays. The next load leaves the card out.
      startTransition(() => setOutcome(r));
    });
  const notNow = () => {
    try {
      localStorage.setItem(NOT_NOW, "1");
    } catch {
      /* storage unavailable: hidden for this view only */
    }
    setHidden(true);
  };

  return (
    <section className="mt-3 rounded-2xl border border-line px-4 py-3" data-testid="remember-phone">
      <h2 className="text-sm font-extrabold">{t("identity.rememberTitle")}</h2>
      <p className="mt-0.5 text-sm text-muted">{t("identity.rememberHelp")}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className="btn-ghost btn-sm" disabled={pending} onClick={save}>
          {pending ? t("identity.passkeyWorking") : t("identity.rememberButton")}
        </button>
        <button type="button" className="link text-sm font-semibold" disabled={pending} onClick={notNow}>
          {t("identity.rememberNotNow")}
        </button>
      </div>
      {(outcome === "failed" || outcome === "too_many") && (
        <p role="status" className="mt-2 text-sm font-semibold text-danger">
          {outcome === "too_many" ? t("errors.too_many") : t("identity.rememberNo")}
        </p>
      )}
      {/* A phone that keeps a passkey already, in a browser that just made a new record: Face ID or a
          fingerprint signs in the passkey's record and folds this new one into it (`passkeyFold`). */}
      <p className="mt-2 text-xs text-muted">
        {t("identity.rememberSavedBefore")} <PasskeySignIn inline className="link font-semibold" />
      </p>
    </section>
  );
}
