"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { startTransition, useState, useTransition } from "react";
import { thatsMeAction } from "@/actions/identity";
import { heldRowDoorsAction, joinAction, takeHeldPlaceAction, takeHeldRecordAction } from "@/actions/slots";
import { nameIsHere, normalName } from "@/lib/domain/dupes";
import type { HeldRowOffer } from "@/lib/domain/heldRow";
import { readDoors, type OwnDoors } from "@/lib/domain/seatedDoors";
import type { BackInDoors } from "./BackInHelp";
import { requestBackIn } from "./backInBus";
import { OwnDoorList } from "./SeatedAsk";
import { ThatsMeButton, useTwoTap } from "./ThatsMe";
import { readDeviceSignals } from "@/lib/deviceSignals";

/**
 * "Take Danny's held place" (DECIDING rule 34, the owner, 11 October 2026): two taps fill the place
 * the organiser held for this name, from the plain match link, under a typed name. The first tap asks
 * "Take Danny's held place?" and sends nothing; a tap anywhere else takes the question back
 * (`useTwoTap`). The page shows it only where `heldVerdict` said yes, and the action asks again under
 * the match's lock. Since the owner's decision C of 6 November 2026 the held row itself has "I'm Danny",
 * one tap (`HeldRowButton`); this typed way stays as the second way, with its two taps.
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
      const r = await takeHeldPlaceAction(code, name, await readDeviceSignals());
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
 * other name opens the way back in that needs proof. The held row itself shows "I'm Danny" since 6
 * November 2026 (`HeldRowButton`, the owner's decision C); this line is the second way, for a typed name.
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
 * beside the place and close it to its name for good. Two taps, as for a typed name. A different
 * person of the same name is told the way in: a last name on My matches, then Join (`name_held`
 * refuses the plain join until then).
 */
export function HeldForYou({ code, name }: { code: string; name: string }) {
  const t = useTranslations();
  return (
    <div data-testid="held-for-you" className="text-sm text-muted">
      <p>
        {t("identity.heldForYou", { name })} <TakeHeldButton code={code} name={name} />
      </p>
      <Link href="/me" prefetch={false} className="link text-xs" data-testid="held-not-you">
        {t("identity.heldNotYou", { name })}
      </Link>
    </div>
  );
}

/**
 * "I'm Danny" on a held row (DECIDING rule 34, the owner's decision C of 6 November 2026: "Every player
 * confirms with one tap, also in a new browser"). One tap acts; there is no armed state. The page sends the
 * kind and nothing else (`heldRowOffers`), and the server asks every rule again at the tap:
 *   - `by_name`: the place held by name (`takeHeldPlaceAction`, counted as a take from the row);
 *   - `record`: the held record "That's me" signs in, signed in by name and the place taken in one request
 *     (`takeHeldRecordAction`);
 *   - `doors`: a held record that proves itself. The tap opens a panel under the row with that record's
 *     own doors, read at the tap for this one name (`heldRowDoorsAction`, the owner's decision D4 of 16
 *     October 2026). After the proof the page knows Danny, and the row offers `mine`;
 *   - `fold`: this browser's own new record folds into the held record (`thatsMeAction`);
 *   - `mine`: the place keeps this browser's own record (`joinAction`).
 * The doors panel takes the whole width under the row (`basis-full`), so the row's line wraps.
 */
export function HeldRowButton({ code, offer, doors }: { code: string; offer: HeldRowOffer; doors: BackInDoors | null }) {
  const t = useTranslations();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  /** The record's own doors, read once at the first open; the panel then opens and closes with no read. */
  const [own, setOwn] = useState<OwnDoors | null>(null);
  const [open, setOpen] = useState(false);
  const refused = (error: string) => (error === "too_many" ? t("errors.too_many") : t("identity.takeHeldNo", { name: offer.name }));
  const joinError = (error: string) =>
    error === "level_required" ? t("errors.level_required") : error === "invalid" ? t("errors.slot_taken") : error === "full" ? t("creator.noSpots") : t(`errors.${error === "no_identity" ? "generic" : error}` as "errors.generic");

  const tap = () => {
    setError(null);
    if (offer.kind === "doors") {
      if (own) return setOpen((o) => !o);
      return start(async () => {
        const r = await heldRowDoorsAction(code, offer.name);
        startTransition(() => {
          if (r.ok) {
            setOwn(readDoors(r.data.doors));
            setOpen(true);
          } else if (r.error === "too_many") setError(t("errors.too_many"));
          else requestBackIn();
        });
      });
    }
    start(async () => {
      const hint = await readDeviceSignals();
      const r =
        offer.kind === "by_name"
          ? await takeHeldPlaceAction(code, offer.name, hint, "row")
          : offer.kind === "record"
            ? await takeHeldRecordAction(code, offer.name, hint)
            : offer.kind === "fold"
              ? await thatsMeAction(code, offer.name, hint)
              : await joinAction(code, undefined, undefined, undefined, { hint });
      startTransition(() => {
        if (r.ok) return;
        setError(offer.kind === "mine" ? joinError(r.error) : refused(r.error));
        // The record changed between the page and the tap: the way back in that needs proof opens, as for "That's me".
        if (offer.kind === "record" && r.error !== "too_many") requestBackIn();
      });
    });
  };

  return (
    <>
      {/* A long name wraps inside the button and never pushes it past the row at 390 px: `btn` keeps one line. */}
      <div className="max-w-full shrink-0 text-right">
        <button type="button" data-testid="held-row" data-kind={offer.kind} aria-expanded={offer.kind === "doors" ? open : undefined} className="btn-ghost btn-xs max-w-full shrink-0 whitespace-normal py-1.5 leading-tight [overflow-wrap:anywhere]" disabled={pending} onClick={tap}>
          {pending ? t("common.working") : t("identity.heldRowMe", { name: offer.name })}
        </button>
      </div>
      {error && (
        <p role="status" className="basis-full text-xs font-semibold text-danger">
          {error}
        </p>
      )}
      {offer.kind === "doors" && open && own && (
        <div className="basis-full animate-pop" data-testid="held-prove">
          <p className="text-sm font-bold">{t("identity.heldRowProve", { name: offer.name })}</p>
          <OwnDoorList own={own} doors={doors} testid="held" />
        </div>
      )}
    </>
  );
}
