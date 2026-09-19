"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { competitionCategories, competitionPairs, competitions } from "@/db/schema";
import { baseUrl } from "@/lib/config";
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
import { tellMovedUp, tellOrganizerOfEntry, tellPartnerClaimed } from "@/lib/tournament/notify";
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
    const { movedUp } = await withdrawPair(db, { pairId, actorPlayerId: player.id });
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
export async function claimSpotAction(slug: string, token: string, name?: string | null): Promise<ActionResult<{ category: string; p1: string }>> {
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
    return { category: cat.name, p1: p1?.displayName ?? "" };
  });
}
