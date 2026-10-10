import type { Metadata } from "next";
import { detectPlatform } from "@/lib/booking/platforms";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { getViewer } from "@/actions/shared";
import { cleanSource, taggedUrl } from "@/lib/source";
import { ActivityFeed } from "@/components/ActivityFeed";
import { AmericanoPanel } from "@/components/AmericanoPanel";
import { AutoRefresh } from "@/components/tournament/AutoRefresh";
import { CreatorPanel } from "@/components/CreatorPanel";
import { EditMatch } from "@/components/EditMatch";
import type { EventFormValues } from "@/components/EventFields";
import { EmailField } from "@/components/EmailField";
import { Footer, Header } from "@/components/Header";
import { SourceTag } from "@/components/SourceTag";
import { JoinBar, type JoinState } from "@/components/JoinBar";
import { JoinInline } from "@/components/JoinInline";
import { ReturningPlayer } from "@/components/ReturningPlayer";
import { FeedbackInline } from "@/components/FeedbackInline";
import { MatchPayments } from "@/components/MatchPayments";
import { CourtBooking } from "@/components/CourtBooking";
import { prepareBooking } from "@/lib/booking/prepare";
import { courtBookedBy, mayMarkBooked } from "@/lib/domain/courtBooked";
import { paymentsFor } from "@/lib/domain/slots";
import { CreateGroupButton } from "@/components/GroupPanel";
import { JoinRequests } from "@/components/JoinRequests";
import { ConfirmLevels } from "@/components/ConfirmLevels";
import { LevelChip } from "@/components/LevelSelect";
import { OpenSpot } from "@/components/OpenSpot";
import { PushToggle } from "@/components/PushToggle";
import { ScorePanel } from "@/components/ScorePanel";
import { SeriesDoor } from "@/components/SeriesBits";
import { CopyButton, QrFold, ShareButtons } from "@/components/ShareSheet";
import { ListOnBoard } from "@/components/ListOnBoard";
import { SlotActions } from "@/components/SlotActions";
import { StayUpdated } from "@/components/StayUpdated";
import { ThatsMeButton, ThatsMeLine } from "@/components/ThatsMe";
import { LevelAfterJoin } from "@/components/LevelAfterJoin";
import { getDb } from "@/db";
import { feedKeyFor, feedLinks, stayChannels } from "@/lib/calendarFeed";
import { stayUpdated } from "@/lib/domain/stayUpdated";
import { bindDeepLink } from "@/lib/telegram/deepLinks";
import { calendarTitle } from "@/lib/calendar";
import { isValidShareCode } from "@/lib/codes";
import { baseUrl, emailEnabled, shortHost } from "@/lib/config";
import { defaultLength, eventEnd, isOver, parseMatchLength } from "@/lib/domain/matchLength";
import { formatEventDay, formatEventDayLong, formatEventTime, formatWeekdayTime, relativeTime, tzLabel, utcToZonedParts, weekdayName } from "@/lib/dates";
import { groupNameSuggestions } from "@/lib/domain/groupNames";
import { canEditMatchDetails, isClaimable, isOccupied, isSeated } from "@/lib/domain/events";
import { getEventPhotoMeta } from "@/lib/domain/photos";
import { cardImagePath, cardVersion, matchLine } from "@/lib/resultCard";
import { getGroupById } from "@/lib/domain/groups";
import { hasRange, isLevelVerified } from "@/lib/domain/levels";
import { askLevelAfterJoin } from "@/lib/domain/levelAsk";
import { cleanAgeMin, cleanCategory } from "@/lib/domain/eventTags";
import { playerHasPush } from "@/lib/domain/push";
import { getJoinRequests } from "@/lib/domain/requests";
import { myLevelChecks, verifiersFor } from "@/lib/domain/verify";
import { getShownClub, venuesForPicking } from "@/lib/domain/clubs";
import { getEventByCode, getRolodex, type SlotWithPlayer } from "@/lib/domain/queries";
import { pushEnabled, vapidPublicKey } from "@/lib/push";
import { scorePermission } from "@/lib/domain/scores";
import { getTournamentState, pairsOfSeats } from "@/lib/domain/tournament";
import { partnerOf, seatUnits, unitCounts, type SeatUnit } from "@/lib/domain/fixedPairs";
import { partnerGoesWith } from "@/lib/domain/slots";
import { BePartnerButton, PairTools, PartnerLink } from "@/components/PairRows";
import { nightField, nightPlan } from "@/lib/domain/tournamentPlan";
import { nextEdition, seriesOfEvent } from "@/lib/domain/series";
import { venueWithCourt } from "@/lib/labels";
import { rangeChip, rangeText, tagChip } from "@/lib/levelText";
import { eventUrl, inviteUrl, manageUrl, whatsappShareUrl } from "@/lib/share";
import { heldSeats, lineupNames, previewText, tellGroupText } from "@/lib/domain/groupLine";
import { bindLink, joinLink } from "@/lib/whatsapp/link";
import { markedAmong, normalAddress } from "@/lib/domain/emailMarks";
import { NO_OFFER, thatsMeOffer } from "@/lib/domain/thatsMe";

