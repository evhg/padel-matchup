"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { competitionCategories, competitionMatches, competitionPairs, competitions } from "@/db/schema";
import { baseUrl } from "@/lib/config";
import { clearDraw, enterMatchScore, makeDraw, publishDraw, setPairSeed, updateDrawSettings, walkoverMatch, type DrawSettings } from "@/lib/domain/competitionDraw";
import {
  addCategory,
  claimPartnerSpot,
  createCompetition,
  enterPair,
  getCompetition,
  isCompetitionStatus,
  removeCategory,
  setCompetitionStatus,
  setPairPaid,
  updateCategory,
  updateCompetition,
  withdrawPair,
  type CategoryFields,
  type CompetitionFields,
} from "@/lib/domain/competitions";
import { DomainError } from "@/lib/domain/errors";
import { createPlayer, getPlayer } from "@/lib/domain/players";
import { getSessionPlayer } from "@/lib/session";
import { moveMatch, orderOfPlay, scheduleCompetition, setCourts } from "@/lib/domain/competitionSchedule";
import { zonedTimeToUtc } from "@/lib/dates";
import { luckyLoser, setCheckedIn, setStreamUrl } from "@/lib/domain/competitionExtras";
import { advanceCategory } from "@/lib/domain/competitionDraw";
import { afterResult } from "@/lib/tournament/live";
import { tellDrawPublished, tellMoved, tellMovedUp, tellOrganizerOfEntry, tellPartnerClaimed, tellSchedule } from "@/lib/tournament/notify";
import { ActionFailure, requirePlayer, runA, type ActionResult } from "./shared";

/**
 * The serious tournament's writes. Every one goes through the domain rules in
 * `src/lib/domain/competitions.ts`; this file adds who is asking, the notices,
 * and the pages to refresh.
 */

const refresh = (slug: string) => {
  revalidatePath(`/t/${slug}`);
  revalidatePath(`/t/${slug}/manage`);
  revalidatePath("/t");
};

async function me() {
  const db = await getDb();
  const player = await getSessionPlayer(db);
  if (!player) throw new ActionFailure("no_identity");
  return { db, player };
}

/** A new competition by whoever is signed in — or by the name typed, when nobody is. It opens on its manage screen. */
export async function createCompetitionAction(input: CompetitionFields & { organizerName?: string | null }): Promise<ActionResult<{ slug: string }>> {
  const db = await getDb();
  const r = await runA(async () => {
    const player = await requirePlayer(db, input.organizerName);
    const c = await createCompetition(db, { ...input, organizerPlayerId: player.id });
    return { slug: c.slug };
  });
  if (!r.ok) return r;
  refresh(r.data.slug);
  redirect(`/t/${r.data.slug}/manage`);
}

export async function updateCompetitionAction(slug: string, input: CompetitionFields): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, player } = await me();
    const c = await getCompetition(db, slug);
    if (!c) throw new DomainError("not_found");
    await updateCompetition(db, { ...input, id: c.id, organizerPlayerId: player.id });
    refresh(slug);
    return null;
  });
}

export async function setCompetitionStatusAction(slug: string, status: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, player } = await me();
    const c = await getCompetition(db, slug);
    if (!c) throw new DomainError("not_found");
    if (!isCompetitionStatus(status)) throw new DomainError("invalid", "status");
    await setCompetitionStatus(db, { id: c.id, organizerPlayerId: player.id, status });
    refresh(slug);
    return null;
  });
}

export async function addCategoryAction(slug: string, input: CategoryFields): Promise<ActionResult<{ id: string }>> {
  return runA(async () => {
    const { db, player } = await me();
    const c = await getCompetition(db, slug);
    if (!c) throw new DomainError("not_found");
    const cat = await addCategory(db, { ...input, competitionId: c.id, organizerPlayerId: player.id });
    refresh(slug);
    return { id: cat.id };
  });
}

export async function updateCategoryAction(slug: string, categoryId: string, input: CategoryFields): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, player } = await me();
    await updateCategory(db, { ...input, categoryId, organizerPlayerId: player.id });
    refresh(slug);
    return null;
  });
}

export async function removeCategoryAction(slug: string, categoryId: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, player } = await me();
    await removeCategory(db, { categoryId, organizerPlayerId: player.id });
    refresh(slug);
    return null;
  });
}

export type EnteredView = { status: "entered" | "waiting"; position: number; category: string; claimLink: string | null };

