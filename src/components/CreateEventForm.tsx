"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { createEventAction, pastPlayersAction } from "@/actions/events";
import { answerFor, answerKey, askFor, namesTyped, pickOf, type PastAnswer, type PastPick } from "@/lib/domain/pastAsk";
import { nextOccurrence, tomorrowAt } from "@/lib/dates";
import { defaultLength } from "@/lib/domain/matchLength";
import { EventFields, type EventFormValues, type TimePatternInput } from "./EventFields";
import type { PastNamesState } from "./PastNames";
import { useOwnNameAutofill } from "./PasskeyAutofill";
import type { VenueOption } from "./VenueCombobox";
import { readDeviceSignals } from "@/lib/deviceSignals";

/** Inputs that press themselves on Enter: a browser clicks them, and that is theirs to keep. */
const PRESSED = new Set(["submit", "button", "image", "reset"]);
/** What Go moves on to: a field that takes typing or a pick, never a box to tick or a hidden value. */
const SKIPPED = new Set([...PRESSED, "hidden", "checkbox", "radio"]);
function takesGo(el: Element): el is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  const field = el instanceof HTMLInputElement ? (SKIPPED.has(el.type) ? null : el) : el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement ? el : null;
  if (!field || field.disabled) return false;
  // On the screen. A closed <details> ("Played before?") keeps its fields laid out in Chrome and hides
  // them with content-visibility, so a count of boxes passes them; `checkVisibility` does not. It is
  // newer than the oldest iPhone we serve (iOS 15), where the count of boxes stands in.
  return typeof field.checkVisibility === "function" ? field.checkVisibility() : field.getClientRects().length > 0;
}

/**
 * The keyboard's Go key (Enter on a computer) in a field of the create form moves on to the next field
 * and never sends the form. The form sent itself on Go from the name or the venue, so a match was made
 * on the default day and time that nobody had looked at: 14 of the 27 matches of the 60 days to 15
 * October 2026 started exactly at the default time. A textarea keeps Enter for a new line, a button for
 * its press, and a field that answers Enter itself (the email of "Played before?", a pick from the
 * venue list) calls `preventDefault` first and keeps it. The create button is the one way to create.
 */
function enterMovesOn(e: React.KeyboardEvent<HTMLFormElement>) {
  if (e.key !== "Enter" || e.nativeEvent.isComposing || e.defaultPrevented) return;
  const from = e.target;
  if (!(from instanceof HTMLInputElement) || PRESSED.has(from.type)) return;
  e.preventDefault();
  const all = Array.from(e.currentTarget.elements);
  for (const next of all.slice(all.indexOf(from) + 1)) {
    if (!takesGo(next)) continue;
    next.focus();
    // A field the browser would not focus after all: the one after it.
    if (document.activeElement === next) return;
  }
  // The last field closes the keyboard: Go still sends nothing.
  from.blur();
}

