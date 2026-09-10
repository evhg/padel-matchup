"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { decideClubLevelCheckAction, decideLevelCheckAction } from "@/actions/verify";
import { formatLevel } from "@/lib/domain/levels";
import { LevelSelect } from "./LevelSelect";

export type LevelCheckDTO = { id: string; name: string; level: number | null; askedAgo: string };

/** Players asking a coach or a club to confirm their level: the number they said, a number to correct it, one tap each way. */
export function LevelChecks({ checks, by }: { checks: LevelCheckDTO[]; by: { kind: "coach" } | { kind: "club"; token: string } }) {
  const t = useTranslations();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [levels, setLevels] = useState<Record<string, number | null>>({});
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (checks.length === 0) return null;

  const decide = (c: LevelCheckDTO, approve: boolean) =>
    start(async () => {
      const level = levels[c.id] ?? c.level;
      setError(null);
      const r = by.kind === "coach" ? await decideLevelCheckAction(c.id, approve, level) : await decideClubLevelCheckAction(by.token, c.id, approve, level);
      if (!r.ok) {
        setNote(null);
        // A check a colleague already answered is not a failure: say so, and it is gone on refresh, so its buttons do not sit there failing.
        setError(r.detail === "not_pending" || r.detail === "not_found" ? t("levelCheck.alreadyAnswered") : t("common.somethingWrong"));
        router.refresh();
        return;
      }
      setNote(approve ? t("levelCheck.done", { name: c.name, level: formatLevel(level ?? 0), admitted: r.data.admitted }) : t("levelCheck.declined", { name: c.name }));
      router.refresh();
    });

  return (
    <section className="card animate-pop" data-testid="level-checks">
      <div className="text-sm font-extrabold">{t("levelCheck.checksTitle")}</div>
      <p className="mt-1 text-xs text-muted">{t("levelCheck.checksHelp")}</p>
      <ul className="mt-2 flex flex-col gap-2">
        {checks.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center gap-2 rounded-2xl border border-line bg-white px-4 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate font-bold">{c.name}</div>
              <div className="truncate text-xs text-muted">
                {c.level != null ? t("levelCheck.declared", { level: formatLevel(c.level) }) : "—"} · {c.askedAgo}
              </div>
            </div>
            <LevelSelect value={levels[c.id] ?? c.level} onChange={(v) => setLevels((m) => ({ ...m, [c.id]: v }))} className="w-24" ariaLabel={t("level.label")} />
            <button type="button" className="btn-primary btn-xs" disabled={pending} onClick={() => decide(c, true)} data-testid="level-check-confirm">
              ✓ {t("levelCheck.confirm")}
            </button>
            <button type="button" className="btn-ghost btn-xs" disabled={pending} onClick={() => decide(c, false)}>
              {t("levelCheck.decline")}
            </button>
          </li>
        ))}
      </ul>
      {note && <p className="mt-2 text-sm font-semibold text-ok">{note}</p>}
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </section>
  );
}