type Props = { params: Promise<{ code: string }>; searchParams?: Promise<{ s?: string }> };

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
  // The preview under a link pasted in a group: who is in and how many spots are left, so "who's in?"
  // is answered without a tap. The names of the players who are in, as the page shows them; a spot held
  // for somebody is a count, never a name, because they never said yes; never a level (decision E).
  const when = formatWeekdayTime(ev.startsAt, ev.tz, locale);
  const cancelled = ev.status === "cancelled";
  const open = !cancelled && ev.status !== "past" && !isOver(ev, new Date());
  const seats = detail.roster.map((s) => ({ status: s.status, name: s.player?.displayName ?? s.invitedName }));
  const held = open ? heldSeats(seats) : 0;
  const description = cancelled
    ? [t("og.cancelled"), when, ev.venueName].filter(Boolean).join(" · ")
    : previewText({
        when,
        venue: ev.venueName,
        names: lineupNames(seats),
        capacity: ev.capacity,
        held: held ? t("shareText.held", { count: held }) : null,
        spots: open ? t("shareText.spots", { count: detail.roster.filter(isClaimable).length }) : null,
      });
  return {
    title,
    description,
    openGraph: { title, description, url: eventUrl(baseUrl(), code), type: "website" },
    twitter: { card: "summary_large_image", title, description },
    alternates: { types: { "application/json+oembed": `${baseUrl()}/api/oembed?url=${encodeURIComponent(eventUrl(baseUrl(), code))}&format=json` } },
  };
}

