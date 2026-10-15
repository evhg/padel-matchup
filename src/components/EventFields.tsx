"use client";

import { CITIES } from "@/lib/domain/cities";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useId, useMemo, useState, type ComponentProps } from "react";
import { GAMES_PRESETS, POINTS_PRESETS } from "@/lib/domain/americano";
import type { TournamentFormat } from "@/db/schema";
import { AGE_MINS, CATEGORY_KEYS, EVENT_CATEGORIES, type AgeMin, type EventCategory } from "@/lib/domain/eventTags";
import { DEFAULT_POINTS, FORMATS } from "@/lib/domain/formats";
import { hasRange, LEVEL_PRESETS, LEVEL_STEPS, formatLevel, normalizeRange, presetFor, rangeFor, type PresetKey } from "@/lib/domain/levels";
import { defaultLength, MATCH_LENGTHS, type MatchLength } from "@/lib/domain/matchLength";
import { hoursAndMinutes, nightPlan } from "@/lib/domain/tournamentPlan";

export const FORMAT_KEYS = { americano: "create.formatAmericano", mexicano: "create.formatMexicano", king: "create.formatKing" } as const;
export const FORMAT_HELP_KEYS = { americano: "create.formatAmericanoHelp", mexicano: "create.formatMexicanoHelp", king: "create.formatKingHelp" } as const;
import { formatDayMonth, nextOccurrence } from "@/lib/dates";
import { bestTimes, datesSharingAWeekday, freeLineMessage, freeLineOf, timeChipsOf } from "@/lib/domain/bestTimes";
import { rangeChip, rangeText, tagChip } from "@/lib/levelText";
import { LevelGuide, LevelSelect } from "./LevelSelect";
import { VenueCombobox, type VenueOption } from "./VenueCombobox";
import { PastNames } from "./PastNames";

export type EventFormValues = {
  type: "match" | "tournament";
  /** People the organiser already has, one per line. Each takes a spot before the link is shared. */
  haveNames: string;
  title: string;
  date: string;
  time: string;
  /** How long the court is booked: 60, 90 or 120 minutes, three taps and never a typed number. */
  durationMinutes: MatchLength;
  tz: string;
  venueName: string;
  venueMapUrl: string;
  court: string;
  note: string;
  capacity: number;
  whenFull: "waitlist" | "closed";
  courts: number | null;
  pointsPerMatch: number | null;
  /** First to N games instead of points: the other way social tournaments score. */
  gamesTo: number | null;
  /** Tournament format. */
  format: TournamentFormat;
  /** Tournament: two partners play every round together (decision F). Off by default. */
  fixedPairs: boolean;
  /** Level range; both null = open to everyone. */
  levelMin: number | null;
  levelMax: number | null;
  /** With a range: only confirmed levels walk in; declared ones ask to join. */
  levelVerifiedOnly: boolean;
  /** Who it is for: men, women or mixed, and 35+, 45+ or 55+. Null is anyone; nothing is checked at join. */
  category: EventCategory | null;
  ageMin: AgeMin | null;
  /** Organizer's own level, asked once when they set a range without having one. */
  myLevel: number | null;
  /** Opt-in to the public venue board (needs a venue). */
  publicListing: boolean;
  /** The club's booking page or confirmation, shown to players. */
  bookingUrl: string;
  /** What each player pays and how to pay the organizer; free text, shown to players. */
  cost: string;
  payNote: string;
};

export type TimePatternInput = { dow: number; time: string };
/** A time to tap. A free court's chip carries the club's zone too: its hour is the club's. */
type Chip = { key: string; date: string; time: string; tz?: string };

/** Quick picks: the organizer's own recurring slots, projected to their next occurrence. Never guessed. */
function historyChips(patterns: TimePatternInput[], tz: string, now = new Date()): Chip[] {
  return patterns.map((p) => ({ key: `${p.dow}-${p.time}`, ...nextOccurrence(p.dow, p.time, tz, now) }));
}

/**
 * The zones somebody here is actually likely to want, first. The control was 418 entries in one
 * alphabetical list starting at Africa/Abidjan with no search, on a phone — a Phuket organiser with
 * a WhatsApp thread already going scrolled for forty seconds, and called it the place they would
 * have given up. The phone's own zone, whatever is already set, and the cities this app knows.
 */
