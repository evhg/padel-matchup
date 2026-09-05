"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { setMyLevelAction } from "@/actions/identity";
import type { LevelLogEntry } from "@/db/schema";
import { formatLevel } from "@/lib/domain/levels";
import { LevelGuide, LevelSelect } from "./LevelSelect";

/** "Your level" on My matches: declare once, see how results moved it. */
export function LevelEditor({ level, source, log }: { level: number | null; source: string | null; log: LevelLogEntry[] | null }) {
  const t = useTranslations();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<number | null>(level);
  const [pending, start] = useTransition();
  const last = log?.at(-1) ?? null;
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (value == null) return;
    start(async () => {
      await setMyLevelAction(value);
      setEditing(false);
    });
  };
  if (!editing) {
    return (
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
              <div className="text-xl font-extrabold tabular-nums">{formatLevel(level)}</div>
              <p className="text-xs text-faint">
                {source === "adjusted" ? t("level.adjusted") : t("level.selfDeclared")}
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
