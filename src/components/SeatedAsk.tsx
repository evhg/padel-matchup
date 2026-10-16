"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { normalName } from "@/lib/domain/dupes";
import { anyDoor, readDoors, type OwnDoors } from "@/lib/domain/seatedDoors";
import type { BackInDoors } from "./BackInHelp";
import { registerBackInHandler } from "./backInBus";
import { PasskeySignIn } from "./PasskeySignIn";
import { RestoreWithEmail } from "./RestoreWithEmail";
import { TelegramLogin } from "./TelegramLogin";
import { ThatsMeButton } from "./ThatsMe";

/** The name as the line-up writes it, for a typed name the server answered with `name_seated`; the typed name when the page has it under no other spelling. */
export const seatedNameOf = (typed: string, namesHere: readonly string[]): string => namesHere.find((n) => normalName(n) === normalName(typed)) ?? typed.trim();

/**
 * What the server answered a typed name with, so the join form asks before it makes a second record:
 *   - `seated`: a record of the name holds a seat or a waiting place here (`name_seated`), with that
 *     record's own doors (`own`, three booleans; the owner's decision of 16 October 2026, D4);
 *   - `unreached`: the name is one of the organiser's past partners that Kicksmash cannot reach, and
 *     "That's me" signs that record in (`name_unreached`; the owner's decision of 16 October 2026, D6).
 * The browser never holds the list behind either answer: only this answer, for the name it typed.
 */
export type NameAsk = { name: string; kind: "seated"; own: OwnDoors } | { name: string; kind: "unreached"; first: string };

/** The join's refusal as an ask, or null for any other answer. */
export function askOf(r: { ok: boolean; error?: string; detail?: string }, typed: string | null | undefined): NameAsk | null {
  if (r.ok || !typed) return null;
  if (r.error === "name_seated") return { name: typed, kind: "seated", own: readDoors(r.detail) };
  // The first name as the record writes it ("Tomasz" for "tomasz"), from the server; the typed name when it gave none.
  if (r.error === "name_unreached") return { name: typed, kind: "unreached", first: r.detail?.trim() || typed.trim() };
  return null;
}

/**
 * What "That's me" sends, and the name its armed face shows ("Sign in as Tim?"). The unreached tap sends
 * the name as typed, so the server asks the same question the join asked (`unreachedOffer`): the first
 * name alone could find another record of that name in the match or its crew first. Its face shows the
 * first name the server gave. A seated tap sends the line-up's name that "That's me" signs in. Pure.
 */
export function thatsMeTapOf(ask: NameAsk, typed: string, claimable: readonly string[]): { name: string; label: string } | null {
  if (ask.kind === "unreached") return { name: ask.name.trim(), label: ask.first };
  const n = claimable.find((c) => normalName(c) === normalName(typed));
  return n ? { name: n, label: n } : null;
}

/** Whether the ask stands for what the field holds now: a changed name takes it back. */
export const askStanding = (ask: NameAsk | null, typed: string): NameAsk | null => (ask && normalName(ask.name) === normalName(typed) ? ask : null);

/**
 * "Danny is in this match. Sign in as Danny?" The owner's decision of 15 October 2026 (D2, DECIDING
 * rule 34): a browser that knows nobody types a name a record holds a seat or a waiting place with, and
 * Join no longer makes a second Danny; the server answers `name_seated`, and every join form shows this
 * in place of the line under the name (the open spot, the waiting list's form, the bar).
 *
 * The yes is a door that exists already, never a third sign-in. A record "That's me" signs in (the page
 * asked the rule: `claimable`) takes its two taps: "That's me", then "Sign in as Danny?". A record "That's
 * me" refuses gets its own doors and no other (the owner's decision of 16 October 2026, D4, `seatedDoors`):
 * the email code where it has an address, first; Telegram where it has a linked Telegram; Face ID or a
 * fingerprint where it has a passkey. With none of them, no door. The email code and Telegram need the
 * deployment's own settings (`doors`); where a form has none, those two stay away.
 *
 * "Played before as Tim? Sign in as Tim." is the same question for a name of the organiser's unreached
 * past partners (`unreached`, the owner's decision of 16 October 2026, D6): "That's me" in two taps,
 * which the server decides again at the tap.
 *
 * Under either, "I'm a different Danny" sends the same join with the flag only this button sets
 * (`onDifferent`); the name then joins as typed, and the namesake rules apply as before.
 */