export default async function EventPage({ params, searchParams }: Props) {
  const source = cleanSource((await searchParams)?.s);
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
  // Over when its own length has run out (60, 90 or 120 minutes, the organiser's pick), or the sweep said so.
  const over = ev.status === "past" || isOver(ev, now);
  const cancelled = ev.status === "cancelled";
  const live = !cancelled && started && !over;
  const me = viewer.player;
  // The organiser sees whose email stopped arriving, beside the name, so they can send the link
  // another way. One read for the whole roster; nobody else sees it (src/lib/domain/emailMarks.ts).
  const bounced = viewer.isCreator && emailEnabled() ? await markedAmong(db, [...roster, ...waitlist].flatMap((s) => [s.player?.email, s.invitedEmail])) : new Set<string>();
  const didBounce = (a: string | null | undefined) => Boolean(a) && bounced.has(normalAddress(a));
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
  // Sequential, like everything else on this page: the pooler stalls on pipelined bursts (rule 8).
  const payments = ev.cost ? (await paymentsFor(db, ev.id)).map((r) => ({ slotId: r.slotId, playerId: r.playerId, name: r.name, claimed: Boolean(r.claimedAt), paid: Boolean(r.paidAt) })) : [];
  // Confirmed levels only: who can confirm the viewer's, and whom they already asked.
  const verifiers = ranged && ev.levelVerifiedOnly && !cancelled && !over ? await verifiersFor(db, ev) : [];
  const myChecks = me && verifiers.length > 0 ? await myLevelChecks(db, me.id) : [];
  const verifierDTOs = verifiers.map((v) => (v.kind === "coach" ? { key: `coach:${v.id}`, name: v.name, target: { coachId: v.id } } : { key: `club:${v.slug}`, name: v.name, target: { clubSlug: v.slug } }));
  const askedKeys = myChecks.map((c) => (c.coachId ? `coach:${c.coachId}` : `club:${c.clubSlug}`));

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
  // Null unless a WhatsApp number is configured, so the block simply is not there (rule 4).
  const waJoin = joinLink(code);
  // "Court booked ✓ (by Ana)": a player booked and paid in the club's own app and said so (DECIDING rule 34).
  const booked = courtBookedBy(detail);
  const bookedText = booked ? (booked.name ? t("event.courtBookedBy", { name: booked.name }) : t("event.courtBooked")) : null;
  const shareVenue = bookedText ? `${venue} · ${bookedText}` : venue;
  const shareText =
    spotsLeft === 0 && ev.whenFull === "waitlist"
      ? t("shareText.eventFull", { day, time, venue: shareVenue, url })
      : t("shareText.event", { day, time, venue: shareVenue, spots: t("shareText.spotsLeft", { count: spotsLeft }), url });
  // "Tell the group": once in, one tap carries the line-up back to the group the link came from
  // (src/lib/domain/groupLine.ts). The match's own link, tagged as a WhatsApp one; never a personal
  // link, because a message in a group can be forwarded.
  const lineSeats = roster.map((s) => ({ status: s.status, name: s.player?.displayName ?? s.invitedName }));
  const tellGroup =
    joinState === "leave"
      ? whatsappShareUrl(
          tellGroupText(
            {
              when: formatWeekdayTime(ev.startsAt, ev.tz, locale),
              venue: ev.venueName,
              names: lineupNames(lineSeats),
              capacity: ev.capacity,
              held: heldSeats(lineSeats) ? t("shareText.held", { count: heldSeats(lineSeats) }) : null,
              spots: t("shareText.spots", { count: spotsLeft }),
            },
            taggedUrl(url, "wa"),
          ),
        )
      : null;

  const participants = roster.filter(isOccupied);
  const isTournament = ev.type === "tournament";
  // Tournaments: reserved-but-unaccepted names count towards round 1 (placeholders get a player id when it is generated).
  const namedSlots = isTournament ? roster.filter((s) => isOccupied(s) || s.status === "invited") : participants;
  const participantIds = namedSlots.map((s) => s.playerId).filter((x): x is string => Boolean(x));
  const perm = scorePermission({ event: ev, now, viewerPlayerId: me?.id ?? null, isCreator: viewer.isCreator, participantIds });
  const enteredBy = detail.scores[0]?.enteredByPlayerId ? (participants.find((s) => s.playerId === detail.scores[0].enteredByPlayerId)?.player?.displayName ?? null) : null;
  const showScore = started && !cancelled && ev.type === "match";
  // After the score, the card itself: the court photo and WhatsApp one tap away. The owner, 24
  // September: right after the match is when players forward it, and a WhatsApp group only ever gets
  // it by hand, so the hand has to find it here. One light read, only once a score exists.
  const result = showScore && detail.scores.length > 0 ? matchLine(t as unknown as (key: string, values?: Record<string, string | number>) => string, detail) : null;
  const resultPhoto = result ? await getEventPhotoMeta(db, ev.id).catch(() => null) : null;
  const resultCardUrl = taggedUrl(`${baseUrl()}/${code}/card`, "card");
  const resultCard = result
    ? {
        href: `/${code}/card`,
        image: cardImagePath(code, cardVersion(detail, resultPhoto)),
        alt: result.line,
        shareUrl: resultCardUrl,
        shareText: t("shareText.result", { line: result.line, day, url: resultCardUrl }),
        photo: me && (viewer.isCreator || isSeated(detail, me.id)) ? { has: Boolean(resultPhoto), canRemove: Boolean(resultPhoto && (resultPhoto.uploadedByPlayerId === me.id || viewer.isCreator)) } : null,
      }
    : null;
  // Fixed pairs (decision F): the list reads as pairs and singles, and the draw and the table as pairs.
  const fixedPairs = isTournament && ev.fixedPairs;
  const rosterUnits = fixedPairs ? seatUnits(roster) : [];
  const pairCount = unitCounts(rosterUnits).pairs;
  const myPartner = fixedPairs && mySlot ? partnerOf([...roster, ...waitlist], mySlot) : null;
  const tstate = isTournament ? await getTournamentState(db, ev, participantIds, fixedPairs ? pairsOfSeats(namedSlots) : []) : null;
  // Leaving takes the partner along only when they are still the name this player gave (one read, only then).
  const partnerGoes = myPartner?.status === "invited" && mySlot ? await partnerGoesWith(db, ev, mySlot) : false;
  const levelOf = new Map<string, number | null>(namedSlots.filter((s) => s.playerId).map((s) => [s.playerId!, s.player?.level ?? null]));
  const nameOf = new Map<string, string>(namedSlots.filter((s) => s.playerId).map((s) => [s.playerId!, `${s.player?.displayName ?? s.invitedName ?? "?"}${me && s.playerId === me.id ? ` (${t("common.you")})` : ""}`]));
  const canPlayAgain = viewer.isCreator || isMember;
  // After the result is in, the organizer can confirm the levels of the people they played with.
  const levelCandidates = participants
    .filter((s) => s.player && s.playerId !== ev.creatorPlayerId && s.player.level != null)
    .map((s) => ({ id: s.player!.id, name: s.player!.displayName, level: s.player!.level!, verified: isLevelVerified(s.player!) }));
  const creatorBanner = viewer.isCreator && started && !cancelled && ((ev.type === "match" && detail.scores.length === 0) || (isTournament && (tstate?.scoredMatches ?? 0) === 0 && (tstate?.rounds.length ?? 0) > 0));
  // A tournament has no "final score": the banner names the first round still waiting for one.
  const waitingRound = tstate?.rounds.find((r) => r.matches.some((m) => m.sideA == null || m.sideB == null))?.roundNumber ?? null;
  // The night at a glance under the title (src/lib/domain/tournamentPlan.ts), computed once and handed
  // to the panel too, so the chips and the panel's sample before round 1 name the same courts.
  // The count: the names round 1 would draw, or the field the organiser opened while it cannot start.
  // Fixed pairs: the names round 1 would draw are the players of complete pairs.
  const night = tstate ? nightPlan({ players: nightField({ format: tstate.format, names: fixedPairs ? 2 * pairCount : namedSlots.length, capacity: ev.capacity, roundsDrawn: tstate.rounds.length, fixedPairs }), courts: ev.courts, format: tstate.format, pointsPerMatch: ev.pointsPerMatch, gamesTo: ev.gamesTo, durationMinutes: ev.durationMinutes, fixedPairs }) : null;
  // The format's name, as the create form says it (FORMAT_KEYS lives in a client module, which a server page cannot read values from).
  // "Who is here?" before round 1, for whoever may start it (the organiser or a manage link): the
  // names round 1 would draw, then the waiting list, which plays only when ticked (src/lib/domain/checkIn.ts).
  const checkIn =
    tstate && tstate.rounds.length === 0 && viewer.isCreator && !ev.scoreLockedByCreator && !cancelled && !over
      ? {
          listed: namedSlots.map((s) => ({ id: s.id, name: s.player?.displayName ?? s.invitedName ?? "?", pairId: s.pairId })),
          // A fixed-pairs night's waiting pair may hold a reserved partner: a named spot like any other.
          waiting: waitlist.filter((s) => (fixedPairs ? s.status !== "empty" && s.status !== "declined" : s.status === "joined" && s.playerId)).map((s) => ({ id: s.id, name: s.player?.displayName ?? s.invitedName ?? "?", pairId: s.pairId })),
        }
      : null;
  // The night is running: round 1 drawn, scores not final. Every open page asks again every twenty
  // seconds, as the competition's screen does (`AutoRefresh`), so one phone's score reaches the rest.
  const liveNight = Boolean(tstate && tstate.rounds.length > 0) && !ev.scoreLockedByCreator && !cancelled && !over;
  const formatName = tstate ? t(({ americano: "create.formatAmericano", mexicano: "create.formatMexicano", king: "create.formatKing" } as const)[tstate.format]) : null;

  const group = ev.groupId ? await getGroupById(db, ev.groupId) : null;
  // An Open that repeats: every edition names its series; a finished tournament offers its organizer the door once.
  const seriesRow = ev.seriesId ? await seriesOfEvent(db, ev) : null;
  const seriesNext = seriesRow ? await nextEdition(db, seriesRow.id, now) : null;
  const canMakeSeries = Boolean(me) && me?.id === ev.creatorPlayerId && isTournament && Boolean(ev.standings) && !ev.seriesId && !cancelled;
  const levelChip = rangeChip(t, levelRange);
  // Who it is for, beside the level: information, never a gate (eventTags.ts).
  const forChip = tagChip(t, ev);
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

  // Sequential, not parallel: the pooler stalls on pipelined bursts (rule 8).
  // The organiser and every seated player may change the details (canEditMatchDetails), so both get the form.
  const canEdit = canEditMatchDetails(detail, { isCreator: viewer.isCreator, playerId: me?.id });
  const venues = canEdit ? await venuesForPicking(db, ev.creatorPlayerId, { tz: ev.tz }) : [];
  // The court: "Book this court" opens the club's own booking, prepared as far as its platform's public
  // pages allow (src/lib/booking/prepare.ts), for the organiser and the players; the match's own
  // booking link, when the organiser gave one, stays where it was. One read, only for them.
  const canMarkBooked = !cancelled && !over && mayMarkBooked(detail, me?.id);
  const venueClub = canMarkBooked && !ev.bookingUrl && ev.venueSlug ? await getShownClub(db, ev.venueSlug) : null;
  // Only a club somebody vetted (`mayPrepareFor`): never the website a player typed when listing a club.
  const prepared = venueClub ? prepareBooking(venueClub, { start: ev.startsAt, minutes: ev.durationMinutes, tz: ev.tz, court: ev.court }) : null;
  // The slot beside the link in the club's own zone, the one its day link uses, so the two never name different days.
  const clubTz = venueClub?.tz || ev.tz;
  const slotLine = [formatEventDay(ev.startsAt, clubTz, locale), formatEventTime(ev.startsAt, clubTz, locale), t("event.minutes", { minutes: ev.durationMinutes }), ev.court ? (/^\d{1,3}$/.test(ev.court) ? courtNumber(ev.court) : ev.court) : null].filter(Boolean).join(", ");
  const rolodexAll = viewer.isCreator ? await getRolodex(db, ev.creatorPlayerId) : [];
  // Suggestions never include people already in this match (joined, confirmed or invited).
  const inEventIds = new Set([...roster, ...waitlist].filter((s) => s.playerId && s.status !== "empty" && s.status !== "declined").map((s) => s.playerId!));
  // The same list twice over: the organiser's suggestions leave these people out, and a stranger
  // typing one of these names is offered the way back in rather than a second row of their own.
  const namesHere = [...roster, ...waitlist].filter((s) => s.status !== "empty" && s.status !== "declined").map((s) => s.player?.displayName ?? s.invitedName ?? "").filter(Boolean);
  const inEventNames = new Set(namesHere.map((n) => n.trim().toLowerCase()));
  const rolodex = rolodexAll.filter((r) => !(r.playerId && inEventIds.has(r.playerId)) && !inEventNames.has(r.name.trim().toLowerCase()));
  // "That's me" (DECIDING rule 34): a browser that knows nobody signs in as a record of this match or
  // its crew by name, inside the owner's limits; a browser that already made its own new record folds
  // it into the old one. One bounded read, and none for a viewer the rule can never apply to (the
  // organiser, a manage link included, has their own way in).
  const offer = cancelled || viewer.isCreator ? NO_OFFER : await thatsMeOffer(db, { id: ev.id, groupId: ev.groupId, creatorPlayerId: ev.creatorPlayerId }, me, namesHere);
  const offerOnRoster = (id: string | null) => Boolean(id) && (offer.ids.has(id!) || offer.fold?.id === id);
  const hasPush = me && pushEnabled() ? await playerHasPush(db, me.id) : false;
  // The moment somebody is in: where they hear about this match, asked once (src/lib/domain/stayUpdated.ts).
  const stay = me && (isMember || isWaitlisted) && !cancelled && !over ? stayUpdated(me, stayChannels()) : null;
  // Right under it, while they have no level: "Your level?" in one tap. A ranged match asked at the join already.
  const askLevel = Boolean(me) && askLevelAfterJoin({ seated: isMember || isWaitlisted, level: me?.level ?? null, ranged, organiser: viewer.isCreator, open: !cancelled && !over });
  // Only a chat player's calendar needs the feed, and only its key costs a read (the personal token, when it is not on the row yet).
  const stayFeed = me && stay?.kind === "reached" && stay.calendar === "feed" ? feedLinks(base, await feedKeyFor(db, me), locale) : null;
  const parts = utcToZonedParts(ev.startsAt, ev.tz);
  const editInitial: EventFormValues = {
    type: ev.type,
    // Editing a match that exists: its people are already on the roster below.
    haveNames: "",
    title: ev.title ?? "",
    date: parts.date,
    time: parts.time,
    durationMinutes: parseMatchLength(ev.durationMinutes) ?? defaultLength(ev.type),
    tz: ev.tz,
    venueName: ev.venueName ?? "",
    venueMapUrl: ev.venueMapUrl ?? "",
    court: ev.court ?? "",
    note: ev.note ?? "",
    capacity: ev.capacity,
    whenFull: ev.whenFull,
    courts: ev.courts,
    pointsPerMatch: ev.pointsPerMatch,
    gamesTo: ev.gamesTo,
    levelMin: ev.levelMin,
    levelMax: ev.levelMax,
    levelVerifiedOnly: ev.levelVerifiedOnly,
    category: cleanCategory(ev.category),
    ageMin: cleanAgeMin(ev.ageMin),
    myLevel: creator.level,
    publicListing: ev.publicListing,
    format: ev.format ?? "americano",
    fixedPairs: ev.fixedPairs,
    bookingUrl: ev.bookingUrl ?? "",
    cost: ev.cost ?? "",
    payNote: ev.payNote ?? "",
  };
  const venueOptions = venues.map((v) => ({ name: v.name, mapUrl: v.mapUrl, where: v.where, country: v.country, province: v.province, courts: v.courts, courtNames: v.courtNames }));
  const inviteTextTemplate = t("shareText.invite", { name: "__NAME__", day, time, venue, url: "__URL__" });
  const nudgeTextTemplate = t("shareText.nudge", { name: "__NAME__", day, time, venue, url: "__URL__" });
  // A pair that waits says so: "I saved you a spot" would not be true yet.
  const waitingInviteTemplate = t("pairs.shareWaiting", { name: "__NAME__", day, time, venue, url: "__URL__" });
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
      <li key={s.id} className={`rounded-2xl border px-4 py-3 ${occupiedSlot ? "border-line bg-card" : s.status === "invited" ? "border-dashed border-warn/50 bg-warn-soft/40" : "border-dashed border-line-strong bg-bg/60"}`}>
        <div className="flex items-center gap-3">
          {!tappable && (
            <span className={`inline-grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-extrabold ${occupiedSlot ? "bg-ink text-on-ink" : "bg-line text-muted"}`}>
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
                {viewer.isCreator && didBounce(s.player?.email) && (
                  <span className="chip-danger" data-testid="email-bounced-chip">
                    {t("creator.emailBounced")}
                  </span>
                )}
              </div>
            ) : s.status === "invited" ? (
              <div>
                <div className="font-bold">{t("event.reservedFor", { name })}</div>
                <div className="text-xs font-semibold text-warn">
                  {viewer.isCreator && didBounce(s.invitedEmail)
                    ? t("creator.inviteBounced")
                    : s.invitedEmail && emailEnabled()
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
                mode={cancelled || over ? "none" : viewer.isCreator ? "reserve" : !isWaitlist && joinState === "join" && !fixedPairs ? "join" : "none"}
                label={s.status === "declined" ? t("event.declinedOpen", { name }) : t("event.openSpot")}
                slotId={s.id}
                hasIdentity={Boolean(me)}
                rolodex={viewer.isCreator ? rolodex.map((r) => ({ name: r.name, email: r.email, phone: r.phone })) : []}
                emailEnabled={emailEnabled()}
                namesHere={namesHere}
                claimable={offer.names}
                levelRange={ranged ? levelRange : null}
                myLevel={me?.level ?? null}
              />
            )}
          </div>
          {occupiedSlot && offerOnRoster(s.playerId) && (
            <div className="shrink-0 text-right">
              <ThatsMeButton code={code} name={name} />
            </div>
          )}
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

  // A fixed-pairs night's list (decision F): one row a pair, "Ana & Bo", and one row a player who came
  // alone, "Ana · Partner needed", with "Be their partner" for whoever can take the place beside them.
  const personName = (s: SlotWithPlayer) => s.player?.displayName ?? s.invitedName ?? "";
  const beforeRound1 = (tstate?.rounds.length ?? 0) === 0 && !cancelled && !over;
  const mySingleOnList = Boolean(fixedPairs && isMember && !myPartner);
  const unitRow = (u: SeatUnit<SlotWithPlayer>, isWaitlist = false) => {
    const seatsOf = u.kind === "pair" ? u.seats : [u.seat];
    const mine = Boolean(me && seatsOf.some((s) => s.playerId === me.id));
    const hasOrganizer = seatsOf.some((s) => s.playerId === ev.creatorPlayerId);
    const invited = seatsOf.find((s) => s.status === "invited");
    const person = (s: SlotWithPlayer) => (
      <span key={s.id} className="inline-flex items-center gap-1.5">
        <span className="font-bold">{personName(s)}</span>
        <LevelChip level={s.player?.level} verified={s.player ? isLevelVerified(s.player) : false} />
      </span>
    );
    // Singles on the same side of the line, for the organiser's "Pair with…".
    const others = u.kind === "single" ? seatUnits(isWaitlist ? waitlist : roster).flatMap((x) => (x.kind === "single" && x.seat.id !== u.seat.id ? [{ id: x.seat.id, name: personName(x.seat) }] : [])) : [];
    // "Be their partner": a single on the list, before round 1, for somebody who is not in a pair and has a place to sit.
    // Never on a reserved name: its link is for whoever gave it.
    const canBePartner = u.kind === "single" && u.seat.status !== "invited" && !isWaitlist && beforeRound1 && u.seat.playerId !== me?.id && !myPartner && (mySingleOnList || (!isMember && spotsLeft > 0));
    return (
      <li key={seatsOf[0].id} className={`rounded-2xl border px-4 py-3 ${u.kind === "pair" ? "border-line bg-card" : "border-dashed border-warn/50 bg-warn-soft/40"}`} data-testid={u.kind === "pair" ? "pair-row" : "single-row"}>
        <div className="flex items-center gap-3">
          <span className="inline-grid h-9 w-9 shrink-0 place-items-center rounded-full bg-ink text-sm font-extrabold text-on-ink">{seatsOf.map((s) => personName(s).slice(0, 1).toUpperCase()).join("")}</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {u.kind === "pair" ? (
                <>
                  {person(u.seats[0])}
                  <span className="font-bold text-muted">&amp;</span>
                  {person(u.seats[1])}
                </>
              ) : (
                <>
                  {person(u.seat)}
                  <span className="text-sm font-semibold text-warn">· {t("pairs.partnerNeeded")}</span>
                </>
              )}
              {mine && <span className="chip-open">{t("common.you")}</span>}
              {hasOrganizer && <span className="chip-muted">{t("common.organizer")}</span>}
            </div>
            {invited && <div className="text-xs font-semibold text-warn">{t("event.reservedFor", { name: personName(invited) })} · {t("event.inviteNotAccepted")}</div>}
          </div>
        </div>
        {/* Whoever named the partner holds their link, and nobody else: the partner claims the spot by opening it. */}
        {invited?.inviteCode && mine && partnerGoes && !viewer.isCreator && !cancelled && !over && (
          <PartnerLink name={personName(invited)} url={inviteUrl(base, code, invited.inviteCode)} text={(invited.position > ev.capacity ? waitingInviteTemplate : inviteTextTemplate).replace("__NAME__", personName(invited)).replace("__URL__", inviteUrl(base, code, invited.inviteCode))} />
        )}
        {canBePartner && <BePartnerButton code={code} slotId={u.seat.id} hasIdentity={Boolean(me)} />}
        {/* The organiser: split or pair before round 1, a partner off by name; a reserved name keeps its forward-and-cancel, a single its remove. */}
        {viewer.isCreator && !cancelled && !over && (
          <PairTools code={code} slotId={seatsOf[0].id} kind={u.kind} singles={others} canPair={beforeRound1} removable={u.kind === "pair" ? u.seats.filter((s) => isOccupied(s) && s.playerId !== ev.creatorPlayerId).map((s) => ({ id: s.id, name: personName(s) })) : []} />
        )}
        {viewer.isCreator &&
          !cancelled &&
          !over &&
          seatsOf
            .filter((s) => s.status === "invited" || (u.kind === "single" && isOccupied(s) && s.playerId !== ev.creatorPlayerId))
            .map((s) => {
              const href = s.inviteCode ? inviteUrl(base, code, s.inviteCode) : undefined;
              const name = personName(s);
              return (
                <div key={s.id}>
                  <SlotActions
                    code={code}
                    slotId={s.id}
                    kind={s.status === "invited" ? "invited" : "member"}
                    name={name}
                    inviteUrl={href}
                    phone={s.invitedPhone}
                    forwardText={href ? inviteTextTemplate.replace("__NAME__", name).replace("__URL__", href) : undefined}
                    nudgeText={href ? nudgeTextTemplate.replace("__NAME__", name).replace("__URL__", href) : undefined}
                    stale={s.status === "invited" && Boolean(s.invitedAt) && now.getTime() - s.invitedAt!.getTime() > 24 * 3600 * 1000}
                    emailedTo={s.status === "invited" && s.invitedEmail && emailEnabled() ? s.invitedEmail : null}
                  />
                </div>
              );
            })}
      </li>
    );
  };

  return (
    <>
      <SourceTag source={source} />
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2">
        {/* Hero */}
        <section className={`card overflow-hidden ${cancelled ? "opacity-80" : ""}`}>
          <div className="flex flex-wrap items-center gap-2">
            <span className={statusChip.cls}>{statusChip.label}</span>
            <span className="text-xs font-bold uppercase tracking-wider text-faint">{typeLabel}</span>
            {levelChip && <span className="chip-muted">🎚️ {levelChip}</span>}
            {levelChip && ev.levelVerifiedOnly && <span className="chip-muted">✓ {t("levelCheck.chip")}</span>}
            {forChip && (
              <span className="chip-muted" data-testid="tag-chip">
                {forChip}
              </span>
            )}
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
            {/* The organiser's one tap onto the venue's board; the switch that takes it off again stays in More options. */}
            {viewer.isCreator && !ev.publicListing && ev.venueSlug && ev.venueName && !cancelled && !over && <ListOnBoard code={code} venue={ev.venueName} />}
          </div>
          <h1 className="mt-3 text-2xl font-extrabold leading-tight tracking-tight">{title}</h1>
          {night && (
            <div className="mt-2 flex flex-wrap gap-1.5" data-testid="night-chips">
              <span className="chip-muted">👥 {t("americano.chipPlayers", { count: occupied, capacity: ev.capacity })}</span>
              {formatName && <span className="chip-muted">{formatName}</span>}
              {fixedPairs && <span className="chip-muted">{t("pairs.fixed")}</span>}
              {ev.gamesTo ? <span className="chip-muted">{t("americano.chipGames", { n: ev.gamesTo })}</span> : ev.pointsPerMatch ? <span className="chip-muted">{t("americano.chipPoints", { n: ev.pointsPerMatch })}</span> : null}
              {night.rounds && <span className="chip-muted">{t("americano.chipRounds", { n: night.rounds })}</span>}
              <span className="chip-muted">{t("americano.chipCourts", { n: night.courts })}</span>
              <span className="chip-muted">{t("americano.chipEnds", { time: formatEventTime(eventEnd(ev), ev.tz, locale) })}</span>
            </div>
          )}
          <div className="mt-4 flex items-end gap-3">
            <div className="text-5xl font-extrabold tracking-tighter tabular-nums">{time}</div>
            <div className="pb-1">
              <div className="text-lg font-bold leading-tight">{formatEventDayLong(ev.startsAt, ev.tz, locale)}</div>
              {/* How long the court is booked, beside the start: Erik could not tell whether his match was 60 or 90 minutes (25 September 2026). */}
              <div className="text-sm font-semibold text-muted" data-testid="match-length">
                {t("event.until", { time: formatEventTime(eventEnd(ev), ev.tz, locale) })} · {t("event.minutes", { minutes: ev.durationMinutes })}
              </div>
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
                  🎟 {detectPlatform(ev.bookingUrl) ? t("club.bookOn", { platform: detectPlatform(ev.bookingUrl)!.name }) : t("event.openBooking")}
                </a>
              )}
              {ev.venueMapUrl && (
                <a href={ev.venueMapUrl} target="_blank" rel="noopener noreferrer" className="btn-ghost btn-sm">
                  📍 {t("event.openMap")}
                </a>
              )}
            </div>
          </div>
          {ev.cost && (
            <p className="mt-3 text-sm">
              <span className="font-bold">💸 {t("event.costPerPlayer", { cost: ev.cost })}</span>
              {ev.payNote && <span className="text-muted"> · {ev.payNote}</span>}
            </p>
          )}
          {ev.note && <p className="mt-3 whitespace-pre-line text-sm text-ink-soft">{ev.note}</p>}
          {(booked || canMarkBooked) && !cancelled && (
            <CourtBooking code={code} book={prepared ? { url: prepared.url, checkout: prepared.prepared === "checkout" } : null} slotLine={slotLine} booked={booked ? { name: booked.name } : null} canMark={canMarkBooked} />
          )}
          {cancelled && (
            <div className="mt-4 rounded-2xl bg-danger-soft p-4">
              <div className="font-extrabold text-danger">{t("event.cancelled")}</div>
              <div className="text-sm text-danger">{t("event.cancelledHelp")}</div>
            </div>
          )}
          {!cancelled && over && detail.scores.length === 0 && ev.type === "match" && (
            <div className="mt-4 rounded-2xl bg-bg p-4">
              <div className="font-extrabold">{t("event.past")}</div>
              <div className="text-sm text-muted">{t("event.pastNoScore")}</div>
            </div>
          )}
          {me && stay && stay.kind !== "hidden" && (
            <StayUpdated
              code={code}
              member={isMember}
              email={emailEnabled() ? me.email : null}
              state={stay}
              links={{
                whatsapp: stay.kind === "ask" && stay.choices.includes("whatsapp") ? bindLink(me, code) : null,
                telegram: stay.kind === "ask" && stay.choices.includes("telegram") ? bindDeepLink(me, code) : null,
              }}
              feed={stayFeed ? { webcal: stayFeed.webcal, google: stayFeed.google } : null}
            />
          )}
          {me && askLevel && <LevelAfterJoin playerId={me.id} />}
        </section>

        {creatorBanner && (
          <a href="#score" className="flex items-center justify-between rounded-2xl border border-accent bg-accent-soft px-4 py-3 font-bold">
            <span>🏆 {isTournament && waitingRound ? t("creator.scoreReminderTournament", { n: waitingRound }) : t("creator.scoreReminderBanner")}</span>
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
            card={resultCard}
          />
        )}
        {seriesRow && (
          <p className="px-1 text-sm text-muted" data-testid="series-line">
            <Link href={`/s/${seriesRow.slug}`} prefetch={false} className="link font-semibold">
              ↻ {t("series.partOf", { name: seriesRow.name })}
            </Link>
            {seriesNext && seriesNext.id !== ev.id ? ` · ${t("series.partOfNext", { date: formatEventDayLong(seriesNext.startsAt, seriesNext.tz, locale) })}` : ""}
          </p>
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
            gamesTo={ev.gamesTo}
            courtNames={ev.courtNames ?? null}
            rotationLength={tstate.rotationLength}
            participantCount={fixedPairs ? 2 * pairCount : namedSlots.length}
            capacity={ev.capacity}
            night={night}
            fixedPairs={fixedPairs}
            rounds={tstate.rounds.map((r) => ({
              id: r.id,
              roundNumber: r.roundNumber,
              // A resting pair is written side by side: "Ana & Bo".
              resting: fixedPairs ? r.resting.flatMap((p, i) => (i % 2 === 0 ? [`${nameOf.get(p) ?? "?"} & ${nameOf.get(r.resting[i + 1]) ?? "?"}`] : [])) : r.resting.map((p) => nameOf.get(p) ?? "?"),
              matches: r.matches.map((m) => ({ id: m.id, court: m.court, a: [nameOf.get(m.a1) ?? "?", nameOf.get(m.a2) ?? "?"], b: [nameOf.get(m.b1) ?? "?", nameOf.get(m.b2) ?? "?"], sideA: m.sideA, sideB: m.sideB })),
            }))}
            standings={
              tstate.pairStandings
                ? tstate.pairStandings.map((r) => ({ playerId: r.key, name: `${nameOf.get(r.pair[0]) ?? "?"} & ${nameOf.get(r.pair[1]) ?? "?"}`, rank: r.rank, points: r.points, played: r.played, wins: r.wins, diff: r.diff, level: null, court: r.court }))
                : tstate.standings.map((r) => ({ playerId: r.playerId, name: nameOf.get(r.playerId) ?? "?", rank: r.rank, points: r.points, played: r.played, wins: r.wins, diff: r.diff, level: levelOf.get(r.playerId) ?? null, court: "court" in r ? r.court : null }))
            }
            canPlayAgain={canPlayAgain}
            cardHref={`/${code}/card`}
            checkIn={checkIn}
          />
        )}
        {/* Live: scores typed on one phone appear on the others. Paused while the tab is hidden, gone once the scores are final or the booking is over. */}
        {liveNight && <AutoRefresh seconds={20} />}
        {viewer.isCreator && ev.scoreLockedByCreator && !cancelled && levelCandidates.length > 0 && <ConfirmLevels code={code} players={levelCandidates} />}
        {canMakeSeries && <SeriesDoor code={code} suggestedName={ev.title ?? `${ev.venueName ?? "Padel"} ${weekdayName(ev.startsAt, ev.tz, locale)} Open`} suggestedCapacity={ev.capacity} />}

        {/* Players */}
        <section className="card">
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg font-extrabold">{t("event.players", { count: occupied, capacity: ev.capacity })}</h2>
            {!cancelled && !over && <span className="text-sm font-semibold text-muted">{t("event.spotsLeft", { count: spotsLeft })}</span>}
          </div>
          <ul className="mt-3 flex flex-col gap-2">{fixedPairs ? [...rosterUnits.map((u) => unitRow(u)), ...roster.filter((s) => s.status === "empty" || s.status === "declined").map((s, i) => slotRow(s, i))] : roster.map((s, i) => slotRow(s, i))}</ul>
          {pendingRequests.length > 0 && (
            <JoinRequests code={code} items={pendingRequests.map((r) => ({ id: r.id, name: r.player?.displayName ?? "?", level: r.level ?? r.player?.level ?? null, ago: relativeTime(r.createdAt, locale, now) }))} />
          )}
          {(!me || (ranged && me.level == null)) && joinState === "join_waitlist" && <JoinInline code={code} label={t("event.joinWaitlist")} hasIdentity={Boolean(me)} levelRange={ranged ? levelRange : null} myLevel={me?.level ?? null} />}
          {waitlist.length > 0 && (
            <>
              <h3 className="mt-5 text-sm font-extrabold uppercase tracking-wider text-muted">{t("event.waitlist")}</h3>
              <ul className="mt-2 flex flex-col gap-2">{fixedPairs ? seatUnits(waitlist).map((u) => unitRow(u, true)) : waitlist.map((s, i) => slotRow(s, i, true))}</ul>
            </>
          )}
          {joinState === "full" && !viewer.isCreator && <p className="mt-4 text-sm text-muted">{t("event.fullHelp")}</p>}
          {offer.fold && ![...roster, ...waitlist].some((s) => s.playerId === offer.fold!.id) && <ThatsMeLine code={code} name={offer.fold.name} />}
          {/*
            A friend's link in a chat opens in the phone's default browser (WhatsApp's own browser is
            only for the buttons of business templates), and that browser may not be the one the
            player first joined in: another app's browser, the home-screen icon on an iPhone, Chrome
            beside Safari, another phone. Each keeps its own cookies, so the page asks "What's your
            name?" and somebody who has played before becomes a second row with none of their matches
            on it. In one week 29 players arrived and 3 joined anything, and 15 of 55 rows were a name
            that already existed. "That's me" on the roster is the way back for a record with nothing
            to prove it (DECIDING rule 34); this fold is the way for one that can prove itself. Closed
            by default, so a real first-timer reads one line and the name field above is untouched.
          */}
          {!me && (
            <div data-testid="event-back-in">
              <ReturningPlayer collapsed />
            </div>
          )}
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
          {!group && me && (viewer.isCreator || isMember) && !cancelled && participants.length >= 2 && <CreateGroupButton code={code} suggestions={groupNameSuggestions(locale, code)} />}
        </section>

        {/* Share */}
        {!cancelled && !over && (
          <section className="card">
            <h2 className="text-lg font-extrabold">{t("event.share")}</h2>
            <div className="mt-1 mb-3 truncate text-sm font-semibold text-muted">
              {shortHost()}/{code}
            </div>
            <ShareButtons url={url} text={shareText} />
            {/* The hand-off. A bot cannot be in the crew's WhatsApp group, so a person carries the
                message across: this link opens a thread with us and takes the spot from there. */}
            {waJoin && (
              <div className="mt-3 rounded-2xl border border-line px-4 py-3">
                <div className="text-sm font-bold">{t("wa.handoff")}</div>
                <p className="mt-1 text-xs text-muted">{t("wa.handoffHelp")}</p>
                <div className="mt-2 truncate text-xs text-faint">{waJoin}</div>
                <CopyButton value={waJoin} label={t("wa.copy")} className="btn-ghost btn-sm mt-2" />
              </div>
            )}
            <div className="mt-3">
              <QrFold url={url} label={t("share.qrHint")} />
            </div>
          </section>
        )}

        {viewer.isCreator && (
          <CreatorPanel
            code={code}
            initial={editInitial}
            venues={venueOptions}
            creatorEmail={creator.email}
            creatorNotify={creator.emailNotifications}
            banter={creator.banter}
            emailEnabled={emailEnabled()}
            manageUrl={manageUrl(base, code, ev.manageCode)}
            isCancelled={cancelled}
            groupInvite={groupInviteText ? { text: groupInviteText, count: pendingInvites.length, url } : null}
            paste={!cancelled && !over ? { namesHere, spots: spotsLeft } : null}
          />
        )}

        {!viewer.isCreator && canEdit && !cancelled && !over && (
          <section className="card" data-testid="player-edit">
            <h2 className="text-lg font-extrabold">{t("event.changeDetails")}</h2>
            <p className="mt-0.5 text-sm text-muted">{t("event.changeDetailsHelp")}</p>
            <div className="mt-3">
              <EditMatch code={code} initial={editInitial} venues={venueOptions} />
            </div>
          </section>
        )}

        <ActivityFeed items={detail.activity} viewerId={me?.id ?? null} />

        {(cancelled || over) && (
          <Link href="/" className="btn-primary w-full">
            {t("event.createYourOwn")}
          </Link>
        )}
        {/* A cost named means somebody has to chase it. Everyone sees the same list instead. */}
        {ev.cost && (isMember || viewer.isCreator) && payments.length > 0 && (
          <MatchPayments code={ev.code} cost={ev.cost} rows={payments} isOrganiser={viewer.isCreator} mePlayerId={me?.id ?? null} />
        )}
        {/* The quiet door for what should change, where players actually are: opens in place, never a popup. */}
        <FeedbackInline variant="line" signedInVia={me?.telegramId ? "telegram" : "none"} />
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
        verifiedOnly={ev.levelVerifiedOnly}
        verified={me ? isLevelVerified(me) : false}
        verifiers={verifierDTOs}
        asked={askedKeys}
        fixedPairs={fixedPairs}
        partnerName={myPartner ? (myPartner.player?.displayName ?? myPartner.invitedName ?? "") : null}
        partnerGoes={partnerGoes}
        pairsLocked={(tstate?.rounds.length ?? 0) > 0}
        tellGroupHref={tellGroup}
      />
    </>
  );
}
