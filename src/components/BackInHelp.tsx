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
/** `bare`: the doors alone, with no box and no heading, under a question of the caller's own ("Danny is in this match. Sign in as Danny?", `SeatedAsk`). */
export function BackInHelp({ doors, bare = false }: { doors: BackInDoors; bare?: boolean }) {
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
  // Neither the email code nor Telegram on this deployment (rule 4): Face ID or a fingerprint alone, with
  // no box and no heading, so a browser that cannot do it meets no empty "Played before?" box.
  if (!doors.email && !doors.telegram)
    return (
      <div ref={box} data-testid="back-in-open" className="mt-3">
        <PasskeySignIn />
      </div>
    );
  return (
    <div ref={box} data-testid="back-in-open" className={bare ? "mt-2" : "mt-3 rounded-2xl border border-line bg-card px-3 py-3"}>
      {!bare && <p className="text-sm font-bold">{t("identity.usedBefore")}</p>}
      <div className={bare ? "" : "mt-2"}>
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
