import { eq, getTableName, inArray, is, sql, type SQL } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { demandSignals, events, players, scores, slots, tournamentRounds } from "@/db/schema";
import { DomainError } from "./errors";

/**
 * Every column in the schema that points at a player, with the other columns of each unique key it
 * is part of.
 *
 * Read from the schema rather than listed by hand, because the hand-written list is how merges lost
 * data. Until 23 September 2026 `mergePlayers` moved matches, slots, scores, tournaments, activity
 * and venues, then deleted the old rows, and every other table that points at a player went with
 * them: a student's place on a coach's list and their lesson packages by `on delete cascade`, their
 * lessons' student and a note's author blanked by `set null`. Erik's question lost its way back to
 * him like that, on a morning with four merges in it. A table added next month is moved without
 * anybody remembering to.
 */
export type PlayerReference = { table: string; column: string; uniqueWith: string[][] };

export function playerReferences(): PlayerReference[] {
  const out: PlayerReference[] = [];
  for (const t of Object.values(schema)) {
    if (!is(t, PgTable)) continue;
    const c = getTableConfig(t);
    const named = (cols: readonly unknown[]) => cols.map((x) => (x as { name?: unknown }).name);
    // An index on an expression has no plain column names; it is left out, and a clash on it fails
    // the merge loudly rather than losing a row quietly.
    const keys = [
      ...c.indexes.filter((i) => i.config.unique).map((i) => named(i.config.columns)),
      ...c.uniqueConstraints.map((u) => named(u.columns)),
      ...c.primaryKeys.map((p) => named(p.columns)),
      ...c.columns.filter((col) => col.isUnique || col.primary).map((col) => [col.name]),
    ].filter((k): k is string[] => k.every((n) => typeof n === "string"));
    for (const fk of c.foreignKeys) {
      const ref = fk.reference();
      if (getTableName(ref.foreignTable) !== "players") continue;
      for (const col of ref.columns) {
        out.push({ table: c.name, column: col.name, uniqueWith: keys.filter((k) => k.includes(col.name)).map((k) => k.filter((n) => n !== col.name)) });
      }
    }
  }
  return out;
}

/** One row per player, and deleting the source's would take real data with it: both having one is a person to ask, not a merge to run. */
const REFUSE_WHEN_BOTH = new Set(["coaches"]);

const ident = (s: string) => sql.identifier(s);
const count = (r: unknown) => (Array.isArray(r) ? r.length : ((r as { rows?: unknown[] }).rows ?? []).length);

/**
 * Folds identities `from` into `into`, in one transaction, and deletes the sources.
 *
 * Four things keep a rule of their own: a seat in a match both already hold (the source's is
 * freed), a player id inside a tournament round's resting list or an event's standings (arrays,
 * not foreign keys), and a want (`demand_signals`, no foreign key either). Everything else that points at a player moves, table by table from the schema.
 * Where a unique key would clash — both in the same group, both students of one coach — the
 * survivor's row stays and the source's goes. That holds for `group_requests` too, whatever the two
 * statuses: when both rows asked to join one group, the survivor's ask stays as it is (a pending one
 * stays pending, a declined one keeps its seven days) and the source's goes, even if the source's
 * was the newer or the approved one. Accepted on purpose (October 2026): a clash needs one person
 * under two names asking one crew, a rule of its own is not worth it at today's size, and the worst
 * case is a person who asks again. Membership is not decided here: `group_members` moves by its own
 * key, and the admins' list leaves out a pending ask of somebody who is a member. Then the sources
 * are deleted, and the survivor takes any address or chat account it lacked, with the facts that
 * belong to them: an address comes with
 * its proof (`emailVerifiedAt`), and a level comes with its source, log and confirmation. The
 * recovery address and the home-screen mark come across when the survivor has none.
 *
 * `proved` is for a caller that proved the sources are the same person (the same Telegram account).
 * Then the survivor also takes the source's personal link and public page, because people already
 * hold them: the icon on a home screen, a calendar subscription, the cookie of another phone. The
 * source's token becomes the survivor's token when it has none, and otherwise its `previousToken`
 * when that is free, which `findPlayerByPersonalToken` still accepts. Since the owner's decision 2A
 * (9 October 2026) the survivor can be either record, so without this the record that lost took its
 * personal link with it. A fold by name or a placeholder never passes `proved`: a stranger with the
 * same name must not get a key to the survivor.
 *
 * Crypto-free on purpose so slot code (reachable from client bundles) can import it.
 */
