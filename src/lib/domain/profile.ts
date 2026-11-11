import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, or } from "drizzle-orm";
import type { Db } from "@/db";
import {
  coachBlocks,
  coachManagers,
  coachOpenings,
  coachPackageOffers,
  coachStudents,
  coachWants,
  coaches,
  competitionPairs,
  competitions,
  demandSignals,
  events,
  feedback,
  groupRequests,
  groups,
  joinRequests,
  lessonPackages,
  lessonRequests,
  lessonWaitlist,
  lessons,
  levelChecks,
  milestones,
  notices,
  passkeys,
  players,
  pushSubscriptions,
  series,
  venues,
  type Player,
} from "@/db/schema";
import { clubStatus, listClubsClaimedBy } from "./clubs";
import { deviceHintsOf } from "./deviceHints";
import { placesOf } from "./fixedPairs";
import { getPlayerGroups } from "./groups";
import { bandOf, isLevelVerified } from "./levels";
import { signPassport, type Passport, type SignedPassport } from "./passport";
import { getPlayerEvents, type MyEvent } from "./queries";
import { venueSlug } from "./venueBoard";

/**
 * The player passport: an opt-in public page (/u/{slug}), a signed level
 * document any app can verify, and a one-file export of everything we hold.
 * Off by default; nothing here is reachable until the player switches it on.
 */
const SLUG_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const PASSPORT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const suffix = () => Array.from(randomBytes(5), (b) => SLUG_ALPHABET[b % SLUG_ALPHABET.length]).join("");

/** "Ana María" → "ana-x7k2m": first name, ASCII, plus five random characters so names never collide. */
export function mintPublicSlug(displayName: string): string {
  const first = venueSlug(displayName.trim().split(/\s+/)[0] ?? "")?.slice(0, 20) || "player";
  return `${first}-${suffix()}`;
}

export const isValidPublicSlug = (s: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s) && s.length >= 7 && s.length <= 40;

export async function setPublicProfile(db: Db, playerId: string, on: boolean, now = new Date()): Promise<Player | null> {
  const [me] = await db.select().from(players).where(eq(players.id, playerId)).limit(1);
  if (!me) return null;
  const slug = me.publicSlug ?? mintPublicSlug(me.displayName);
  const [row] = await db
    .update(players)
    .set({ publicProfile: on, publicSlug: slug, publicSince: on ? (me.publicSince ?? now) : me.publicSince })
    .where(eq(players.id, playerId))
    .returning();
  return row;
}

export async function getPublicPlayer(db: Db, slug: string): Promise<Player | null> {
  if (!isValidPublicSlug(slug)) return null;
  const [p] = await db.select().from(players).where(and(eq(players.publicSlug, slug), eq(players.publicProfile, true))).limit(1);
  return p ?? null;
}

export type ProfileStats = { played: number; won: number; decided: number; podiums: number; clubs: { name: string; slug: string }[]; since: Date };

/** Results the player was actually in (not organised from the sidelines), finished matches only. */
export function statsFromEvents(player: Pick<Player, "id" | "createdAt">, past: MyEvent[]): ProfileStats {
  const played = past.filter((m) => m.event.status !== "cancelled" && m.slot.position > 0 && m.slot.position <= m.event.capacity);
  const won = played.filter((m) => m.outcome === "won").length;
  const decided = played.filter((m) => m.outcome === "won" || m.outcome === "lost").length;
  const podiums = played.filter((m) => m.event.type === "tournament" && placesOf(m.event).slice(0, 3).flat().includes(player.id)).length;
  const clubs = new Map<string, string>();
  for (const m of played) {
    const slug = m.event.venueSlug;
    if (slug && m.event.venueName && !clubs.has(slug)) clubs.set(slug, m.event.venueName);
  }
  return { played: played.length, won, decided, podiums, clubs: [...clubs.entries()].slice(0, 8).map(([slug, name]) => ({ slug, name })), since: player.createdAt };
}

export async function profileStats(db: Db, player: Player, now = new Date()): Promise<ProfileStats> {
  const { past } = await getPlayerEvents(db, player.id, now);
  return statsFromEvents(player, past);
}

