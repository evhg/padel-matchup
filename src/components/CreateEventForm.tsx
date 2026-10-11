"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, useTransition } from "react";
import { createEventAction } from "@/actions/events";
import { nextOccurrence, tomorrowAt } from "@/lib/dates";
import { defaultLength } from "@/lib/domain/matchLength";
import { EventFields, type EventFormValues, type TimePatternInput } from "./EventFields";
import type { VenueOption } from "./VenueCombobox";

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
  };
}) {
  const t = useTranslations();
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
    setError(null);
    if (!hasIdentity && !name.trim()) return setError(t("identity.nameRequired"));
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
        names: (() => {
          const typed = values.haveNames.split("\n").map((n) => n.trim()).filter(Boolean);
          return typed.length ? typed : undefined;
        })(),
        publicListing: values.publicListing,
        bookingUrl: values.bookingUrl || undefined,
        cost: values.cost || undefined,
        payNote: values.payNote || undefined,
        booked: booking ? bookedByMe : undefined,
        invite: invite?.url,
      });
      // On success the action redirects to the share screen.
      if (r && !r.ok) setError(r.error === "invalid" ? t("create.errDate") : r.error === "name_required" ? t("identity.nameRequired") : t("common.somethingWrong"));
    });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      {!hasIdentity && (
        <div className="card bg-accent-soft border-accent">
          <label className="label text-ink">{t("identity.whatsYourName")}</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("identity.namePlaceholder")} autoComplete="given-name" maxLength={40} />
          <p className="mt-1.5 text-sm text-muted">{t("identity.nameHelp")}</p>
          {returning}
        </div>
      )}
      <div className="card">
        <EventFields values={values} onChange={onChange} venues={venues} patterns={patterns} hasLevel={hasLevel} missing={booking?.missing} check={booking?.check} />
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