/** A player enters a category with a partner by name; the organiser hears, the player gets the partner's link. */
export async function enterPairAction(slug: string, categoryId: string, input: { yourName?: string | null; partnerName: string }): Promise<ActionResult<EnteredView>> {
  const db = await getDb();
  return runA(async () => {
    const player = await requirePlayer(db, input.yourName);
    const locale = await getLocale();
    const e = await enterPair(db, { categoryId, playerId: player.id, partner: { name: input.partnerName }, locale });
    if (e.competition.slug !== slug) throw new DomainError("not_found");
    const count = (await db.select({ id: competitionPairs.id }).from(competitionPairs).where(eq(competitionPairs.categoryId, categoryId))).length;
    await tellOrganizerOfEntry(db, e, count).catch(() => undefined);
    refresh(slug);
    return { status: e.pair.status === "waiting" ? "waiting" : "entered", position: e.pair.position, category: e.category.name, claimLink: e.claimToken ? `${baseUrl()}/t/${slug}?claim=${e.claimToken}` : null };
  });
}

/** The desk: the organiser enters a pair by two names, closed or open, whatever the levels say. */
export async function deskEnterAction(slug: string, categoryId: string, input: { p1: string; p2: string }): Promise<ActionResult<EnteredView>> {
  return runA(async () => {
    const { db, player } = await me();
    const c = await getCompetition(db, slug);
    if (!c || c.organizerPlayerId !== player.id) throw new DomainError("forbidden", "organizer");
    const locale = await getLocale();
    const p1 = await createPlayer(db, { displayName: input.p1, locale });
    const e = await enterPair(db, { categoryId, playerId: p1.id, partner: { name: input.p2 }, locale, byOrganizer: true });
    refresh(slug);
    return { status: e.pair.status === "waiting" ? "waiting" : "entered", position: e.pair.position, category: e.category.name, claimLink: null };
  });
}

/** Either player, or the organiser, takes a pair out; the pair that moves up is told. */
export async function withdrawPairAction(slug: string, pairId: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, player } = await me();
    const { pair, movedUp } = await withdrawPair(db, { pairId, actorPlayerId: player.id });
    // Out of a made draw: the first pair waiting takes the place in every match still to play.
    const [cat] = await db.select().from(competitionCategories).where(eq(competitionCategories.id, pair.categoryId)).limit(1);
    if (cat && cat.drawStatus !== "none") {
      // `withdrawPair` moved the first waiting pair up already; it takes the place in the draw. The notice below covers it.
      await luckyLoser(db, { categoryId: cat.id, withdrawnPairId: pair.id, replacementId: movedUp?.id ?? null });
      await advanceCategory(db, cat.id);
      await afterResult(db, cat.id);
    }
    if (movedUp) {
      const [c] = await db.select().from(competitions).where(eq(competitions.id, movedUp.competitionId)).limit(1);
      const [cat] = await db.select().from(competitionCategories).where(eq(competitionCategories.id, movedUp.categoryId)).limit(1);
      if (c && cat) await tellMovedUp(db, movedUp, c, cat).catch(() => undefined);
    }
    refresh(slug);
    return null;
  });
}

export async function setPairPaidAction(slug: string, pairId: string, paid: boolean): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, player } = await me();
    await setPairPaid(db, { pairId, organizerPlayerId: player.id, paid });
    refresh(slug);
    return null;
  });
}

/** The partner confirms the spot, signed in or by typing their name; the player who named them hears. */
export async function claimSpotAction(slug: string, token: string, name?: string | null): Promise<ActionResult<{ category: string; p1: string; pairId: string }>> {
  const db = await getDb();
  return runA(async () => {
    const player = await requirePlayer(db, name);
    const pair = await claimPartnerSpot(db, { token, playerId: player.id });
    const [c] = await db.select().from(competitions).where(eq(competitions.id, pair.competitionId)).limit(1);
    const [cat] = await db.select().from(competitionCategories).where(eq(competitionCategories.id, pair.categoryId)).limit(1);
    if (!c || !cat || c.slug !== slug) throw new DomainError("not_found");
    await tellPartnerClaimed(db, pair, c, cat, player.displayName).catch(() => undefined);
    const p1 = await getPlayer(db, pair.p1PlayerId);
    refresh(slug);
    return { category: cat.name, p1: p1?.displayName ?? "", pairId: pair.id };
  });
}

// ---------------------------------------------------------------------------
// The draw
// ---------------------------------------------------------------------------

export async function updateDrawSettingsAction(slug: string, categoryId: string, input: DrawSettings): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, player } = await me();
    await updateDrawSettings(db, { ...input, categoryId, organizerPlayerId: player.id });
    refresh(slug);
    return null;
  });
}

export async function setPairSeedAction(slug: string, pairId: string, seed: number | null, wildcard?: boolean): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, player } = await me();
    await setPairSeed(db, { pairId, organizerPlayerId: player.id, seed, wildcard });
    refresh(slug);
    return null;
  });
}

