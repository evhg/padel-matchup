import { and, asc, count, desc, eq, gte, inArray, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@/db";
import {
  competitionCategories,
  competitionPairs,
  competitions,
  players,
  type Competition,
  type CompetitionCategory,
  type CompetitionPair,
  type CompetitionStatus,
  type Player,
} from "@/db/schema";
import { isValidTimeZone } from "@/lib/dates";
import { slugFrom } from "@/lib/translit";
import { DomainError } from "./errors";
import { LEVEL_MAX, LEVEL_MIN } from "./levels";
import { mergePlayers } from "./merge";
import { bumpMetric } from "./metrics";
import { createPlayer, getPlayer, normalizeName } from "./players";

/**
 * The serious tournament, step 1: a competition with categories, pairs entered
 * per category, a waiting list when a category is full, and a partner who can
 * be named before they have an account. Rules 23–26 in DECIDING.md: a player
 * enters at most two categories; a partner is entered by name and claims the
 * spot by link; the fee is text and the organiser marks "paid"; nothing here
 * moves money. The draw, the courts and the live scores are the next steps
 * and hang off `competition_pairs`.
 */

export const COMPETITION = {
  nameMax: 80,
  noteMax: 400,
  venueMax: 80,
  cityMax: 40,
  categoriesMax: 12,
  categoryNameMax: 40,
  pairsMin: 4,
  pairsMax: 64,
  pairsDefault: 16,
  /** Open competitions one person may organise at a time. */
  perOrganizer: 10,
  tokenLength: 12,
} as const;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TOKEN_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

const clean = (v: string | null | undefined, max: number): string | null => {
  const s = (v ?? "").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
};

/** Twelve characters from an alphabet without look-alikes; web crypto, so the module stays importable anywhere. */
function claimToken(): string {
  const bytes = new Uint8Array(COMPETITION.tokenLength);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => TOKEN_ALPHABET[b % TOKEN_ALPHABET.length]).join("");
}

export const isCompetitionStatus = (v: unknown): v is CompetitionStatus => v === "open" || v === "closed";
export const isOrganizer = (c: Pick<Competition, "organizerPlayerId">, playerId: string | null | undefined): boolean => Boolean(playerId) && c.organizerPlayerId === playerId;

/** The slug from the name, transliterated; a name with nothing usable in it falls back to the first day. */
export function competitionSlugBase(name: string, startsOn: string): string {
  const fromName = slugFrom(name, 48);
  return fromName.length >= 2 ? fromName : `open-${startsOn}`;
}

