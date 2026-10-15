"use client";

import { useTranslations } from "next-intl";
import { useSyncExternalStore } from "react";
import { normalName } from "@/lib/domain/dupes";
import { canAskBackIn, requestBackIn, subscribeBackIn } from "./backInBus";
import { BackInHelp, type BackInDoors } from "./BackInHelp";
import { PasskeySignIn } from "./PasskeySignIn";
import { ThatsMeButton } from "./ThatsMe";

/** The name as the line-up writes it, for a typed name the server answered with `name_seated`; the typed name when the page has it under no other spelling. */
export const seatedNameOf = (typed: string, namesHere: readonly string[]): string => namesHere.find((n) => normalName(n) === normalName(typed)) ?? typed.trim();

/**
 * "Danny is in this match. Sign in as Danny?" The owner's decision of 15 October 2026 (D2, DECIDING
 * rule 34): a browser that knows nobody types a name a record holds a seat or a waiting place with, and
 * Join no longer makes a second Danny; the server answers `name_seated`, and every join form shows this
 * in place of the line under the name (the open spot, the waiting list's form, the bar).
 *
 * The yes is a door that exists already, never a third sign-in. A record "That's me" signs in (the page
 * asked the rule: `claimable`) takes its two taps: "That's me", then "Sign in as Danny?". A record with an
 * email or a passkey, which "That's me" refuses, gets its own doors, as the "Played before?" help shows
 * them: Face ID or a fingerprint, then the email code (`BackInHelp`, `doors`); where the form has no room
 * for them (the bar), the passkey button and the way to the page's own "Played before?" fold. Under it,
 * "I'm a different Danny" sends the same join with the flag only this button sets (`onDifferent`); the
 * name then joins as typed, and the namesake rules apply as before.
 */
export function SeatedAsk({
  code,
  typed,
  namesHere,
  claimable,
  doors = null,
  onDifferent,
  pending = false,
}: {
  code: string;
  typed: string;
  namesHere: readonly string[];
  /** Names "That's me" signs in by name (the page asked the rule). */
  claimable: readonly string[];
  /** The ways back in this deployment runs, where the form has room for them; null in the bar. */
  doors?: BackInDoors | null;
  onDifferent: () => void;
  pending?: boolean;
}) {
  const t = useTranslations();
  // The page's own "Played before?" fold, when it has one (the email code or Telegram run here): the bar's way to the email code.
  const foldHere = useSyncExternalStore(subscribeBackIn, canAskBackIn, () => false);
  const name = seatedNameOf(typed, namesHere);
  const thatsMe = claimable.find((n) => normalName(n) === normalName(typed));
  return (
    <div data-testid="seated-ask" className="rounded-2xl border border-court/30 bg-card px-3 py-3 animate-pop">
      <p className="text-sm font-bold">{t("identity.seatedAsk", { name })}</p>
      {thatsMe ? (
        <div className="mt-2">
          <ThatsMeButton code={code} name={thatsMe} className="btn-primary btn-sm" armedClassName="btn-primary btn-sm whitespace-normal leading-tight ring-2 ring-ink" />
        </div>
      ) : doors ? (
        <BackInHelp doors={doors} bare />
      ) : (
        <div className="mt-2 flex flex-col items-start gap-1">
          <PasskeySignIn className="btn-ghost btn-sm w-full whitespace-normal leading-snug" />
          {foldHere && (
            <button type="button" className="link text-sm font-semibold" onClick={() => requestBackIn()}>
              {t("identity.thatsMe")}
            </button>
          )}
        </div>
      )}
      <button type="button" className="link mt-3 block text-xs font-semibold" data-testid="seated-different" disabled={pending} onClick={onDifferent}>
        {t("identity.seatedDifferent", { name })}
      </button>
    </div>
  );
}
