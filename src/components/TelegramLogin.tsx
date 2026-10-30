"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { readAuthResult, returnToFor, telegramAuthUrl } from "@/lib/telegram/login";
import { writeSignalsCookie } from "@/lib/deviceSignals";

/**
 * Sign in with Telegram, in this tab: one button that sends the tab to
 * Telegram and comes back here with the signed fields in the hash; those go
 * to /api/telegram/login, which verifies them, sets the session and returns
 * the tab to this page. No widget, no popup, no second tab. Linked accounts
 * see their handle instead.
 */
/**
 * Back from Telegram: the signed fields are in the hash, on a fresh load or (rarely) a hash change, and
 * they go to the login route. Every page with a "Sign in with Telegram" must read them on load, also
 * when the button itself is not on the screen yet: the match page opens its "Played before?" only with
 * the join form (DECIDING rule 39), so it reads them through `TelegramReturn`.
 */
export function useTelegramReturn(authUrl: string, onBack?: () => void): void {
  const said = useRef(onBack);
  said.current = onBack;
  useEffect(() => {
    const back = () => {
      const fields = readAuthResult(window.location.hash);
      if (!fields) return;
      said.current?.();
      const here = window.location.pathname + window.location.search;
      history.replaceState(null, "", here);
      // The login route sends the tab back to this page (`loginNext` checks it), not to My matches.
      // Two pages keep My matches: the landing page, where "the way back to your own matches" is the
      // reason to sign in, and a personal link, whose token must never travel in another URL.
      const keep = window.location.pathname !== "/" && !/^\/p(\/|$)/i.test(window.location.pathname);
      // The device hint's values ride to the login route in a one-minute cookie of its own: a plain navigation carries no argument.
      // The read takes at most SIGNAL_BUDGET_MS, and the tab leaves whatever it gives.
      const leave = () => window.location.replace(`${authUrl}?${new URLSearchParams(keep ? { ...fields, next: here } : fields)}`);
      writeSignalsCookie().then(leave, leave);
    };
    back();
    window.addEventListener("hashchange", back);
    return () => window.removeEventListener("hashchange", back);
  }, [authUrl]);
}

/** The return from Telegram alone, with no button: for a page whose button is not mounted on load. */
export function TelegramReturn({ authUrl }: { authUrl: string }) {
  useTelegramReturn(authUrl);
  return null;
}

/** `bare`: the button alone, with no heading and no pitch, under a line of the caller's own ("With the Telegram you linked before:", `SeatedAsk`). */
export function TelegramLogin({ botId, linkedUsername, linked, lang, authUrl, bare = false }: { botId: string; linkedUsername: string | null; linked: boolean; lang: string; authUrl: string; bare?: boolean }) {
  const t = useTranslations();
  const [busy, setBusy] = useState(false);
  useTelegramReturn(authUrl, () => setBusy(true));
  const go = () => {
    setBusy(true);
    window.location.assign(telegramAuthUrl(botId, window.location.origin, returnToFor(window.location), lang));
  };
  return (
    <div>
      {!bare && <div className="text-xs font-bold uppercase tracking-wider text-faint">{t("telegram.title")}</div>}
      {linked && !busy ? (
        <div className="mt-1 text-sm font-semibold">✓ {linkedUsername ? t("telegram.linked", { username: linkedUsername }) : t("telegram.linkedNoName")}</div>
      ) : (
        <>
          {!bare && <p className="mt-1 text-xs text-faint">{t("telegram.help")}</p>}
          <button type="button" onClick={go} disabled={busy} className={bare ? "btn-ghost btn-sm" : "btn-ghost btn-sm mt-2"}>
            <TelegramMark />
            {busy ? t("telegram.signingIn") : t("telegram.signIn")}
          </button>
        </>
      )}
    </div>
  );
}

const TelegramMark = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <circle cx="12" cy="12" r="12" fill="#2AABEE" />
    <path fill="#fff" d="M5.5 11.7l10.9-4.2c.5-.2 1 .1.8.9l-1.9 8.8c-.1.6-.5.8-1 .5l-2.9-2.1-1.4 1.3c-.2.2-.3.3-.6.3l.2-2.9 5.3-4.8c.2-.2 0-.3-.3-.1l-6.6 4.1-2.8-.9c-.6-.2-.6-.6.3-.9z" />
  </svg>
);
