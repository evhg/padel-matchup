"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { makeScheduleAction, setCourtsAction } from "@/actions/competitions";

/** The courts by name and the day's window; then one button gives every match a court and a time. */
export function CourtsForm({ slug, courtNames, dayStart, dayEnd, hasDraw }: { slug: string; courtNames: string[]; dayStart: string; dayEnd: string; hasDraw: boolean }) {
  const t = useTranslations();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [text, setText] = useState(courtNames.join("\n"));
  const [from, setFrom] = useState(dayStart);
  const [to, setTo] = useState(dayEnd);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const names = text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const save = () =>
    start(async () => {
      setError(null);
      setNote(null);
      const r = await setCourtsAction(slug, { courtNames: names, dayStart: from, dayEnd: to });
      if (r.ok) {
        setNote(t("tournament.saved"));
        router.refresh();
      } else setError(t("common.somethingWrong"));
    });
  return (
    <section className="card flex flex-col gap-3" data-testid="courts-form">
      <h2 className="text-lg font-extrabold">{t("tournament.courts")}</h2>
      <label className="block">
        <span className="text-sm font-bold">{t("tournament.courts")}</span>
        <textarea className="input mt-1 min-h-20" value={text} rows={3} onChange={(e) => setText(e.target.value)} aria-label={t("tournament.courts")} />
      </label>
      <span className="-mt-2 text-xs text-muted">{t("tournament.courtsHelp")}</span>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="text-sm font-bold">{t("tournament.dayStart")}</span>
          <input className="input mt-1" type="time" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="block">
          <span className="text-sm font-bold">{t("tournament.dayEnd")}</span>
          <input className="input mt-1" type="time" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button type="button" className="btn-ghost btn-sm" disabled={pending} onClick={save}>
          {t("common.save")}
        </button>
      </div>
      <p className="text-xs text-muted">{t("tournament.scheduleHelp")}</p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn-primary btn-sm"
          disabled={pending || names.length === 0}
          onClick={() =>
            start(async () => {
              setError(null);
              setNote(null);
              const saved = await setCourtsAction(slug, { courtNames: names, dayStart: from, dayEnd: to });
              if (!saved.ok) return setError(t("common.somethingWrong"));
              const r = await makeScheduleAction(slug);
              if (r.ok) {
                setNote(t("tournament.scheduled", { count: r.data.count }));
                router.refresh();
              } else setError(r.error === "invalid" && r.detail === "courts" ? t("tournament.scheduleNeedsCourts") : r.error === "invalid" && r.detail === "no_draw" ? t("tournament.scheduleNeedsDraw") : t("common.somethingWrong"));
            })
          }
        >
          {t("tournament.makeSchedule")}
        </button>
        {!hasDraw && <span className="text-xs text-muted">{t("tournament.scheduleNeedsDraw")}</span>}
        {note && <span className="text-sm font-semibold text-ok">{note}</span>}
        {error && <span className="text-sm font-semibold text-warn">{error}</span>}
      </div>
    </section>
  );
}
