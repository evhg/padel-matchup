import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { getViewer } from "@/actions/shared";
import { ActivityFeed } from "@/components/ActivityFeed";
import { CreatorPanel } from "@/components/CreatorPanel";
import { EmailField } from "@/components/EmailField";
import { Footer, Header } from "@/components/Header";
import { JoinBar, type JoinState } from "@/components/JoinBar";
import { ScorePanel } from "@/components/ScorePanel";
import { QrPanel, ShareButtons } from "@/components/ShareSheet";
import { SlotActions } from "@/components/SlotActions";
import { StandingsPanel } from "@/components/StandingsPanel";
import { getDb } from "@/db";
import { calendarTitle, googleCalendarUrl } from "@/lib/calendar";
import { isValidShareCode } from "@/lib/codes";
import { baseUrl, emailEnabled, EVENT_DURATION_MS, shortHost } from "@/lib/config";
import { formatEventDay, formatEventDayLong, formatEventTime, relativeTime, tzLabel, utcToZonedParts } from "@/lib/dates";
import { isClaimable, isOccupied } from "@/lib/domain/events";
import { getEventByCode, getRolodex, getVenues, type SlotWithPlayer } from "@/lib/domain/queries";
import { scorePermission } from "@/lib/domain/scores";
import { eventUrl, inviteUrl, manageUrl } from "@/lib/share";

