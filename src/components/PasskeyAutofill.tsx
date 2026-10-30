"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { passkeySignInAction, passkeySignInOptionsAction } from "@/actions/passkeys";
import { createAutofillPage, OPTIONS_TTL_MS, type HeldOptions, type Phase } from "@/lib/passkeys/autofill";
import { canAutofillPasskey, type PageSignInOptions } from "@/lib/passkeys/caps";
import { readDeviceSignals } from "@/lib/deviceSignals";

/**
 * The passkey above the keyboard in the player's own name field (the owner, 28 October 2026: "May the
 * player's own name field offer a saved passkey above the keyboard ('Tim', then Face ID)?" — "Yes, own
 * name field (Recommended)"). A phone that keeps a passkey for Kicksmash offers "Tim" in the bar above
 * the keyboard when the player taps the name field; Face ID then signs the browser in as Tim's record,
 * exactly as "Sign in with Face ID or fingerprint" does, and the page renders again, signed in.
 *
 * Two halves. `PasskeyAutofill`, once on a page for a browser that knows nobody, with the page's own
 * challenge (src/lib/passkeys/page.ts): where the browser can offer a passkey in its autofill
 * (`canAutofillPasskey`, the new capability call first), it starts the one conditional request of the
 * page at once, before any field is tapped, with no call to the server. `useOwnNameAutofill`, in each
 * form where the player types their OWN name: it adds the "webauthn" token to that field's autocomplete
 * ("given-name webauthn") while the request can be answered, and says under the field what happened.
 * Never on a field that holds another person's name (a partner's, a place the organiser holds, the
 * create form's other names): those forms do not call the hook.
 *
 * What the request does and when (the challenge's own end, one options call at a time, the kill switch)
 * is the machine in src/lib/passkeys/autofill.ts; this file hands it the library and the server. A typed
 * name and Join work as before: the form's own submit ends the request first (`stop`), and a tap on the
 * field again starts a new one. The request also ends when the page goes, and when the button's own
 * sign-in starts (the library keeps one ceremony at a time).
 *
 * Unverified on a real iPhone: Safari and Chrome on iOS 17, 18 and 26 with "given-name webauthn" (the
 * HTML standard allows the token after any field name, and Apple's own examples use "username
 * webauthn"), a private tab, and the home-screen icon (ROADMAP.md).
 */

type Options = PublicKeyCredentialRequestOptionsJSON;

/** The page's one conditional request, shared by every own-name field on it. */
const page = createAutofillPage<Options>({
  options: async () => {
    const r = await passkeySignInOptionsAction();
    // The cookie's five minutes, counted from the answer on the phone's own clock.
    return r.ok ? { optionsJSON: r.data, expiresAt: Date.now() + OPTIONS_TTL_MS } : null;
  },
  // `via` names the counter; `hint`, the device values, keeps this phone as the record's device hint, as the button does.
  signIn: async (answer) => passkeySignInAction(answer, { via: "autofill", hint: await readDeviceSignals() }),
});

/** The page's challenge as the machine holds it: the options for the phone, and their end, which stays in the browser. */
function heldOf(options: PageSignInOptions | null): HeldOptions<Options> | null {
  if (!options) return null;
  const { expiresAt, ...optionsJSON } = options;
  return { optionsJSON, expiresAt };
}

/**
 * Once on a page, for a browser that knows nobody: `options` is the page's own challenge, null while
 * the kill switch is off (`PASSKEY_AUTOFILL`). Each refresh of the page brings a new one, which replaces
 * held options near their end. It renders nothing.
 */
export function PasskeyAutofill({ options }: { options: PageSignInOptions | null }) {
  const router = useRouter();
  // Before the effect below: the machine keeps the newest challenge while the browser is still asked.
  useEffect(() => {
    page.offer(heldOf(options));
  }, [options]);
  useEffect(() => {
    let live = true;
    (async () => {
      if (!(await canAutofillPasskey())) return;
      const lib = await import("@simplewebauthn/browser");
      // The library asks `isConditionalMediationAvailable()` itself before it starts, so both must say yes.
      if (!live || !(await lib.browserSupportsWebAuthnAutofill()) || !live) return;
      page.enable(
        {
          // No field need be on screen yet: the join form opens on a tap, and the request must already wait
          // when the field is first focused, or the phone may not offer the passkey there.
          start: (optionsJSON) => lib.startAuthentication({ optionsJSON, useBrowserAutofill: true, verifyBrowserAutofillInput: false }),
          cancel: () => lib.WebAuthnAbortService.cancelCeremony(),
        },
        () => router.refresh(),
      );
    })().catch(() => undefined);
    // A tab iOS kept in memory, or a page the back button brought back: a stale challenge goes, with no call.
    const wake = () => {
      if (document.visibilityState === "visible") page.wake();
    };
    window.addEventListener("pageshow", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      live = false;
      window.removeEventListener("pageshow", wake);
      document.removeEventListener("visibilitychange", wake);
      page.leave();
    };
  }, [router]);
  return null;
}

/**
 * For the form where the player types their own name. `base` is the field's own autocomplete
 * ("given-name"): the token goes after it, so the browser's own suggestion of a first name stays.
 * `onFocus` starts the request again where it ended; `stop` goes first in the form's submit; `note` says
 * under the field what the sign-in did.
 */
export function useOwnNameAutofill(base = "given-name"): { autoComplete: string; onFocus: () => void; stop: () => void; note: ReactNode } {
  const t = useTranslations();
  const phase = useSyncExternalStore(page.subscribe, page.phase, () => "off" as Phase);
  const said = phase === "working" ? t("common.working") : phase === "again" ? t("identity.passkeyAutofillAgain") : phase === "no" ? t("identity.passkeyNo") : null;
  return {
    autoComplete: phase === "off" ? base : `${base} webauthn`,
    onFocus: page.focus,
    stop: page.stop,
    note: said ? (
      <p role="status" className={`text-sm font-semibold ${phase === "working" ? "text-muted" : "text-danger"}`} data-testid="passkey-autofill-note">
        {said}
      </p>
    ) : null,
  };
}