export function SeatedAsk({
  code,
  typed,
  namesHere,
  claimable,
  ask,
  doors = null,
  onDifferent,
  pending = false,
}: {
  code: string;
  typed: string;
  namesHere: readonly string[];
  /** Names "That's me" signs in by name (the page asked the rule). */
  claimable: readonly string[];
  /** The server's answer for the name typed. */
  ask: NameAsk;
  /** The deployment's ways back in, for the email code and Telegram; null where the page gives none. */
  doors?: BackInDoors | null;
  onDifferent: () => void;
  pending?: boolean;
}) {
  const t = useTranslations();
  const box = useRef<HTMLDivElement>(null);
  // The question is the way back in on the page while it stands: the forms take their "Played before?" help
  // away under it (`askHasDoors`), and the line under the line-up ("Played before? Sign in", `BackInOpener`)
  // steps aside while a way back in is registered, so it never stands beside the question as a dead tap. A
  // request for the way back in (a refused "That's me") brings the question on screen.
  useEffect(
    () =>
      registerBackInHandler(() => {
        const el = box.current;
        if (el) requestAnimationFrame(() => el.scrollIntoView({ block: "center", behavior: "smooth" }));
      }),
    [],
  );
  const unreached = ask.kind === "unreached";
  const name = ask.kind === "unreached" ? ask.first : seatedNameOf(typed, namesHere);
  const thatsMe = thatsMeTapOf(ask, typed, claimable);
  const own = ask.kind === "seated" ? ask.own : null;
  const email = Boolean(own?.email && doors?.email);
  const telegram = own?.telegram && doors?.telegram ? doors.telegram : null;
  const passkey = Boolean(own?.passkey);
  return (
    <div ref={box} data-testid="seated-ask" data-ask={ask.kind} className="rounded-2xl border border-court/30 bg-card px-3 py-3 animate-pop">
      <p className="text-sm font-bold">{t(unreached ? "identity.unreachedAsk" : "identity.seatedAsk", { name })}</p>
      {thatsMe ? (
        <div className="mt-2">
          <ThatsMeButton code={code} name={thatsMe.name} label={thatsMe.label} className="btn-primary btn-sm" armedClassName="btn-primary btn-sm whitespace-normal leading-tight ring-2 ring-ink" />
        </div>
      ) : own && anyDoor(own) ? (
        // The record's own doors, the email code first (D4): never the deployment's whole set.
        <div className="mt-2 flex flex-col gap-3" data-testid="seated-doors">
          {email && (
            <div data-testid="seated-door-email">
              <p className="mb-2 text-sm text-muted">{t("identity.backInEmail")}</p>
              <RestoreWithEmail compact />
            </div>
          )}
          {telegram && (
            <div data-testid="seated-door-telegram" className={email ? "border-t border-line pt-3" : ""}>
              <p className="mb-2 text-sm text-muted">{t("identity.seatedTelegram")}</p>
              <TelegramLogin bare botId={telegram.botId} linked={false} linkedUsername={null} lang={telegram.lang} authUrl={telegram.authUrl} />
            </div>
          )}
          {passkey && (
            <div data-testid="seated-door-passkey" className={email || telegram ? "border-t border-line pt-3" : ""}>
              <PasskeySignIn className="btn-ghost btn-sm w-full whitespace-normal leading-snug" />
            </div>
          )}
        </div>
      ) : null}
      <button type="button" className="link mt-3 block text-xs font-semibold" data-testid="seated-different" disabled={pending} onClick={onDifferent}>
        {t("identity.seatedDifferent", { name })}
      </button>
    </div>
  );
}