export async function makeDrawAction(slug: string, categoryId: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, player } = await me();
    await makeDraw(db, { categoryId, organizerPlayerId: player.id });
    refresh(slug);
    return null;
  });
}

export async function clearDrawAction(slug: string, categoryId: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, player } = await me();
    await clearDraw(db, { categoryId, organizerPlayerId: player.id });
    refresh(slug);
    return null;
  });
}

/** Published, and every player in the draw hears where they start. */
export async function publishDrawAction(slug: string, categoryId: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, player } = await me();
    const category = await publishDraw(db, { categoryId, organizerPlayerId: player.id });
    const [c] = await db.select().from(competitions).where(eq(competitions.id, category.competitionId)).limit(1);
    const pairs = await db
      .select()
      .from(competitionPairs)
      .where(and(eq(competitionPairs.categoryId, categoryId), inArray(competitionPairs.status, ["entered", "waiting"])));
    const matches = await db.select().from(competitionMatches).where(eq(competitionMatches.categoryId, categoryId));
    if (c) await tellDrawPublished(db, c, category, pairs, matches).catch(() => undefined);
    refresh(slug);
    return null;
  });
}

/** "6-4 3-6 10-8" from the organiser or a player of either pair. */
export async function enterScoreAction(slug: string, matchId: string, text: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, player } = await me();
    const sets = text
      .trim()
      .split(/[\s,;]+/)
      .filter(Boolean)
      .map((s) => s.split(/[-:]/).map((n) => Number(n)));
    if (sets.length === 0 || sets.some((s) => s.length !== 2 || s.some((n) => !Number.isInteger(n) || n < 0))) throw new DomainError("invalid", "score_shape");
    const m = await enterMatchScore(db, { matchId, actorPlayerId: player.id, scoreA: sets.map((s) => s[0]), scoreB: sets.map((s) => s[1]) });
    await afterResult(db, m.categoryId);
    refresh(slug);
    return null;
  });
}

export async function walkoverAction(slug: string, matchId: string, winner: "A" | "B"): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, player } = await me();
    const m = await walkoverMatch(db, { matchId, organizerPlayerId: player.id, winner });
    await afterResult(db, m.categoryId);
    refresh(slug);
    return null;
  });
}

// ---------------------------------------------------------------------------
// Courts and times
// ---------------------------------------------------------------------------

export async function setCourtsAction(slug: string, input: { courtNames: string[]; dayStart?: string | null; dayEnd?: string | null }): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, player } = await me();
    const c = await getCompetition(db, slug);
    if (!c) throw new DomainError("not_found");
    await setCourts(db, { competitionId: c.id, organizerPlayerId: player.id, courtNames: input.courtNames, dayStart: input.dayStart, dayEnd: input.dayEnd });
    refresh(slug);
    return null;
  });
}

/** Every match a court and a time, and every player their list. */
export async function makeScheduleAction(slug: string): Promise<ActionResult<{ count: number }>> {
  return runA(async () => {
    const { db, player } = await me();
    const c = await getCompetition(db, slug);
    if (!c) throw new DomainError("not_found");
    const { slots } = await scheduleCompetition(db, { competitionId: c.id, organizerPlayerId: player.id });
    const rows = await orderOfPlay(db, c.id);
    await tellSchedule(db, c, rows.filter((r) => slots.some((s) => s.id === r.id))).catch(() => undefined);
    refresh(slug);
    return { count: slots.length };
  });
}

/** A new court or time for one match, given as the competition's local "YYYY-MM-DDTHH:MM"; both pairs hear. */
export async function moveMatchAction(slug: string, matchId: string, courtName: string, local: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, player } = await me();
    const c = await getCompetition(db, slug);
    if (!c) throw new DomainError("not_found");
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(local);
    if (!m) throw new DomainError("invalid", "time");
    const moved = await moveMatch(db, { matchId, organizerPlayerId: player.id, courtName, scheduledAt: zonedTimeToUtc(m[1], m[2], c.tz) });
    const row = (await orderOfPlay(db, c.id)).find((r) => r.id === moved.id);
    if (row) await tellMoved(db, c, row).catch(() => undefined);
    refresh(slug);
    return null;
  });
}

// ---------------------------------------------------------------------------
// The big-event extras
// ---------------------------------------------------------------------------

/** A https link to the stream of one match; empty clears it. */
export async function setStreamUrlAction(slug: string, matchId: string, url: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, player } = await me();
    await setStreamUrl(db, { matchId, organizerPlayerId: player.id, url });
    refresh(slug);
    return null;
  });
}

export async function checkInAction(slug: string, pairId: string, on: boolean): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, player } = await me();
    await setCheckedIn(db, { pairId, organizerPlayerId: player.id, on });
    refresh(slug);
    return null;
  });
}