function likelyZones(current: string): string[] {
  const here = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    } catch {
      return "";
    }
  })();
  return [...new Set([current, here, ...CITIES.map((c) => c.tz)].filter(Boolean))];
}

function timeZones(current: string): string[] {
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
    return list.includes(current) || !current ? list : [current, ...list];
  } catch {
    return [current];
  }
}

/** The option that swaps the dropdown back to a text box; never a court's real name. */
const COURT_OTHER = "__other__";

export function EventFields({
  values,
  onChange,
  venues,
  showType = true,
  patterns = [],
  hasLevel = true,
  missing = [],
  check = [],
  courtTotal = null,
  startLocked = false,
  past,
  enterNext = false,
}: {
  values: EventFormValues;
  onChange: (patch: Partial<EventFormValues>) => void;
  venues: VenueOption[];
  showType?: boolean;
  patterns?: TimePatternInput[];
  /** False when the organizer has no level yet: a range then also asks for theirs. */
  hasLevel?: boolean;
  /** A pasted booking's gaps: each one is marked, in words, until the organiser fills it. */
  missing?: readonly ("venue" | "date" | "time")[];
  /** A pasted booking's guesses: the organiser's last venue, a date its weekday disagrees with. Each is marked until the organiser changes it. */
  check?: readonly ("venue" | "date")[];
  /**
   * A pasted booking's price for the whole court ("Total: 1,600 THB"): said in one line under the time
   * and the place, and never put in "Cost per player", which would ask each player for the whole court.
   */
  courtTotal?: string | null;
  /** The match has started and this viewer is not the organiser (`mayMoveStart`): the day, the time and the zone show, and do not change. */
  startLocked?: boolean;
  /** The create form's past players under the names: "Played with you" and "Is this Danny…?" (`PastNames`). */
  past?: Omit<ComponentProps<typeof PastNames>, "text">;
  /** The create form, where Go moves on to the next field (`enterMovesOn`): the keyboard says "next" on the venue and the court. The edit form has no such step, so its keys stay as they were. */
  enterNext?: boolean;
}) {
  const t = useTranslations();
  // A day or a time the booking did not give shows the form's own (the usual slot, else tomorrow at
  // 18:00), and stays marked as not the booking's until the organiser picks one: a guess in the shape
  // of a fact must say it is a guess.
  const [picked, setPicked] = useState({ date: false, time: false });
  const pick = (patch: Partial<EventFormValues>) => {
    if ("date" in patch || "time" in patch) setPicked((p) => ({ date: p.date || "date" in patch, time: p.time || "time" in patch }));
    onChange(patch);
  };
  const lacks = {
    venue: missing.includes("venue") && !values.venueName.trim(),
    date: missing.includes("date") && (!values.date || !picked.date),
    time: missing.includes("time") && (!values.time || !picked.time),
  };
  const gap = "ring-2 ring-warn";
  // What the paste filled and the organiser must look at: marked while it is still the value the paste gave.
  const [pasted] = useState({ venue: values.venueName, date: values.date });
  const doubt = {
    venue: check.includes("venue") && values.venueName === pasted.venue,
    date: check.includes("date") && values.date === pasted.date,
  };
  const locale = useLocale();
  const [tzOpen, setTzOpen] = useState(false);
  // Until the organiser taps a length, it follows the type: 90 for a match, 120 for a tournament.
  const [lengthPicked, setLengthPicked] = useState(false);
  const lengthLabel = useId();
  const pickType = (type: "match" | "tournament") => onChange(lengthPicked ? { type } : { type, durationMinutes: defaultLength(type) });
  // The picked club's court count, if it is one Kicksmash knows. Nothing is stored on the event but
  // the court itself: the count is looked up from the list, so it follows whatever venue is showing.
  const [typingCourt, setTypingCourt] = useState(false);
  const courtNumbers = useMemo(() => {
    if (typingCourt) return null;
    const picked = venues.find((v) => v.name.trim().toLowerCase() === values.venueName.trim().toLowerCase());
    // The club's own names when it listed its courts ("Centre", "Court 3"); the count as 1…n otherwise.
    const named = picked?.courtNames ?? [];
    if (named.length > 0 && named.length <= 24) {
      if (values.court && !named.includes(values.court)) return null;
      return named;
    }
    const n = picked?.courts ?? null;
    // A count nobody published, or one too large to read as a list, leaves the field as free text.
    if (!n || n < 1 || n > 24) return null;
    // A court already named something else (an older match, or "Centre court") keeps its text box.
    if (values.court && !Array.from({ length: n }, (_, i) => String(i + 1)).includes(values.court)) return null;
    return Array.from({ length: n }, (_, i) => String(i + 1));
  }, [venues, values.venueName, values.court, typingCourt]);
  const zones = useMemo(() => timeZones(values.tz), [values.tz]);
  const nearby = useMemo(() => likelyZones(values.tz), [values.tz]);
  const chips = useMemo(() => historyChips(patterns, values.tz), [patterns, values.tz]);
  // The picked club's free courts (its own feed, or the times a platform shows publicly), the owner's
  // choice of 10 October 2026. Up to three times at the head of the row of time chips, the organiser's
  // usual times first (`bestTimes`), and their usual times after them up to four (`timeChipsOf`):
  // one row of chips, no new action (rule 1). A usual time stays even when the club shows it taken,
  // because the organiser may have booked it. One line under the time says whether the club shows a
  // court free then, in the club's hour when the form's zone is not the club's.
  const pickedFree = useMemo(() => venues.find((v) => v.name.trim().toLowerCase() === values.venueName.trim().toLowerCase())?.free ?? null, [venues, values.venueName]);
  const freeChips = useMemo<Chip[]>(() => {
    if (!pickedFree) return [];
    return bestTimes({ clubs: [{ slug: "picked", name: values.venueName, feed: pickedFree, usual: true }], patterns, lengthMinutes: values.durationMinutes, now: new Date() }).map((b) => ({ key: b.start.toISOString(), date: b.date, time: b.time, tz: b.tz }));
  }, [pickedFree, patterns, values.durationMinutes, values.venueName]);
  const timeChips = useMemo(() => {
    const row = timeChipsOf(freeChips, chips);
    // A weekday that shows twice is two weeks: those chips name the day and month instead.
    const twice = datesSharingAWeekday(row);
    const weekday = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
    return row.map((c) => {
      const day = new Date(`${c.date}T00:00:00Z`);
      return { ...c, label: t("create.chipDay", { day: twice.has(c.date) ? formatDayMonth(day, "UTC", locale) : weekday.format(day), time: c.time }) };
    });
  }, [freeChips, chips, locale, t]);
  const freeCount = timeChips.filter((c) => c.free).length;
  const freeThen = useMemo(() => {
    try {
      return freeLineMessage(freeLineOf(pickedFree, values, values.durationMinutes, new Date()));
    } catch {
      return null;
    }
  }, [pickedFree, values]);
  // "More" opens by itself only when something non-default is already set (editing a match).
  const [moreOpen, setMoreOpen] = useState(Boolean(values.haveNames || values.title || values.note || values.bookingUrl || values.cost || values.payNote || values.publicListing || values.whenFull === "closed"));
  // Sent with "Is this Danny…?" still open: the names show again, wherever "More" was left.
  const reveal = past?.reveal ?? 0;
  useEffect(() => {
    if (reveal) setMoreOpen(true);
  }, [reveal]);
  // The level sits one tap from the form, behind its own chip: "looking for a fourth" carries the one
  // fact the fourth needs. The presets stay folded (rule 1); the chip reads what is set.
  const [levelOpen, setLevelOpen] = useState(false);
  const tagLabel = useId();
  const pill = (on: boolean) => `min-h-10 rounded-xl px-3 text-sm font-bold ring-1 transition ${on ? "bg-ink text-on-ink ring-ink" : "bg-card text-ink ring-line-strong hover:bg-bg"}`;
  const range = { min: values.levelMin, max: values.levelMax };
  const preset = presetFor(range);
  const [customOpen, setCustomOpen] = useState(preset === "custom");
  const levelChoice: PresetKey | "custom" | "any" = customOpen ? "custom" : (preset ?? "any");
  const pickPreset = (k: PresetKey | "custom" | "any") => {
    if (k === "any") {
      setCustomOpen(false);
      onChange({ levelMin: null, levelMax: null });
    } else if (k === "custom") {
      setCustomOpen(true);
      if (!hasRange(range)) onChange({ levelMin: 2.5, levelMax: 4 });
    } else {
      setCustomOpen(false);
      const r = rangeFor(k);
      onChange({ levelMin: r.min, levelMax: r.max });
    }
  };

  // The tournament's night in one line under Players, from the same function as the match page's
  // chips: courts, the rounds a full rotation takes, and how long that is at the chosen score.
  const plan = values.type === "tournament" ? nightPlan({ players: values.capacity, courts: values.courts, format: values.format, pointsPerMatch: values.pointsPerMatch, gamesTo: values.gamesTo, durationMinutes: values.durationMinutes, fixedPairs: values.fixedPairs }) : null;
  const hm = (minutes: number) => {
    const { h, m } = hoursAndMinutes(minutes);
    return h === 0 ? t("event.minutes", { minutes: m }) : t("create.planHm", { h, m });
  };
  const planLine = plan
    ? [
        plan.pairs ? t("pairs.planPairs", { pairs: plan.pairs }) : null,
        t("create.planCourts", { courts: plan.courts }),
        plan.rotation ? t(plan.pairs ? "pairs.planRotation" : "create.planRotation", { rounds: plan.rotation }) : plan.fits ? t("create.planFits", { rounds: plan.fits, minutes: values.durationMinutes }) : null,
        plan.rotationMinutes ? (values.gamesTo ? t("create.planTimeGames", { time: hm(plan.rotationMinutes), n: values.gamesTo }) : t("create.planTimePoints", { time: hm(plan.rotationMinutes), n: values.pointsPerMatch ?? 0 })) : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;
  // Round 1 shrinks a field to the names present, and since rests exist that can be ten: an edit keeps it on offer.
  const fieldSizes = [...new Set([...Array.from({ length: 16 }, (_, i) => (i + 1) * 4), values.capacity])].sort((a, b) => a - b);

  const summary = [
    values.whenFull === "closed" ? t("create.whenFullClosed") : t("create.whenFullWaitlist"),
    values.venueName.trim() ? (values.publicListing ? t("venue.listedShort") : t("venue.notListedShort")) : null,
    values.bookingUrl ? t("create.bookingSet") : null,
    values.cost ? t("create.costSet", { cost: values.cost }) : null,
    values.title || values.note ? t("create.titleSet") : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex flex-col gap-5">
      {showType && (
        <div>
          <div className="segment" role="group" aria-label={t("create.title")}>
            <button type="button" aria-pressed={values.type === "match"} onClick={() => pickType("match")}>
              {t("create.typeMatch")}
              <span className="block text-2xs font-semibold opacity-70">{t("create.typeMatchHelp")}</span>
            </button>
            <button type="button" aria-pressed={values.type === "tournament"} onClick={() => pickType("tournament")}>
              {t("create.typeTournament")}
              <span className="block text-2xs font-semibold opacity-70">{t("create.typeTournamentHelp")}</span>
            </button>
          </div>

        </div>
      )}

      {!startLocked && timeChips.length > 0 && (
        <div data-testid={freeCount > 0 ? "free-times" : undefined}>
          <div className="label">{freeCount === 0 ? t("create.chipsLabel") : freeCount === timeChips.length ? t("create.freeLabel", { club: values.venueName.trim() }) : t("create.freeAndUsualLabel", { club: values.venueName.trim() })}</div>
          <div className="flex flex-wrap gap-2">
          {timeChips.map((c) => {
            const active = values.date === c.date && values.time === c.time && (!c.tz || values.tz === c.tz);
            return (
              <button key={c.key} type="button" aria-pressed={active} data-testid={c.free ? "free-chip" : undefined} onClick={() => pick(c.tz ? { date: c.date, time: c.time, tz: c.tz } : { date: c.date, time: c.time })} className={`min-h-11 rounded-xl px-3.5 text-sm font-bold ring-1 transition ${active ? "bg-ink text-on-ink ring-ink" : "bg-card text-ink ring-line-strong hover:bg-bg"}`}>
                {c.free ? `✓ ${c.label}` : c.label}
              </button>
            );
          })}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">{t("create.date")}</label>
          <input className={`input ${lacks.date || doubt.date ? gap : ""}`} type="date" value={values.date} onChange={(e) => pick({ date: e.target.value })} disabled={startLocked} required aria-describedby={lacks.date ? "paste-no-date" : doubt.date ? "paste-check-day" : undefined} />
        </div>
        <div>
          <label className="label">{t("create.time")}</label>
          <input className={`input ${lacks.time ? gap : ""}`} type="time" step={300} value={values.time} onChange={(e) => pick({ time: e.target.value })} disabled={startLocked} required aria-describedby={lacks.time ? "paste-no-time" : undefined} />
        </div>
      </div>
      {(lacks.date || lacks.time) && (
        <div className="-mt-3 text-sm font-semibold text-warn" data-testid="paste-missing-when">
          {lacks.date && <p id="paste-no-date">✏️ {t("create.pasteNoDay")}</p>}
          {lacks.time && <p id="paste-no-time">✏️ {t("create.pasteNoTime")}</p>}
        </div>
      )}
      {doubt.date && (
        <p id="paste-check-day" className="-mt-3 text-sm font-semibold text-warn" data-testid="paste-check-day">
          ✏️ {t("create.pasteCheckDay")}
        </p>
      )}
      <div className="-mt-3 text-sm text-muted">
        {t("create.timezone")}:{" "}
        {startLocked ? (
          <span>{values.tz.replace(/_/g, " ")}</span>
        ) : tzOpen ? (
          <select className="input mt-1" value={values.tz} onChange={(e) => onChange({ tz: e.target.value })} data-testid="tz-select">
            <optgroup label={t("create.tzNearby")}>
              {nearby.map((z) => (
                <option key={`near-${z}`} value={z}>
                  {z.replace(/_/g, " ")}
                </option>
              ))}
            </optgroup>
            <optgroup label={t("create.tzAll")}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z.replace(/_/g, " ")}
                </option>
              ))}
            </optgroup>
          </select>
        ) : (
          <button type="button" className="link" onClick={() => setTzOpen(true)}>
            {values.tz.replace(/_/g, " ")}
          </button>
        )}
        {startLocked && (
          <p className="mt-1 font-semibold" data-testid="start-locked">
            {t("event.startLocked")}
          </p>
        )}
        {/* Only where the club's feed speaks for the time picked; past it, nothing rather than a guess. */}
        {!startLocked && freeThen && (
          <p className={`mt-1 ${freeThen.key.startsWith("create.free") ? "font-semibold text-ok" : ""}`} data-testid="free-then">
            {t(freeThen.key, freeThen.values)}
          </p>
        )}
      </div>

      {/* How long the court is booked, beside the time it starts: three taps, 90 already chosen. The
          owner's decision of 30 September 2026, after a player could not tell 60 from 90. */}
      <div>
        <div className="label" id={lengthLabel}>
          {t("create.length")}
        </div>
        <div className="segment" role="group" aria-labelledby={lengthLabel} data-testid="length-choice">
          {MATCH_LENGTHS.map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={values.durationMinutes === m}
              onClick={() => {
                setLengthPicked(true);
                onChange({ durationMinutes: m });
              }}
            >
              {t("event.minutes", { minutes: m })}
            </button>
          ))}
        </div>
      </div>

      <div>
        <VenueCombobox venues={venues} value={values.venueName} mapUrl={values.venueMapUrl} onChange={(v) => onChange({ venueName: v.name, venueMapUrl: v.mapUrl })} enterKeyHint={enterNext ? "next" : undefined} />
        {lacks.venue && (
          <p className="mt-1.5 text-sm font-semibold text-warn" data-testid="paste-missing-club">
            ✏️ {t("create.pasteNoClub")}
          </p>
        )}
        {doubt.venue && (
          <p className="mt-1.5 text-sm font-semibold text-warn" data-testid="paste-check-club">
            ✏️ {t("create.pasteCheckClub")}
          </p>
        )}
      </div>

      <div className="-mt-2">
        <label className="label">
          {t("create.court")} <span className="font-normal">({t("common.optional")})</span>
        </label>
        {courtNumbers ? (
          <select
            className="input"
            value={values.court}
            onChange={(e) => {
              if (e.target.value === COURT_OTHER) return setTypingCourt(true);
              onChange({ court: e.target.value });
            }}
          >
            <option value="">{t("create.courtNone")}</option>
            {courtNumbers.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
            <option value={COURT_OTHER}>{t("create.courtOther")}</option>
          </select>
        ) : (
          <input className="input" value={values.court} maxLength={40} placeholder={t("create.courtPlaceholder")} autoComplete="off" enterKeyHint={enterNext ? "next" : undefined} onChange={(e) => onChange({ court: e.target.value })} />
        )}
      </div>
      {courtTotal && (
        <p className="-mt-2 text-sm text-muted" data-testid="paste-total">
          💸 {t("create.pasteTotal", { total: courtTotal })}
        </p>
      )}


      {values.type === "tournament" && (
        <div>
          {showType && (
            <div className="mb-3">
              <label className="label">{t("create.format")}</label>
              <div className="flex flex-wrap gap-2" role="group" aria-label={t("create.format")}>
                {FORMATS.map((f) => (
                  <button
                    key={f}
                    type="button"
                    aria-pressed={values.format === f}
                    onClick={() => onChange({ format: f, pointsPerMatch: values.gamesTo ? null : values.pointsPerMatch == null || values.pointsPerMatch === DEFAULT_POINTS[values.format] ? DEFAULT_POINTS[f] : values.pointsPerMatch })}
                    className={`min-h-10 rounded-xl px-3 text-sm font-bold ring-1 transition ${values.format === f ? "bg-ink text-on-ink ring-ink" : "bg-card text-ink ring-line-strong hover:bg-bg"}`}
                  >
                    {t(FORMAT_KEYS[f])}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-sm text-muted">{values.fixedPairs ? t(({ americano: "pairs.howAmericano", mexicano: "pairs.howMexicano", king: "pairs.howKing" } as const)[values.format]) : t(FORMAT_HELP_KEYS[values.format])}</p>
              {/* Fixed pairs (decision F): off by default, the same engine with the pair as the unit. */}
              <label className="mt-2 flex cursor-pointer items-start gap-3 rounded-2xl bg-bg px-4 py-3">
                <input type="checkbox" className="mt-1 h-5 w-5 accent-ink" checked={values.fixedPairs} onChange={(e) => onChange({ fixedPairs: e.target.checked })} data-testid="fixed-pairs" />
                <span className="min-w-0">
                  <span className="block font-bold">{t("pairs.fixed")}</span>
                  <span className="block text-xs text-muted">{t("pairs.fixedHelp")}</span>
                </span>
              </label>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">{t("create.capacity")}</label>
              <select
                className="input px-3"
                aria-label={t("create.capacity")}
                value={values.capacity}
                onChange={(e) => onChange({ capacity: Number(e.target.value) })}
              >
                {fieldSizes.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">{t("create.scoreBy")}</label>
              {/* One way to score at a time: points per match, or first to N games (the other popular way). */}
              <select
                className="input px-3"
                aria-label={t("create.scoreBy")}
                value={values.gamesTo ? `g:${values.gamesTo}` : values.pointsPerMatch ? `p:${values.pointsPerMatch}` : ""}
                onChange={(e) => {
                  const v = e.target.value;
                  onChange(v.startsWith("g:") ? { gamesTo: Number(v.slice(2)), pointsPerMatch: null } : v.startsWith("p:") ? { pointsPerMatch: Number(v.slice(2)), gamesTo: null } : { pointsPerMatch: null, gamesTo: null });
                }}
              >
                <option value="">{t("create.pointsFree")}</option>
                {POINTS_PRESETS.map((n) => (
                  <option key={`p${n}`} value={`p:${n}`}>
                    {t("create.pointsN", { n })}
                  </option>
                ))}
                {GAMES_PRESETS.map((n) => (
                  <option key={`g${n}`} value={`g:${n}`}>
                    {t("create.gamesTo", { n })}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {planLine && (
            <p className="mt-1.5 text-sm font-semibold" data-testid="night-plan">
              {planLine}
            </p>
          )}
          {plan?.tooLong && <p className="mt-1 text-sm text-warn">{t("create.planTooLong", { minutes: values.durationMinutes })}</p>}
          <p className="mt-1.5 text-sm text-muted">{showType ? `${t("create.roundsHelp")} ${t("create.capacityHelp")}` : `${t("create.tournamentHelp")} ${t("create.capacityHelp")}`}</p>
        </div>
      )}


      <div>
        <button type="button" className="chip-muted hover:bg-line" aria-expanded={levelOpen} onClick={() => setLevelOpen((o) => !o)} data-testid="level-chip">
          🎚️ {[rangeChip(t, range) ?? t("level.any"), tagChip(t, values)].filter(Boolean).join(" · ")}{" "}
          <span className={`inline-block transition ${levelOpen ? "rotate-180" : ""}`} aria-hidden>
            ⌄
          </span>
        </button>
        {levelOpen && (
          <div className="mt-3 animate-pop">
      <div>
        <label className="label">{t("level.label")}</label>
        <div className="flex flex-wrap gap-2" role="group" aria-label={t("level.label")}>
          {(["any", ...LEVEL_PRESETS.map((p) => p.key), "custom"] as const).map((k) => (
            <button key={k} type="button" aria-pressed={levelChoice === k} onClick={() => pickPreset(k)} className={`min-h-10 rounded-xl px-3 text-sm font-bold ring-1 transition ${levelChoice === k ? "bg-ink text-on-ink ring-ink" : "bg-card text-ink ring-line-strong hover:bg-bg"}`}>
              {t(`level.${k}`)}
            </button>
          ))}
        </div>
        {levelChoice === "custom" && (
          <div className="mt-2 grid grid-cols-2 gap-3">
            <div>
              <label className="label">{t("level.from")}</label>
              <select className="input px-3" value={values.levelMin ?? 0} onChange={(e) => { const r = normalizeRange(Number(e.target.value), values.levelMax ?? 7); onChange({ levelMin: r.min, levelMax: r.max }); }}>
                {LEVEL_STEPS.map((v) => (
                  <option key={v} value={v}>
                    {formatLevel(v)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">{t("level.to")}</label>
              <select className="input px-3" value={values.levelMax ?? 7} onChange={(e) => { const r = normalizeRange(values.levelMin ?? 0, Number(e.target.value)); onChange({ levelMin: r.min, levelMax: r.max }); }}>
                {LEVEL_STEPS.map((v) => (
                  <option key={v} value={v}>
                    {formatLevel(v)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
        <p className="mt-1.5 text-sm text-muted">{hasRange(range) ? t("level.rangeHelp", { range: rangeText(t, range) }) : t("level.anyHelp")}</p>
        {hasRange(range) && (
          <label className="mt-2 flex cursor-pointer items-start gap-3 rounded-2xl bg-bg px-4 py-3">
            <input type="checkbox" className="mt-1 h-5 w-5 accent-ink" checked={values.levelVerifiedOnly} onChange={(e) => onChange({ levelVerifiedOnly: e.target.checked })} data-testid="verified-only" />
            <span className="min-w-0">
              <span className="block font-bold">✓ {t("levelCheck.verifiedOnly")}</span>
              <span className="block text-xs text-muted">{t("levelCheck.verifiedOnlyHelp")}</span>
            </span>
          </label>
        )}
        {hasRange(range) && !hasLevel && (
          <div className="mt-3 rounded-2xl bg-bg p-3">
            <label className="label">{t("level.yourLevel")}</label>
            <LevelSelect value={values.myLevel} onChange={(v) => onChange({ myLevel: v })} />
            <LevelGuide className="mt-2" />
          </div>
        )}
      </div>
      {/* Who it is for, behind the same chip as the level, so the common case is no longer on a phone.
          The owner's decision of 9 October 2026 (G1): a tag on the event, never on the player, and
          nothing is checked at join. */}
      <div className="mt-4">
        <div className="label" id={tagLabel}>
          {t("level.tagLabel")}
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-labelledby={tagLabel} data-testid="tag-category">
          {([null, ...EVENT_CATEGORIES] as const).map((c) => (
            <button key={c ?? "anyone"} type="button" aria-pressed={values.category === c} onClick={() => onChange({ category: c })} className={pill(values.category === c)}>
              {c ? t(CATEGORY_KEYS[c]) : t("level.tagAnyone")}
            </button>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label={t("level.tagAgeLabel")} data-testid="tag-age">
          {([null, ...AGE_MINS] as const).map((a) => (
            <button key={a ?? "any"} type="button" aria-pressed={values.ageMin === a} onClick={() => onChange({ ageMin: a })} className={pill(values.ageMin === a)}>
              {a ? t("level.tagAge", { age: a }) : t("level.tagAnyAge")}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-sm text-muted">{t("level.tagHelp")}</p>
      </div>
          </div>
        )}
      </div>
      <div className="border-t border-line pt-4">
        <button type="button" className="flex w-full items-center justify-between gap-3 text-left" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)}>
          <span className="min-w-0">
            <span className="block text-sm font-bold">{t("create.more")}</span>
            <span className="block truncate text-xs text-muted">{summary}</span>
          </span>
          <span className={`shrink-0 text-faint transition ${moreOpen ? "rotate-180" : ""}`} aria-hidden>
            ⌄
          </span>
        </button>
        {moreOpen && (
          <div className="mt-5 flex flex-col gap-5 animate-pop">
      {/* An organiser who is three of four shares a link that says "3 spots left", which is true and
          reads as though nobody is coming. The names go in before the link is ever shared. */}
      <div>
        <label className="label">{t("create.haveAlready")}</label>
        <textarea className="textarea" rows={3} value={values.haveNames} maxLength={600} onChange={(e) => onChange({ haveNames: e.target.value })} data-testid="have-already" />
        <p className="mt-1 text-xs text-muted">{t("create.haveAlreadyHelp")}</p>
        {values.type === "tournament" && values.fixedPairs && <p className="mt-1 text-xs text-muted">{t("pairs.namesHelp")}</p>}
        {past && <PastNames text={values.haveNames} {...past} />}
      </div>
      <div>
        <label className="label">{t("create.whenFull")}</label>
        <div className="segment">
          <button type="button" aria-pressed={values.whenFull === "waitlist"} onClick={() => onChange({ whenFull: "waitlist" })}>
            {t("create.whenFullWaitlist")}
          </button>
          <button type="button" aria-pressed={values.whenFull === "closed"} onClick={() => onChange({ whenFull: "closed" })}>
            {t("create.whenFullClosed")}
          </button>
        </div>
        <p className="mt-1.5 text-sm text-muted">{values.whenFull === "waitlist" ? t("create.whenFullWaitlistHelp") : t("create.whenFullClosedHelp")}</p>
      </div>
      {values.venueName.trim() && (
        <label className="flex cursor-pointer items-start gap-3 rounded-2xl bg-bg px-4 py-3">
          <input type="checkbox" className="mt-1 h-5 w-5 accent-ink" checked={values.publicListing} onChange={(e) => onChange({ publicListing: e.target.checked })} />
          <span className="min-w-0">
            <span className="block font-bold">📍 {t("venue.listToggle")}</span>
            <span className="block text-xs text-muted">{t("venue.listHelp")}</span>
          </span>
        </label>
      )}
            <div>
              <label className="label">
                {t("create.bookingUrl")} <span className="font-normal">({t("common.optional")})</span>
              </label>
              <input className="input" type="url" inputMode="url" autoComplete="off" placeholder="https://" value={values.bookingUrl} maxLength={500} onChange={(e) => onChange({ bookingUrl: e.target.value })} />
              <p className="mt-1.5 text-sm text-muted">{t("create.bookingUrlHelp")}</p>
            </div>
            <div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">
                    {t("create.cost")} <span className="font-normal">({t("common.optional")})</span>
                  </label>
                  <input className="input" value={values.cost} maxLength={40} autoComplete="off" placeholder={t("create.costPlaceholder")} onChange={(e) => onChange({ cost: e.target.value })} />
                </div>
                <div>
                  <label className="label">{t("create.payNote")}</label>
                  <input className="input" value={values.payNote} maxLength={120} autoComplete="off" placeholder={t("create.payNotePlaceholder")} onChange={(e) => onChange({ payNote: e.target.value })} />
                  <p className="mt-1.5 text-sm text-muted">{t("create.payNoteHelp")}</p>
                </div>
              </div>
              <p className="mt-1.5 text-sm text-muted">{t("create.costHelp")}</p>
            </div>
            <div>
              <label className="label">
                {t("create.titleLabel")} <span className="font-normal">({t("common.optional")})</span>
              </label>
              <input className="input" value={values.title} maxLength={80} placeholder={t("create.titlePlaceholder")} onChange={(e) => onChange({ title: e.target.value })} />
            </div>
            <div>
              <label className="label">
                {t("create.note")} <span className="font-normal">({t("common.optional")})</span>
              </label>
              <textarea className="textarea" value={values.note} maxLength={500} placeholder={t("create.notePlaceholder")} onChange={(e) => onChange({ note: e.target.value })} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
