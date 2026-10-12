"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { registerBackInHandler } from "./backInBus";
import { PasskeySignIn } from "./PasskeySignIn";
import { RestoreWithEmail } from "./RestoreWithEmail";
import { TelegramLogin } from "./TelegramLogin";

/** The doors this deployment runs, from the server: the email code and Telegram are each optional (rule 4); Face ID or a fingerprint is always there where the browser can do it. */
export type BackInDoors = { email: boolean; telegram: { botId: string; lang: string; authUrl: string } | null };

/**
 * "Played before? Get your matches back.", open, beside the name field of a join form on the match page
 * (the owner accepted this on 12 October 2026, with passkeys, DECIDING rule 39). Until then it was a
 * closed line under the line-up, and a player whose cookie lives in another browser typed their name
 * above it and became a second record. Face ID or a fingerprint first, then the email code, then
 * Telegram. It renders only once the join form opens, so a view of the page costs no call (rule 12).
 * A typed name that is already here ("That's me" on a record that can prove itself) scrolls to it.
 */
export function BackInHelp({ doors }: { doors: BackInDoors }) {
  const t = useTranslations();
  const box = useRef<HTMLDivElement>(null);
  useEffect(
    () =>
      registerBackInHandler(() => {
        const el = box.current;
        if (el) requestAnimationFrame(() => el.scrollIntoView({ block: "center", behavior: "smooth" }));
      }),
    [],
  );
  return (
    <div ref={box} data-testid="back-in-open" className="mt-3 rounded-2xl border border-line bg-card px-3 py-3">
      <p className="text-sm font-bold">{t("identity.usedBefore")}</p>
      <div className="mt-2">
        <PasskeySignIn />
      </div>
      {doors.email && (
        <div className="mt-3">
          <p className="mb-2 text-sm text-muted">{t("identity.backInEmail")}</p>
          <RestoreWithEmail compact />
        </div>
      )}
      {doors.telegram && (
        <div className={doors.email ? "mt-4 border-t border-line pt-3" : "mt-3"}>
          {doors.email && <p className="mb-2 text-sm text-muted">{t("identity.backInTelegram")}</p>}
          <TelegramLogin botId={doors.telegram.botId} linked={false} linkedUsername={null} lang={doors.telegram.lang} authUrl={doors.telegram.authUrl} />
        </div>
      )}
    </div>
  );
}