export function buildPassport(player: Player, stats: Pick<ProfileStats, "played" | "won">, base: string, publicKeyHex: string | null, now = new Date()): Passport {
  return {
    v: 1,
    iss: base,
    kid: publicKeyHex ? publicKeyHex.slice(0, 8).toLowerCase() : "none",
    sub: `${base}/u/${player.publicSlug}`,
    name: player.displayName,
    level: player.level,
    band: player.level != null ? bandOf(player.level) : null,
    verified: isLevelVerified(player),
    source: player.levelSource,
    played: stats.played,
    won: stats.won,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PASSPORT_TTL_MS).toISOString(),
  };
}

export const passportKeys = () => {
  const priv = process.env.PASSPORT_PRIVATE_KEY;
  const pub = process.env.PASSPORT_PUBLIC_KEY;
  return priv && pub && /^[0-9a-f]{64}$/i.test(priv) && /^[0-9a-f]{64}$/i.test(pub) ? { priv, pub } : null;
};

/** The signed document, or the plain one with alg "none" when no key is configured (a self-hosted copy without keys). */
export async function issuePassport(player: Player, stats: Pick<ProfileStats, "played" | "won">, base: string, now = new Date()): Promise<SignedPassport | (Passport & { alg: "none"; sig: null })> {
  const keys = passportKeys();
  const doc = buildPassport(player, stats, base, keys?.pub ?? null, now);
  if (!keys) return { ...doc, alg: "none", sig: null };
  return signPassport(doc, keys.priv, keys.pub);
}

/**
 * The most rows of one kind the export carries, newest first. Far above what a player makes (a want lives
 * a month, a coach's busiest year is some hundreds of lessons), so the file is whole in practice and one
 * read can never run away with the request (rule 12).
 */
export const EXPORT_LIST_MAX = 1000;

/**
 * Everything we hold about a player, in one file. Their own contact details, yes; tokens and manage links,
 * never. The owner's decision of 9 November 2026, "Export holds everything" (the privacy page promises
 * "everything we hold about you"): every row about the player, table by table, `tests/export.test.ts` holds
 * the list. Other people stay out of it: a lesson's student, a pair's partner, a coach's list of students.
 * Sequential reads (rule 8), each by an index that starts with the player where one exists, each bounded.
 * The export is a cold path: a tap on My matches, ten a day at most.
 */
