"use client";

import { useTranslations } from "next-intl";
import { startTransition, useState, useTransition } from "react";
import { joinAction, leaveAction, withdrawJoinRequestAction } from "@/actions/slots";
import { askLevelCheckAction } from "@/actions/verify";
import { formatLevel, levelFit, type LevelRange } from "@/lib/domain/levels";
import { requestJoin } from "./joinBus";
import { LevelSelect } from "./LevelSelect";

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
}) {
  const t = useTranslations();
  const [inline, setInline] = useState(false);
  const [name, setName] = useState("");
  const [level, setLevel] = useState<number | null>(myLevel);
  const [error, setError] = useState<string | null>(null);
  const [askedKeys, setAskedKeys] = useState<string[]>(asked);
  const [pending, start] = useTransition();

  const fit = levelFit(levelRange, myLevel);
  const needsLevel = Boolean(levelRange) && myLevel == null;
  const outOfRange = fit === "below" || fit === "above";
  // Inside the range, but the event wants a confirmed level and this one is only declared.
  const unverified = Boolean(levelRange) && verifiedOnly && fit === "ok" && !verified;

  // State updates after an awaited server action are wrapped in startTransition
  // so they join the router's transition instead of interrupting it (React 19).
  const join = (withName?: string, withLevel?: number | null) =>
    start(async () => {
      setError(null);
      const r = await joinAction(code, withName, withLevel ?? undefined);
      startTransition(() => {
        if (!r.ok) setError(r.error === "name_required" ? t("identity.nameRequired") : r.error === "level_required" ? t("errors.level_required") : t(`errors.${r.error === "no_identity" ? "generic" : r.error}` as "errors.generic"));
        else setInline(false);
      });
    });

  const leave = () => {
    if (!confirm(t("event.leaveConfirm"))) return;
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

  if (state === "cancelled" || state === "past") return null;

  const joinLabel = outOfRange || unverified ? t("level.askToJoin") : state === "join_waitlist" ? t("event.joinWaitlist") : isTournament ? t("event.joinTournament") : t("event.join");

  // No identity yet (or no level yet on a ranged event): expand an in-flow spot
  // instead of opening a sheet (fixed overlays drift off screen on iOS once the keyboard shows).
  const onJoin = () => {
    if (hasIdentity && !needsLevel) return join();
    if (!requestJoin()) setInline(true);
  };

  return (
    <>
      <div className="h-28" aria-hidden />
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg/95 backdrop-blur supports-[backdrop-filter]:bg-bg/80" style={{ boxShadow: "var(--shadow-bar)" }}>
        <div className="mx-auto flex w-full max-w-xl items-center gap-3 px-4 pb-[max(env(safe-area-inset-bottom),12px)] pt-3">
          {(state === "join" || state === "join_waitlist") && (
            <div className="flex w-full flex-col gap-1">
              {inline ? (
                <form
                  className="flex flex-col gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!hasIdentity && !name.trim()) return setError(t("identity.nameRequired"));
                    if (levelRange && level == null) return setError(t("errors.level_required"));
                    join(hasIdentity ? undefined : name, level);
                  }}
                >
                  <div className="flex gap-2">
                    {!hasIdentity && <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t("identity.namePlaceholder")} autoComplete="given-name" maxLength={40} enterKeyHint="go" />}
                    {levelRange && <LevelSelect value={level} onChange={setLevel} />}
                    <button type="submit" className="btn-primary shrink-0" disabled={pending}>
                      {pending ? t("common.working") : t("event.joinShort")}
                    </button>
                  </div>
                </form>
              ) : (
                <button type="button" className="btn-primary w-full text-lg" disabled={pending} onClick={onJoin}>
                  {pending ? t("common.working") : joinLabel}
                </button>
              )}
              <div className="flex justify-between gap-2 text-xs font-semibold text-muted">
                <span>{outOfRange && myLevel != null ? t("level.outOfRange", { level: formatLevel(myLevel), range: rangeText }) : unverified && myLevel != null ? t("levelCheck.gate", { level: formatLevel(myLevel) }) : state === "join" ? t("event.spotsLeft", { count: spotsLeft }) : t("event.waitlistHelp")}</span>
                {error && <span className="text-danger">{error}</span>}
              </div>
            </div>
          )}
          {state === "requested" && (
            <>
              <div className="min-w-0 flex-1">
                <div className="text-base font-extrabold">✋ {t("level.requestSent")}</div>
                <div className="text-xs text-muted">{t("level.requestSentHelp", { name: organizerName })}</div>
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
              <div className="flex-1">
                <div className="text-base font-extrabold text-ok">✓ {t("event.youAreIn")}</div>
                {error && <div className="text-xs text-danger">{error}</div>}
              </div>
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
