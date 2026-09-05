"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { setMyLevelAction, setRankingOptInAction } from "@/actions/identity";
import type { LevelLogEntry } from "@/db/schema";
import { formatLevel } from "@/lib/domain/levels";
import { LevelGuide, LevelSelect } from "./LevelSelect";

/** "Your level" on My matches: declare once, see how results moved it. */
/** `offerRanking`: show the opt-in once there is something to rank (a level or a played match), so a fresh screen stays quiet. */
export function LevelEditor({ level, source, log, verified = false, rankingOptIn = false, offerRanking = false }: { level: number | null; source: string | null; log: LevelLogEntry[] | null; verified?: boolean; rankingOptIn?: boolean; offerRanking?: boolean }) {
  const t = useTranslations();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<number | null>(level);
  const [pending, start] = useTransition();
  const [optIn, setOptIn] = useState(rankingOptIn);
  const [optPending, startOpt] = useTransition();
  const last = log?.at(-1) ?? null;
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (value == null) return;
    start(async () => {
      await setMyLevelAction(value);
      setEditing(false);
    });
  };
  const view = (
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-bold uppercase tracking-wider text-faint">{t("level.yourLevel")}</div>
          {level == null ? (
            <>
              <div className="text-xl font-extrabold text-muted">{t("level.notSet")}</div>
              <p className="mt-1 text-xs text-faint">{t("level.notSetHelp")}</p>
            </>
          ) : (
            <>
              <div className="text-xl font-extrabold tabular-nums">
                {formatLevel(level)}
                {verified && (
                  <span className="ml-1.5 text-base text-accent-strong" title={t("level.verified")}>
                    ✓
                  </span>
                )}
              </div>
              <p className="text-xs text-faint">
                {verified ? t("level.verified") : source === "adjusted" ? t("level.adjusted") : t("level.selfDeclared")}
                {last && source === "adjusted" ? ` · ${t("level.lastChange", { from: formatLevel(last.from), to: formatLevel(last.to), type: last.type === "match" ? t("event.match").toLowerCase() : t("event.tournament").toLowerCase() })}` : ""}
              </p>
            </>
          )}
        </div>
        <button type="button" className={`${level == null ? "btn-secondary" : "btn-ghost"} btn-sm shrink-0`} onClick={() => setEditing(true)}>
          {level == null ? t("level.set") : t("common.edit")}
        </button>
      </div>
  );
  const optInRow =
    offerRanking || level != null || optIn ? (
      <label className="mt-3 flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 accent-ink"
          checked={optIn}
          disabled={optPending}
          onChange={(e) => {
            const on = e.target.checked;
            setOptIn(on);
            startOpt(async () => {
              await setRankingOptInAction(on);
            });
          }}
        />
        <span>
          <span className="font-semibold">{t("ranking.optInCta")}</span>
          <span className="block text-xs text-faint">{t("ranking.optInHelp")}</span>
        </span>
      </label>
    ) : null;
  if (!editing) {
    return (
      <div>
        {view}
        {optInRow}
      </div>
    );
  }
  return (
    <form onSubmit={save} className="flex flex-col gap-2">
      <div className="text-xs font-bold uppercase tracking-wider text-faint">{t("level.yourLevel")}</div>
      <p className="text-sm text-muted">{t("level.pickHelp")}</p>
      <div className="flex gap-2">
        <LevelSelect value={value} onChange={setValue} />
        <button type="submit" className="btn-secondary shrink-0" disabled={pending || value == null}>
          {pending ? t("common.saving") : t("common.save")}
        </button>
      </div>
      <LevelGuide />
      <button type="button" className="self-start text-sm link" onClick={() => setEditing(false)}>
        {t("common.cancel")}
      </button>
    </form>
  );
}
