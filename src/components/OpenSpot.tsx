"use client";

import { useTranslations } from "next-intl";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { joinAction, reserveAction } from "@/actions/slots";
import type { LevelRange } from "@/lib/domain/levels";
import { answerKey, askFor, type PastAnswer, type PastView } from "@/lib/domain/pastAsk";
import { BackInHelp, type BackInDoors } from "./BackInHelp";
import { useOwnNameAutofill } from "./PasskeyAutofill";
import { formState, registerJoinHandler, sendForm } from "./joinBus";
import { LevelSelect } from "./LevelSelect";
import { PastAsk } from "./PastAsk";
import { HeldForYou, heldNameOf, NameHereLine } from "./TakeHeld";
import { askOf, askStanding, SeatedAsk, type NameAsk } from "./SeatedAsk";
import { normalName } from "@/lib/domain/dupes";
import { readDeviceSignals } from "@/lib/deviceSignals";

export type RolodexItem = { name: string; email: string | null; phone: string | null };
type Mode = "reserve" | "join" | "none";

/**
 * An empty roster row that expands in place — never a popup.
 *  - Organizer: name (+ optional phone/email) and Done → spot reserved; with an
 *    email the invite goes out automatically.
 *  - Anyone not in yet: joins on tap, or expands into a name field first.
 */
