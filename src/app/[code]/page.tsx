import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { getViewer } from "@/actions/shared";
import { ActivityFeed } from "@/components/ActivityFeed";
import { AmericanoPanel } from "@/components/AmericanoPanel";
import { CalendarEmail } from "@/components/CalendarEmail";
import { CreatorPanel } from "@/components/CreatorPanel";
import { EmailField } from "@/components/EmailField";
import { Footer, Header } from "@/components/Header";
import { JoinBar, type JoinState } from "@/components/JoinBar";
import { JoinInline } from "@/components/JoinInline";
import { CreateGroupButton } from "@/components/GroupPanel";
import { JoinRequests } from "@/components/JoinRequests";
import { ConfirmLevels } from "@/components/ConfirmLevels";
import { LevelChip } from "@/components/LevelSelect";
import { OpenSpot } from "@/components/OpenSpot";
import { PushToggle } from "@/components/PushToggle";
import { ScorePanel } from "@/components/ScorePanel";
import { QrPanel, ShareButtons } from "@/components/ShareSheet";
import { SlotActions } from "@/components/SlotActions";
import { getDb } from "@/db";
import { calendarTitle } from "@/lib/calendar";
import { isValidShareCode } from "@/lib/codes";
import { baseUrl, emailEnabled, EVENT_DURATION_MS, shortHost } from "@/lib/config";
import { formatEventDay, formatEventDayLong, formatEventTime, relativeTime, tzLabel, utcToZonedParts } from "@/lib/dates";
import { isClaimable, isOccupied } from "@/lib/domain/events";
import { getGroupById } from "@/lib/domain/groups";
import { hasRange, isLevelVerified } from "@/lib/domain/levels";
import { playerHasPush } from "@/lib/domain/push";
import { getJoinRequests } from "@/lib/domain/requests";
import { getEventByCode, getRolodex, getVenues, type SlotWithPlayer } from "@/lib/domain/queries";
import { pushEnabled, vapidPublicKey } from "@/lib/push";
import { scorePermission } from "@/lib/domain/scores";
import { getTournamentState } from "@/lib/domain/tournament";
import { venueWithCourt } from "@/lib/labels";
import { rangeChip, rangeText } from "@/lib/levelText";
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
  const venue = venueWithCourt(ev, { venueTbd: t("event.venueTbd"), courtNumber: (n) => t("event.courtNumber", { n }) });
  const description = `${formatEventDay(ev.startsAt, ev.tz, locale)} · ${formatEventTime(ev.startsAt, ev.tz, locale)} · ${venue} · ${t("event.players", { count: occupied, capacity: ev.capacity })}`;
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

  // Level range: players outside it ask to join; the organizer decides.
  const levelRange = { min: ev.levelMin, max: ev.levelMax };
  const ranged = hasRange(levelRange);
  const requests = ranged ? await getJoinRequests(db, ev.id) : [];
  const myRequest = me ? requests.find((r) => r.playerId === me.id) : undefined;
  const pendingRequests = viewer.isCreator ? requests.filter((r) => r.status === "pending") : [];

  let joinState: JoinState = "join";
  if (cancelled) joinState = "cancelled";
  else if (over) joinState = "past";
  else if (isMember) joinState = started ? "member_live" : "leave";
  else if (isWaitlisted) joinState = "leave_waitlist";
  else if (myRequest?.status === "pending") joinState = "requested";
  else if (myRequest?.status === "declined") joinState = "request_declined";
  else if (spotsLeft > 0) joinState = "join";
  else if (ev.whenFull === "waitlist") joinState = "join_waitlist";
  else joinState = "full";

  const typeLabel = t(ev.type === "match" ? "event.match" : "event.tournament");
  const title = calendarTitle(ev, typeLabel);
  const day = formatEventDay(ev.startsAt, ev.tz, locale);
  const time = formatEventTime(ev.startsAt, ev.tz, locale);
  const courtNumber = (n: string) => t("event.courtNumber", { n });
  const venue = venueWithCourt(ev, { venueTbd: t("event.venueTbd"), courtNumber });
  const shareText =
    spotsLeft === 0 && ev.whenFull === "waitlist"
      ? t("shareText.eventFull", { day, time, venue, url })
      : t("shareText.event", { day, time, venue, spots: t("shareText.spotsLeft", { count: spotsLeft }), url });

  const participants = roster.filter(isOccupied);
  const isTournament = ev.type === "tournament";
  // Tournaments: reserved-but-unaccepted names count towards round 1 (placeholders get a player id when it is generated).
  const namedSlots = isTournament ? roster.filter((s) => isOccupied(s) || s.status === "invited") : participants;
  const participantIds = namedSlots.map((s) => s.playerId).filter((x): x is string => Boolean(x));
  const perm = scorePermission({ event: ev, now, viewerPlayerId: me?.id ?? null, isCreator: viewer.isCreator, participantIds });
  const enteredBy = detail.scores[0]?.enteredByPlayerId ? (participants.find((s) => s.playerId === detail.scores[0].enteredByPlayerId)?.player?.displayName ?? null) : null;
  const showScore = started && !cancelled && ev.type === "match";
  const tstate = isTournament ? await getTournamentState(db, ev, participantIds) : null;
  const levelOf = new Map<string, number | null>(namedSlots.filter((s) => s.playerId).map((s) => [s.playerId!, s.player?.level ?? null]));
  const nameOf = new Map<string, string>(namedSlots.filter((s) => s.playerId).map((s) => [s.playerId!, `${s.player?.displayName ?? s.invitedName ?? "?"}${me && s.playerId === me.id ? ` (${t("common.you")})` : ""}`]));
  const canPlayAgain = viewer.isCreator || isMember;
  // After the result is in, the organizer can confirm the levels of the people they played with.
  const levelCandidates = participants
    .filter((s) => s.player && s.playerId !== ev.creatorPlayerId && s.player.level != null)
    .map((s) => ({ id: s.player!.id, name: s.player!.displayName, level: s.player!.level!, verified: isLevelVerified(s.player!) }));
  const creatorBanner = viewer.isCreator && started && !cancelled && ((ev.type === "match" && detail.scores.length === 0) || (isTournament && (tstate?.scoredMatches ?? 0) === 0 && (tstate?.rounds.length ?? 0) > 0));

  const group = ev.groupId ? await getGroupById(db, ev.groupId) : null;
  const levelChip = rangeChip(t, levelRange);
  const levelRangeText = ranged ? rangeText(t, levelRange) : "";
  const statusChip = cancelled
    ? { cls: "chip-danger", label: t("event.statusCancelled") }
    : over
      ? { cls: "chip-muted", label: t("event.statusPast") }
      : live
        ? { cls: "chip-live", label: t("event.statusLive") }
        : spotsLeft === 0
          ? { cls: "chip-full", label: t("event.statusFull") }
          : { cls: "chip-open", label: t("event.statusOpen") };

  const [venues, rolodexAll] = viewer.isCreator ? await Promise.all([getVenues(db, ev.creatorPlayerId), getRolodex(db, ev.creatorPlayerId)]) : [[], []];
  // Suggestions never include people already in this match (joined, confirmed or invited).
  const inEventIds = new Set([...roster, ...waitlist].filter((s) => s.playerId && s.status !== "empty" && s.status !== "declined").map((s) => s.playerId!));
  const inEventNames = new Set([...roster, ...waitlist].filter((s) => s.status !== "empty" && s.status !== "declined").map((s) => (s.player?.displayName ?? s.invitedName ?? "").trim().toLowerCase()).filter(Boolean));
  const rolodex = rolodexAll.filter((r) => !(r.playerId && inEventIds.has(r.playerId)) && !inEventNames.has(r.name.trim().toLowerCase()));
  const hasPush = me && pushEnabled() ? await playerHasPush(db, me.id) : false;
  const parts = utcToZonedParts(ev.startsAt, ev.tz);
  const inviteTextTemplate = t("shareText.invite", { name: "__NAME__", day, time, venue, url: "__URL__" });
  const nudgeTextTemplate = t("shareText.nudge", { name: "__NAME__", day, time, venue, url: "__URL__" });
  const pendingInvites = roster.filter((s) => s.status === "invited" && s.inviteCode);
  const groupInviteText =
    pendingInvites.length > 0
      ? t("shareText.inviteGroup", { day, time, venue, lines: pendingInvites.map((s) => `${s.invitedName}: ${inviteUrl(base, code, s.inviteCode!)}`).join("\n") })
      : null;

  const slotRow = (s: SlotWithPlayer, index: number, isWaitlist = false) => {
    const name = s.player?.displayName ?? s.invitedName ?? "";
    const isMe = Boolean(me && s.playerId === me.id);
    const isOrganizer = s.playerId === ev.creatorPlayerId;
    const occupiedSlot = isOccupied(s);
    const inviteHref = s.inviteCode ? inviteUrl(base, code, s.inviteCode) : undefined;
    const stale = s.status === "invited" && Boolean(s.invitedAt) && now.getTime() - s.invitedAt!.getTime() > 24 * 3600 * 1000;
    const justInvited = s.status === "invited" && Boolean(s.invitedAt) && now.getTime() - s.invitedAt!.getTime() < 90 * 1000;
    const tappable = !occupiedSlot && s.status !== "invited";
    return (
      <li key={s.id} className={`rounded-2xl border px-4 py-3 ${occupiedSlot ? "border-line bg-white" : s.status === "invited" ? "border-dashed border-warn/50 bg-warn-soft/40" : "border-dashed border-line-strong bg-bg/60"}`}>
        <div className="flex items-center gap-3">
          {!tappable && (
            <span className={`inline-grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-extrabold ${occupiedSlot ? "bg-ink text-white" : "bg-line text-muted"}`}>
              {occupiedSlot ? name.slice(0, 1).toUpperCase() : isWaitlist ? index + 1 : "·"}
            </span>
          )}
          <div className="min-w-0 flex-1">
            {occupiedSlot ? (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="truncate font-bold">{name}</span>
                <LevelChip level={s.player?.level} verified={s.player ? isLevelVerified(s.player) : false} />
                {isMe && <span className="chip-open">{t("common.you")}</span>}
                {isOrganizer && <span className="chip-muted">{t("common.organizer")}</span>}
                {s.status === "confirmed" && <span className="chip-live">{t("event.confirmed")}</span>}
              </div>
            ) : s.status === "invited" ? (
              <div>
                <div className="font-bold">{t("event.reservedFor", { name })}</div>
                <div className="text-xs font-semibold text-warn">
                  {s.invitedEmail && emailEnabled()
                    ? viewer.isCreator && s.invitedAt
                      ? s.lastRemindedAt
                        ? t("creator.remindedAgo", { ago: relativeTime(s.lastRemindedAt, locale, now) })
                        : t("creator.inviteEmailedAgo", { ago: relativeTime(s.invitedAt, locale, now) })
                      : t("event.inviteSent")
                    : t("event.inviteNotAccepted")}
                </div>
              </div>
            ) : (
              <OpenSpot
                key={`${s.id}-${s.status}`}
                code={code}
                mode={cancelled || over ? "none" : viewer.isCreator ? "reserve" : !isWaitlist && joinState === "join" ? "join" : "none"}
                label={s.status === "declined" ? t("event.declinedOpen", { name }) : t("event.openSpot")}
                slotId={s.id}
                hasIdentity={Boolean(me)}
                rolodex={viewer.isCreator ? rolodex.map((r) => ({ name: r.name, email: r.email, phone: r.phone })) : []}
                emailEnabled={emailEnabled()}
                levelRange={ranged ? levelRange : null}
                myLevel={me?.level ?? null}
              />
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
            defaultOpen={justInvited}
            emailedTo={s.status === "invited" && s.invitedEmail && emailEnabled() ? s.invitedEmail : null}
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
            {levelChip && <span className="chip-muted">🎚️ {levelChip}</span>}
            {group && (
              <Link href={`/g/${group.code}`} prefetch={false} className="chip-muted hover:bg-line">
                👥 {t("group.partOf", { name: group.name })}
              </Link>
            )}
            {ev.publicListing && ev.venueSlug && ev.venueName && (
              <Link href={`/v/${ev.venueSlug}`} prefetch={false} className="chip-muted hover:bg-line">
                📍 {t("venue.listed", { venue: ev.venueName })}
              </Link>
            )}
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
              <div className={`truncate text-base font-bold ${ev.venueName ? "" : "text-muted"}`}>{venue}</div>
              <div className="text-xs text-muted">{t("event.organizedBy", { name: creator.displayName })}</div>
            </div>
            <div className="flex shrink-0 gap-1.5">
              {ev.bookingUrl && (
                <a href={ev.bookingUrl} target="_blank" rel="noopener noreferrer" className="btn-ghost btn-sm">
                  🎟 {t("event.openBooking")}
                </a>
              )}
              {ev.venueMapUrl && (
                <a href={ev.venueMapUrl} target="_blank" rel="noopener noreferrer" className="btn-ghost btn-sm">
                  📍 {t("event.openMap")}
                </a>
              )}
            </div>
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
          {me && (isMember || isWaitlisted) && !cancelled && !over && <CalendarEmail code={code} email={me.email} emailEnabled={emailEnabled()} className="mt-4" />}
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
            players={participants.map((s) => ({ id: s.playerId!, name: s.player?.displayName ?? s.invitedName ?? "", team: s.team, level: s.player?.level ?? null }))}
            canEdit={perm.allowed}
            reason={perm.allowed ? null : perm.reason}
            locked={ev.scoreLockedByCreator}
            enteredBy={enteredBy}
            canPlayAgain={canPlayAgain}
            cardHref={detail.scores.length > 0 ? `/${code}/card` : undefined}
          />
        )}
        {isTournament && tstate && (
          <AmericanoPanel
            code={code}
            format={tstate.format}
            isCreator={viewer.isCreator}
            canScore={viewer.isCreator || Boolean(me && participantIds.includes(me.id))}
            locked={ev.scoreLockedByCreator}
            started={started}
            cancelled={cancelled}
            pointsPerMatch={ev.pointsPerMatch}
            courtNames={ev.courtNames ?? null}
            rotationLength={tstate.rotationLength}
            participantCount={namedSlots.length}
            capacity={ev.capacity}
            rounds={tstate.rounds.map((r) => ({
              id: r.id,
              roundNumber: r.roundNumber,
              resting: r.resting.map((p) => nameOf.get(p) ?? "?"),
              matches: r.matches.map((m) => ({ id: m.id, court: m.court, a: [nameOf.get(m.a1) ?? "?", nameOf.get(m.a2) ?? "?"], b: [nameOf.get(m.b1) ?? "?", nameOf.get(m.b2) ?? "?"], sideA: m.sideA, sideB: m.sideB })),
            }))}
            standings={tstate.standings.map((r) => ({ playerId: r.playerId, name: nameOf.get(r.playerId) ?? "?", rank: r.rank, points: r.points, played: r.played, wins: r.wins, diff: r.diff, level: levelOf.get(r.playerId) ?? null, court: "court" in r ? r.court : null }))}
            canPlayAgain={canPlayAgain}
            cardHref={`/${code}/card`}
          />
        )}
        {viewer.isCreator && ev.scoreLockedByCreator && !cancelled && levelCandidates.length > 0 && <ConfirmLevels code={code} players={levelCandidates} />}

        {/* Players */}
        <section className="card">
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg font-extrabold">{t("event.players", { count: occupied, capacity: ev.capacity })}</h2>
            {!cancelled && !over && <span className="text-sm font-semibold text-muted">{t("event.spotsLeft", { count: spotsLeft })}</span>}
          </div>
          <ul className="mt-3 flex flex-col gap-2">{roster.map((s, i) => slotRow(s, i))}</ul>
          {pendingRequests.length > 0 && (
            <JoinRequests code={code} items={pendingRequests.map((r) => ({ id: r.id, name: r.player?.displayName ?? "?", level: r.level ?? r.player?.level ?? null, ago: relativeTime(r.createdAt, locale, now) }))} />
          )}
          {(!me || (ranged && me.level == null)) && joinState === "join_waitlist" && <JoinInline code={code} label={t("event.joinWaitlist")} hasIdentity={Boolean(me)} levelRange={ranged ? levelRange : null} myLevel={me?.level ?? null} />}
          {waitlist.length > 0 && (
            <>
              <h3 className="mt-5 text-sm font-extrabold uppercase tracking-wider text-muted">{t("event.waitlist")}</h3>
              <ul className="mt-2 flex flex-col gap-2">{waitlist.map((s, i) => slotRow(s, i, true))}</ul>
            </>
          )}
          {joinState === "full" && !viewer.isCreator && <p className="mt-4 text-sm text-muted">{t("event.fullHelp")}</p>}
          {me && me.email && (isMember || isWaitlisted) && !cancelled && !over && emailEnabled() && (
            <div className="mt-5 border-t border-line pt-4">
              <EmailField initial={me.email} mode="me" code={code} title={t("event.yourEmail")} emailEnabled={emailEnabled()} notifyOn={me.emailNotifications} />
            </div>
          )}
          {me && isMember && !cancelled && !started && pushEnabled() && (
            <div className="mt-4 border-t border-line pt-4">
              <PushToggle vapidPublicKey={vapidPublicKey()} subscribed={hasPush} />
            </div>
          )}
          {!group && me && (viewer.isCreator || isMember) && !cancelled && participants.length >= 2 && <CreateGroupButton code={code} />}
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
              venueName: ev.venueName ?? "",
              venueMapUrl: ev.venueMapUrl ?? "",
              court: ev.court ?? "",
              note: ev.note ?? "",
              capacity: ev.capacity,
              whenFull: ev.whenFull,
              courts: ev.courts,
              pointsPerMatch: ev.pointsPerMatch,
              levelMin: ev.levelMin,
              levelMax: ev.levelMax,
              myLevel: creator.level,
              publicListing: ev.publicListing,
              format: ev.format ?? "americano",
              bookingUrl: ev.bookingUrl ?? "",
            }}
            venues={venues.map((v) => ({ name: v.name, mapUrl: v.mapUrl }))}
            creatorEmail={creator.email}
            creatorNotify={creator.emailNotifications}
            emailEnabled={emailEnabled()}
            manageUrl={manageUrl(base, code, ev.manageCode)}
            isCancelled={cancelled}
            groupInvite={groupInviteText ? { text: groupInviteText, count: pendingInvites.length, url } : null}
          />
        )}

        <ActivityFeed items={detail.activity} viewerId={me?.id ?? null} />

        {(cancelled || over) && (
          <Link href="/" className="btn-primary w-full">
            {t("event.createYourOwn")}
          </Link>
        )}
      </main>
      <Footer />
      <JoinBar
        code={code}
        state={joinState}
        hasIdentity={Boolean(me)}
        spotsLeft={spotsLeft}
        waitlistPosition={waitlistPosition}
        isTournament={ev.type === "tournament"}
        levelRange={ranged ? levelRange : null}
        rangeText={levelRangeText}
        myLevel={me?.level ?? null}
        organizerName={creator.displayName}
      />
    </>
  );
}
