"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { enterScoreAction, walkoverAction } from "@/actions/competitions";

/**
 * The score as people say it, "6-4 3-6 10-8", from the organiser or a player of either pair.
 * The organiser can also give a walkover, and correct a result until the next match has one.
 */
export function ScoreForm({ slug, matchId, rule, ruleLabel, organizer, done, aName, bName }: { slug: string; matchId: string; rule: string; ruleLabel: string; organizer: boolean; done: boolean; aName: string; bName: string }) {
  const t = useTranslations();
  const router = useRouter();
  const [open, setOpen] = useState(!done);
  const [text, setText] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const fail = (r: { error: string; detail?: string }) =>
    setError(r.error === "locked" ? t("tournament.errLocked") : r.error === "invalid" && r.detail?.startsWith("score_") ? t("tournament.errScore", { rule: ruleLabel }) : r.error === "invalid" && r.detail === "not_published" ? t("tournament.errNotPublished") : t("common.somethingWrong"));
  if (!open) {
    return (
      <button type="button" className="btn-ghost btn-sm" onClick={() => setOpen(true)}>
        {t("tournament.enterScore")}
      </button>
    );
  }
  return (
    <form
      className="mt-1 flex flex-col gap-2"
      data-testid={`score-${matchId}`}
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const r = await enterScoreAction(slug, matchId, text);
          if (r.ok) {
            setText("");
            setOpen(false);
            router.refresh();
          } else fail(r);
        });
      }}
    >
      <div className="flex gap-2">
        <input className="input min-w-0 flex-1" inputMode="numeric" placeholder={rule === "sets2stb" || rule === "sets3" ? "6-4 3-6 10-8" : rule === "set9" ? "9-7" : "6-4"} value={text} onChange={(e) => setText(e.target.value)} aria-label={t("tournament.enterScore")} />
        <button type="submit" className="btn-primary btn-sm shrink-0" disabled={pending || !text.trim()}>
          {t("tournament.saveScore")}
        </button>
      </div>
      <span className="text-xs text-muted">
        {t("tournament.scoreHelp")} {ruleLabel}
      </span>
      {organizer && !done && (
        <div className="flex flex-wrap gap-2">
          {(["A", "B"] as const).map((side) => (
            <button
              key={side}
              type="button"
              className="btn-ghost btn-sm"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await walkoverAction(slug, matchId, side);
                  if (r.ok) router.refresh();
                  else fail(r);
                })
              }
            >
              {t("tournament.walkoverTo", { name: side === "A" ? aName : bName })}
            </button>
          ))}
        </div>
      )}
      {error && <p className="text-sm font-semibold text-warn">{error}</p>}
      {done && (
        <button type="button" className="btn-ghost btn-sm self-start" onClick={() => setOpen(false)}>
          {t("common.cancel")}
        </button>
      )}
    </form>
  );
}