export async function mergePlayers(db: Db, into: string, from: string[], o: { proved?: boolean } = {}): Promise<void> {
  const sources = [...new Set(from)].filter((id) => id !== into);
  if (sources.length === 0) return;
  await db.transaction(async (tx) => {
    const [target] = await tx.select().from(players).where(eq(players.id, into));
    if (!target) throw new DomainError("not_found");
    const srcRows = await tx.select().from(players).where(inArray(players.id, sources));

    const mine = await tx.select({ eventId: slots.eventId }).from(slots).where(eq(slots.playerId, into));
    const mineEvents = new Set(mine.map((m) => m.eventId));
    const theirs = await tx.select().from(slots).where(inArray(slots.playerId, sources));
    for (const s of theirs) {
      if (mineEvents.has(s.eventId)) {
        const [ev] = await tx.select({ capacity: events.capacity }).from(events).where(eq(events.id, s.eventId));
        if (ev && s.position > ev.capacity) await tx.delete(slots).where(eq(slots.id, s.id));
        else
          await tx
            .update(slots)
            .set({ playerId: null, status: "empty", kind: "open", inviteCode: null, invitedName: null, invitedEmail: null, invitedPhone: null, invitedAt: null, lastRemindedAt: null, joinedAt: null, team: null })
            .where(eq(slots.id, s.id));
      } else {
        await tx.update(slots).set({ playerId: into }).where(eq(slots.id, s.id));
        mineEvents.add(s.eventId);
      }
    }

    const rounds = await tx.select({ id: tournamentRounds.id, resting: tournamentRounds.resting }).from(tournamentRounds);
    for (const r of rounds) {
      if (r.resting.some((id) => sources.includes(id))) {
        await tx.update(tournamentRounds).set({ resting: [...new Set(r.resting.map((id) => (sources.includes(id) ? into : id)))] }).where(eq(tournamentRounds.id, r.id));
      }
    }
    const withStandings = await tx.select({ id: events.id, standings: events.standings }).from(events).where(sql`${events.standings} is not null`);
    for (const e of withStandings) {
      if (e.standings?.some((id) => sources.includes(id))) {
        await tx.update(events).set({ standings: [...new Set(e.standings.map((id) => (sources.includes(id) ? into : id)))] }).where(eq(events.id, e.id));
      }
    }

    // A want points at its player without a foreign key, so the schema read below cannot see it, and
    // until 24 September a merge left every want of the folded row pointing at a row that was gone.
    await tx.update(demandSignals).set({ playerId: into }).where(inArray(demandSignals.playerId, sources));

    for (const ref of playerReferences()) {
      const t = ident(ref.table);
      const c = ident(ref.column);
      for (const src of sources) {
        for (const other of ref.uniqueWith) {
          if (other.length === 0) {
            // One row per player: the survivor's stays and the source's goes, unless that loses data.
            const both = count(await tx.execute(sql`select 1 from ${t} a where a.${c} = ${src} and exists (select 1 from ${t} b where b.${c} = ${into})`));
            if (both && REFUSE_WHEN_BOTH.has(ref.table)) throw new DomainError("invalid");
            if (both) await tx.execute(sql`delete from ${t} where ${c} = ${src}`);
            continue;
          }
          // Both rows would share this key once moved: keep the survivor's. `=` on purpose, not
          // `is not distinct from`: a unique key lets two NULLs stand side by side, so they never clash.
          const same: SQL = sql.join(
            other.map((k) => sql`b.${ident(k)} = a.${ident(k)}`),
            sql` and `,
          );
          await tx.execute(sql`delete from ${t} a where a.${c} = ${src} and exists (select 1 from ${t} b where b.${c} = ${into} and ${same})`);
        }
        await tx.execute(sql`update ${t} set ${c} = ${into} where ${c} = ${src}`);
      }
    }

    // After the sources are gone: a chat account, a personal token and a public slug are each unique
    // to one row, so the survivor can only take one once nobody else holds it.
    const first = <K extends keyof (typeof srcRows)[number]>(k: K) => srcRows.find((s) => s[k] !== null && s[k] !== undefined)?.[k] ?? null;
    const patch: Partial<typeof players.$inferInsert> = {};
    // An address keeps its proof: the code came back to that address, whichever row asked for it.
    const withEmail = target.email ? srcRows.find((s) => s.email === target.email && s.emailVerifiedAt) : srcRows.find((s) => s.email);
    if (!target.email && withEmail) patch.email = withEmail.email;
    if (withEmail?.emailVerifiedAt && !target.emailVerifiedAt) patch.emailVerifiedAt = withEmail.emailVerifiedAt;
    if (!target.recoveryEmail && first("recoveryEmail")) patch.recoveryEmail = first("recoveryEmail");
    if (!target.homescreenAt && first("homescreenAt")) patch.homescreenAt = first("homescreenAt");
    // A level travels whole, from one row: the number, where it came from, its log and who confirmed it.
    const leveled = target.level === null ? srcRows.find((s) => s.level !== null) : undefined;
    if (leveled) {
      Object.assign(patch, {
        level: leveled.level,
        levelSource: leveled.levelSource,
        levelUpdatedAt: leveled.levelUpdatedAt,
        levelLog: leveled.levelLog,
        levelVerifiedAt: leveled.levelVerifiedAt,
        levelVerifiedBy: leveled.levelVerifiedBy,
        levelVerifiedLevel: leveled.levelVerifiedLevel,
        levelVerifiedSource: leveled.levelVerifiedSource,
      });
    }
    if (o.proved) {
      const tokens = srcRows.flatMap((s) => [s.personalToken, s.previousToken]).filter((t): t is string => Boolean(t));
      if (!target.personalToken && tokens.length) {
        patch.personalToken = tokens[0];
        patch.previousToken = target.previousToken ?? tokens[1] ?? null;
      } else if (target.personalToken && !target.previousToken && tokens.length) {
        // Two links can stay alive, not more: the one a home screen most likely opens is the current one.
        patch.previousToken = tokens[0];
      }
      const pub = target.publicSlug ? undefined : srcRows.find((s) => s.publicSlug);
      if (pub) Object.assign(patch, { publicSlug: pub.publicSlug, publicProfile: pub.publicProfile || target.publicProfile, publicSince: target.publicSince ?? pub.publicSince });
    }
    if (!target.phone && first("phone")) patch.phone = first("phone");
    if (!target.telegramId && first("telegramId")) patch.telegramId = first("telegramId");
    if (!target.discordId && first("discordId")) patch.discordId = first("discordId");
    if (!target.lineId && first("lineId")) patch.lineId = first("lineId");
    await tx.delete(players).where(inArray(players.id, sources));
    if (Object.keys(patch).length) await tx.update(players).set(patch).where(eq(players.id, into));
  });
}

