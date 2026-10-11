"use client";

import { useTranslations } from "next-intl";
import { startTransition, useState, useTransition } from "react";
import { takeHeldPlaceAction } from "@/actions/slots";
import { nameIsHere, normalName } from "@/lib/domain/dupes";
import { requestBackIn } from "./backInBus";
import { ThatsMeButton, useTwoTap } from "./ThatsMe";

/**
 * "Take Danny's held place" (DECIDING rule 34, the owner, 11 October 2026): two taps fill the place
 * the organiser held for this name, from the plain match link. The first tap asks "Take Danny's held
 * place?" and sends nothing; a tap anywhere else takes the question back (`useTwoTap`). The page shows
 * it only where `heldVerdict` said yes, and the action asks again under the match's lock.
 */
export function TakeHeldButton({
  code,
  name,
  className = "link text-sm font-semibold",
  armedClassName = "link text-sm font-extrabold text-ink",
}: {
  code: string;
  name: string;
  className?: string;
  armedClassName?: string;
}) {
  const t = useTranslations();
  const [pending, start] = useTransition();
  const { armed, setArmed, ref } = useTwoTap<HTMLButtonElement>();
  const [error, setError] = useState<string | null>(null);
  const tap = () => {
    if (!armed) {
      setError(null);
      setArmed(true);
      return;
    }
    setArmed(false);
    start(async () => {
      const r = await takeHeldPlaceAction(code, name);
      startTransition(() => {
        if (!r.ok) setError(r.error === "too_many" ? t("errors.too_many") : t("identity.takeHeldNo", { name }));
      });
    });
  };
  return (
    <>
      <button ref={ref} type="button" data-testid="take-held" data-armed={armed ? "true" : undefined} className={armed ? armedClassName : className} disabled={pending} onClick={tap} onBlur={() => setArmed(false)}>
        {pending ? t("common.working") : armed ? t("identity.takeHeldSure", { name }) : t("identity.takeHeld", { name })}
      </button>
      {error && (
        <span role="status" className="block text-xs font-semibold text-danger">
          {error}
        </span>
      )}
    </>
  );
}

/** The held place a typed name may take, as the organiser typed it: one of `held`, the names the page's `heldOffers` gave. */
export const heldNameOf = (typed: string, held: readonly string[]): string | undefined => {
  const n = normalName(typed);
  return n.length < 2 ? undefined : held.find((h) => normalName(h) === n);
};

/**
 * Under a typed name that is already in this match, wherever a name is typed to join (the open spot,
 * the waiting list's form on a full match, the bar). The duplicate is born here: a friend's link opens
 * in a browser that has never seen the player, who types the name they always type. So the line says
 * the name is here and offers the way back, quietly, with the name field untouched. A record the rule
 * lets in by name signs in with "That's me" (DECIDING rule 34); a place held for the name with nothing
 * else on it is taken with "Take Danny's held place", in two taps, and the form then sends no Join
 * (`heldNameOf`), because a second record of the name would close the place to its name for good; any
 * other name opens the way back in that needs proof.
 */
export function NameHereLine({ code, name, namesHere, claimable, held }: { code: string; name: string; namesHere: readonly string[]; claimable: readonly string[]; held: readonly string[] }) {
  const t = useTranslations();
  if (!nameIsHere(name, namesHere)) return null;
  const heldName = heldNameOf(name, held);
  return (
    <p data-testid="already-here" className="text-sm text-muted">
      {t("identity.alreadyHere", { name: name.trim() })}{" "}
      {nameIsHere(name, claimable) ? (
        <ThatsMeButton code={code} name={name.trim()} className="link font-semibold" armedClassName="link font-extrabold text-ink" />
      ) : heldName ? (
        <TakeHeldButton code={code} name={heldName} />
      ) : (
        <button type="button" className="link font-semibold" onClick={() => requestBackIn()}>
          {t("identity.thatsMe")}
        </button>
      )}
    </p>
  );
}

/**
 * For a browser that knows a record of the held name, with no place in the match (DECIDING rule 34):
 * the held place, offered in place of its one-tap Join, which would seat a second record of the name
 * beside the place and close it to its name for good. Two taps, as for a typed name.
 */
export function HeldForYou({ code, name }: { code: string; name: string }) {
  const t = useTranslations();
  return (
    <p data-testid="held-for-you" className="text-sm text-muted">
      {t("identity.heldForYou", { name })} <TakeHeldButton code={code} name={name} />
    </p>
  );
}
