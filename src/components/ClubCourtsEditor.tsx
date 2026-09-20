"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { setClubCourtsAction } from "@/actions/clubs";

type Row = { name: string; kind: "indoor" | "outdoor" | "" };

/**
 * The club's courts one by one: a name and indoor or outdoor, saved as a set. "Number them" fills
 * the list from the count the club typed, so six courts are six rows in one tap. The counts on the
 * page follow the rows.
 */
export function ClubCourtsEditor({ token, initial, total, courtWord }: { token: string; initial: Row[]; total: number | null; courtWord: string }) {
  const t = useTranslations();
  const [pending, start] = useTransition();
  const [rows, setRows] = useState<Row[]>(initial);
  const [note, setNote] = useState<string | null>(null);
  const set = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => setRows((rs) => rs.filter((_, j) => j !== i));
  const add = () => setRows((rs) => (rs.length >= 64 ? rs : [...rs, { name: `${courtWord} ${rs.length + 1}`, kind: "" }]));
  const number = () => setRows(Array.from({ length: Math.min(64, Math.max(1, total ?? 4)) }, (_, i) => ({ name: `${courtWord} ${i + 1}`, kind: initial[i]?.kind ?? "" })));
  const save = () => {
    setNote(null);
    start(async () => {
      const r = await setClubCourtsAction(token, rows.filter((r) => r.name.trim()).map((r) => ({ name: r.name.trim(), kind: r.kind || null })));
      setNote(r.ok ? t("club.courtsSaved", { count: r.data.courts.length }) : r.error === "invalid" ? t("club.courtNameTwice") : t("common.somethingWrong"));
    });
  };
  return (
    <section className="card flex flex-col gap-3" id="courts" data-testid="club-courts-editor">
      <div>
        <h2 className="text-lg font-extrabold">{t("club.courtsTitle")}</h2>
        <p className="mt-1 text-xs text-muted">{t("club.courtsEditorHelp")}</p>
      </div>
      {rows.length === 0 && <p className="text-sm text-muted">{t("club.courtsNone")}</p>}
      <ul className="flex flex-col gap-2">
        {rows.map((r, i) => (
          <li key={i} className="flex items-center gap-2">
            <input className="input min-w-0 flex-1" value={r.name} maxLength={40} aria-label={t("club.courtName")} onChange={(e) => set(i, { name: e.target.value })} />
            <select className="input w-32 shrink-0" value={r.kind} aria-label={t("club.courtKind")} onChange={(e) => set(i, { kind: e.target.value as Row["kind"] })}>
              <option value="">—</option>
              <option value="indoor">{t("club.courtsIndoor")}</option>
              <option value="outdoor">{t("club.courtsOutdoor")}</option>
            </select>
            <button type="button" className="btn-ghost btn-sm shrink-0" aria-label={t("common.remove")} onClick={() => remove(i)}>
              ✕
            </button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-ghost btn-sm" onClick={add} disabled={rows.length >= 64}>
          ＋ {t("club.addCourt")}
        </button>
        {rows.length === 0 && (
          <button type="button" className="btn-ghost btn-sm" onClick={number} data-testid="number-courts">
            {t("club.numberCourts", { n: Math.min(64, Math.max(1, total ?? 4)) })}
          </button>
        )}
        <button type="button" className="btn-primary btn-sm ml-auto" onClick={save} disabled={pending} data-testid="save-courts">
          {pending ? t("common.saving") : t("common.save")}
        </button>
      </div>
      {note && <p className="text-sm font-semibold text-muted">{note}</p>}
    </section>
  );
}
