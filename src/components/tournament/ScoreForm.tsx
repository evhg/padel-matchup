"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { enterScoreAction, walkoverAction } from "@/actions/competitions";
import { scoreVerdict } from "@/lib/tournamentText";

/**
 * The score as people say it, "6-4 3-6 10-8", from the organiser or a player of either pair.
 * The organiser can also give a walkover, and correct a result until the next match has one.
 */
/** An example that fits the rule, for the placeholder and the help line (a super set is not three sets). */
const EXAMPLES: Record<string, string> = { set6tb: "6-4", set9: "9-7", sets2stb: "6-4 3-6 10-8", sets3: "6-4 3-6 7-5" };

export function ScoreForm({ slug, matchId, rule, ruleLabel, organizer, done, aName, bName }: { slug: string; matchId: string; rule: string; ruleLabel: string; organizer: boolean; done: boolean; aName: string; bName: string }) {
  const t = useTranslations();
  const router = useRouter();
  // A player's own match opens ready to score; the organiser's desk lists thirty matches, so each one waits for a tap.
  const [open, setOpen] = useState(!done && !organizer);
  const [text, setText] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const fail = (r: { error: string; detail?: string }) =>
    setError(r.error === "locked" ? t("tournament.errLocked") : r.error === "invalid" && r.detail?.startsWith("score_") ? t("tournament.errScore", { rule: ruleLabel }) : r.error === "invalid" && r.detail === "not_published" ? t("tournament.errNotPublished") : t("common.somethingWrong"));
  if (!open) {
    // A result already in reads "Change the score", so the desk sees at a glance which matches still wait for one.
    return (
      <button type="button" className="btn-ghost btn-sm" onClick={() => setOpen(true)}>
        {done ? t("tournament.changeScore") : t("tournament.enterScore")}
      </button>
    );
  }
  const example = EXAMPLES[rule] ?? "6-4";
  const verdict = scoreVerdict(rule, text);
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
        <input className="input min-w-0 flex-1" inputMode="numeric" placeholder={example} value={text} onChange={(e) => setText(e.target.value)} aria-label={t("tournament.enterScore")} />
        <button type="submit" className="btn-primary btn-sm shrink-0" disabled={pending || !text.trim()}>
          {t("tournament.saveScore")}
        </button>
      </div>
      <span className="text-xs text-muted">
        {t("tournament.scoreHelpNamed", { name: aName, example })} {ruleLabel}
      </span>
      {verdict && (
        <p className="text-sm font-bold text-ok" data-testid="score-verdict">
          {t("tournament.scoreWinner", { name: verdict === "A" ? aName : bName })}
        </p>
      )}
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
