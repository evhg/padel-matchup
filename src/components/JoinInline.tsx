"use client";

import { useTranslations } from "next-intl";
import { startTransition, useEffect, useRef, useState, useTransition } from "react";
import { joinAction } from "@/actions/slots";
import type { LevelRange } from "@/lib/domain/levels";
import { BackInHelp, type BackInDoors } from "./BackInHelp";
import { formState, registerJoinHandler, sendForm } from "./joinBus";
import { LevelSelect } from "./LevelSelect";
import { useOwnNameAutofill } from "./PasskeyAutofill";
import { heldNameOf, NameHereLine } from "./TakeHeld";
import { askOf, askStanding, SeatedAsk, type NameAsk } from "./SeatedAsk";
import { normalName } from "@/lib/domain/dupes";
import { readDeviceSignals } from "@/lib/deviceSignals";

/**
 * In-flow name (and level, on ranged events) entry for joining the waitlist without an identity: the
 * waiting list's form of a full match. A typed name already in the match gets the same line as the open
 * spot (`NameHereLine`): "That's me", or "Take Danny's held place", and then the form sends no Join, so
 * a second Danny never waits beside his held place (DECIDING rule 34).
 */
export function JoinInline({
  code,
  label,
  hasIdentity = false,
  levelRange = null,
  myLevel = null,
  namesHere = [],
  claimable = [],
  held = [],
  backIn = null,
}: {
  code: string;
  label: string;
  hasIdentity?: boolean;
  levelRange?: LevelRange | null;
  myLevel?: number | null;
  /** Everybody already in this match, held places too. */
  namesHere?: readonly string[];
  /** Names "That's me" signs in by name (the page asked the rule). */
  claimable?: readonly string[];
  /** Names of held places a typed name may take (`heldOffers`). */
  held?: readonly string[];
  /** For a browser that knows nobody: the ways back in, open under the name field (DECIDING rule 39). */
  backIn?: BackInDoors | null;
}) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [level, setLevel] = useState<number | null>(myLevel);
  const [error, setError] = useState<string | null>(null);
  /** The server's answer for a typed name: `name_seated` or `name_unreached` ("Sign in as Danny?"). */
  const [nameAsk, setNameAsk] = useState<NameAsk | null>(null);
  const [pending, start] = useTransition();
  const box = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // The passkey above the keyboard in the player's own name field.
  const own = useOwnNameAutofill();

  // The fixed Join button: a second tap, with the form open and a name in it, sends the form through its
  // own checks (the name, the held place, the level), as the form's own Join does. Before that it opens
  // the form. The DOM holds the state the handler needs, so it registers once and keeps its place.
  useEffect(
    () =>
      registerJoinHandler(
        () => {
          if (formState(box.current, input.current) === "filled" && sendForm(box.current)) return;
          setOpen(true);
          requestAnimationFrame(() => {
            box.current?.scrollIntoView({ block: "center", behavior: "smooth" });
            input.current?.focus({ preventScroll: true });
          });
        },
        () => formState(box.current, input.current),
      ),
    [],
  );

  if (!open) return null;
  const askLevel = Boolean(levelRange) && level == null;
  /** `different`: "I'm a different Danny", the one tap that sends the join past "Sign in as Danny?". */
  const send = (different = false) =>
    start(async () => {
      setError(null);
      const typed = hasIdentity ? undefined : name;
      const r = await joinAction(code, typed, level ?? undefined, undefined, { differentPerson: different || undefined, hint: readDeviceSignals() });
      startTransition(() => {
        const asked = askOf(r, typed);
        setNameAsk(asked);
        if (!r.ok && !asked) setError(r.error === "level_required" ? t("errors.level_required") : t(`errors.${r.error === "name_required" || r.error === "no_identity" ? "generic" : r.error}` as "errors.generic"));
      });
    });
  // "Sign in as Danny?" while the field still holds the name the server asked about; with the record's own doors in it when "That's me" cannot sign it in.
  const asking = hasIdentity ? null : askStanding(nameAsk, name);
  // While the question stands, the general "Played before?" help steps aside: the question shows the record's own doors only (D4).
  const askHasDoors = Boolean(asking) && (asking?.kind === "unreached" || !claimable.some((n) => normalName(n) === normalName(name)));
  return (
    <div className="mt-4">
      <form
        ref={box}
        className="rounded-2xl border border-court/30 bg-court-soft/40 p-3 animate-pop"
        onSubmit={(e) => {
          e.preventDefault();
          // A typed name and the button, as before: the passkey's request waiting in the field ends first.
          own.stop();
          if (!hasIdentity && !name.trim()) return setError(t("identity.nameRequired"));
          // The Go key and the button while "Take Danny's held place" is on screen: a second Danny would close the place for good.
          if (!hasIdentity && heldNameOf(name, held)) return setError(t("errors.name_held"));
          if (levelRange && level == null) return setError(t("errors.level_required"));
          send();
        }}
      >
        <div className="text-sm font-bold text-court">{hasIdentity ? t("level.pickTitle") : t("identity.whatsYourName")}</div>
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex gap-2">
            {!hasIdentity && <input ref={input} data-testid="waitlist-name" className="input" placeholder={t("identity.namePlaceholder")} value={name} autoComplete={own.autoComplete} onFocus={own.onFocus} maxLength={40} enterKeyHint="go" onChange={(e) => setName(e.target.value)} />}
            {(askLevel || (levelRange && !hasIdentity)) && <LevelSelect value={level} onChange={setLevel} />}
            <button type="submit" className="btn-primary shrink-0" disabled={pending}>
              {pending ? t("common.working") : label}
            </button>
          </div>
          {!hasIdentity && own.note}
          {asking ? (
            <SeatedAsk code={code} typed={name} namesHere={namesHere} claimable={claimable} ask={asking} doors={backIn} pending={pending} onDifferent={() => send(true)} />
          ) : (
            !hasIdentity && <NameHereLine code={code} name={name} namesHere={namesHere} claimable={claimable} held={held} />
          )}
        </div>
        {error ? <p className="mt-1 text-sm font-semibold text-danger">{error}</p> : <p className="mt-1 text-xs text-faint">{levelRange ? t("level.pickHelp") : t("identity.nameHelp")}</p>}
      </form>
      {!hasIdentity && backIn && !askHasDoors && <BackInHelp doors={backIn} />}
    </div>
  );
}
