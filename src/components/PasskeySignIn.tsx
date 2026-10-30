"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { startTransition, useEffect, useState, useTransition } from "react";
import { passkeySignInAction, passkeySignInOptionsAction } from "@/actions/passkeys";
import { readDeviceSignals } from "@/lib/deviceSignals";

/**
 * "Sign in with Face ID or fingerprint" (DECIDING rule 39): the phone offers the passkeys it keeps for
 * Kicksmash, in any of its browsers, and the one the player picks signs this browser in as its record.
 * Nothing reaches the server until the tap (rule 12: no call per anonymous view); the library loads on
 * mount only to ask whether this browser can do it at all, and the button stays away when it cannot.
 */
// An outlined button that wraps: the join form's own Join stays the one primary action (rule 3), and
// ".btn" keeps a label on one line, which ran this one off both edges at 390 px.
export function PasskeySignIn({ className = "btn-ghost w-full whitespace-normal py-2 leading-snug", inline = false }: { className?: string; inline?: boolean }) {
  const t = useTranslations();
  const router = useRouter();
  const [can, setCan] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [welcome, setWelcome] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    import("@simplewebauthn/browser")
      .then((w) => live && setCan(w.browserSupportsWebAuthn()))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  if (!can) return null;
  if (welcome) return inline ? <span className="font-semibold text-ok">✓ {t("identity.passkeyWelcome", { name: welcome })}</span> : <p className="text-sm font-semibold text-ok">✓ {t("identity.passkeyWelcome", { name: welcome })}</p>;

  const go = () =>
    start(async () => {
      setError(null);
      const opts = await passkeySignInOptionsAction();
      if (!opts.ok) return startTransition(() => setError(opts.error === "too_many" ? t("errors.too_many") : t("identity.passkeyNo")));
      let answer: unknown;
      try {
        const { startAuthentication } = await import("@simplewebauthn/browser");
        answer = await startAuthentication({ optionsJSON: opts.data });
      } catch {
        // Cancelled, or no passkey of ours on this phone: the phone said so already, so the line stays plain.
        return startTransition(() => setError(t("identity.passkeyNo")));
      }
      const r = await passkeySignInAction(answer, { hint: await readDeviceSignals() });
      startTransition(() => {
        if (!r.ok) return setError(r.error === "too_many" ? t("errors.too_many") : t("identity.passkeyNo"));
        setWelcome(r.data.name);
        router.refresh();
      });
    });

  const button = (
    <button type="button" className={className} data-testid="passkey-signin" disabled={pending} onClick={go}>
      {pending ? t("identity.passkeyWorking") : t("identity.passkeySignIn")}
    </button>
  );
  if (inline)
    return (
      <>
        {button}
        {error && (
          <span role="status" className="block font-semibold text-danger">
            {error}
          </span>
        )}
      </>
    );
  return (
    <div>
      {button}
      {error && (
        <p role="status" className="mt-1 text-sm font-semibold text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
