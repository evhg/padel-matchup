"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";

/**
 * Telegram Login Widget: one button, Telegram signs the fields and sends the
 * browser to /api/telegram/login. Linked accounts see their handle instead.
 */
export function TelegramLogin({ botUsername, linkedUsername, linked, lang, authUrl }: { botUsername: string; linkedUsername: string | null; linked: boolean; lang: string; authUrl: string }) {
  const t = useTranslations();
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (linked || !host.current || host.current.childElementCount > 0) return;
    const s = document.createElement("script");
    s.async = true;
    s.src = "https://telegram.org/js/telegram-widget.js?22";
    s.dataset.telegramLogin = botUsername;
    s.dataset.size = "medium";
    s.dataset.radius = "12";
    s.dataset.userpic = "false";
    s.dataset.lang = lang === "ru" ? "ru" : lang === "es" ? "es" : "en";
    s.dataset.authUrl = authUrl;
    s.dataset.requestAccess = "write";
    host.current.appendChild(s);
  }, [botUsername, linked, lang, authUrl]);
  return (
    <div>
      <div className="text-xs font-bold uppercase tracking-wider text-faint">{t("telegram.title")}</div>
      {linked ? (
        <div className="mt-1 text-sm font-semibold">✓ {linkedUsername ? t("telegram.linked", { username: linkedUsername }) : t("telegram.linkedNoName")}</div>
      ) : (
        <>
          <p className="mt-1 text-xs text-faint">{t("telegram.help")}</p>
          <div ref={host} className="mt-2 min-h-10" aria-label={t("telegram.signIn")} />
        </>
      )}
    </div>
  );
}
