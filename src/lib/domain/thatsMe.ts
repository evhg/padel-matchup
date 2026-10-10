import { eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { events, players, type Player } from "@/db/schema";
import { normalName, safeToMerge } from "./dupes";
import { recordFact } from "./facts";
import { mergePlayers } from "./merge";
import { bumpMetric } from "./metrics";
import { LIMITS, takeRate } from "./ratelimit";
import { countSignIn } from "./signins";

/**
 * "That's me": a browser that has never seen this person signs in as their record, by name, with no
 * email and no code (DECIDING rule 32).
 *
 * A link in a WhatsApp group opens the phone's default browser, and every browser, every app's own
 * browser and the icon on an iPhone's home screen keeps its own cookies. A player in a browser that
 * does not know them typed their name and became a second record, and the ways back in (an email
 * code, Telegram) reached 2 of 21 players (production, 10 October 2026). The owner, the same day:
 * "Yes, 'That's me' signs in", with every limit below required:
 *
 *   - never the match's organiser, nor a co-organiser (an admin or the creator of the crew the match
 *     belongs to);
 *   - never a record that can prove itself or be reached: an email, a recovery email, a phone, a
 *     Telegram, Discord or LINE account, a push subscription; nor one with a coach's book (its own or
 *     one it runs), a claimed club or a public profile. Added here in the same spirit: nor one that
 *     organises a series or a competition, which are other people's events;
 *   - never a member of a group that asks to join (a merge carries memberships; DECIDING rule 30);
 *   - never across matches the record has no part in: it holds a seat, a waiting place or an invite
 *     in this match, or is a member of the crew this match belongs to (a seat in a crew's match makes
 *     a member already, `joinWithPolicy`);
 *   - never more than one record per name: two of the same name there, and neither is offered.
 *
 * If the browser already made a new record (the player typed the name and joined), "That's me" folds
 * that record into the old one with `mergePlayers`, never `proved` (a name hands over no personal
 * link), and the seat moves with it. The new record must be as bare as the old one and carry the
 * same name. Rate-limited per address like the other identity doors, counted, and recorded as a fact.
 *
 * The owner decided on 9 October 2026 that the restore without proof stays ("a friendly app, hacking
 * is encouraged"): this is the same spirit, with tighter limits.
 */

/** One record that could be meant, with every fact the limits read. `key` is the name in lower case with single spaces, as the database makes it. */
export type ThatsMeRow = {
  id: string;
  name: string;
  key: string;
  /** Carries the name that was asked about (always true when none was). */
  named: boolean;
  /** How many records in this match or crew carry the same key, this one included. */
  sameName: number;
  inContext: boolean;
  organiser: boolean;
  coOrganiser: boolean;
  email: boolean;
  recoveryEmail: boolean;
  phone: boolean;
  telegram: boolean;
  discord: boolean;
  line: boolean;
  push: boolean;
  coachBook: boolean;
  claimedClub: boolean;
  publicProfile: boolean;
  organisesEvents: boolean;
  inAskingGroup: boolean;
};

export type ThatsMeRefusal =
  | "nobody"
  | "namesake"
  | "no_context"
  | "organiser"
  | "co_organiser"
  | "email"
  | "recovery_email"
  | "phone"
  | "telegram"
  | "discord"
  | "line"
  | "push"
  | "coach_book"
  | "claimed_club"
  | "public_profile"
  | "organises_events"
  | "asking_group"
  | "not_same_name"
  | "too_many";

/** A way to reach or prove the record, or a role that belongs to other people: the first one found, or null. Shared by the record asked for and the record a fold gives up. */
function reachableBy(r: ThatsMeRow): ThatsMeRefusal | null {
  if (r.email) return "email";
  if (r.recoveryEmail) return "recovery_email";
  if (r.phone) return "phone";
  if (r.telegram) return "telegram";
  if (r.discord) return "discord";
  if (r.line) return "line";
  if (r.push) return "push";
  if (r.coachBook) return "coach_book";
  if (r.claimedClub) return "claimed_club";
  if (r.publicProfile) return "public_profile";
  if (r.organisesEvents) return "organises_events";
  return null;
}

/**
 * Why this record may not be signed in by name, or null when nothing stands in the way. `others` is
 * how many records of the same name the asking browser itself accounts for (its own new record), so a
 * fold is not refused as a namesake of the record that wants to fold. Pure.
 */
export function whyNot(r: ThatsMeRow, others = 0): ThatsMeRefusal | null {
  if (!r.inContext) return "no_context";
  if (r.organiser) return "organiser";
  if (r.coOrganiser) return "co_organiser";
  const reach = reachableBy(r);
  if (reach) return reach;
  if (r.inAskingGroup) return "asking_group";
  if (r.sameName - others > 1) return "namesake";
  return null;
}

export type ThatsMeVerdict = { ok: true; id: string; fold: boolean } | { ok: false; reason: ThatsMeRefusal };

/**
 * The decision, over the rows `thatsMeRows` read for one name. `viewerId` is the record this browser
 * is signed in as, if any: then the answer folds it into the record named, and only when it is as bare
 * as that record and carries the same name. A cookie whose record is gone (merged elsewhere, deleted)
 * reads no row and counts as a browser that knows nobody, as the page treats it. Pure: the page and
 * the action both ask it, so what the page offers is what the tap does.
 */
export function thatsMeVerdict(rows: readonly ThatsMeRow[], viewerId: string | null = null): ThatsMeVerdict {
  const viewer = viewerId ? (rows.find((r) => r.id === viewerId) ?? null) : null;
  const named = rows.filter((r) => r.named && r.id !== viewerId && r.inContext);
  if (named.length === 0) return { ok: false, reason: "nobody" };
  // The browser's own new record is in the count when it sits in the same match or crew under the same name.
  const own = viewer && viewer.inContext && viewer.key === named[0].key ? 1 : 0;
  if (named.length > 1) return { ok: false, reason: "namesake" };
  const target = named[0];
  const why = whyNot(target, own);
  if (why) return { ok: false, reason: why };
  if (viewer) {
    if (viewer.key !== target.key) return { ok: false, reason: "not_same_name" };
    const reach = reachableBy(viewer);
    if (reach) return { ok: false, reason: reach };
  }
  return { ok: true, id: target.id, fold: Boolean(viewer) };
}

/** The records a browser that knows nobody may sign in as, from the rows read for a whole match: what the page offers. Pure. */
export const claimableRows = (rows: readonly ThatsMeRow[]): ThatsMeRow[] => rows.filter((r) => whyNot(r) === null);

const rowsOf = (r: unknown): Record<string, unknown>[] => (Array.isArray(r) ? r : ((r as { rows?: Record<string, unknown>[] }).rows ?? []));
const yes = (v: unknown) => v === true || v === "t" || v === "true";

/** A match as the rule reads it: its own id, its crew and its organiser. */
export type ThatsMeMatch = { id: string; groupId: string | null; creatorPlayerId: string };

/** The most rows one read returns: a tournament's field and its waiting list, with a crew beside it. */
export const THATS_ME_ROWS = 120;

/**
 * Every record in this match (a seat, a waiting place or an invite) or in its crew (a membership),
 * with each fact the limits read, in one bounded read (rule 12): every fact is a lookup down the
 * index of its own table (`slots_event_position_idx`, the members' key, `push_subscriptions_player_idx`,
 * `coaches_player_idx`, `coach_managers_player_idx`, `clubs_claimed_by_idx`, `series_organizer_idx`,
 * `competitions_organizer_idx`, `group_members_player_idx`). `name` narrows it to that name; the
 * browser's own record (`viewerId`) comes back beside it, wherever it is, so a fold can be judged.
 *
 * The count of a name is taken over the whole match and crew before the limit cuts, so a cut can
 * hide a row but never a namesake. Names are compared in the database on both sides, so "Аня" and
 * "аня" meet whatever the database's own idea of lower case is.
 */
export async function thatsMeRows(db: Db, m: ThatsMeMatch, o: { name?: string | null; viewerId?: string | null } = {}): Promise<ThatsMeRow[]> {
  const name = o.name?.trim() ? o.name : null;
  const viewerId = o.viewerId && /^[0-9a-f-]{36}$/i.test(o.viewerId) ? o.viewerId : null;
  const res = await db.execute(sql`
    with ctx as (
      select s.player_id as id from slots s
       where s.event_id = ${m.id} and s.player_id is not null and s.status in ('joined', 'confirmed', 'invited')
      union
      select gm.player_id from group_members gm where gm.group_id = ${m.groupId}
    ),
    pool as (
      select id from ctx
      union
      select p.id from players p where p.id = ${viewerId}
    ),
    facts as (
      select p.id, p.display_name, p.created_at,
        lower(regexp_replace(btrim(p.display_name), '[[:space:]]+', ' ', 'g')) as key,
        (${name}::text is null or lower(regexp_replace(btrim(p.display_name), '[[:space:]]+', ' ', 'g')) = lower(regexp_replace(btrim(${name}::text), '[[:space:]]+', ' ', 'g'))) as named,
        exists (select 1 from ctx where ctx.id = p.id) as in_context,
        p.id = ${m.creatorPlayerId} as organiser,
        (exists (select 1 from group_members a where a.group_id = ${m.groupId} and a.player_id = p.id and a.role = 'admin')
          or exists (select 1 from groups g where g.id = ${m.groupId} and g.creator_player_id = p.id)) as co_organiser,
        p.email is not null as email,
        p.recovery_email is not null as recovery_email,
        p.phone is not null as phone,
        p.telegram_id is not null as telegram,
        p.discord_id is not null as discord,
        p.line_id is not null as line,
        exists (select 1 from push_subscriptions ps where ps.player_id = p.id) as push,
        (exists (select 1 from coaches c where c.player_id = p.id) or exists (select 1 from coach_managers cm where cm.player_id = p.id)) as coach_book,
        exists (select 1 from clubs cl where cl.claimed_by = p.id) as claimed_club,
        p.public_profile,
        (exists (select 1 from series sr where sr.organizer_player_id = p.id) or exists (select 1 from competitions cp where cp.organizer_player_id = p.id)) as organises_events,
        exists (select 1 from group_members gx join groups gg on gg.id = gx.group_id where gx.player_id = p.id and gg.ask_to_join) as in_asking_group
      from players p
      where p.id in (select id from pool) and p.display_name <> 'Deleted player'
    )
    select f.*, count(*) filter (where f.in_context) over (partition by f.key) as same_name
    from facts f
    where f.named or f.id = ${viewerId}
    order by f.created_at
    limit ${THATS_ME_ROWS}`);
  return rowsOf(res).map((x) => ({
    id: String(x.id),
    name: String(x.display_name),
    key: String(x.key),
    named: yes(x.named),
    sameName: Number(x.same_name ?? 0),
    inContext: yes(x.in_context),
    organiser: yes(x.organiser),
    coOrganiser: yes(x.co_organiser),
    email: yes(x.email),
    recoveryEmail: yes(x.recovery_email),
    phone: yes(x.phone),
    telegram: yes(x.telegram),
    discord: yes(x.discord),
    line: yes(x.line),
    push: yes(x.push),
    coachBook: yes(x.coach_book),
    claimedClub: yes(x.claimed_club),
    publicProfile: yes(x.public_profile),
    organisesEvents: yes(x.organises_events),
    inAskingGroup: yes(x.in_asking_group),
  }));
}

export type ThatsMeResult = { ok: true; player: Player; folded: boolean } | { ok: false; reason: ThatsMeRefusal | "not_found" };

/**
 * The tap. Takes the rate first, so a refusal costs an attempt too and names cannot be tried one after
 * another; reads the rows for that one name; decides; folds the browser's own record when there is
 * one; counts the way in and records the fact (no name in it). The caller sets the cookie to the
 * player it returns.
 */
export async function thatsMe(db: Db, input: { code: string; name: string; viewerId: string | null; rateKey: string; now?: Date }): Promise<ThatsMeResult> {
  if (!(await takeRate(db, "thatsme", input.rateKey, LIMITS.thatsMePerIpPerDay, "day", input.now))) return { ok: false, reason: "too_many" };
  const [ev] = await db.select({ id: events.id, groupId: events.groupId, creatorPlayerId: events.creatorPlayerId, code: events.code }).from(events).where(eq(events.code, input.code)).limit(1);
  if (!ev) return { ok: false, reason: "not_found" };
  const rows = await thatsMeRows(db, ev, { name: input.name, viewerId: input.viewerId });
  const verdict = thatsMeVerdict(rows, input.viewerId);
  if (!verdict.ok) {
    await bumpMetric(db, "thats_me_refused").catch(() => undefined);
    return verdict;
  }
  const [target] = await db.select().from(players).where(eq(players.id, verdict.id)).limit(1);
  if (!target) return { ok: false, reason: "nobody" };
  if (verdict.fold && input.viewerId) {
    const [mine] = await db.select().from(players).where(eq(players.id, input.viewerId)).limit(1);
    // The last word on every pair of records, as everywhere else a merge runs (`same_name_one_address`).
    if (!mine || !safeToMerge(target, mine).ok) return { ok: false, reason: "not_same_name" };
    await mergePlayers(db, target.id, [mine.id]);
  }
  await countSignIn(db, "thats_me");
  if (verdict.fold) await countSignIn(db, "thats_me_fold");
  await recordFact(db, { kind: "player.thats_me", channel: "web", actorPlayerId: target.id, subject: { type: "player", id: target.id }, code: ev.code, data: { folded: verdict.fold }, at: input.now });
  const [fresh] = await db.select().from(players).where(eq(players.id, target.id)).limit(1);
  return { ok: true, player: fresh ?? target, folded: verdict.fold };
}

/** What a match page offers: the records a browser that knows nobody may tap, or the one its own new record folds into. */
export type ThatsMeOffer = { ids: Set<string>; names: string[]; fold: { id: string; name: string } | null };
export const NO_OFFER: ThatsMeOffer = { ids: new Set(), names: [], fold: null };

/**
 * The page's side of the rule, in at most one read. A browser that knows nobody reads the whole match
 * and crew, and every record the rule allows wears "That's me" on its row; the names go to the open
 * spot as well, for the person who types theirs. A browser signed in as a record with nothing to prove
 * it reads only its own name, and only when that name is in the match twice or the match has a crew:
 * anybody else, and every record that can be reached, costs no read at all.
 */
export async function thatsMeOffer(db: Db, m: ThatsMeMatch, viewer: Pick<Player, "id" | "displayName" | "email" | "recoveryEmail" | "phone" | "telegramId" | "discordId" | "lineId" | "publicProfile"> | null, namesHere: readonly string[]): Promise<ThatsMeOffer> {
  if (!viewer) {
    const ok = claimableRows(await thatsMeRows(db, m));
    return { ids: new Set(ok.map((r) => r.id)), names: ok.map((r) => r.name), fold: null };
  }
  const bare = !viewer.email && !viewer.recoveryEmail && !viewer.phone && !viewer.telegramId && !viewer.discordId && !viewer.lineId && !viewer.publicProfile;
  const twice = namesHere.filter((n) => normalName(n) === normalName(viewer.displayName)).length >= 2;
  if (!bare || !(twice || m.groupId)) return NO_OFFER;
  const rows = await thatsMeRows(db, m, { name: viewer.displayName, viewerId: viewer.id });
  const v = thatsMeVerdict(rows, viewer.id);
  const target = v.ok ? rows.find((r) => r.id === v.id) : undefined;
  return target ? { ids: new Set(), names: [], fold: { id: target.id, name: target.name } } : NO_OFFER;
}