type Props = { params: Promise<{ code: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { code } = await params;
  if (!isValidShareCode(code)) return {};
  const db = await getDb();
  const detail = await getEventByCode(db, code);
  if (!detail) return {};
  const t = await getTranslations();
  const locale = await getLocale();
  const ev = detail.event;
  const title = calendarTitle(ev, t(ev.type === "match" ? "event.match" : "event.tournament"));
  const occupied = detail.roster.filter(isOccupied).length;
  const description = `${formatEventDay(ev.startsAt, ev.tz, locale)} · ${formatEventTime(ev.startsAt, ev.tz, locale)} · ${ev.venueName} · ${t("event.players", { count: occupied, capacity: ev.capacity })}`;
  return {
    title,
    description,
    openGraph: { title, description, url: eventUrl(baseUrl(), code), type: "website" },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function EventPage({ params }: Props) {
  const { code } = await params;
  if (!isValidShareCode(code)) notFound();
  const db = await getDb();
  const detail = await getEventByCode(db, code);
  if (!detail) notFound();
  const [t, locale, viewer] = await Promise.all([getTranslations(), getLocale(), getViewer(db, detail)]);

  const { event: ev, roster, waitlist, creator } = detail;
  const now = new Date();
  const base = baseUrl();
  const url = eventUrl(base, code);
  const occupied = roster.filter(isOccupied).length;
  const spotsLeft = roster.filter(isClaimable).length;
  const started = now.getTime() >= ev.startsAt.getTime();
  const over = ev.status === "past" || now.getTime() >= ev.startsAt.getTime() + EVENT_DURATION_MS;
  const cancelled = ev.status === "cancelled";
  const live = !cancelled && started && !over;
  const me = viewer.player;
  const mySlot = me ? [...roster, ...waitlist].find((s) => s.playerId === me.id) : undefined;
  const isMember = Boolean(mySlot && mySlot.position <= ev.capacity);
  const isWaitlisted = Boolean(mySlot && mySlot.position > ev.capacity);
  const waitlistPosition = isWaitlisted ? waitlist.findIndex((s) => s.id === mySlot!.id) + 1 : 0;

  let joinState: JoinState = "join";
  if (cancelled) joinState = "cancelled";
  else if (over) joinState = "past";
  else if (isMember) joinState = started ? "member_live" : "leave";
  else if (isWaitlisted) joinState = "leave_waitlist";
  else if (spotsLeft > 0) joinState = "join";
  else if (ev.whenFull === "waitlist") joinState = "join_waitlist";
  else joinState = "full";

  const typeLabel = t(ev.type === "match" ? "event.match" : "event.tournament");
  const title = calendarTitle(ev, typeLabel);
  const day = formatEventDay(ev.startsAt, ev.tz, locale);
  const time = formatEventTime(ev.startsAt, ev.tz, locale);
  const shareText =
    spotsLeft === 0 && ev.whenFull === "waitlist"
      ? t("shareText.eventFull", { day, time, venue: ev.venueName, url })
      : t("shareText.event", { day, time, venue: ev.venueName, spots: t("shareText.spotsLeft", { count: spotsLeft }), url });
  const calendarHref = googleCalendarUrl(ev, { title, url, tz: ev.tz });

  const participants = roster.filter(isOccupied);
  const participantIds = participants.map((s) => s.playerId).filter((x): x is string => Boolean(x));
  const perm = scorePermission({ event: ev, now, viewerPlayerId: me?.id ?? null, isCreator: viewer.isCreator, participantIds });
  const enteredBy = detail.scores[0]?.enteredByPlayerId ? (participants.find((s) => s.playerId === detail.scores[0].enteredByPlayerId)?.player?.displayName ?? null) : null;
  const showScore = started && !cancelled && ev.type === "match";
  const showStandings = started && !cancelled && ev.type === "tournament";
  const creatorBanner = viewer.isCreator && started && !cancelled && ((ev.type === "match" && detail.scores.length === 0) || (ev.type === "tournament" && !(ev.standings?.length)));

  const statusChip = cancelled
    ? { cls: "chip-danger", label: t("event.statusCancelled") }
    : over
      ? { cls: "chip-muted", label: t("event.statusPast") }
      : live
        ? { cls: "chip-live", label: t("event.statusLive") }
        : spotsLeft === 0
          ? { cls: "chip-full", label: t("event.statusFull") }
          : { cls: "chip-open", label: t("event.statusOpen") };

  const [venues, rolodex] = viewer.isCreator ? await Promise.all([getVenues(db, ev.creatorPlayerId), getRolodex(db, ev.creatorPlayerId)]) : [[], []];
  const parts = utcToZonedParts(ev.startsAt, ev.tz);
  const inviteTextTemplate = t("shareText.invite", { name: "__NAME__", day, time, venue: ev.venueName, url: "__URL__" });
  const nudgeTextTemplate = t("shareText.nudge", { name: "__NAME__", day, time, venue: ev.venueName, url: "__URL__" });

  const slotRow = (s: SlotWithPlayer, index: number, isWaitlist = false) => {
    const name = s.player?.displayName ?? s.invitedName ?? "";
    const isMe = Boolean(me && s.playerId === me.id);
    const isOrganizer = s.playerId === ev.creatorPlayerId;
    const occupiedSlot = isOccupied(s);
    const inviteHref = s.inviteCode ? inviteUrl(base, code, s.inviteCode) : undefined;
    const stale = s.status === "invited" && Boolean(s.invitedAt) && now.getTime() - s.invitedAt!.getTime() > 24 * 3600 * 1000;
    return (
      <li key={s.id} className={`rounded-2xl border px-4 py-3 ${occupiedSlot ? "border-line bg-white" : s.status === "invited" ? "border-dashed border-warn/50 bg-warn-soft/40" : "border-dashed border-line-strong bg-bg/60"}`}>
        <div className="flex items-center gap-3">
          <span className={`inline-grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-extrabold ${occupiedSlot ? "bg-ink text-white" : "bg-line text-muted"}`}>
            {occupiedSlot ? name.slice(0, 1).toUpperCase() : isWaitlist ? index + 1 : "·"}
          </span>
          <div className="min-w-0 flex-1">
            {occupiedSlot ? (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="truncate font-bold">{name}</span>
                {isMe && <span className="chip-open">{t("common.you")}</span>}
                {isOrganizer && <span className="chip-muted">{t("common.organizer")}</span>}
                {s.status === "confirmed" && <span className="chip-live">{t("event.confirmed")}</span>}
              </div>
            ) : s.status === "invited" ? (
              <div>
                <div className="font-bold">{t("event.reservedFor", { name })}</div>
                <div className="text-xs font-semibold text-warn">
                  {t("event.invited")}
                  {viewer.isCreator && s.invitedAt && <> · {s.lastRemindedAt ? t("creator.remindedAgo", { ago: relativeTime(s.lastRemindedAt, locale, now) }) : t("creator.invitedAgo", { ago: relativeTime(s.invitedAt, locale, now) })}</>}
                </div>
              </div>
            ) : s.status === "declined" ? (
              <span className="font-semibold text-muted">{t("event.declinedOpen", { name })}</span>
            ) : (
              <span className="font-semibold text-muted">{t("event.openSpot")}</span>
            )}
          </div>
        </div>
        {viewer.isCreator && !cancelled && !over && (s.status === "invited" || (occupiedSlot && !isOrganizer)) && (
          <SlotActions
            code={code}
            slotId={s.id}
            kind={s.status === "invited" ? "invited" : "member"}
            name={name}
            inviteUrl={inviteHref}
            phone={s.invitedPhone}
            forwardText={inviteHref ? inviteTextTemplate.replace("__NAME__", name).replace("__URL__", inviteHref) : undefined}
            nudgeText={inviteHref ? nudgeTextTemplate.replace("__NAME__", name).replace("__URL__", inviteHref) : undefined}
            stale={stale}
          />
        )}
      </li>
    );
  };

  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2">
        {/* Hero */}
        <section className={`card overflow-hidden ${cancelled ? "opacity-80" : ""}`}>
          <div className="flex flex-wrap items-center gap-2">
            <span className={statusChip.cls}>{statusChip.label}</span>
            <span className="text-xs font-bold uppercase tracking-wider text-faint">{typeLabel}</span>
          </div>
          <h1 className="mt-3 text-2xl font-extrabold leading-tight tracking-tight">{title}</h1>
          <div className="mt-4 flex items-end gap-3">
            <div className="text-5xl font-extrabold tracking-tighter tabular-nums">{time}</div>
            <div className="pb-1">
              <div className="text-lg font-bold leading-tight">{formatEventDayLong(ev.startsAt, ev.tz, locale)}</div>
              <div className="text-xs font-semibold text-faint">
                {tzLabel(ev.startsAt, ev.tz, locale)} · {!over && !cancelled ? t("event.startsIn", { when: relativeTime(ev.startsAt, locale, now) }) : relativeTime(ev.startsAt, locale, now)}
              </div>
            </div>
          </div>
          <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl bg-bg px-4 py-3">
            <div className="min-w-0">
              <div className="truncate text-base font-bold">{ev.venueName}</div>
              <div className="text-xs text-muted">{t("event.organizedBy", { name: creator.displayName })}</div>
            </div>
            {ev.venueMapUrl && (
              <a href={ev.venueMapUrl} target="_blank" rel="noopener noreferrer" className="btn-ghost btn-sm shrink-0">
                📍 {t("event.openMap")}
              </a>
            )}
          </div>
          {ev.note && <p className="mt-3 whitespace-pre-line text-sm text-ink-soft">{ev.note}</p>}
          {cancelled && (
            <div className="mt-4 rounded-2xl bg-danger-soft p-4">
              <div className="font-extrabold text-danger">{t("event.cancelled")}</div>
              <div className="text-sm text-danger/80">{t("event.cancelledHelp")}</div>
            </div>
          )}
          {!cancelled && over && detail.scores.length === 0 && ev.type === "match" && (
            <div className="mt-4 rounded-2xl bg-bg p-4">
              <div className="font-extrabold">{t("event.past")}</div>
              <div className="text-sm text-muted">{t("event.pastNoScore")}</div>
            </div>
          )}
          {!cancelled && !over && (
            <a href={calendarHref} target="_blank" rel="noopener noreferrer" className="btn-ghost mt-4 w-full">
              📅 {t("event.addToCalendar")}
            </a>
          )}
        </section>

        {creatorBanner && (
          <a href="#score" className="flex items-center justify-between rounded-2xl border border-accent bg-accent-soft px-4 py-3 font-bold">
            <span>🏆 {t("creator.scoreReminderBanner")}</span>
            <span>→</span>
          </a>
        )}

        {showScore && (
          <ScorePanel
            code={code}
            scores={detail.scores.map((s) => ({ setNumber: s.setNumber, sideA: s.sideA, sideB: s.sideB }))}
            players={participants.map((s) => ({ id: s.playerId!, name: s.player?.displayName ?? s.invitedName ?? "", team: s.team }))}
            canEdit={perm.allowed}
            reason={perm.allowed ? null : perm.reason}
            locked={ev.scoreLockedByCreator}
            enteredBy={enteredBy}
          />
        )}
        {showStandings && (
          <StandingsPanel
            code={code}
            players={participants.map((s) => ({ id: s.playerId!, name: s.player?.displayName ?? s.invitedName ?? "" }))}
            standings={ev.standings ?? []}
            canEdit={viewer.isCreator}
          />
        )}

        {/* Players */}
        <section className="card">
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg font-extrabold">{t("event.players", { count: occupied, capacity: ev.capacity })}</h2>
            {!cancelled && !over && <span className="text-sm font-semibold text-muted">{t("event.spotsLeft", { count: spotsLeft })}</span>}
          </div>
          <ul className="mt-3 flex flex-col gap-2">{roster.map((s, i) => slotRow(s, i))}</ul>
          {waitlist.length > 0 && (
            <>
              <h3 className="mt-5 text-sm font-extrabold uppercase tracking-wider text-muted">{t("event.waitlist")}</h3>
              <ul className="mt-2 flex flex-col gap-2">{waitlist.map((s, i) => slotRow(s, i, true))}</ul>
            </>
          )}
          {joinState === "full" && !viewer.isCreator && <p className="mt-4 text-sm text-muted">{t("event.fullHelp")}</p>}
          {me && (isMember || isWaitlisted) && !cancelled && !over && emailEnabled() && (
            <div className="mt-5 border-t border-line pt-4">
              <EmailField initial={me.email} mode="me" code={code} title={t("event.yourEmail")} emailEnabled={emailEnabled()} />
            </div>
          )}
        </section>

        {/* Share */}
        {!cancelled && !over && (
          <section className="card">
            <h2 className="text-lg font-extrabold">{t("event.share")}</h2>
            <div className="mt-1 mb-3 truncate text-sm font-semibold text-muted">
              {shortHost()}/{code}
            </div>
            <ShareButtons url={url} text={shareText} />
            <details className="mt-3 group">
              <summary className="cursor-pointer list-none text-sm link">QR · {t("share.qrHint")}</summary>
              <div className="mt-3">
                <QrPanel url={url} />
              </div>
            </details>
          </section>
        )}

        {viewer.isCreator && (
          <CreatorPanel
            code={code}
            initial={{
              type: ev.type,
              title: ev.title ?? "",
              date: parts.date,
              time: parts.time,
              tz: ev.tz,
              venueName: ev.venueName,
              venueMapUrl: ev.venueMapUrl ?? "",
              note: ev.note ?? "",
              capacity: ev.capacity,
              whenFull: ev.whenFull,
            }}
            venues={venues.map((v) => ({ name: v.name, mapUrl: v.mapUrl }))}
            rolodex={rolodex.map((r) => ({ name: r.name, email: r.email, phone: r.phone }))}
            canReserve={!cancelled && !over && spotsLeft > 0}
            creatorEmail={creator.email}
            emailEnabled={emailEnabled()}
            manageUrl={manageUrl(base, code, ev.manageCode)}
            inviteTextTemplate={inviteTextTemplate}
            isCancelled={cancelled}
          />
        )}

        <ActivityFeed items={detail.activity} />

        {(cancelled || over) && (
          <Link href="/new" className="btn-primary w-full">
            {t("event.createYourOwn")}
          </Link>
        )}
      </main>
      <Footer code={code} />
      <JoinBar code={code} state={joinState} hasIdentity={Boolean(me)} spotsLeft={spotsLeft} waitlistPosition={waitlistPosition} isTournament={ev.type === "tournament"} />
    </>
  );
}
