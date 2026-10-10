"use client";

import { useTranslations } from "next-intl";
import { startTransition, useState, useTransition } from "react";
import { bePartnerAction, pairSinglesAction, removeAction, splitPairAction } from "@/actions/slots";
import { ShareButtons } from "./ShareSheet";

/**
 * The controls of a fixed-pairs night's list (the owner's decision F): "Be their partner" on a player
 * who came alone, the partner's link for whoever named them, and the organiser's two tools, pair two
 * singles and split a pair. The rows themselves are the match page's, rendered on the server.
 */

/** The error a pair write can give, in the reader's words: a detail the messages name, else the code. */
function useErrorText() {
  const t = useTranslations();
  return (r: { error: string; detail?: string }) => {
    // A ranged night: the level is asked by the Join button, which this row has no room for.
    if (r.error === "level_required" || r.error === "forbidden") return t("pairs.useJoin");
    const key = r.detail && ["taken", "already_paired", "pairs_locked", "partner_needed", "need_2_pairs"].includes(r.detail) ? r.detail : r.error === "name_required" ? null : r.error === "no_identity" ? "generic" : r.error;
    return key ? t(`errors.${key}` as "errors.generic") : t("identity.nameRequired");
  };
}

/** "Be their partner": one tap when the viewer has a name here, a name field first when not. */
export function BePartnerButton({ code, slotId, hasIdentity }: { code: string; slotId: string; hasIdentity: boolean }) {
  const t = useTranslations();
  const errorText = useErrorText();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const go = (withName?: string) =>
    start(async () => {
      setError(null);
      const r = await bePartnerAction(code, slotId, withName);
      startTransition(() => {
        if (!r.ok) setError(errorText(r));
      });
    });
  return (
    <div className="mt-2">
      {open && !hasIdentity ? (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return setError(t("identity.nameRequired"));
            go(name);
          }}
        >
          <input className="input min-h-11 min-w-0 flex-1 text-sm" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t("identity.namePlaceholder")} autoComplete="given-name" maxLength={40} aria-label={t("identity.namePlaceholder")} />
          <button type="submit" className="btn-primary btn-sm shrink-0" disabled={pending}>
            {pending ? t("common.working") : t("pairs.bePartner")}
          </button>
        </form>
      ) : (
        <button type="button" className="btn-secondary btn-sm" disabled={pending} onClick={() => (hasIdentity ? go() : setOpen(true))}>
          {pending ? t("common.working") : t("pairs.bePartner")}
        </button>
      )}
      {error && <p className="mt-1 text-xs font-semibold text-danger">{error}</p>}
    </div>
  );
}

/** The partner's invite link, for whoever named them: the partner opens it to claim the spot. */
export function PartnerLink({ name, url, text }: { name: string; url: string; text: string }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <button type="button" className="btn-secondary btn-xs" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {t("pairs.sendLink", { name })}
      </button>
      {open && (
        <div className="mt-2 rounded-2xl bg-bg p-3 animate-pop">
          <ShareButtons url={url} text={text} size="sm" />
        </div>
      )}
    </div>
  );
}

/**
 * The organiser's tools on a row: before round 1, split a pair or pair a single with another single;
 * on a pair, take one partner off by name ("Remove Ana"), which leaves the other a single and, once
 * the night runs, out of the next draw. One row of small buttons, so a list of pairs stays a list.
 */
export function PairTools({ code, slotId, kind, singles = [], removable = [], canPair = true }: { code: string; slotId: string; kind: "pair" | "single"; /** The other singles this one may pair with: id and name. */ singles?: { id: string; name: string }[]; /** A pair's partners the organiser may take off: seat id and name. */ removable?: { id: string; name: string }[]; /** Before round 1: split and pair are open. */ canPair?: boolean }) {
  const t = useTranslations();
  const errorText = useErrorText();
  const [other, setOther] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const run = (fn: () => ReturnType<typeof splitPairAction>) =>
    start(async () => {
      setError(null);
      const r = await fn();
      startTransition(() => {
        if (!r.ok) setError(errorText(r));
      });
    });
  if (kind === "single" && (singles.length === 0 || !canPair)) return null;
  if (kind === "pair" && !canPair && removable.length === 0) return null;
  return (
    <div className="mt-2">
      {kind === "pair" ? (
        <div className="flex flex-wrap gap-2">
          {canPair && (
            <button type="button" className="btn-ghost btn-xs" disabled={pending} onClick={() => run(() => splitPairAction(code, slotId))}>
              {t("pairs.split")}
            </button>
          )}
          {removable.map((r) => (
            <button
              key={r.id}
              type="button"
              className="btn-danger btn-xs"
              disabled={pending}
              onClick={() => {
                if (confirm(t("creator.removeConfirm", { name: r.name }))) run(() => removeAction(code, r.id));
              }}
            >
              {t("pairs.remove", { name: r.name })}
            </button>
          ))}
        </div>
      ) : (
        <div className="flex gap-2">
          <select className="input min-h-10 min-w-0 flex-1 text-sm" value={other} onChange={(e) => setOther(e.target.value)} aria-label={t("pairs.pairWith")}>
            <option value="">{t("pairs.pairWith")}</option>
            {singles.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button type="button" className="btn-secondary btn-sm shrink-0" disabled={pending || !other} onClick={() => run(() => pairSinglesAction(code, slotId, other))}>
            {t("pairs.pairButton")}
          </button>
        </div>
      )}
      {error && <p className="mt-1 text-xs font-semibold text-danger">{error}</p>}
    </div>
  );
}
