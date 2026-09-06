"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { readAuthResult, returnToFor, telegramAuthUrl } from "@/lib/telegram/login";

/**
 * Sign in with Telegram, in this tab: one button that sends the tab to
 * Telegram and comes back here with the signed fields in the hash; those go
 * to /api/telegram/login, which verifies them and sets the session. No
 * widget, no popup, no second tab. Linked accounts see their handle instead.
 */
export function TelegramLogin({ botId, linkedUsername, linked, lang, authUrl }: { botId: string; linkedUsername: string | null; linked: boolean; lang: string; authUrl: string }) {
  const t = useTranslations();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    // Back from Telegram: the signed fields are in the hash, on a fresh load or (rarely) a hash change.
    const back = () => {
      const fields = readAuthResult(window.location.hash);
      if (!fields) return;
      setBusy(true);
      history.replaceState(null, "", window.location.pathname + window.location.search);
      window.location.replace(`${authUrl}?${new URLSearchParams(fields)}`);
    };
    back();
    window.addEventListener("hashchange", back);
    return () => window.removeEventListener("hashchange", back);
  }, [authUrl]);
  const go = () => {
    setBusy(true);
    window.location.assign(telegramAuthUrl(botId, window.location.origin, returnToFor(window.location), lang));
  };
  return (
    <div>
      <div className="text-xs font-bold uppercase tracking-wider text-faint">{t("telegram.title")}</div>
      {linked && !busy ? (
        <div className="mt-1 text-sm font-semibold">✓ {linkedUsername ? t("telegram.linked", { username: linkedUsername }) : t("telegram.linkedNoName")}</div>
      ) : (
        <>
          <p className="mt-1 text-xs text-faint">{t("telegram.help")}</p>
          <button type="button" onClick={go} disabled={busy} className="btn-ghost btn-sm mt-2">
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
