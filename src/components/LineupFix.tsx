"use client";

import { useTranslations } from "next-intl";
import { useId, useState, useTransition, type ReactNode } from "react";
import { fixPutAction, fixRemoveAction, fixReplaceAction, fixTakeAction } from "@/actions/lineupFix";
import { normalName } from "@/lib/domain/dupes";
import { errorLine } from "@/lib/errorLine";
import type { ActionResult } from "@/actions/shared";

/**
 * The line-up of a played match put right (the owner's decision of 24 November 2026; the rules are
 * `src/lib/domain/fixWindow.ts`). One control at the end of a row of the match's list, and a form that
 * opens under the row (`basis-full`, the row wraps):
 *
 *   - an open place: "Add a name" for the organiser and the players, "Add me" for anybody signed in
 *     without a seat;
 *   - a held place or a player: "Change" for the organiser and the players, which opens "Who played?",
 *     "It was me" for an organiser without a seat, and "Remove Bo"; "I played instead of Bo" for anybody
 *     signed in without a seat.
 *
 * Grey and plain buttons only: the screen's one lime button is somebody else's. A removal and a
 * replacement ask first, and say that the player hears it, when they will.
 */

type Rights = { edit: boolean; take: boolean; replace: boolean };

/** How many "Played with you" names show under the field: the ones that start like the typed name. */
const CHIPS = 6;

/** One request at a time, and a refusal that says why (the seven days ran out while the page was open: `past`). */
function useFix() {
  const t = useTranslations();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<ActionResult<null>>, done?: () => void) => {
    setError(null);
    start(async () => {
      const r = await fn();
      if (!r.ok) setError(t(`errors.${errorLine(r.error)}`));
      else done?.();
    });
  };
  return { pending, error, run };
}

/** "Who played?": a name, or one tap on a past player's name (`pick`: the server finds the record again). */
function WhoPlayed({ played, pending, onSave, onCancel, extra }: { played: readonly string[]; pending: boolean; onSave: (name: string, pick: boolean) => void; onCancel: () => void; extra?: ReactNode }) {
  const t = useTranslations();
  const id = useId();
  const [name, setName] = useState("");
  const typed = normalName(name);
  const chips = played.filter((p) => !typed || normalName(p).startsWith(typed)).slice(0, CHIPS);
  return (
    <div className="basis-full animate-pop" data-testid="fix-form">
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onSave(name.trim(), false);
        }}
      >
        <label className="label" htmlFor={`fix-name-${id}`}>
          {t("event.fixWho")}
        </label>
        <div className="flex gap-2">
          <input id={`fix-name-${id}`} data-testid="fix-name" className="input" value={name} maxLength={40} autoComplete="off" enterKeyHint="done" onChange={(e) => setName(e.target.value)} />
          <button type="submit" className="btn-secondary btn-sm shrink-0" disabled={pending || !name.trim()} data-testid="fix-save">
            {pending ? t("common.working") : t("common.save")}
          </button>
        </div>
        {chips.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-faint">{t("creator.playedWithYou")}</span>
            {chips.map((p) => (
              <button key={p} type="button" className="btn-ghost btn-sm" disabled={pending} onClick={() => onSave(p, true)}>
                {p}
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {extra}
          <button type="button" className="btn-ghost btn-sm" onClick={onCancel}>
            {t("common.cancel")}
          </button>
        </div>
      </form>
    </div>
  );
}

/** An open place in the window: "Add a name", "Add me". */
export function FixOpenPlace({ code, slotId, rights, played }: { code: string; slotId: string; rights: Rights; played: readonly string[] }) {
  const t = useTranslations();
  const { pending, error, run } = useFix();
  const [open, setOpen] = useState(false);
  if (!rights.edit && !rights.take) return null;
  return (
    <>
      {!open && (
        <div className="flex shrink-0 gap-2">
          {rights.take && (
            <button type="button" className="btn-secondary btn-sm" disabled={pending} onClick={() => run(() => fixTakeAction(code, slotId))} data-testid="fix-take">
              {t("event.fixTake")}
            </button>
          )}
          {rights.edit && (
            <button type="button" className="btn-ghost btn-sm" disabled={pending} onClick={() => setOpen(true)} data-testid="fix-add">
              {t("event.fixAdd")}
            </button>
          )}
        </div>
      )}
      {open && <WhoPlayed played={played} pending={pending} onCancel={() => setOpen(false)} onSave={(name, pick) => run(() => fixPutAction(code, slotId, name, pick), () => setOpen(false))} />}
      {error && <p className="basis-full text-sm font-semibold text-danger">{error}</p>}
    </>
  );
}

/**
 * A held place or a player, in the window. `tells`: the place was taken, so the player hears who removed
 * or replaced them, and the question says so.
 */
export function FixPlace({ code, slotId, name, rights, tells, played }: { code: string; slotId: string; name: string; rights: Rights; tells: boolean; played: readonly string[] }) {
  const t = useTranslations();
  const { pending, error, run } = useFix();
  const [open, setOpen] = useState(false);
  if (!rights.edit && !rights.replace) return null;
  const replace = () => {
    if (!confirm(tells ? t("event.fixReplaceConfirm", { name }) : t("event.fixReplaceHeld", { name }))) return;
    run(() => fixReplaceAction(code, slotId), () => setOpen(false));
  };
  const remove = () => {
    if (!confirm(tells ? t("event.fixRemoveConfirm", { name }) : t("event.fixRemoveHeld", { name }))) return;
    run(() => fixRemoveAction(code, slotId), () => setOpen(false));
  };
  return (
    <>
      {!open && rights.edit && (
        <button type="button" className="btn-ghost btn-sm shrink-0" disabled={pending} onClick={() => setOpen(true)} data-testid="fix-change">
          {t("event.fixChange")}
        </button>
      )}
      {!rights.edit && rights.replace && (
        <div className="basis-full">
          <button type="button" className="btn-ghost btn-sm -ml-2" disabled={pending} onClick={replace} data-testid="fix-replace">
            {t("event.fixReplace", { name })}
          </button>
        </div>
      )}
      {open && (
        <WhoPlayed
          played={played}
          pending={pending}
          onCancel={() => setOpen(false)}
          onSave={(who, pick) => run(() => fixPutAction(code, slotId, who, pick), () => setOpen(false))}
          extra={
            <>
              {rights.replace && (
                <button type="button" className="btn-secondary btn-sm" disabled={pending} onClick={replace} data-testid="fix-me">
                  {t("event.fixItWasMe")}
                </button>
              )}
              <button type="button" className="btn-danger btn-sm" disabled={pending} onClick={remove} data-testid="fix-remove">
                {t("event.fixRemove", { name })}
              </button>
            </>
          }
        />
      )}
      {error && <p className="basis-full text-sm font-semibold text-danger">{error}</p>}
    </>
  );
}