export async function exportPlayerData(db: Db, player: Player, base: string, now = new Date()) {
  const { upcoming, past } = await getPlayerEvents(db, player.id, now);
  const myGroups = await getPlayerGroups(db, player.id);
  const clubs = await listClubsClaimedBy(db, player.id);
  const match = (m: MyEvent) => ({
    code: m.event.code,
    url: `${base}/${m.event.code}`,
    type: m.event.type,
    format: m.event.format,
    title: m.event.title,
    startsAt: m.event.startsAt,
    tz: m.event.tz,
    venue: m.event.venueName,
    status: m.event.status,
    organizer: m.event.creatorPlayerId === player.id,
    seat: m.slot.position > 0 && m.slot.position <= m.event.capacity ? m.slot.position : null,
    waitlisted: m.slot.position > m.event.capacity,
    team: m.slot.team,
    outcome: m.outcome,
  });
  const stats = statsFromEvents(player, past);
  // What they set and what they were told: theirs to download like the rest, and nobody else's to read.
  const inbox = await db.select({ kind: notices.kind, key: notices.key, params: notices.params, createdAt: notices.createdAt, deliveredAt: notices.deliveredAt, readAt: notices.readAt }).from(notices).where(eq(notices.playerId, player.id)).orderBy(desc(notices.createdAt));
  // The phones that remember them (DECIDING rule 39): the words, the day saved and the day last used, as My
  // matches lists them. Never the credential id or the public key: the select names neither column.
  const phones = await db.select({ label: passkeys.label, savedAt: passkeys.createdAt, lastUsedAt: passkeys.lastUsedAt }).from(passkeys).where(eq(passkeys.playerId, player.id)).orderBy(asc(passkeys.createdAt));
  // The phones we recognise (device hints, the owner's decision of 28 October 2026): the words and the two
  // days, as My matches lists them. Never the key: the read names no such column.
  const deviceHints = (await deviceHintsOf(db, player.id)).map((h) => ({ label: h.label, savedAt: h.createdAt, lastSeenAt: h.lastSeenAt }));
  const rest = await exportRest(db, player, base);
  return {
    exportedAt: now.toISOString(),
    format: "kicksmash-export/1",
    player: {
      displayName: player.displayName,
      email: player.email,
      phone: player.phone,
      locale: player.locale,
      level: player.level,
      levelSource: player.levelSource,
      levelUpdatedAt: player.levelUpdatedAt,
      levelVerifiedAt: player.levelVerifiedAt,
      levelLog: player.levelLog ?? [],
      rankingOptIn: player.rankingOptIn,
      // "Don't recognise my phones" (DECIDING rule 40): the moment the player switched it on, or null.
      hintsOff: player.hintsOff,
      publicProfile: player.publicProfile,
      publicUrl: player.publicProfile && player.publicSlug ? `${base}/u/${player.publicSlug}` : null,
      telegram: player.telegramUsername,
      discord: player.discordUsername,
      // The rest of the row (the owner's decision of 9 November 2026): every column but the two tokens.
      emailVerifiedAt: player.emailVerifiedAt,
      recoveryEmail: player.recoveryEmail,
      emailNotifications: player.emailNotifications,
      telegramId: player.telegramId,
      discordId: player.discordId,
      lineId: player.lineId,
      line: player.lineDisplayName,
      banter: player.banter,
      homescreenAt: player.homescreenAt,
      levelVerifiedLevel: player.levelVerifiedLevel,
      levelVerifiedSource: player.levelVerifiedSource,
      publicSince: player.publicSince,
      createdAt: player.createdAt,
    },
    stats: { played: stats.played, won: stats.won, decided: stats.decided, podiums: stats.podiums },
    matches: { upcoming: upcoming.map(match), past: past.map(match) },
    groups: myGroups.map((g) => ({ code: g.group.code, name: g.group.name, url: `${base}/g/${g.group.code}` })),
    clubs: clubs.map((c) => ({ slug: c.slug, name: c.name, status: clubStatus(c), url: `${base}/v/${c.slug}` })),
    notices: { kinds: player.noticeKinds ?? {}, quietFrom: player.quietFrom, quietTo: player.quietTo, quietTz: player.quietTz, inbox },
    phones,
    deviceHints,
    ...rest,
    passport: await issuePassport(player, stats, base, now),
  };
}

/**
 * The rows the export left out until 9 November 2026 (F6 of the audit of that day), one read each, in order.
 * What stays out, and why: the personal link and its old token, manage links, a coach's invite and manager
 * codes and calendar feed (each one signs somebody in or reads a private calendar); a passkey's credential and
 * a device hint's key (`phones`, `deviceHints` above say what they are); a push endpoint and its keys; the
 * students on a coach's lessons and a pair's partner (other people); the fact log (`recordFact`: counts, with
 * no name), the match feed and the scores, which belong to the matches above; an address's opt-out and
 * bounce rows, which are about the address, not the person; one-time email codes, which live minutes.
 * Six reads have no index that starts with the player (`feedback`, `join_requests`, `competition_pairs`, and
 * a student's packages, waiting lists and requests): an index is a migration, the tables are small, and
 * nothing but this file reads them from the player's side.
 */
