"use client";

import { useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { dropWantAction, recordWantAction } from "@/actions/demand";

export type Want = { id: string; weekday: number | null; fromTime: string | null; toTime: string | null; place: string };

/** 2024-01-07 was a Sunday, so index 0 is Sunday — the same numbering the rows use. */
const dayName = (d: number, locale: string) => new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, 7 + d)));
const HOURS = ["07:00", "08:00", "09:00", "10:00", "11:00", "16:00", "17:00", "18:00", "19:00", "20:00", "21:00"];
/** An hour either side, the same window a typed "want tue 14" means. */
const around = (time: string) => {
  const mins = Number(time.slice(0, 2)) * 60;
  const clamp = (m: number) => `${String(Math.floor(Math.max(0, Math.min(1439, m)) / 60)).padStart(2, "0")}:${String(Math.max(0, Math.min(1439, m)) % 60).padStart(2, "0")}`;
  return { fromTime: clamp(mins - 60), toTime: clamp(mins + 60) };
};

/**
 * What the app never asked anybody: when do you actually want to play? Everything else here records
 * matches that exist. This records the ones somebody wishes existed, so a new match — or a seat that
 * opens the night before — can go to the people who said they wanted exactly that.
 */
export function WhenIPlay({ initial, suggestedPlace }: { initial: Want[]; suggestedPlace?: string | null }) {
  const t = useTranslations("want");
  const locale = useLocale();
  const [wants, setWants] = useState(initial);
  const [place, setPlace] = useState(suggestedPlace ?? "");
  const [weekday, setWeekday] = useState<string>("");
  const [time, setTime] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const describe = (w: Want) => {
    const day = w.weekday === null ? t("anyDay") : dayName(w.weekday, locale);
    const when = w.fromTime && w.toTime ? `${w.fromTime}–${w.toTime}` : t("anyTime");
    return `${day} · ${when} · ${t("at")} ${w.place}`;
  };

  const add = () =>
    start(async () => {
      setError(null);
      const times = time ? around(time) : { fromTime: null, toTime: null };
      const res = await recordWantAction({ place, weekday: weekday === "" ? null : Number(weekday), ...times });
      if (!res.ok) {
        setError(res.error === "invalid" ? t("unknownPlace") : res.error === "too_many" ? t("tooMany") : t("unknownPlace"));
        return;
      }
      setWants((prev) => [...prev.filter((w) => w.id !== res.data.id), { id: res.data.id, weekday: weekday === "" ? null : Number(weekday), ...times, place }]);
      setTime("");
    });

  const remove = (id: string) =>
    start(async () => {
      const res = await dropWantAction(id);
      if (res.ok) setWants((prev) => prev.filter((w) => w.id !== id));
    });

  return (
    <section className="card">
      <h2 className="text-lg font-extrabold">{t("title")}</h2>
      <p className="mt-1 text-xs text-muted">{t("sub")}</p>

      {wants.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-2">
          {wants.map((w) => (
            <li key={w.id} className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2 text-sm">
              <span>{describe(w)}</span>
              <button type="button" className="text-xs font-bold text-muted underline underline-offset-4 hover:text-ink" disabled={pending} onClick={() => remove(w.id)}>
                {t("remove")}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-muted">{t("none")}</p>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <select id="want-day" className="input min-h-11 flex-1 text-sm" value={weekday} onChange={(e) => setWeekday(e.target.value)} aria-label={t("anyDay")}>
          <option value="">{t("anyDay")}</option>
          {[1, 2, 3, 4, 5, 6, 0].map((d) => (
            <option key={d} value={d}>
              {dayName(d, locale)}
            </option>
          ))}
        </select>
        <select id="want-time" className="input min-h-11 flex-1 text-sm" value={time} onChange={(e) => setTime(e.target.value)} aria-label={t("anyTime")}>
          <option value="">{t("anyTime")}</option>
          {HOURS.map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </select>
      </div>
      <input id="want-place" className="input mt-2 min-h-11 w-full text-sm" value={place} onChange={(e) => setPlace(e.target.value)} placeholder={t("place")} aria-label={t("place")} />
      <p className="mt-1 text-xs text-faint">{t("placeHelp")}</p>
      {error ? <p className="mt-2 text-xs font-bold text-red">{error}</p> : null}
      <button type="button" className="btn-primary mt-3 self-start" disabled={pending || place.trim() === ""} onClick={add}>
        {t("add")}
      </button>
    </section>
  );
}
