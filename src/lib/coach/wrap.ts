import { and, asc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "@/db";
import {
  clubs,
  coaches,
  events,
  lessonPackages,
  lessons,
  players,
  slots,
  type Club,
  type Coach,
  type Player,
} from "@/db/schema";
import { utcToZonedParts, weekdayName } from "@/lib/dates";
import { isClubLive } from "@/lib/domain/clubs";
import { isPackageOpen } from "@/lib/domain/coaching";
import { monthCounts, monthRange } from "./chains";

/**
 * The monthly wrap: on the 1st, one message to each coach and each club with
 * last month's numbers, the way they would count them. Nothing when the month
 * was empty. The invitation to pass the assistant on rides along once the
 * month has earned it. Delivery and translation are handed in, so the sums
 * are testable without a mail server.
 */

/** From nine in the morning on the 1st, with two more days to catch up; `wrapSentFor` keeps it to once. */
export const WRAP = {
  fromHour: 9,
  untilDay: 3,
  inviteAfterLessons: 8,
} as const;

export type CoachWrap = {
  done: number;
  noShows: number;
  lateCancelled: number;
  students: number;
  packagesStarted: number;
  lessonsLeft: number;
  busiestDay: string | null;
};
export type ClubWrap = {
  matches: number;
  seats: number;
  filled: number;
  players: number;
  busiest: string | null;
};

const mostCommon = (items: string[]): string | null => {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i, (counts.get(i) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};

/** A coach's month: lessons done, no-shows, students seen, packages started, lessons left on open packages, the busiest weekday. */
export async function coachWrap(
  db: Db,
  coach: Pick<Coach, "id" | "tz">,
  from: Date,
  to: Date,
  locale = "en",
  now = new Date(),
): Promise<CoachWrap> {
  const counts = await monthCounts(db, coach.id, from, to);
  const started = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(lessonPackages)
    .where(
      and(
        eq(lessonPackages.coachId, coach.id),
        gte(lessonPackages.createdAt, from),
        lt(lessonPackages.createdAt, to),
      ),
    );
  const open = await db
    .select()
    .from(lessonPackages)
    .where(
      and(
        eq(lessonPackages.coachId, coach.id),
        isNull(lessonPackages.closedAt),
      ),
    );
  const lessonsLeft = open
    .filter((p) => isPackageOpen(p, now))
    .reduce((sum, p) => sum + Math.max(0, p.size - p.used), 0);
  const done = await db
    .select({ startsAt: lessons.startsAt })
    .from(lessons)
    .where(
      and(
        eq(lessons.coachId, coach.id),
        eq(lessons.status, "done"),
        gte(lessons.startsAt, from),
        lt(lessons.startsAt, to),
      ),
    )
    .orderBy(asc(lessons.startsAt));
  return {
    done: counts.done,
    noShows: counts.noShows,
    lateCancelled: counts.lateCancelled,
    students: counts.students,
    packagesStarted: Number(started[0]?.n ?? 0),
    lessonsLeft,
    busiestDay: mostCommon(
      done.map((l) => weekdayName(l.startsAt, coach.tz, locale)),
    ),
  };
}

/** A club's month on its page: matches, seats taken of seats offered, distinct players, the busiest weekday and time. */
export async function clubWrap(
  db: Db,
  club: Pick<Club, "slug" | "tz">,
  from: Date,
  to: Date,
  locale = "en",
): Promise<ClubWrap> {
  const tz = club.tz ?? "UTC";
  const rows = await db
    .select({
      id: events.id,
      capacity: events.capacity,
      startsAt: events.startsAt,
    })
    .from(events)
    .where(
      and(
        eq(events.venueSlug, club.slug),
        eq(events.publicListing, true),
        gte(events.startsAt, from),
        lt(events.startsAt, to),
        sql`${events.status} <> 'cancelled'`,
      ),
    )
    .orderBy(asc(events.startsAt));
  if (rows.length === 0)
    return { matches: 0, seats: 0, filled: 0, players: 0, busiest: null };
  const seated = await db
    .select({ eventId: slots.eventId, playerId: slots.playerId })
    .from(slots)
    .where(
      and(
        inArray(
          slots.eventId,
          rows.map((r) => r.id),
        ),
        inArray(slots.status, ["joined", "confirmed"]),
        sql`${slots.position} <= (select capacity from ${events} e where e.id = ${slots.eventId})`,
      ),
    );
  const label = (at: Date) =>
    `${weekdayName(at, tz, locale)} ${utcToZonedParts(at, tz).time}`;
  return {
    matches: rows.length,
    seats: rows.reduce((s, r) => s + r.capacity, 0),
    filled: seated.length,
    players: new Set(seated.map((s) => s.playerId).filter(Boolean)).size,
    busiest: mostCommon(rows.map((r) => label(r.startsAt))),
  };
}

export type WrapNote = {
  subject: string;
  heading: string;
  body: string;
  url: string;
  open: string;
  footer: string;
  optOut: string;
};
type Translate = (
  localeLike: string | null | undefined,
) => Promise<{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: (key: string, values?: Record<string, any>) => string;
  locale: string;
}>;
export type WrapDeps = {
  deliver: (to: Player, note: WrapNote) => Promise<unknown>;
  translate: Translate;
  baseUrl: string;
  appName: string;
};

/** The first days of the month from nine in the morning, local time: a missed hour is caught up, and `wrapSentFor` keeps it to once. */
export const wrapDue = (tz: string, now: Date): boolean => {
  const { date, time } = utcToZonedParts(now, tz);
  const day = Number(date.slice(8, 10));
  return (
    day >= 1 &&
    day <= WRAP.untilDay &&
    Number(time.slice(0, 2)) >= WRAP.fromHour
  );
};

/** The previous month in a zone: its range and label ("2026-09"). */
export const previousMonth = (tz: string, now: Date) =>
  monthRange(tz, new Date(monthRange(tz, now).from.getTime() - 1));

/**
 * Sends every wrap that is due and not yet sent. Empty months send nothing but
 * still count as sent, so a quiet coach is never nagged and never retried. Each
 * coach and each club is one unit of work: the sums come first, the claim after,
 * and one failure never touches the others.
 */
export async function monthlyWraps(
  db: Db,
  now: Date,
  deps: WrapDeps,
): Promise<{
  coaches: number;
  clubs: number;
  skipped: number;
  errors: string[];
}> {
  const out = { coaches: 0, clubs: 0, skipped: 0, errors: [] as string[] };
  // Local day 1–3 anywhere on Earth falls on UTC dates 28–31 or 1–4; every other day the scan has nothing to do.
  const utcDay = now.getUTCDate();
  if (utcDay > 4 && utcDay < 28) return out;
  const coachRows = await db
    .select({ coach: coaches, player: players })
    .from(coaches)
    .innerJoin(players, eq(players.id, coaches.playerId))
    .where(isNull(coaches.archivedAt));
  for (const { coach, player } of coachRows) {
    try {
      if (!wrapDue(coach.tz, now)) continue;
      const month = previousMonth(coach.tz, now);
      if (coach.wrapSentFor === month.label) continue;
      const { t, locale } = await deps.translate(player.locale);
      const w = await coachWrap(db, coach, month.from, month.to, locale, now);
      const [claimed] = await db
        .update(coaches)
        .set({ wrapSentFor: month.label })
        .where(
          and(
            eq(coaches.id, coach.id),
            sql`${coaches.wrapSentFor} is distinct from ${month.label}`,
          ),
        )
        .returning({ id: coaches.id });
      if (!claimed) continue;
      if (w.done + w.packagesStarted + w.noShows + w.lateCancelled === 0) {
        out.skipped++;
        continue;
      }
      const monthName = new Intl.DateTimeFormat(locale, {
        month: "long",
        year: "numeric",
        timeZone: coach.tz,
      }).format(month.from);
      const vars = {
        month: monthName,
        done: w.done,
        students: w.students,
        noShows: w.noShows,
        packages: w.packagesStarted,
        left: w.lessonsLeft,
        busiest: w.busiestDay ?? "none",
      };
      const invite =
        w.done >= WRAP.inviteAfterLessons
          ? ` ${t("wrap.coachInvite", { url: `${deps.baseUrl}/coaches?s=wrap` })}`
          : "";
      await deps.deliver(player, {
        subject: t("wrap.coachSubject", vars),
        heading: t("wrap.coachSubject", vars),
        body: `${t("wrap.coachBody", vars)}${invite}`,
        url: `${deps.baseUrl}/coach`,
        open: t("wrap.open"),
        footer: t("wrap.footer", { app: deps.appName }),
        optOut: t("email.optOut"),
      });
      out.coaches++;
    } catch (e) {
      out.errors.push(`coach ${coach.id}: ${String(e)}`);
    }
  }
  const clubRows = await db
    .select({ club: clubs, player: players })
    .from(clubs)
    .innerJoin(players, eq(players.id, clubs.claimedBy));
  for (const { club, player } of clubRows) {
    try {
      if (!isClubLive(club) || !club.tz || !wrapDue(club.tz, now)) continue;
      const month = previousMonth(club.tz, now);
      if (club.wrapSentFor === month.label) continue;
      const { t, locale } = await deps.translate(player.locale);
      const w = await clubWrap(db, club, month.from, month.to, locale);
      const [claimed] = await db
        .update(clubs)
        .set({ wrapSentFor: month.label })
        .where(
          and(
            eq(clubs.slug, club.slug),
            sql`${clubs.wrapSentFor} is distinct from ${month.label}`,
          ),
        )
        .returning({ slug: clubs.slug });
      if (!claimed) continue;
      if (w.matches === 0) {
        out.skipped++;
        continue;
      }
      const monthName = new Intl.DateTimeFormat(locale, {
        month: "long",
        year: "numeric",
        timeZone: club.tz,
      }).format(month.from);
      const vars = {
        month: monthName,
        matches: w.matches,
        filled: w.filled,
        seats: w.seats,
        rate: w.seats ? Math.round((w.filled / w.seats) * 100) : 0,
        players: w.players,
        busiest: w.busiest ?? "none",
        club: club.name,
      };
      await deps.deliver(player, {
        subject: t("wrap.clubSubject", vars),
        heading: t("wrap.clubSubject", vars),
        body: t("wrap.clubBody", vars),
        url: `${deps.baseUrl}/v/${club.slug}/manage/${club.manageToken}`,
        open: t("wrap.open"),
        footer: t("wrap.footer", { app: deps.appName }),
        optOut: t("email.optOut"),
      });
      out.clubs++;
    } catch (e) {
      out.errors.push(`club ${club.slug}: ${String(e)}`);
    }
  }
  return out;
}