/**
 * How much a record has lived: its occupied seats, the matches it created and the matches it entered
 * a score for. Read when two records turn out to be one person, to decide which one survives
 * (`recordToKeep`).
 */
export type RecordWeight = { id: string; history: number; createdAt: Date };

/**
 * The record to keep when two records are one person: the one with more history, and on a tie the
 * older one. On the same instant too, the first one, which callers pass as the record signed in here.
 *
 * The owner, 9 October 2026 (decision 2A): "keep the record with more history". A merge keeps the
 * survivor's personal token and nothing of the other's, so the record that loses also loses the
 * personal link its home-screen icon opens and the cookie on every other device. The real record has
 * the matches, so it is the one people already hold in their hands.
 */
export function recordToKeep(first: RecordWeight, second: RecordWeight): string {
  if (first.history !== second.history) return first.history > second.history ? first.id : second.id;
  return second.createdAt.getTime() < first.createdAt.getTime() ? second.id : first.id;
}

/**
 * `RecordWeight` for a few players, in one query. Each count is one player's own rows read through an
 * index (`slots_player_idx`, `events_creator_idx`); a score is counted only in a match the player sat
 * in or created, so it is read through `scores_event_set_idx` and never by a scan of every score.
 */
export async function recordWeights(db: Db, ids: string[]): Promise<RecordWeight[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: players.id,
      createdAt: players.createdAt,
      history: sql<number>`(
        (select count(*) from ${slots} s where s.player_id = ${players}.id and s.status in ('joined', 'confirmed'))
        + (select count(*) from ${events} e where e.creator_player_id = ${players}.id)
        + (select count(distinct sc.event_id) from ${scores} sc where sc.entered_by_player_id = ${players}.id and sc.event_id in (
            select s2.event_id from ${slots} s2 where s2.player_id = ${players}.id
            union all select e2.id from ${events} e2 where e2.creator_player_id = ${players}.id))
      )::int`,
    })
    .from(players)
    .where(inArray(players.id, ids));
  return rows.map((r) => ({ id: r.id, createdAt: r.createdAt, history: Number(r.history) }));
}
