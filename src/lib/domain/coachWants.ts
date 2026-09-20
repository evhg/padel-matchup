import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { coachWants, players, type Coach, type CoachWant, type Player } from "@/db/schema";
import { baseUrl } from "@/lib/config";
import { tell as tellPlayer } from "@/lib/coach/notify";
import { cityBySlug, type City } from "./cities";
import { coachCity } from "./coaching";
import { DomainError } from "./errors";
import { LEVEL_STEPS } from "./levels";
import { getPlayer } from "./players";

/**
 * "I want a coach": the other half of the coaches' directory. A city's list used to end on "no
 * coach has listed here yet" and nothing to do about it; Ana in the walk would have typed her level
 * and "evenings" if anything had asked. One row is one standing want in one city: the level and a
 * few words on when. It counts on the coaches' door ("3 people here asked for a coach"), it hears
 * the first coach who lists in that city, and that coach hears how many were waiting. It expires,
 * like a match want: a want nobody answered in three months is not a want any more.
 */
export const COACH_WANT_TTL_MS = 90 * 24 * 3600_000;
/** How many wanters one listing tells; a city with more is a city with a second coach soon. */
export const COACH_WANT_FANOUT_MAX = 20;
/** A want told about one coach is not told about the next for a week. */
export const COACH_WANT_QUIET_MS = 7 * 24 * 3600_000;

export type CoachWantInput = { playerId: string; citySlug: string; level?: number | null; whenNote?: string | null };

/** Record a want, one per person per city: saying it again refreshes the level, the note and the clock. */
export async function recordCoachWant(db: Db, input: CoachWantInput, now = new Date()): Promise<CoachWant> {
  const city = cityBySlug(input.citySlug);
  if (!city) throw new DomainError("invalid", "city");
  const level = input.level != null && (LEVEL_STEPS as readonly number[]).includes(input.level) ? input.level : null;
  const whenNote = (input.whenNote ?? "").replace(/\s+/g, " ").trim().slice(0, 80) || null;
  const expiresAt = new Date(now.getTime() + COACH_WANT_TTL_MS);
  const [row] = await db
    .insert(coachWants)
    .values({ playerId: input.playerId, citySlug: city.slug, level, whenNote, expiresAt, createdAt: now })
    .onConflictDoUpdate({ target: [coachWants.playerId, coachWants.citySlug], set: { level, whenNote, expiresAt } })
    .returning();
  return row;
}

/** How many people in a city want a coach right now. */
export async function countCoachWants(db: Db, citySlug: string, now = new Date()): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(coachWants)
    .where(and(eq(coachWants.citySlug, citySlug), gt(coachWants.expiresAt, now)));
  return Number(row?.n ?? 0);
}

/** The wants in a city that may hear about a coach now: live, and not told in the last week. Bounded. */
export async function coachWantsToTell(db: Db, citySlug: string, now = new Date(), limit = COACH_WANT_FANOUT_MAX): Promise<{ want: CoachWant; player: Player }[]> {
  const quietBefore = new Date(now.getTime() - COACH_WANT_QUIET_MS);
  const rows = await db
    .select({ want: coachWants, player: players })
    .from(coachWants)
    .innerJoin(players, eq(players.id, coachWants.playerId))
    .where(and(eq(coachWants.citySlug, citySlug), gt(coachWants.expiresAt, now), or(isNull(coachWants.notifiedAt), lt(coachWants.notifiedAt, quietBefore))))
    .limit(limit);
  return rows;
}

export async function markCoachWantsNotified(db: Db, ids: string[], now = new Date()): Promise<void> {
  for (const id of ids) await db.update(coachWants).set({ notifiedAt: now }).where(eq(coachWants.id, id));
}

/** Wants belonging to a player who is leaving. Called by account deletion; nothing else may need it. */
export async function dropCoachWantsFor(db: Db, playerId: string): Promise<number> {
  const rows = await db.delete(coachWants).where(eq(coachWants.playerId, playerId)).returning({ id: coachWants.id });
  return rows.length;
}

/** Rows past their day, cleared by the hourly tick so the index stays small. */
export async function pruneCoachWants(db: Db, now = new Date()): Promise<number> {
  const rows = await db.delete(coachWants).where(lt(coachWants.expiresAt, now)).returning({ id: coachWants.id });
  return rows.length;
}

const L = (locale: string | null | undefined) => (locale === "ru" ? "ru" : locale === "es" ? "es" : "en");

/** What a wanter hears when a coach lists in their city. */
export function coachListedText(locale: string | null | undefined, coach: Pick<Coach, "displayName" | "handle">, city: City): string {
  const url = `${baseUrl()}/c/${coach.handle}`;
  switch (L(locale)) {
    case "ru":
      return `Тренер появился: ${coach.displayName}, ${city.name}\nВы просили тренера здесь. Свободные часы, которые можно забронировать самому: ${url}`;
    case "es":
      return `Hay un entrenador en ${city.name}: ${coach.displayName}\nPediste un entrenador aquí. Horas libres que reservas tú mismo: ${url}`;
    default:
      return `A coach listed in ${city.name}: ${coach.displayName}\nYou asked for a coach here. Free times you can book yourself: ${url}`;
  }
}

/** What the coach hears: how many were waiting, and that they were told. */
export function waitingToldText(locale: string | null | undefined, n: number, city: City): string {
  switch (L(locale)) {
    case "ru":
      return `${n} ${n === 1 ? "человек" : "человек(а)"} в ${city.name} просили тренера\nОни только что узнали о вашей странице.`;
    case "es":
      return `${n} ${n === 1 ? "persona" : "personas"} en ${city.name} pidieron un entrenador\nAcaban de saber de tu página.`;
    default:
      return `${n} ${n === 1 ? "person" : "people"} in ${city.name} asked for a coach\nThey just heard about your page.`;
  }
}

/**
 * A coach just listed in a city: the people who asked for one hear it (at most twenty, none twice in
 * a week), and the coach hears how many. The city is the coach's clubs' city, the same rule as the
 * founding badge, so a Bangkok coach never answers a Phuket want. Runs after the response.
 */
export async function tellCoachListed(db: Db, coach: Coach, now = new Date(), tell: typeof tellPlayer = tellPlayer): Promise<{ city: string | null; told: number }> {
  const city = await coachCity(db, coach);
  if (!city) return { city: null, told: 0 };
  const rows = await coachWantsToTell(db, city.slug, now);
  const url = `${baseUrl()}/c/${coach.handle}`;
  for (const { want, player } of rows) {
    if (player.id === coach.playerId) continue;
    await tell(db, player, coachListedText(player.locale, coach, city), { inline_keyboard: [[{ text: coach.displayName, url }]] }).catch(() => undefined);
    void want;
  }
  await markCoachWantsNotified(db, rows.map((r) => r.want.id), now);
  const told = rows.filter((r) => r.player.id !== coach.playerId).length;
  if (told > 0) {
    const me = await getPlayer(db, coach.playerId);
    if (me) await tell(db, me, waitingToldText(me.locale, told, city), { inline_keyboard: [[{ text: "Kicksmash", url: `${baseUrl()}/coach` }]] }).catch(() => undefined);
  }
  return { city: city.slug, told };
}