async function freeSlug(db: Db, base: string): Promise<string> {
  const taken = new Set((await db.select({ slug: competitions.slug }).from(competitions).where(sql`${competitions.slug} = ${base} or ${competitions.slug} like ${base + "-%"}`)).map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  throw new DomainError("invalid", "slug");
}

export type CompetitionFields = {
  name: string;
  tz: string;
  startsOn: string;
  endsOn?: string | null;
  venueName?: string | null;
  venueSlug?: string | null;
  city?: string | null;
  entryNote?: string | null;
  /** Editions of one series share a tag; the ranking across them adds up. */
  seriesTag?: string | null;
};

function checkFields(input: CompetitionFields) {
  const name = clean(input.name, COMPETITION.nameMax);
  if (!name || name.length < 2) throw new DomainError("invalid", "name");
  if (!isValidTimeZone(input.tz)) throw new DomainError("invalid", "tz");
  if (!DATE.test(input.startsOn)) throw new DomainError("invalid", "startsOn");
  const endsOn = input.endsOn && DATE.test(input.endsOn) ? input.endsOn : input.startsOn;
  if (endsOn < input.startsOn) throw new DomainError("invalid", "endsOn");
  return {
    name,
    tz: input.tz,
    startsOn: input.startsOn,
    endsOn,
    venueName: clean(input.venueName, COMPETITION.venueMax),
    venueSlug: clean(input.venueSlug, COMPETITION.venueMax),
    city: clean(input.city, COMPETITION.cityMax),
    entryNote: clean(input.entryNote, COMPETITION.noteMax),
    seriesTag: clean(input.seriesTag, 40)?.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || null,
  };
}

/** A new competition, open for entries from the start; the organiser adds the categories next. */
export async function createCompetition(db: Db, input: CompetitionFields & { organizerPlayerId: string }): Promise<Competition> {
  const fields = checkFields(input);
  const [{ n }] = await db
    .select({ n: count() })
    .from(competitions)
    .where(and(eq(competitions.organizerPlayerId, input.organizerPlayerId), eq(competitions.status, "open")));
  if (Number(n) >= COMPETITION.perOrganizer) throw new DomainError("too_many", "competitions");
  const [c] = await db
    .insert(competitions)
    .values({ ...fields, slug: await freeSlug(db, competitionSlugBase(fields.name, fields.startsOn)), organizerPlayerId: input.organizerPlayerId })
    .returning();
  await bumpMetric(db, "competition_created");
  return c;
}

async function ownCompetition(db: Db, id: string, organizerPlayerId: string): Promise<Competition> {
  const [c] = await db.select().from(competitions).where(eq(competitions.id, id)).limit(1);
  if (!c) throw new DomainError("not_found", "competition");
  if (!isOrganizer(c, organizerPlayerId)) throw new DomainError("forbidden", "organizer");
  return c;
}

export async function updateCompetition(db: Db, input: CompetitionFields & { id: string; organizerPlayerId: string }): Promise<Competition> {
  await ownCompetition(db, input.id, input.organizerPlayerId);
  const fields = checkFields(input);
  const [c] = await db.update(competitions).set({ ...fields, updatedAt: new Date() }).where(eq(competitions.id, input.id)).returning();
  return c;
}

/** Open takes entries; closed shows the field as it is and takes none. */
export async function setCompetitionStatus(db: Db, input: { id: string; organizerPlayerId: string; status: CompetitionStatus }): Promise<Competition> {
  await ownCompetition(db, input.id, input.organizerPlayerId);
  if (!isCompetitionStatus(input.status)) throw new DomainError("invalid", "status");
  const [c] = await db.update(competitions).set({ status: input.status, updatedAt: new Date() }).where(eq(competitions.id, input.id)).returning();
  return c;
}

export async function getCompetition(db: Db, slug: string): Promise<Competition | null> {
  const [c] = await db.select().from(competitions).where(eq(competitions.slug, slug)).limit(1);
  return c ?? null;
}

/** The competitions one person organises, the newest first. */
export async function competitionsOf(db: Db, organizerPlayerId: string): Promise<Competition[]> {
  return db.select().from(competitions).where(eq(competitions.organizerPlayerId, organizerPlayerId)).orderBy(desc(competitions.startsOn));
}

/** Open competitions whose last day is `today` or later, soonest first. `today` is a local date, "YYYY-MM-DD". */
export async function listOpenCompetitions(db: Db, today: string): Promise<Competition[]> {
  return db
    .select()
    .from(competitions)
    .where(and(eq(competitions.status, "open"), gte(competitions.endsOn, today)))
    .orderBy(asc(competitions.startsOn), asc(competitions.name));
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export type CategoryFields = { name: string; levelMin?: number | null; levelMax?: number | null; maxPairs?: number | null };

function checkCategory(input: CategoryFields) {
  const name = clean(input.name, COMPETITION.categoryNameMax);
  if (!name) throw new DomainError("invalid", "name");
  const level = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? Math.min(LEVEL_MAX, Math.max(LEVEL_MIN, Math.round(v * 2) / 2)) : null);
  const levelMin = level(input.levelMin);
  const levelMax = level(input.levelMax);
  if (levelMin !== null && levelMax !== null && levelMin > levelMax) throw new DomainError("invalid", "level");
  const maxPairs = Number.isInteger(input.maxPairs) ? Number(input.maxPairs) : COMPETITION.pairsDefault;
  if (maxPairs < COMPETITION.pairsMin || maxPairs > COMPETITION.pairsMax) throw new DomainError("invalid", "maxPairs");
  return { name, levelMin, levelMax, maxPairs };
}

export async function addCategory(db: Db, input: CategoryFields & { competitionId: string; organizerPlayerId: string }): Promise<CompetitionCategory> {
  await ownCompetition(db, input.competitionId, input.organizerPlayerId);
  const fields = checkCategory(input);
  const [{ n }] = await db.select({ n: count() }).from(competitionCategories).where(eq(competitionCategories.competitionId, input.competitionId));
  if (Number(n) >= COMPETITION.categoriesMax) throw new DomainError("too_many", "categories");
  const [cat] = await db
    .insert(competitionCategories)
    .values({ ...fields, competitionId: input.competitionId, position: Number(n) })
    .returning();
  return cat;
}

async function ownCategory(db: Db, categoryId: string, organizerPlayerId: string): Promise<{ category: CompetitionCategory; competition: Competition }> {
  const [cat] = await db.select().from(competitionCategories).where(eq(competitionCategories.id, categoryId)).limit(1);
  if (!cat) throw new DomainError("not_found", "category");
  const competition = await ownCompetition(db, cat.competitionId, organizerPlayerId);
  return { category: cat, competition };
}

export async function updateCategory(db: Db, input: CategoryFields & { categoryId: string; organizerPlayerId: string }): Promise<CompetitionCategory> {
  await ownCategory(db, input.categoryId, input.organizerPlayerId);
  const fields = checkCategory(input);
  const [cat] = await db.update(competitionCategories).set(fields).where(eq(competitionCategories.id, input.categoryId)).returning();
  return cat;
}

/** A category goes only while nobody is in it; a pair that withdrew does not hold it. */
export async function removeCategory(db: Db, input: { categoryId: string; organizerPlayerId: string }): Promise<void> {
  await ownCategory(db, input.categoryId, input.organizerPlayerId);
  const [{ n }] = await db
    .select({ n: count() })
    .from(competitionPairs)
    .where(and(eq(competitionPairs.categoryId, input.categoryId), ne(competitionPairs.status, "withdrawn")));
  if (Number(n) > 0) throw new DomainError("invalid", "has_pairs");
  await db.delete(competitionCategories).where(eq(competitionCategories.id, input.categoryId));
}

export async function categoriesOf(db: Db, competitionId: string): Promise<CompetitionCategory[]> {
  return db.select().from(competitionCategories).where(eq(competitionCategories.competitionId, competitionId)).orderBy(asc(competitionCategories.position), asc(competitionCategories.createdAt));
}

// ---------------------------------------------------------------------------
// Pairs
// ---------------------------------------------------------------------------

const inPlay = (p: Pick<CompetitionPair, "status">) => p.status !== "withdrawn";
const playerIn = (playerId: string) => or(eq(competitionPairs.p1PlayerId, playerId), eq(competitionPairs.p2PlayerId, playerId));

/** Every entry of one person in a competition that is still in play. */
export async function entriesOf(db: Db, competitionId: string, playerId: string): Promise<CompetitionPair[]> {
  return db
    .select()
    .from(competitionPairs)
    .where(and(eq(competitionPairs.competitionId, competitionId), ne(competitionPairs.status, "withdrawn"), playerIn(playerId)))
    .orderBy(asc(competitionPairs.createdAt));
}

/** A partner named before, in this competition, by the same person: the same placeholder again, never a second one. */
async function partnerByName(db: Db, competitionId: string, enteredBy: string, name: string, locale: string): Promise<{ partner: Player; fresh: boolean }> {
  const clean = normalizeName(name);
  if (!clean) throw new DomainError("invalid", "partner");
  const p2 = alias(players, "p2");
  const mine = await db
    .select({ partner: p2, claimToken: competitionPairs.claimToken })
    .from(competitionPairs)
    .innerJoin(p2, eq(p2.id, competitionPairs.p2PlayerId))
    .where(and(eq(competitionPairs.competitionId, competitionId), eq(competitionPairs.p1PlayerId, enteredBy), sql`lower(${p2.displayName}) = lower(${clean})`))
    .limit(1);
  if (mine[0]) return { partner: mine[0].partner, fresh: Boolean(mine[0].claimToken) };
  return { partner: await createPlayer(db, { displayName: clean, locale }), fresh: true };
}

export type EnterInput = {
  categoryId: string;
  /** The person entering, who plays. */
  playerId: string;
  partner: { playerId: string } | { name: string };
  locale: string;
  /** The organiser enters pairs at the desk, closed or not, whatever their level says. */
  byOrganizer?: boolean;
  now?: Date;
};

export type Entered = { pair: CompetitionPair; category: CompetitionCategory; competition: Competition; partner: Player; player: Player; claimToken: string | null };

/**
 * A pair into a category: full means the waiting list, in order of entry. Both players are
 * checked the same way — once per category, at most `maxCategoriesPerPlayer` per competition,
 * and a declared level inside the band when there is one. The partner entered by name is a
 * placeholder player with a claim token on the pair; the merge on claim makes them one person.
 */
export async function enterPair(db: Db, input: EnterInput): Promise<Entered> {
  const [cat] = await db.select().from(competitionCategories).where(eq(competitionCategories.id, input.categoryId)).limit(1);
  if (!cat) throw new DomainError("not_found", "category");
  const [c] = await db.select().from(competitions).where(eq(competitions.id, cat.competitionId)).limit(1);
  if (!c) throw new DomainError("not_found", "competition");
  if (c.status !== "open" && !input.byOrganizer) throw new DomainError("closed");
  // Once the draw is made the field is the field; a late pair is the organiser's call, before the redraw.
  if (cat.drawStatus !== "none") throw new DomainError("closed", "drawn");
  const player = await getPlayer(db, input.playerId);
  if (!player) throw new DomainError("not_found", "player");
  let partner: Player;
  let token: string | null = null;
  if ("playerId" in input.partner) {
    const p = await getPlayer(db, input.partner.playerId);
    if (!p) throw new DomainError("not_found", "partner");
    partner = p;
  } else {
    const found = await partnerByName(db, c.id, player.id, input.partner.name, input.locale);
    partner = found.partner;
    // The organiser's desk vouches for both names: no link to confirm, no "not confirmed yet" on the poster.
    token = found.fresh && !input.byOrganizer ? claimToken() : null;
  }
  if (partner.id === player.id) throw new DomainError("invalid", "same_player");
  for (const p of [player, partner]) {
    const mine = await entriesOf(db, c.id, p.id);
    if (mine.some((e) => e.categoryId === cat.id)) throw new DomainError("already_in", p.id === player.id ? "you" : "partner");
    if (new Set(mine.map((e) => e.categoryId)).size >= c.maxCategoriesPerPlayer) throw new DomainError("too_many", p.id === player.id ? "you" : "partner");
    if (!input.byOrganizer && typeof p.level === "number") {
      if ((cat.levelMin !== null && p.level < cat.levelMin) || (cat.levelMax !== null && p.level > cat.levelMax)) throw new DomainError("invalid", "level");
    }
  }
  const [{ entered, last }] = await db
    .select({ entered: sql<number>`count(*) filter (where ${competitionPairs.status} = 'entered')::int`, last: sql<number>`coalesce(max(${competitionPairs.position}), 0)::int` })
    .from(competitionPairs)
    .where(eq(competitionPairs.categoryId, cat.id));
  const status = Number(entered) >= cat.maxPairs ? "waiting" : "entered";
  const [pair] = await db
    .insert(competitionPairs)
    .values({ categoryId: cat.id, competitionId: c.id, p1PlayerId: player.id, p2PlayerId: partner.id, claimToken: token, status, position: Number(last) + 1, enteredByPlayerId: player.id })
    .returning();
  await bumpMetric(db, "competition_entry");
  return { pair, category: cat, competition: c, partner, player, claimToken: token };
}

async function loadPair(db: Db, pairId: string): Promise<{ pair: CompetitionPair; competition: Competition }> {
  const [pair] = await db.select().from(competitionPairs).where(eq(competitionPairs.id, pairId)).limit(1);
  if (!pair) throw new DomainError("not_found", "pair");
  const [competition] = await db.select().from(competitions).where(eq(competitions.id, pair.competitionId)).limit(1);
  if (!competition) throw new DomainError("not_found", "competition");
  return { pair, competition };
}

/** The first pair waiting takes the freed spot, in order of entry. Returns it when there was one. */
async function moveUp(db: Db, categoryId: string): Promise<CompetitionPair | null> {
  const [next] = await db
    .select()
    .from(competitionPairs)
    .where(and(eq(competitionPairs.categoryId, categoryId), eq(competitionPairs.status, "waiting")))
    .orderBy(asc(competitionPairs.position))
    .limit(1);
  if (!next) return null;
  const [moved] = await db.update(competitionPairs).set({ status: "entered" }).where(and(eq(competitionPairs.id, next.id), eq(competitionPairs.status, "waiting"))).returning();
  return moved ?? null;
}

export type Withdrawn = { pair: CompetitionPair; movedUp: CompetitionPair | null };

/** Either player of the pair, or the organiser, takes the pair out; a spot that was held goes to the first pair waiting. */
export async function withdrawPair(db: Db, input: { pairId: string; actorPlayerId: string; now?: Date }): Promise<Withdrawn> {
  const { pair, competition } = await loadPair(db, input.pairId);
  const mine = pair.p1PlayerId === input.actorPlayerId || pair.p2PlayerId === input.actorPlayerId;
  if (!mine && !isOrganizer(competition, input.actorPlayerId)) throw new DomainError("forbidden");
  if (!inPlay(pair)) return { pair, movedUp: null };
  const [withdrawn] = await db
    .update(competitionPairs)
    .set({ status: "withdrawn", withdrawnAt: input.now ?? new Date(), claimToken: null })
    .where(eq(competitionPairs.id, pair.id))
    .returning();
  const movedUp = pair.status === "entered" ? await moveUp(db, pair.categoryId) : null;
  return { pair: withdrawn, movedUp };
}

/** An account going: every entry of theirs leaves the field. Nobody is told here; the caller decides. */
export async function withdrawEntriesOf(db: Db, playerId: string, now = new Date()): Promise<Withdrawn[]> {
  const rows = await db
    .select({ id: competitionPairs.id })
    .from(competitionPairs)
    .where(and(ne(competitionPairs.status, "withdrawn"), playerIn(playerId)));
  const out: Withdrawn[] = [];
  for (const r of rows) out.push(await withdrawPair(db, { pairId: r.id, actorPlayerId: playerId, now }));
  return out;
}

export async function setPairPaid(db: Db, input: { pairId: string; organizerPlayerId: string; paid: boolean }): Promise<CompetitionPair> {
  const { pair, competition } = await loadPair(db, input.pairId);
  if (!isOrganizer(competition, input.organizerPlayerId)) throw new DomainError("forbidden", "organizer");
  const [updated] = await db.update(competitionPairs).set({ paid: input.paid }).where(eq(competitionPairs.id, pair.id)).returning();
  return updated;
}

/**
 * The partner opens the claim link signed in: the placeholder entered by name folds into their
 * account (every pair it was in moves with it) and the token is spent. Their own partner cannot
 * claim their spot, and a spot already claimed is nobody's to claim again.
 */
export async function claimPartnerSpot(db: Db, input: { token: string; playerId: string }): Promise<CompetitionPair> {
  const token = input.token.trim().toLowerCase();
  if (!token) throw new DomainError("not_found", "token");
  const [pair] = await db.select().from(competitionPairs).where(eq(competitionPairs.claimToken, token)).limit(1);
  if (!pair || !inPlay(pair)) throw new DomainError("not_found", "token");
  if (pair.p1PlayerId === input.playerId) throw new DomainError("invalid", "own_pair");
  if (pair.p2PlayerId !== input.playerId) {
    // The real person may already be in this competition: two categories with two placeholders of
    // the same name is fine, the same person twice in one category is not.
    const theirs = await entriesOf(db, pair.competitionId, input.playerId);
    if (theirs.some((e) => e.categoryId === pair.categoryId && e.id !== pair.id)) throw new DomainError("already_in", "partner");
    await mergePlayers(db, input.playerId, [pair.p2PlayerId]);
  }
  const [claimed] = await db.update(competitionPairs).set({ claimToken: null }).where(eq(competitionPairs.id, pair.id)).returning();
  return claimed;
}

/** The pair a claim link points at, for the page to say whose spot it is before anyone taps. */
export async function pairByClaimToken(db: Db, token: string): Promise<(CompetitionPair & { p1Name: string; p2Name: string; categoryName: string }) | null> {
  const t = token.trim().toLowerCase();
  if (!t) return null;
  const p1 = alias(players, "p1");
  const p2 = alias(players, "p2");
  const [row] = await db
    .select({ pair: competitionPairs, p1Name: p1.displayName, p2Name: p2.displayName, categoryName: competitionCategories.name })
    .from(competitionPairs)
    .innerJoin(p1, eq(p1.id, competitionPairs.p1PlayerId))
    .innerJoin(p2, eq(p2.id, competitionPairs.p2PlayerId))
    .innerJoin(competitionCategories, eq(competitionCategories.id, competitionPairs.categoryId))
    .where(eq(competitionPairs.claimToken, t))
    .limit(1);
  return row && inPlay(row.pair) ? { ...row.pair, p1Name: row.p1Name, p2Name: row.p2Name, categoryName: row.categoryName } : null;
}

/** A pair by id with its names and category, for the page after a claim. */
export async function pairSummary(db: Db, pairId: string): Promise<{ id: string; p1PlayerId: string; p2PlayerId: string; p1Name: string; p2Name: string; categoryName: string; status: CompetitionPair["status"] } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(pairId)) return null;
  const p1 = alias(players, "p1");
  const p2 = alias(players, "p2");
  const [row] = await db
    .select({ pair: competitionPairs, p1Name: p1.displayName, p2Name: p2.displayName, categoryName: competitionCategories.name })
    .from(competitionPairs)
    .innerJoin(p1, eq(p1.id, competitionPairs.p1PlayerId))
    .innerJoin(p2, eq(p2.id, competitionPairs.p2PlayerId))
    .innerJoin(competitionCategories, eq(competitionCategories.id, competitionPairs.categoryId))
    .where(eq(competitionPairs.id, pairId))
    .limit(1);
  return row ? { id: row.pair.id, p1PlayerId: row.pair.p1PlayerId, p2PlayerId: row.pair.p2PlayerId, p1Name: row.p1Name, p2Name: row.p2Name, categoryName: row.categoryName, status: row.pair.status } : null;
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export type PairView = {
  id: string;
  p1: { id: string; name: string };
  p2: { id: string; name: string };
  status: Exclude<CompetitionPair["status"], "withdrawn">;
  position: number;
  paid: boolean;
  seed: number | null;
  wildcard: boolean;
  /** False while the partner was named and has not opened the link. */
  claimed: boolean;
  checkedIn: boolean;
};
export type CategoryView = { category: CompetitionCategory; entered: PairView[]; waiting: PairView[] };
export type CompetitionPage = { competition: Competition; organizerName: string; categories: CategoryView[]; pairs: number };