async function exportRest(db: Db, player: Player, base: string) {
  const id = player.id;
  const N = EXPORT_LIST_MAX;
  // "When do you want to play" (`demand_player_idx`) and "I want a coach" (`coach_wants_player_city_idx`).
  const wants = await db
    .select({ weekday: demandSignals.weekday, onDate: demandSignals.onDate, fromTime: demandSignals.fromTime, toTime: demandSignals.toTime, venue: demandSignals.venueSlug, city: demandSignals.citySlug, toldAt: demandSignals.notifiedAt, expiresAt: demandSignals.expiresAt, createdAt: demandSignals.createdAt })
    .from(demandSignals)
    .where(eq(demandSignals.playerId, id))
    .orderBy(desc(demandSignals.createdAt))
    .limit(N);
  const coachWanted = await db
    .select({ city: coachWants.citySlug, level: coachWants.level, when: coachWants.whenNote, toldAt: coachWants.notifiedAt, expiresAt: coachWants.expiresAt, createdAt: coachWants.createdAt })
    .from(coachWants)
    .where(eq(coachWants.playerId, id))
    .orderBy(desc(coachWants.createdAt))
    .limit(N);
  // The notes from the feedback form, with the name and the contact we keep on them (/privacy). A note sent
  // from Telegram before the account was linked carries the Telegram user id (`feedback_tg_user_idx`). Our own
  // triage of a note (`verdict`, `assessment`) and the chats' message ids are about the note, not the person.
  const notes = await db
    .select({ source: feedback.source, name: feedback.name, email: feedback.email, telegramUserId: feedback.telegramUserId, discordUserId: feedback.discordUserId, text: feedback.text, context: feedback.context, status: feedback.status, reply: feedback.replyText, repliedAt: feedback.repliedAt, shippedAt: feedback.shippedAt, publicSummary: feedback.publicSummary, publicName: feedback.publicName, createdAt: feedback.createdAt })
    .from(feedback)
    .where(player.telegramId ? or(eq(feedback.playerId, id), eq(feedback.telegramUserId, player.telegramId)) : eq(feedback.playerId, id))
    .orderBy(desc(feedback.createdAt))
    .limit(N);
  // Asks to join a crew (`group_requests_player_idx`) and a match outside its level range (no player index).
  const groupAsks = await db
    .select({ group: groups.code, name: groups.name, note: groupRequests.note, status: groupRequests.status, createdAt: groupRequests.createdAt, decidedAt: groupRequests.decidedAt })
    .from(groupRequests)
    .innerJoin(groups, eq(groups.id, groupRequests.groupId))
    .where(eq(groupRequests.playerId, id))
    .orderBy(desc(groupRequests.createdAt))
    .limit(N);
  const matchAsks = await db
    .select({ match: events.code, level: joinRequests.level, status: joinRequests.status, createdAt: joinRequests.createdAt, decidedAt: joinRequests.decidedAt })
    .from(joinRequests)
    .innerJoin(events, eq(events.id, joinRequests.eventId))
    .where(eq(joinRequests.playerId, id))
    .orderBy(desc(joinRequests.createdAt))
    .limit(N);
  // Level checks asked of a coach or a club, the pending ones and the answered ones (`level_checks_player_idx`).
  const checks = await db
    .select({ coach: coaches.handle, club: levelChecks.clubSlug, level: levelChecks.level, status: levelChecks.status, decidedLevel: levelChecks.decidedLevel, createdAt: levelChecks.createdAt, decidedAt: levelChecks.decidedAt })
    .from(levelChecks)
    .leftJoin(coaches, eq(coaches.id, levelChecks.coachId))
    .where(eq(levelChecks.playerId, id))
    .orderBy(desc(levelChecks.createdAt))
    .limit(N);
  // The coach's page (`coaches_player_idx`), and for a coach only, the book behind it.
  const [page] = await db.select().from(coaches).where(eq(coaches.playerId, id)).limit(1);
  let coach = null;
  if (page) {
    const given = await db
      .select({ startsAt: lessons.startsAt, minutes: lessons.minutes, status: lessons.status, kind: lessons.kind, heads: lessons.heads, amount: lessons.amount, paidAt: lessons.paidAt, compedAt: lessons.compedAt, note: lessons.note, venue: lessons.venueSlug, court: lessons.court, createdAt: lessons.createdAt, cancelledAt: lessons.cancelledAt })
      .from(lessons)
      .where(eq(lessons.coachId, page.id))
      .orderBy(desc(lessons.startsAt))
      .limit(N);
    const offers = await db
      .select({ size: coachPackageOffers.size, minutes: coachPackageOffers.minutes, heads: coachPackageOffers.heads, price: coachPackageOffers.price, validDays: coachPackageOffers.validDays, createdAt: coachPackageOffers.createdAt, archivedAt: coachPackageOffers.archivedAt })
      .from(coachPackageOffers)
      .where(eq(coachPackageOffers.coachId, page.id))
      .orderBy(asc(coachPackageOffers.position))
      .limit(N);
    const blocked = await db
      .select({ startsAt: coachBlocks.startsAt, endsAt: coachBlocks.endsAt, reason: coachBlocks.reason, createdAt: coachBlocks.createdAt })
      .from(coachBlocks)
      .where(eq(coachBlocks.coachId, page.id))
      .orderBy(desc(coachBlocks.startsAt))
      .limit(N);
    const opened = await db
      .select({ startsAt: coachOpenings.startsAt, endsAt: coachOpenings.endsAt, createdAt: coachOpenings.createdAt })
      .from(coachOpenings)
      .where(eq(coachOpenings.coachId, page.id))
      .orderBy(desc(coachOpenings.startsAt))
      .limit(N);
    coach = {
      handle: page.handle,
      url: `${base}/c/${page.handle}`,
      displayName: page.displayName,
      bio: page.bio,
      clubs: page.clubNames,
      languages: page.languages,
      lessonMinutes: page.lessonMinutes,
      secondMinutes: page.secondMinutes,
      court: page.court,
      hours: page.hours,
      tz: page.tz,
      cutoffHours: page.cutoffHours,
      latePasses: page.latePasses,
      minNoticeHours: page.minNoticeHours,
      prices: { single: page.priceSingle, two: page.priceTwo, three: page.priceThree, four: page.priceFour, secondSingle: page.priceSecondSingle, secondTwo: page.priceSecondTwo, outsideHoursFee: page.outsideHoursFee, currency: page.currency },
      payAtClub: page.payAtClub,
      promptpayId: page.promptpayId,
      payLink: page.payLink,
      whatsapp: page.whatsapp,
      isPublic: page.isPublic,
      openBooking: page.openBooking,
      approveNewBookings: page.approveNewBookings,
      teachesLevelMin: page.teachesLevelMin,
      teachesLevelMax: page.teachesLevelMax,
      googleCalendar: page.gcalStatus,
      foundingAt: page.foundingAt,
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
      archivedAt: page.archivedAt,
      offers,
      lessons: given,
      blocked,
      opened,
    };
  }
  // Books the player runs for a coach (`coach_managers_player_idx`).
  const manages = await db.select({ coach: coaches.handle, since: coachManagers.createdAt }).from(coachManagers).innerJoin(coaches, eq(coaches.id, coachManagers.coachId)).where(eq(coachManagers.playerId, id)).limit(N);
  // The player as a student: the coaches' lists (`coach_students_player_idx`), the lessons (`lessons_student_idx`),
  // the packages, the waiting lists and the requests (no index of these three starts with the student).
  const studentOf = await db
    .select({ coach: coaches.handle, status: coachStudents.status, note: coachStudents.note, createdAt: coachStudents.createdAt, acceptedAt: coachStudents.acceptedAt })
    .from(coachStudents)
    .innerJoin(coaches, eq(coaches.id, coachStudents.coachId))
    .where(eq(coachStudents.playerId, id))
    .limit(N);
  const taken = await db
    .select({ coach: coaches.handle, startsAt: lessons.startsAt, minutes: lessons.minutes, status: lessons.status, kind: lessons.kind, heads: lessons.heads, amount: lessons.amount, paidClaimedAt: lessons.paidClaimedAt, paidAt: lessons.paidAt, note: lessons.note, createdAt: lessons.createdAt, cancelledAt: lessons.cancelledAt })
    .from(lessons)
    .innerJoin(coaches, eq(coaches.id, lessons.coachId))
    .where(eq(lessons.studentPlayerId, id))
    .orderBy(desc(lessons.startsAt))
    .limit(N);
  const packages = await db
    .select({ coach: coaches.handle, size: lessonPackages.size, used: lessonPackages.used, minutes: lessonPackages.minutes, heads: lessonPackages.heads, amount: lessonPackages.amount, currency: lessonPackages.currency, paidAt: lessonPackages.paidAt, expiresAt: lessonPackages.expiresAt, note: lessonPackages.note, createdAt: lessonPackages.createdAt, closedAt: lessonPackages.closedAt })
    .from(lessonPackages)
    .innerJoin(coaches, eq(coaches.id, lessonPackages.coachId))
    .where(eq(lessonPackages.studentPlayerId, id))
    .orderBy(desc(lessonPackages.createdAt))
    .limit(N);
  const waiting = await db
    .select({ coach: coaches.handle, slotStartsAt: lessonWaitlist.slotStartsAt, weekStart: lessonWaitlist.weekStart, status: lessonWaitlist.status, offeredAt: lessonWaitlist.offeredAt, createdAt: lessonWaitlist.createdAt, resolvedAt: lessonWaitlist.resolvedAt })
    .from(lessonWaitlist)
    .innerJoin(coaches, eq(coaches.id, lessonWaitlist.coachId))
    .where(eq(lessonWaitlist.studentPlayerId, id))
    .orderBy(desc(lessonWaitlist.createdAt))
    .limit(N);
  const asked = await db
    .select({ coach: coaches.handle, startsAt: lessonRequests.startsAt, minutes: lessonRequests.minutes, heads: lessonRequests.heads, note: lessonRequests.note, status: lessonRequests.status, createdAt: lessonRequests.createdAt, resolvedAt: lessonRequests.resolvedAt })
    .from(lessonRequests)
    .innerJoin(coaches, eq(coaches.id, lessonRequests.coachId))
    .where(eq(lessonRequests.studentPlayerId, id))
    .orderBy(desc(lessonRequests.createdAt))
    .limit(N);
  // Moments (`milestones_player_idx`), the devices with notifications on (`push_subscriptions_player_idx`: the
  // browser in words and two days, never the endpoint or its keys), and the courts the player typed before.
  const moments = await db.select({ kind: milestones.kind, value: milestones.value, createdAt: milestones.createdAt }).from(milestones).where(eq(milestones.playerId, id)).orderBy(desc(milestones.createdAt)).limit(N);
  const pushDevices = await db.select({ device: pushSubscriptions.userAgent, savedAt: pushSubscriptions.createdAt, lastSeenAt: pushSubscriptions.lastSeenAt }).from(pushSubscriptions).where(eq(pushSubscriptions.playerId, id)).orderBy(asc(pushSubscriptions.createdAt)).limit(N);
  const courts = await db.select({ name: venues.name, mapUrl: venues.mapUrl, lastUsedAt: venues.lastUsedAt }).from(venues).where(eq(venues.creatorPlayerId, id)).orderBy(desc(venues.lastUsedAt)).limit(N);
  // What the player runs beyond single matches (`series_organizer_idx`, `competitions_organizer_idx`), and the
  // pairs they entered in a competition, without the partner.
  const seriesRun = await db.select({ slug: series.slug, name: series.name }).from(series).where(eq(series.organizerPlayerId, id)).limit(N);
  const competitionsRun = await db.select({ slug: competitions.slug, name: competitions.name }).from(competitions).where(eq(competitions.organizerPlayerId, id)).limit(N);
  const entries = await db
    .select({ competition: competitions.slug, status: competitionPairs.status, paid: competitionPairs.paid, createdAt: competitionPairs.createdAt, withdrawnAt: competitionPairs.withdrawnAt, checkedInAt: competitionPairs.checkedInAt })
    .from(competitionPairs)
    .innerJoin(competitions, eq(competitions.id, competitionPairs.competitionId))
    .where(or(eq(competitionPairs.p1PlayerId, id), eq(competitionPairs.p2PlayerId, id)))
    .orderBy(desc(competitionPairs.createdAt))
    .limit(N);
  return {
    wants,
    coachWants: coachWanted,
    feedback: notes,
    asks: { groups: groupAsks, matches: matchAsks },
    levelChecks: checks,
    coach,
    managesCoaches: manages,
    lessons: { coaches: studentOf, lessons: taken, packages, waitlist: waiting, requests: asked },
    milestones: moments,
    pushDevices,
    courts,
    series: seriesRun.map((x) => ({ ...x, url: `${base}/s/${x.slug}` })),
    competitions: { organised: competitionsRun.map((x) => ({ ...x, url: `${base}/t/${x.slug}` })), entries },
  };
}
