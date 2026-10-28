"use client";

import { useTranslations } from "next-intl";
import { startTransition, useEffect, useRef, useState, useTransition } from "react";
import { joinAction, leaveAction, withdrawJoinRequestAction } from "@/actions/slots";
import { askLevelCheckAction } from "@/actions/verify";
import { formatLevel, joinBarLevel, joinStep, type LevelRange, type RangeWaiver } from "@/lib/domain/levels";
import { requestJoin } from "./joinBus";
import { PasskeySignIn } from "./PasskeySignIn";
import { useOwnNameAutofill } from "./PasskeyAutofill";
import { LevelSelect } from "./LevelSelect";
import { HeldForYou, heldNameOf, NameHereLine } from "./TakeHeld";
import { askOf, askStanding, SeatedAsk, type NameAsk } from "./SeatedAsk";
import type { BackInDoors } from "./BackInHelp";

export type JoinState = "join" | "join_waitlist" | "leave" | "leave_waitlist" | "member_live" | "full" | "cancelled" | "past" | "requested" | "request_declined";
/** Someone who can confirm the viewer's level for this event: a coach at the club, or the club. */
export type VerifierDTO = { key: string; name: string; target: { coachId: string } | { clubSlug: string } };

export function JoinBar({
  code,
  state,
  hasIdentity,
  spotsLeft,
  waitlistPosition,
  isTournament,
  levelRange = null,
  rangeText = "",
  myLevel = null,
  organizerName = "",
  verifiedOnly = false,
  verified = false,
  verifiers = [],
  asked = [],
  fixedPairs = false,
  partnerName = null,
  partnerGoes = false,
  pairsLocked = false,
  tellGroupHref = null,
  rangeWaived = null,
  openJoin = false,
  namesHere = [],
  claimable = [],
  held = [],
  heldForMe = null,
  backIn = null,
}: {
  code: string;
  state: JoinState;
  hasIdentity: boolean;
  spotsLeft: number;
  waitlistPosition: number;
  isTournament: boolean;
  /** Level range of the event (null = open to everyone). */
  levelRange?: LevelRange | null;
  /** The range, already worded ("3.0–4.5"). */
  rangeText?: string;
  myLevel?: number | null;
  organizerName?: string;
  /** The event takes confirmed levels only. */
  verifiedOnly?: boolean;
  /** The viewer's level carries a tick. */
  verified?: boolean;
  verifiers?: VerifierDTO[];
  /** Keys of verifiers the viewer already asked. */
  asked?: string[];
  /** A fixed-pairs night (decision F): the join takes a partner's name, and leaving says what happens to the partner. */
  fixedPairs?: boolean;
  /** The viewer's partner on such a night, or null while they have none. */
  partnerName?: string | null;
  /** The partner is still only the name the viewer gave: leaving takes that reserved spot too. */
  partnerGoes?: boolean;
  /** Round 1 is drawn: the pairs are the field, and no partner is added any more. */
  pairsLocked?: boolean;
  /**
   * WhatsApp's share with the line-up typed, for a player who is in: the trip out of the group ends
   * back in it. A ghost button beside Leave, so it never competes with a primary action (DECIDING rule 1).
   */
  tellGroupHref?: string | null;
  /**
   * The organiser already played a finished, scored match with the viewer, so the range does not hold
   * them (DECIDING rules 21 and 37): "ok" lets them in, "unverified" still asks for a confirmed level.
   */
  rangeWaived?: RangeWaiver;
  /**
   * The page was opened from an "I'm in" outside Telegram (`?join=1`, `playAgainJoinUrl`): the join step
   * opens by itself, as after a tap on Join. It never joins: a link that a mail scanner follows seats nobody.
   */
  openJoin?: boolean;
  /** Everybody already in this match, held places too: a typed name among them gets the line that offers the way back. */
  namesHere?: readonly string[];
  /** Names "That's me" signs in by name (the page asked the rule). */
  claimable?: readonly string[];
  /** Names of held places a typed name may take (`heldOffers`): the form sends no Join while one is offered. */
  held?: readonly string[];
  /**
   * The browser knows a record of a held place's name, with no place in the match (DECIDING rule 34):
   * Join offers "Take Danny's held place" instead of seating a second Danny, on a full match too.
   */
  heldForMe?: string | null;
  /** For a browser that knows nobody: the deployment's ways back in, so "Sign in as Danny?" can show the record's own email code and Telegram (D4). */
  backIn?: BackInDoors | null;
}) {
  const t = useTranslations();
  const [inline, setInline] = useState(false);
  const [name, setName] = useState("");
  const [level, setLevel] = useState<number | null>(myLevel);
  const [error, setError] = useState<string | null>(null);
  /** The server's answer for a typed name (`name_seated`, `name_unreached`: "Sign in as Danny?"). */
  const [nameAsk, setNameAsk] = useState<NameAsk | null>(null);
  const [askedKeys, setAskedKeys] = useState<string[]>(asked);
  const [pending, start] = useTransition();
  // Fixed pairs: the partner's name on the way in, or later for a player who came alone; and who leaves.
  const [partner, setPartner] = useState("");
  const [addingPartner, setAddingPartner] = useState(false);
  // The passkey above the keyboard, on the player's own name field only: never on the partner's.
  const own = useOwnNameAutofill();

  // Outside the range, or inside it with only a declared level where the event wants a confirmed one;
  // the same answer the server gives, a past game with the organiser included.
  const { needsLevel, outOfRange, unverified } = joinBarLevel({ range: levelRange, level: myLevel, verifiedOnly, verified, waived: rangeWaived });

  // State updates after an awaited server action are wrapped in startTransition
  // so they join the router's transition instead of interrupting it (React 19).
  // `different`: "I'm a different Danny", the one tap that sends the join past "Sign in as Danny?".
  const join = (withName?: string, withLevel?: number | null, withPartner?: string, different = false) =>
    start(async () => {
      setError(null);
      const r = await joinAction(code, withName, withLevel ?? undefined, withPartner?.trim() || undefined, different ? { differentPerson: true } : undefined);
      startTransition(() => {
        const asked = askOf(r, withName);
        setNameAsk(asked);
        if (asked) return;
        if (!r.ok) setError(r.error === "name_required" ? t("identity.nameRequired") : r.error === "level_required" ? t("errors.level_required") : t(`errors.${r.error === "no_identity" ? "generic" : r.error}` as "errors.generic"));
        // A player already in alone named a partner and no seat was free: still in, alone.
        else if (withPartner && r.data.outcome === "already_in" && !r.data.partner) setError(t("pairs.noSeat"));
        else if (r.data.outcome === "full") setError(t("errors.full"));
        else {
          setInline(false);
          setAddingPartner(false);
          setPartner("");
        }
      });
    });

  const leave = () => {
    // On a fixed-pairs night the question says what happens to the partner. A place on the waiting list
    // is no spot that goes to the next player: its own question.
    const question =
      fixedPairs && partnerName
        ? t(partnerGoes ? "pairs.leaveWithName" : "pairs.leaveKeepsPartner", { name: partnerName })
        : state === "leave_waitlist"
          ? t("event.leaveWaitlistConfirm")
          : t("event.leaveConfirm");
    if (!confirm(question)) return;
    start(async () => {
      const r = await leaveAction(code);
      startTransition(() => {
        if (!r.ok) setError(t(`errors.${r.error === "name_required" || r.error === "no_identity" || r.error === "level_required" ? "generic" : r.error}` as "errors.generic"));
      });
    });
  };

  const withdraw = () =>
    start(async () => {
      const r = await withdrawJoinRequestAction(code);
      startTransition(() => {
        if (!r.ok) setError(t("errors.generic"));
      });
    });

  const ask = (v: VerifierDTO) =>
    start(async () => {
      const r = await askLevelCheckAction(code, v.target);
      startTransition(() => {
        if (!r.ok) setError(r.error === "too_many" ? t("errors.too_many") : t("errors.generic"));
        else setAskedKeys((k) => (k.includes(v.key) ? k : [...k, v.key]));
      });
    });

  // "Sign in as Danny?" while the field still holds the name the server asked about; the ask carries the record's own doors.
  const asking = hasIdentity ? null : askStanding(nameAsk, name);

  // What Join does for this viewer (`joinStep`): the held place, the bar's form, Join itself, or the open spot.
  const step = joinStep({ heldForMe: Boolean(heldForMe), fixedPairs, hasIdentity, needsLevel });
  const joinButton = useRef<HTMLButtonElement>(null);

  // "I'm in" from a message: open the step the Join button opens, once, after the open spots below
  // registered (their effects run before this one, which sits after them on the page). For a known
  // player who needs no level, Join itself is the step: one tap under its own words, and no form that
  // would ask for a level, send one, or say "Join" where the bar says "Ask to join".
  const opened = useRef(false);
  useEffect(() => {
    if (!openJoin || opened.current || (state !== "join" && state !== "join_waitlist")) return;
    opened.current = true;
    if (step === "held" || step === "form") setInline(true);
    else if (step === "tap") joinButton.current?.focus();
    else if (!requestJoin()) setInline(true);
  }, [openJoin, state, step]);

  if (state === "cancelled" || state === "past") return null;

  const joinLabel = outOfRange || unverified ? t("level.askToJoin") : state === "join_waitlist" ? t("event.joinWaitlist") : isTournament ? t("event.joinTournament") : t("event.join");

  // No identity yet (or no level yet on a ranged event): expand an in-flow spot
  // instead of opening a sheet (fixed overlays drift off screen on iOS once the keyboard shows).
  const onJoin = () => {
    // A place held for this browser's own name: Join offers it, never a second seat of the name. A
    // fixed-pairs night always asks for the partner's name first (it may stay empty).
    if (step === "held" || step === "form") return setInline(true);
    if (step === "tap") return join();
    if (!requestJoin()) setInline(true);
  };

  return (
    <>
      <div className="h-28" aria-hidden />
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg/95 backdrop-blur supports-[backdrop-filter]:bg-bg/80" style={{ boxShadow: "var(--shadow-bar)" }}>
        <div className="mx-auto flex w-full max-w-xl items-center gap-3 px-4 pb-[max(env(safe-area-inset-bottom),12px)] pt-3">
          {(state === "join" || state === "join_waitlist") && (
            <div className="flex w-full flex-col gap-1">
              {inline && heldForMe ? (
                <div className="flex items-center justify-between gap-2">
                  <HeldForYou code={code} name={heldForMe} />
                  <button type="button" className="shrink-0 text-sm link" onClick={() => setInline(false)}>
                    {t("common.cancel")}
                  </button>
                </div>
              ) : inline ? (
                <form
                  className="flex flex-col gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    // A typed name and Join, as before: the passkey's request waiting in the field ends first.
                    own.stop();
                    if (!hasIdentity && !name.trim()) return setError(t("identity.nameRequired"));
                    // The Go key and Join while "Take Danny's held place" is on screen: a second Danny would close the place for good.
                    if (!hasIdentity && heldNameOf(name, held)) return setError(t("errors.name_held"));
                    if (levelRange && level == null) return setError(t("errors.level_required"));
                    join(hasIdentity ? undefined : name, level, fixedPairs ? partner : undefined);
                  }}
                >
                  {fixedPairs && (
                    <>
                      <input className="input" autoFocus={hasIdentity} value={partner} onChange={(e) => setPartner(e.target.value)} placeholder={t("pairs.partnerName")} aria-label={t("pairs.partnerName")} autoComplete="off" maxLength={40} data-testid="partner-name" />
                      <p className="text-xs text-muted">{t("pairs.joinHint")}</p>
                    </>
                  )}
                  <div className="flex gap-2">
                    {!hasIdentity && <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} onFocus={own.onFocus} placeholder={t("identity.namePlaceholder")} autoComplete={own.autoComplete} maxLength={40} enterKeyHint="go" data-testid="join-bar-name" />}
                    {levelRange && <LevelSelect value={level} onChange={setLevel} />}
                    <button type="submit" className="btn-primary shrink-0" disabled={pending}>
                      {pending ? t("common.working") : t("event.joinShort")}
                    </button>
                  </div>
                  {!hasIdentity && own.note}
                  {asking ? (
                    <SeatedAsk code={code} typed={name} namesHere={namesHere} claimable={claimable} ask={asking} doors={backIn} pending={pending} onDifferent={() => join(name, level, fixedPairs ? partner : undefined, true)} />
                  ) : (
                    !hasIdentity && <NameHereLine code={code} name={name} namesHere={namesHere} claimable={claimable} held={held} />
                  )}
                  {/* Played before: Face ID or a fingerprint, in one line, where the bar is the join form (DECIDING rule 39). */}
                  {!hasIdentity && !asking && <PasskeySignIn className="btn-ghost btn-sm w-full whitespace-normal leading-snug" />}
                </form>
              ) : (
                <button ref={joinButton} type="button" className="btn-primary w-full text-lg" disabled={pending} onClick={onJoin}>
                  {pending ? t("common.working") : joinLabel}
                </button>
              )}
              <div className="flex justify-between gap-2 text-xs font-semibold text-muted">
                <span>{outOfRange && myLevel != null ? t("level.outOfRange", { level: formatLevel(myLevel), range: rangeText }) : unverified && myLevel != null ? t(rangeWaived === "unverified" ? "levelCheck.gateWaived" : "levelCheck.gate", { level: formatLevel(myLevel) }) : state === "join" ? t("event.spotsLeft", { count: spotsLeft }) : t("event.waitlistHelp")}</span>
                {error && <span className="text-danger">{error}</span>}
              </div>
            </div>
          )}
          {state === "requested" && (
            <>
              <div className="min-w-0 flex-1">
                <div className="text-base font-extrabold">✋ {t("level.requestSent")}</div>
                <div className="text-xs text-muted">{t("level.requestSentHelp", { name: organizerName })}</div>
                {fixedPairs && <div className="text-xs text-muted">{t("pairs.requestPartner")}</div>}
                {unverified &&
                  (verifiers.length > 0 ? (
                    <div className="mt-1.5 flex flex-wrap gap-1.5" data-testid="ask-verifiers">
                      {verifiers.map((v) =>
                        askedKeys.includes(v.key) ? (
                          <span key={v.key} className="chip-open">
                            {t("levelCheck.askedVerifier", { name: v.name })}
                          </span>
                        ) : (
                          <button key={v.key} type="button" className="btn-ghost btn-xs" disabled={pending} onClick={() => ask(v)}>
                            {t("levelCheck.askVerifier", { name: v.name })}
                          </button>
                        ),
                      )}
                    </div>
                  ) : (
                    <div className="text-xs text-muted">{t("levelCheck.noVerifier")}</div>
                  ))}
                {error && <div className="text-xs text-danger">{error}</div>}
              </div>
              <button type="button" className="btn-ghost btn-sm" disabled={pending} onClick={withdraw}>
                {t("level.withdraw")}
              </button>
            </>
          )}
          {state === "request_declined" && <div className="flex-1 text-sm font-bold text-muted">{t("level.requestDeclined", { name: organizerName })}</div>}
          {state === "leave" && (
            <>
              <div className="min-w-0 flex-1">
                <div className="truncate text-base font-extrabold text-ok">✓ {fixedPairs ? (partnerName ? t("pairs.youAreInWith", { name: partnerName }) : t("pairs.youAreInAlone")) : t("event.youAreIn")}</div>
                {/* Came alone: the partner's name now, the way the join takes it. */}
                {fixedPairs && !partnerName && !pairsLocked && (addingPartner ? (
                  <form
                    className="mt-1 flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (partner.trim()) join(undefined, undefined, partner);
                    }}
                  >
                    <input className="input min-h-10 min-w-0 flex-1 text-sm" autoFocus value={partner} onChange={(e) => setPartner(e.target.value)} placeholder={t("pairs.partnerName")} aria-label={t("pairs.partnerName")} maxLength={40} />
                    <button type="submit" className="btn-secondary btn-sm shrink-0" disabled={pending || !partner.trim()}>
                      {t("pairs.savePartner")}
                    </button>
                  </form>
                ) : (
                  <button type="button" className="link text-xs font-semibold" onClick={() => setAddingPartner(true)}>
                    {t("pairs.addPartner")}
                  </button>
                ))}
                {error && <div className="text-xs text-danger">{error}</div>}
              </div>
              {tellGroupHref && (
                <a href={tellGroupHref} target="_blank" rel="noopener noreferrer" className="btn-ghost btn-sm" data-testid="tell-group">
                  {t("event.tellGroup")}
                </a>
              )}
              <button type="button" className="btn-ghost btn-sm" disabled={pending} onClick={leave}>
                {t("event.leave")}
              </button>
            </>
          )}
          {state === "member_live" && <div className="flex-1 text-base font-extrabold text-court">● {t("event.inProgress")}</div>}
          {state === "leave_waitlist" && (
            <>
              <div className="flex-1">
                <div className="text-base font-extrabold">{t("event.youAreOnWaitlist", { position: waitlistPosition })}</div>
                <div className="text-xs text-muted">{t("event.waitlistHelp")}</div>
              </div>
              <button type="button" className="btn-ghost btn-sm" disabled={pending} onClick={leave}>
                {t("event.leaveWaitlist")}
              </button>
            </>
          )}
          {state === "full" && <div className="flex-1 text-base font-extrabold text-warn">{t("event.full")}</div>}
        </div>
      </div>
    </>
  );
}