/** Everything the public page and the manage screen show: three reads, in order (rule 8). */
export async function competitionPage(db: Db, c: Competition): Promise<CompetitionPage> {
  const [org] = await db.select({ name: players.displayName }).from(players).where(eq(players.id, c.organizerPlayerId)).limit(1);
  const cats = await categoriesOf(db, c.id);
  const p1 = alias(players, "p1");
  const p2 = alias(players, "p2");
  const rows =
    cats.length === 0
      ? []
      : await db
          .select({ pair: competitionPairs, p1Name: p1.displayName, p2Name: p2.displayName })
          .from(competitionPairs)
          .innerJoin(p1, eq(p1.id, competitionPairs.p1PlayerId))
          .innerJoin(p2, eq(p2.id, competitionPairs.p2PlayerId))
          .where(and(inArray(competitionPairs.categoryId, cats.map((k) => k.id)), ne(competitionPairs.status, "withdrawn")))
          .orderBy(asc(competitionPairs.position));
  const view = (r: (typeof rows)[number]): PairView => ({
    id: r.pair.id,
    p1: { id: r.pair.p1PlayerId, name: r.p1Name },
    p2: { id: r.pair.p2PlayerId, name: r.p2Name },
    status: r.pair.status === "waiting" ? "waiting" : "entered",
    position: r.pair.position,
    paid: r.pair.paid,
    seed: r.pair.seed,
    wildcard: r.pair.wildcard,
    claimed: !r.pair.claimToken,
    checkedIn: r.pair.checkedInAt !== null,
  });
  return {
    competition: c,
    organizerName: org?.name ?? "",
    categories: cats.map((category) => ({
      category,
      entered: rows.filter((r) => r.pair.categoryId === category.id && r.pair.status === "entered").map(view),
      waiting: rows.filter((r) => r.pair.categoryId === category.id && r.pair.status === "waiting").map(view),
    })),
    pairs: rows.length,
  };
}