export function OpenSpot({
  code,
  slotId,
  mode,
  label,
  hasIdentity,
  rolodex,
  played = [],
  past = [],
  emailEnabled,
  namesHere = [],
  claimable = [],
  held = [],
  heldForMe = null,
  levelRange = null,
  myLevel = null,
  myName = null,
  backIn = null,
}: {
  code: string;
  slotId: string;
  mode: Mode;
  label: string;
  hasIdentity: boolean;
  rolodex: RolodexItem[];
  /**
   * "Played with you": the names of past players the organiser may pick for the place (the owner, 11
   * October 2026: "Yes, keep the record"). A pick keeps that player's record on the place, so no second
   * record appears; typing over the name drops the pick. Names only: the server finds the record again.
   */
  played?: readonly string[];
  /**
   * The organiser's past players as names, days and clubs (`pastViews`): a typed name one of them carries
   * asks "Is this Danny, who played with you on Sep 13 at Kross Padel?" before the place is held (the
   * owner, 12 October 2026). Yes keeps that record; No holds the place by name.
   */
  past?: readonly PastView[];
  emailEnabled: boolean;
  /** Everybody already in this match, so a returning player is recognised before they become a second row. */
  namesHere?: readonly string[];
  /** Names on this line-up that "That's me" signs in by name (DECIDING rule 34): the page asked the rule already, and those rows wear the button too. */
  claimable?: readonly string[];
  /** Names of places held on this line-up that a typed name may take (DECIDING rule 34, the held place by name): the page asked `heldVerdict` already. */
  held?: readonly string[];
  /** The browser knows a record of a held place's name (`heldOffers` for that record): the tap offers that place instead of a one-tap Join. */
  heldForMe?: string | null;
  /** Ranged event: joining asks for a level when the player has none yet. */
  levelRange?: LevelRange | null;
  myLevel?: number | null;
  /** The name of the record this browser holds: the welcome line after a sign-in from the open form. */
  myName?: string | null;
  /** For a browser that knows nobody: the ways back in, shown open under the name field ("Played before?", DECIDING rule 39). */
  backIn?: BackInDoors | null;
}) {
  const t = useTranslations();
  const errText = (error: string) =>
    error === "name_required" ? t("identity.nameRequired") : error === "level_required" ? t("errors.level_required") : error === "invalid" ? t("errors.slot_taken") : error === "full" ? t("creator.noSpots") : t(`errors.${error === "no_identity" ? "generic" : error}` as "errors.generic");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [level, setLevel] = useState<number | null>(myLevel);
  /** The past player picked from "Played with you", while the name still reads as picked. */
  const [picked, setPicked] = useState<string | null>(null);
  // A place held for a phone is that number's, and keeps no record (`reserveLocked`): a phone typed after
  // the pick turns it back into a place held by name, and the line under the name says no more than that.
  const keepsPick = picked !== null && picked === name && !phone.trim();
  /** The answer to "Is this Danny…?", for the name it was given for. */
  const [answer, setAnswer] = useState<{ key: string; answer: PastAnswer } | null>(null);
  // A typed name a past player carries asks first; a pick from the chips, or a phone (the number's own place), asks nothing.
  const asked = mode === "reserve" && !keepsPick && !phone.trim() ? askFor(past, name) : [];
  const answered = answer && answer.key === answerKey(name) ? answer.answer : undefined;
  const [error, setError] = useState<string | null>(null);
  /** The server's answer for a typed name (`name_seated`, `name_unreached`): "Sign in as Danny?" stands while the field still holds it. */
  const [nameAsk, setNameAsk] = useState<NameAsk | null>(null);
  const [pending, start] = useTransition();
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // The passkey above the keyboard, in join mode only: the organiser's "reserve" field holds another person's name.
  const own = useOwnNameAutofill();

  const reset = () => {
    setName("");
    setPhone("");
    setEmail("");
    setPicked(null);
    setAnswer(null);
    setError(null);
  };
  const expand = useCallback(() => {
    setOpen(true);
    requestAnimationFrame(() => {
      box.current?.scrollIntoView({ block: "center", behavior: "smooth" });
      input.current?.focus({ preventScroll: true });
    });
  }, []);

  const needsLevel = Boolean(levelRange) && myLevel == null;

  // The fixed Join button hands its no-identity (or no-level) case to an open row: the row whose form
  // the player opened, else the first one (`requestJoin`). A second tap, with the form open and a name in
  // it, sends the form: the same submit as the form's own Join, so every check it makes runs (the name,
  // the held place, the level). The DOM holds what the handler reads, so it registers once per state.
  const form = useRef<HTMLFormElement>(null);
  const spotState = useCallback(() => formState(form.current, input.current), []);
  const onFixedJoin = useCallback(() => {
    if (spotState() === "filled" && sendForm(form.current)) return;
    expand();
  }, [expand, spotState]);
  useEffect(() => {
    if (mode !== "join" || (hasIdentity && !needsLevel)) return;
    return registerJoinHandler(onFixedJoin, spotState);
  }, [mode, hasIdentity, needsLevel, onFixedJoin, spotState]);

  /** `different`: "I'm a different Danny", the one tap that sends the join past "Sign in as Danny?". */
  const join = (withName?: string, different = false) =>
    start(async () => {
      setError(null);
      const r = await joinAction(code, withName, level ?? undefined, undefined, { differentPerson: different || undefined, hint: await readDeviceSignals() });
      startTransition(() => {
        const asked = askOf(r, withName);
        setNameAsk(asked);
        if (!r.ok && !asked) setError(errText(r.error));
      });
    });

  /** `given`: the answer just tapped, which holds the place at once. */
  const reserve = (given?: PastAnswer) => {
    if (!name.trim()) return setError(t("identity.nameRequired"));
    const said = given ?? answered;
    // Done while "Is this Danny…?" is on screen: the question comes first.
    if (asked.length > 0 && said === undefined) return setError(t("create.askPastFirst", { name: name.trim() }));
    const pick = keepsPick ? true : asked.length > 0 && said !== undefined && said !== "new" && said !== true ? said : undefined;
    start(async () => {
      setError(null);
      const r = await reserveAction(code, { name, phone: phone || undefined, email: email || undefined, slotId, pick });
      startTransition(() => {
        if (!r.ok) setError(errText(r.error));
        else {
          reset();
          setOpen(false);
        }
      });
    });
  };

  const suggestions = useMemo(() => {
    if (mode !== "reserve") return [];
    const q = name.trim().toLowerCase();
    return (q ? rolodex.filter((r) => r.name.toLowerCase().includes(q) && r.name.toLowerCase() !== q) : rolodex).slice(0, 5);
  }, [rolodex, name, mode]);
  const pastChips = useMemo(() => {
    if (mode !== "reserve") return [];
    const q = name.trim().toLowerCase();
    return (q ? played.filter((n) => n.toLowerCase().includes(q) && n.toLowerCase() !== q) : played).slice(0, 5);
  }, [played, name, mode]);

  // Same email or phone as someone the organizer has played with: offer that name.
  const digits = (v: string) => v.replace(/\D/g, "");
  const contactMatch =
    mode === "reserve"
      ? rolodex.find((r) => (email.trim() && r.email && r.email.toLowerCase() === email.trim().toLowerCase()) || (digits(phone).length >= 6 && r.phone && digits(r.phone) === digits(phone)))
      : undefined;
  const contactHint = contactMatch && contactMatch.name.toLowerCase() !== name.trim().toLowerCase() ? contactMatch : undefined;

  const tap = () => {
    if (mode === "reserve") expand();
    // A place is held for this browser's own name: the tap offers it, never a second seat of the name.
    else if (mode === "join" && hasIdentity && !needsLevel && !heldForMe) join();
    else if (mode === "join") expand();
  };

  const avatar = <span className={`inline-grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-extrabold ${mode === "none" ? "bg-line text-muted" : "bg-court-soft text-court"}`}>{mode === "none" ? "·" : "+"}</span>;

  if (mode === "none") {
    return (
      <div className="flex items-center gap-3">
        {avatar}
        <span className="font-semibold text-muted">{label}</span>
      </div>
    );
  }

  if (!open) {
    return (
      <button type="button" className="flex w-full items-center gap-3 rounded-xl text-left" disabled={pending} onClick={tap}>
        {avatar}
        <span className="min-w-0 flex-1">
          <span className="block font-semibold text-muted">{label}</span>
          <span className="block text-xs font-semibold text-court">{pending ? t("common.working") : mode === "reserve" ? t("event.tapToReserve") : t("event.tapToJoin")}</span>
        </span>
        <span className="text-faint">›</span>
      </button>
    );
  }

  const cancel = (
    <button
      type="button"
      className="shrink-0 text-sm link"
      onClick={() => {
        reset();
        setOpen(false);
      }}
    >
      {t("common.cancel")}
    </button>
  );

  if (mode === "join" && hasIdentity && heldForMe) {
    return (
      <div ref={box} className="flex flex-col gap-2 animate-pop">
        <div className="flex items-center gap-3">
          {avatar}
          <HeldForYou code={code} name={heldForMe} />
        </div>
        <div className="flex justify-end">{cancel}</div>
      </div>
    );
  }

  // Signed in from "Played before?" under the name field (Face ID or a fingerprint, the email code): the
  // form opened for a browser that knew nobody, and the page now knows a record that needs no level. A
  // known player's tap joins at once and never opens the form, so only a sign-in gets here. The help
  // and its own welcome went with the name field, so the welcome is said here, with the one Join
  // (review, 12 October 2026: the form read "What's your level?" with no level to pick).
  if (mode === "join" && hasIdentity && !needsLevel) {
    return (
      <div ref={box} className="animate-pop" data-testid="open-spot-welcome">
        <div className="flex items-center gap-3">
          {avatar}
          <span className="min-w-0 flex-1 text-sm font-bold text-ok">✓ {t("identity.backJoinAsk", { name: myName ?? "" })}</span>
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <button type="button" className="btn-primary" disabled={pending} onClick={() => join()}>
            {pending ? t("common.working") : t("event.joinShort")}
          </button>
          {cancel}
        </div>
        {error && <p className="mt-1 text-sm font-semibold text-danger">{error}</p>}
      </div>
    );
  }

  const hasNames = name.trim().length > 0;
  // "Sign in as Danny?" while the field still holds the name the server asked about.
  const asking = mode === "join" && !hasIdentity ? askStanding(nameAsk, name) : null;
  // While the question stands, the help below steps aside: the question shows the record's own doors only (D4), or "That's me" (D6).
  const askHasDoors = Boolean(asking) && (asking?.kind === "unreached" || !claimable.some((n) => normalName(n) === normalName(name)));
  // The held place this typed name may take, under the name the organiser gave it: while it is offered, the form sends no Join.
  const heldName = mode === "join" && !hasIdentity ? heldNameOf(name, held) : undefined;
  return (
    <div ref={box} className="animate-pop">
      <div className="mb-2 flex items-center gap-3">
        {avatar}
        <span className="text-sm font-bold text-court">{mode === "reserve" ? t("creator.reserveInline") : hasIdentity ? t("level.pickTitle") : t("identity.whatsYourName")}</span>
      </div>
      <form
        ref={form}
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          // A typed name and Join, as before: the passkey's request waiting in the field ends first.
          if (mode === "join") own.stop();
          if (mode === "reserve") reserve();
          else if (!hasIdentity && !hasNames) setError(t("identity.nameRequired"));
          // The Go key and Join while "Take Danny's held place" is on screen: a second Danny would close the place for good.
          else if (heldName) setError(t("errors.name_held"));
          else if (levelRange && level == null) setError(t("errors.level_required"));
          else join(hasIdentity ? undefined : name);
        }}
      >
        <div className="flex gap-2">
          {(mode === "reserve" || !hasIdentity) && (
            <input
              ref={input}
              data-testid="open-spot-name"
              className="input"
              placeholder={mode === "reserve" ? t("creator.name") : t("identity.namePlaceholder")}
              value={name}
              autoComplete={mode === "reserve" ? "off" : own.autoComplete}
              onFocus={mode === "join" ? own.onFocus : undefined}
              maxLength={40}
              enterKeyHint={mode === "reserve" ? "done" : "go"}
              onChange={(e) => {
                setName(e.target.value);
                if (picked !== null && e.target.value !== picked) setPicked(null);
              }}
            />
          )}
          {mode === "join" && levelRange && <LevelSelect value={level} onChange={setLevel} />}
          <button type="submit" className="btn-primary shrink-0" disabled={pending}>
            {pending ? t("common.working") : mode === "reserve" ? t("creator.reserveDone") : t("event.joinShort")}
          </button>
        </div>
        {/*
          The duplicate is born here: a friend's link opens in a browser that has never seen the player,
          who types the name they always type. A real namesake must still be able to join, so the line
          stays under the field and the field is untouched (`NameHereLine`). A held place of the name is
          the exception: the form sends no Join while it is offered, and a namesake adds a last name. A
          crew member who is not on this line-up joins, and is then offered the fold into their old record.
        */}
        {mode === "join" && !hasIdentity && own.note}
        {asking ? (
          <SeatedAsk code={code} typed={name} namesHere={namesHere} claimable={claimable} ask={asking} doors={backIn} pending={pending} onDifferent={() => join(name, true)} />
        ) : (
          mode === "join" && !hasIdentity && <NameHereLine code={code} name={name} namesHere={namesHere} claimable={claimable} held={held} />
        )}
        {mode === "reserve" && asked.length > 0 && answered === undefined && (
          <PastAsk
            name={name.trim()}
            options={asked}
            disabled={pending}
            onAnswer={(a) => {
              setAnswer({ key: answerKey(name), answer: a });
              reserve(a);
            }}
          />
        )}
        {mode === "reserve" && keepsPick && (
          <p className="text-xs font-semibold text-ok" data-testid="picked-past-player">
            ✓ {t("creator.keepsRecord", { name })}
          </p>
        )}
        {mode === "reserve" && pastChips.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5" data-testid="played-with-you">
            <span className="text-xs font-bold uppercase tracking-wider text-faint">{t("creator.playedWithYou")}</span>
            {pastChips.map((n) => (
              <button
                key={n}
                type="button"
                className="chip-muted min-h-9 px-3 text-sm"
                onClick={() => {
                  setName(n);
                  setPhone("");
                  setEmail("");
                  setPicked(n);
                  input.current?.focus({ preventScroll: true });
                }}
              >
                {n}
              </button>
            ))}
          </div>
        )}
        {mode === "reserve" && suggestions.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((r) => (
              <button
                key={r.name}
                type="button"
                className="chip-muted min-h-9 px-3 text-sm"
                onClick={() => {
                  setName(r.name);
                  setPicked(null);
                  setPhone(r.phone ?? "");
                  setEmail(r.email ?? "");
                  input.current?.focus({ preventScroll: true });
                }}
              >
                {r.name}
                {r.email || r.phone ? " ·" : ""} {r.phone ? "📱" : ""}
                {r.email ? "✉️" : ""}
              </button>
            ))}
          </div>
        )}
        {mode === "reserve" && (
          <div className="grid grid-cols-2 gap-2">
            <input className="input min-h-11 text-sm" type="tel" inputMode="tel" autoComplete="off" placeholder={`${t("creator.phone")} (${t("common.optional")})`} value={phone} onChange={(e) => setPhone(e.target.value)} />
            {emailEnabled && <input className="input min-h-11 text-sm" type="email" inputMode="email" autoComplete="off" placeholder={`${t("creator.email")} (${t("common.optional")})`} value={email} onChange={(e) => setEmail(e.target.value)} />}
          </div>
        )}
        {contactHint && (
          <button type="button" className="self-start rounded-xl bg-accent-soft px-3 py-2 text-left text-sm font-semibold" onClick={() => setName(contactHint.name)}>
            {t("creator.sameContact", { kind: contactHint.email && contactHint.email.toLowerCase() === email.trim().toLowerCase() ? t("creator.email").toLowerCase() : t("creator.phone").toLowerCase(), name: contactHint.name })}
          </button>
        )}
        <div className="flex items-center justify-between gap-2">
          {error ? <span className="text-sm font-semibold text-danger">{error}</span> : <span className="text-xs text-faint">{mode === "reserve" ? t("creator.reserveSheetHelp") : levelRange ? t("level.pickHelp") : t("identity.nameHelp")}</span>}
          {cancel}
        </div>
      </form>
      {mode === "join" && !hasIdentity && backIn && !askHasDoors && <BackInHelp doors={backIn} />}
    </div>
  );
}