export function CreateEventForm({
  defaultTz,
  tzFromHeader,
  venues,
  hasIdentity,
  returning,
  patterns = [],
  hasLevel = false,
  initialType = "match",
  initialCapacity,
  groupCode,
  initialValues,
  telegramTicket,
  discordTicket,
  carriedNames = [],
  booking,
}: {
  defaultTz: string;
  tzFromHeader: boolean;
  venues: VenueOption[];
  hasIdentity: boolean;
  /** The way back in for somebody who has played before, rendered on the server. Null once they are known. */
  returning?: React.ReactNode;
  /** The organizer's usual weekday/time slots (quick picks + default). */
  patterns?: TimePatternInput[];
  /** The organizer already has a level (a range then doesn't ask for theirs). */
  hasLevel?: boolean;
  /** Prefill from the URL (the americano generator links here). */
  initialType?: "match" | "tournament";
  initialCapacity?: number;
  /** Creating the next match of a group: its members get notified. */
  groupCode?: string;
  /** Field overrides (a group's usual settings). */
  initialValues?: Partial<EventFormValues>;
  /** From the Telegram bot's /new: the card is posted into that chat once the match exists. */
  telegramTicket?: string;
  /** Same for the Discord bot's /new. */
  discordTicket?: string;
  /** Players carried from the americano generator or a pasted booking: each takes a reserved spot the moment the match exists. */
  carriedNames?: string[];
  /**
   * A booking pasted on the landing page (`src=paste`): "Court booked by me" above the create button,
   * ticked when the booking said so, and the fields the booking did not carry, marked for the
   * organiser to fill in place.
   */
  booking?: {
    booked: boolean;
    missing: readonly ("venue" | "date" | "time")[];
    check?: readonly ("venue" | "date")[];
    /** The link the booking's platform made for strangers to join it: the match page shows it, once the server checked it again. */
    invite?: { url: string; platform: string } | null;
    /** The price the booking gave for the whole court: one line under the time and the place, never "Cost per player". */
    total?: string | null;
  };
}) {
  const t = useTranslations();
  // The passkey above the keyboard, on the organiser's own name field only: never on "Players you already have".
  const own = useOwnNameAutofill();
  // Default to the organizer's most usual slot; tomorrow 18:00 only for first-timers.
  const defaultFor = (tz: string) => (patterns[0] ? nextOccurrence(patterns[0].dow, patterns[0].time, tz) : tomorrowAt(tz));
  // In the zone the form opens in: a pasted booking's club's zone, else the person's own.
  const initial = defaultFor(initialValues?.tz ?? defaultTz);
  const cap = initialCapacity && Number.isInteger(initialCapacity) && initialCapacity >= 4 && initialCapacity <= 64 && initialCapacity % 4 === 0 ? initialCapacity : 8;
  const mine = venues[0]?.where === "yours" ? venues[0] : null;
  const [values, setValues] = useState<EventFormValues>({
    type: initialType,
    // The generator hands its field over already filled; a plain create starts empty.
    haveNames: carriedNames.join("\n"),
    title: "",
    date: initial.date,
    time: initial.time,
    durationMinutes: defaultLength(initialValues?.type ?? initialType),
    tz: defaultTz,
    // The first row is a default only when it is theirs. Since the picker carries the whole directory,
    // venues[0] is otherwise a club they have never been to, quietly filled in as the match's venue.
    venueName: mine?.name ?? "",
    venueMapUrl: mine?.mapUrl ?? "",
    court: "",
    note: "",
    capacity: cap,
    whenFull: "waitlist",
    courts: null,
    pointsPerMatch: null,
    gamesTo: null,
    format: "americano",
    fixedPairs: false,
    levelMin: null,
    levelMax: null,
    levelVerifiedOnly: false,
    category: null,
    ageMin: null,
    myLevel: null,
    publicListing: false,
    bookingUrl: "",
    cost: "",
    payNote: "",
    ...initialValues,
  });
  // What the link fixed, which the browser's zone below never moves: a pasted booking's day, hour and
  // zone (the club's, the chat's or the browser's). A paste with no zone takes the browser's here, as a
  // plain create does, and keeps the day and the hour it read.
  const fixed = { date: Boolean(initialValues?.date), time: Boolean(initialValues?.time) };
  const touched = useRef(booking ? Boolean(initialValues?.tz) : Boolean(initialValues?.date));
  const [bookedByMe, setBookedByMe] = useState(Boolean(booking?.booked));
  // A create link anybody can write may carry an invitation (another booking's): the form shows the link itself, and one tap takes it off.
  const [invite, setInvite] = useState(booking?.invite ?? null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  // The organiser's past players (names, days and clubs only), asked for once, when the names first show,
  // and only for somebody the app knows: "Played with you", and "Is this Danny…?" under a typed name.
  const [past, setPast] = useState<PastNamesState | null>(null);
  const [answers, setAnswers] = useState<Record<string, PastAnswer>>({});
  const [reveal, setReveal] = useState(0);
  const pastAsked = useRef(false);
  const loadPast = useCallback(() => {
    if (!hasIdentity || pastAsked.current) return;
    pastAsked.current = true;
    pastPlayersAction()
      .then((r) => setPast({ chips: r.chips, views: r.past }))
      .catch(() => undefined);
  }, [hasIdentity]);
  const answer = useCallback((who: string, a: PastAnswer | undefined) => {
    setAnswers((all) => {
      const next = { ...all };
      if (a === undefined) delete next[answerKey(who)];
      else next[answerKey(who)] = a;
      return next;
    });
  }, []);
  const addPast = useCallback((who: string) => {
    touched.current = true;
    setValues((v) => ({ ...v, haveNames: v.haveNames.trim() ? `${v.haveNames.replace(/\s+$/, "")}\n${who}` : who }));
    setAnswers((all) => ({ ...all, [answerKey(who)]: true }));
  }, []);

  // No Vercel geo header (local dev / non-Vercel host): fall back to the browser's zone.
  useEffect(() => {
    if (tzFromHeader || touched.current) return;
    try {
      const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (browserTz && browserTz !== defaultTz) {
        const d = defaultFor(browserTz);
        setValues((v) => ({ ...v, tz: browserTz, ...(fixed.date ? {} : { date: d.date }), ...(fixed.time ? {} : { time: d.time }) }));
      }
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tzFromHeader, defaultTz]);

  const onChange = (patch: Partial<EventFormValues>) => {
    touched.current = true;
    setValues((v) => ({ ...v, ...patch }));
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    // The organiser's own name typed, as before: the passkey's request waiting in that field ends first.
    own.stop();
    setError(null);
    if (!hasIdentity && !name.trim()) return setError(t("identity.nameRequired"));
    // "Is this Danny…?" still open: the place is held only once the organiser said who it is.
    const typed = namesTyped(values.haveNames);
    const waiting = past ? typed.find((n) => askFor(past.views, n).length > 0 && answerFor(answers, n) === undefined) : undefined;
    if (waiting) {
      setReveal((r) => r + 1);
      return setError(t("create.askPastFirst", { name: waiting }));
    }
    // Only "Yes" and a chip travel, as the name, the day and the club; the server finds the record again.
    const picks = typed.map((n) => pickOf(n, answerFor(answers, n))).filter((p): p is PastPick => p !== null);
    start(async () => {
      const r = await createEventAction({
        name: hasIdentity ? undefined : name,
        type: values.type,
        title: values.title || undefined,
        date: values.date,
        time: values.time,
        durationMinutes: values.durationMinutes,
        tz: values.tz,
        venueName: values.venueName || undefined,
        venueMapUrl: values.venueMapUrl || undefined,
        court: values.court || undefined,
        note: values.note || undefined,
        capacity: values.type === "tournament" ? values.capacity : undefined,
        whenFull: values.whenFull,
        courts: values.type === "tournament" ? values.courts : null,
        pointsPerMatch: values.type === "tournament" ? values.pointsPerMatch : null,
        gamesTo: values.type === "tournament" ? values.gamesTo : null,
        format: values.type === "tournament" ? values.format : undefined,
        fixedPairs: values.type === "tournament" ? values.fixedPairs : undefined,
        levelMin: values.levelMin,
        levelMax: values.levelMax,
        levelVerifiedOnly: values.levelVerifiedOnly,
        category: values.category,
        ageMin: values.ageMin,
        myLevel: values.myLevel,
        groupCode,
        telegramTicket,
        discordTicket,
        names: typed.length ? typed : undefined,
        picks: picks.length ? picks : undefined,
        publicListing: values.publicListing,
        bookingUrl: values.bookingUrl || undefined,
        cost: values.cost || undefined,
        payNote: values.payNote || undefined,
        booked: booking ? bookedByMe : undefined,
        invite: invite?.url,
      }, { hint: await readDeviceSignals() });
      // On success the action redirects to the share screen.
      if (r && !r.ok) setError(r.error === "invalid" ? t("create.errDate") : r.error === "name_required" ? t("identity.nameRequired") : t("common.somethingWrong"));
    });
  };

  return (
    <form onSubmit={submit} onKeyDown={enterMovesOn} className="flex flex-col gap-5">
      {!hasIdentity && (
        <div className="card bg-accent-soft border-accent">
          <label className="label text-ink">{t("identity.whatsYourName")}</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} onFocus={own.onFocus} placeholder={t("identity.namePlaceholder")} autoComplete={own.autoComplete} enterKeyHint="next" maxLength={40} data-testid="create-own-name" />
          {own.note}
          <p className="mt-1.5 text-sm text-muted">{t("identity.nameHelp")}</p>
          {returning}
        </div>
      )}
      <div className="card">
        <EventFields
          values={values}
          onChange={onChange}
          venues={venues}
          patterns={patterns}
          hasLevel={hasLevel}
          missing={booking?.missing}
          check={booking?.check}
          courtTotal={booking?.total ?? null}
          past={hasIdentity ? { state: past, answers, onLoad: loadPast, onAdd: addPast, onAnswer: answer, reveal } : undefined}
          enterNext
        />
      </div>
      {booking && (
        <label className="flex cursor-pointer items-start gap-3 rounded-2xl bg-ok-soft px-4 py-3">
          <input type="checkbox" className="mt-1 h-5 w-5 accent-ink" checked={bookedByMe} onChange={(e) => setBookedByMe(e.target.checked)} data-testid="booked-by-me" />
          <span className="min-w-0">
            <span className="block font-bold">🎟 {t("create.bookedByMe")}</span>
            <span className="block text-xs text-muted">{t("create.bookedByMeHelp")}</span>
          </span>
        </label>
      )}
      {invite && (
        <div className="-mt-2 px-1 text-xs text-muted" data-testid="paste-invite">
          <p>🔗 {t("create.inviteShown", { platform: invite.platform })}</p>
          <p className="mt-1 flex items-start gap-3">
            <span className="min-w-0 flex-1 break-all font-semibold text-ink" data-testid="paste-invite-link">
              {invite.url.replace(/^https:\/\//, "")}
            </span>
            <button type="button" className="shrink-0 font-semibold underline" onClick={() => setInvite(null)}>
              {t("create.inviteRemove")}
            </button>
          </p>
        </div>
      )}
      {error && <p className="text-sm font-semibold text-danger" data-testid="create-error">{error}</p>}
      <button type="submit" className="btn-primary w-full text-lg" disabled={pending}>
        {pending ? t("create.creating") : t("create.submit")}
      </button>
    </form>
  );
}
