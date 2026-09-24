"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { makeScheduleAction, setCourtsAction } from "@/actions/competitions";

/**
 * The courts by name and the day's window; then one button gives every match a court and a time.
 * The fields are uncontrolled on purpose: this page is long, and text typed before React has
 * hydrated it would be wiped by a controlled input's first render.
 */
export function CourtsForm({ slug, courtNames, dayStart, dayEnd, hasDraw }: { slug: string; courtNames: string[]; dayStart: string; dayEnd: string; hasDraw: boolean }) {
  const t = useTranslations();
  const router = useRouter();
  const [pending, start] = useTransition();
  const names = useRef<HTMLTextAreaElement>(null);
  const from = useRef<HTMLInputElement>(null);
  const to = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A match with no room keeps no time: the organiser has to hear it here, the one place they can act on it.
  const [unplaced, setUnplaced] = useState(0);
  const read = () => ({
    courtNames: (names.current?.value ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
    dayStart: from.current?.value || dayStart,
    dayEnd: to.current?.value || dayEnd,
  });
  const save = () =>
    start(async () => {
      setError(null);
      setNote(null);
      setUnplaced(0);
      const r = await setCourtsAction(slug, read());
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
        <textarea ref={names} className="input mt-1 min-h-20" defaultValue={courtNames.join("\n")} rows={3} aria-label={t("tournament.courts")} />
      </label>
      <span className="-mt-2 text-xs text-muted">{t("tournament.courtsHelp")}</span>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="text-sm font-bold">{t("tournament.dayStart")}</span>
          <input ref={from} className="input mt-1" type="time" defaultValue={dayStart} />
        </label>
        <label className="block">
          <span className="text-sm font-bold">{t("tournament.dayEnd")}</span>
          <input ref={to} className="input mt-1" type="time" defaultValue={dayEnd} />
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
          disabled={pending}
          onClick={() =>
            start(async () => {
              setError(null);
              setNote(null);
              setUnplaced(0);
              const fields = read();
              if (fields.courtNames.length === 0) return setError(t("tournament.scheduleNeedsCourts"));
              const saved = await setCourtsAction(slug, fields);
              if (!saved.ok) return setError(t("common.somethingWrong"));
              const r = await makeScheduleAction(slug);
              if (r.ok) {
                setNote(t("tournament.scheduled", { count: r.data.count }));
                setUnplaced(r.data.unplaced);
                router.refresh();
              } else setError(r.error === "invalid" && r.detail === "courts" ? t("tournament.scheduleNeedsCourts") : r.error === "invalid" && r.detail === "no_draw" ? t("tournament.scheduleNeedsDraw") : t("common.somethingWrong"));
            })
          }
        >
          {t("tournament.makeSchedule")}
        </button>
        {!hasDraw && <span className="text-xs text-muted">{t("tournament.scheduleNeedsDraw")}</span>}
        {note && <span className="text-sm font-semibold text-ok">{note}</span>}
        {unplaced > 0 && (
          <span className="text-sm font-semibold text-warn" data-testid="schedule-unplaced">
            {t("tournament.scheduleUnplaced", { count: unplaced })}
          </span>
        )}
        {error && <span className="text-sm font-semibold text-warn">{error}</span>}
      </div>
    </section>
  );
}
