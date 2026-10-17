import { eq, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/db";
import { events, passkeys, players, slots, type Event, type Player } from "@/db/schema";
import { normalName, safeToMerge } from "./dupes";
import { recomputeStatus } from "./events";
import { recordFact } from "./facts";
import { wasComplete } from "./joining";
import { mergePlayers } from "./merge";
import type { MergeCounter } from "./signins";
import { bumpMetric } from "./metrics";
import { LIMITS, takeRate } from "./ratelimit";
import { lockEvent, vacateAndPromote, type Promotion } from "./slots";
import { firstName, UNREACHED_SHOWN } from "./unreached";

/**
 * "That's me": a browser that has never seen this person signs in as their record, by name, with no
 * email and no code (DECIDING rule 34).
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
 *     Telegram, Discord or LINE account, a push subscription, a passkey (Face ID or a fingerprint, the
 *     owner's decision of 12 October 2026, DECIDING rule 39); nor one with a coach's book (its own or
 *     one it runs), a claimed club or a public profile;
 *   - never a member of a group that asks to join (a merge carries memberships; DECIDING rule 30);
 *   - never across matches the record has no part in: it holds a seat, a waiting place or an invite
 *     in this match, or is a member of the crew this match belongs to (a seat in a crew's match makes
 *     a member already, `joinWithPolicy`);
 *   - never more than one record per name: two of the same name there, and neither is offered.
 *
 * And, since the review of 10 October 2026, never a record that runs something for other people,
 * because the cookie alone carries those powers (`getViewer`): one that organises a match or
 * tournament still to come or under way, is the creator or an admin of any crew, organises a series or
 * a competition; nor a coach's student (an accepted place on a coach's list, or a lesson package),
 * whose lessons and paid packages a stranger could then move. Until 11 October 2026 the first limit
 * read "any match, ever", and it refused old Danny, who organised two matches in September. The owner,
 * 11 October 2026, chose ""That's me" for past organisers": "The change refuses only a record that
 * organises an upcoming match." A match called off or over runs nothing for anybody.
 *
 * If the browser already made a new record (the player typed the name and joined), "That's me" folds
 * that record into the old one with `mergePlayers`, never `proved`, when the browser's record is in
 * this match or crew too and passes the same limits as the old one. Where both hold a place in this
 * match, the old record keeps the better one (`settleFoldSeats`), and the place it gives up goes the
 * way a leave goes: a waiting place is removed, a seat is freed and the first waiting player moves up.
 *
 * Rate-limited per address and per record, counted, and recorded as a fact. The session it starts is
 * marked (`markSignedInByName`), and until the record proves something, My matches shows no personal
 * link and no home-screen card, and the link cannot be rotated (`nameOnlySession`).
 *
 * The owner decided on 9 October 2026 that the restore without proof stays ("a friendly app, hacking
 * is encouraged"): this is the same spirit, with tighter limits. The restore asks the person for no
 * proof, and since 11 October 2026 it takes only the seal the server gave that browser, never a bare
 * player id (`restoreSeal` in src/lib/session.ts).
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
  /** A passkey saved on a phone (src/lib/domain/passkeys.ts): the record signs itself in with Face ID or a fingerprint. */
  passkey: boolean;
  coachBook: boolean;
  /** An accepted place on a coach's list, or a lesson package of any coach. */
  coachStudent: boolean;
  claimedClub: boolean;
  publicProfile: boolean;
  /** The creator of a match or tournament that is not called off and not over (still to come, or under way), this one or another. */
  organisesMatches: boolean;
  /** The creator or an admin of any crew. */
  runsCrew: boolean;
  /** The organiser of a series or a competition. */
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
  | "passkey"
  | "coach_book"
  | "coach_student"
  | "claimed_club"
  | "public_profile"
  | "organises_matches"
  | "runs_a_crew"
  | "organises_events"
  | "asking_group"
  | "not_same_name"
  | "too_many";

/**
 * What a name must never stand for: a way to reach or prove the record, something it runs for other
 * people, or a door a name must not open. The first one found, or null. Asked of the record named and
 * of the browser's own record in a fold alike, because a merge carries everything either one holds.
 * The passkey's sign-in asks it too, of the record the browser held before (`passkeyFold` in
 * src/lib/domain/passkeys.ts): the one list, never a copy of it.
 */
export function heldBack(r: Omit<ThatsMeRow, "id" | "name" | "key" | "named" | "sameName" | "inContext" | "organiser" | "coOrganiser">): ThatsMeRefusal | null {
  if (r.email) return "email";
  if (r.recoveryEmail) return "recovery_email";
  if (r.phone) return "phone";
  if (r.telegram) return "telegram";
  if (r.discord) return "discord";
  if (r.line) return "line";
  if (r.push) return "push";
  if (r.passkey) return "passkey";
  if (r.coachBook) return "coach_book";
  if (r.coachStudent) return "coach_student";
  if (r.claimedClub) return "claimed_club";
  if (r.publicProfile) return "public_profile";
  if (r.organisesMatches) return "organises_matches";
  if (r.runsCrew) return "runs_a_crew";
  if (r.organisesEvents) return "organises_events";
  if (r.inAskingGroup) return "asking_group";
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
  const held = heldBack(r);
  if (held) return held;
  if (r.sameName - others > 1) return "namesake";
  return null;
}

export type ThatsMeVerdict = { ok: true; id: string; fold: boolean } | { ok: false; reason: ThatsMeRefusal };

/**
 * The decision, over the rows `thatsMeRows` read for one name. `viewerId` is the record this browser
 * is signed in as, if any: then the answer folds it into the record named, and only when it is in this
 * match or crew as well, carries the same name, and passes every limit the record named passes (an
 * organiser, a crew's admin or a member of a group that asks to join would hand those on in the
 * merge). A cookie whose record is gone (merged elsewhere, deleted) reads no row and counts as a
 * browser that knows nobody, as the page treats it. Pure: the page and the action both ask it, so what
 * the page offers is what the tap does.
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
    if (!viewer.inContext) return { ok: false, reason: "no_context" };
    if (viewer.key !== target.key) return { ok: false, reason: "not_same_name" };
    const held = viewer.organiser ? "organiser" : viewer.coOrganiser ? "co_organiser" : heldBack(viewer);
    if (held) return { ok: false, reason: held };
  }
  return { ok: true, id: target.id, fold: Boolean(viewer) };
}

/**
 * A session that came in by "That's me" stays marked until the record proves something: a code that
 * came back from an address, a Telegram, Discord or LINE account, a number that wrote to us. Until then
 * My matches shows no personal link and no home-screen card, and the link cannot be rotated, so a tap
 * by name hands over no lasting key (the coordinator's decision of 10 October 2026, reported to the
 * owner as an assumption he can reverse). Pure: the cookie's answer and the record in, yes or no out.
 */
export function nameOnlySession(signedByName: boolean, p: Pick<Player, "emailVerifiedAt" | "telegramId" | "discordId" | "lineId" | "phone"> | null): boolean {
  if (!signedByName || !p) return false;
  return !(p.emailVerifiedAt || p.telegramId || p.discordId || p.lineId || p.phone);
}

/** The records a browser that knows nobody may sign in as, from the rows read for a whole match: what the page offers. Pure. */
export const claimableRows = (rows: readonly ThatsMeRow[]): ThatsMeRow[] => rows.filter((r) => whyNot(r) === null);

const rowsOf = (r: unknown): Record<string, unknown>[] => (Array.isArray(r) ? r : ((r as { rows?: Record<string, unknown>[] }).rows ?? []));
const yes = (v: unknown) => v === true || v === "t" || v === "true";

/** A match as the rule reads it: its own id, its crew and its organiser. */
export type ThatsMeMatch = { id: string; groupId: string | null; creatorPlayerId: string };

/** The most rows one read returns: a tournament's field and its waiting list, the browser's own record beside it. */
export const THATS_ME_ROWS = 120;

/**
 * Characters that change a name without showing: zero-width spaces and joiners, direction marks, the
 * word joiner, the byte-order mark, the soft hyphen. Taken out of the key, so "Ana" and "Ana" with a
 * zero-width space inside are one name to the namesake rule (`normalizeName` takes them out of a name
 * as it is typed, too).
 */
const INVISIBLE = "[\u200B\u200C\u200D\u200E\u200F\u2060\uFEFF\u00AD]";

/** A name as the rule compares it, in the database: composed (NFC), invisible characters out, lower case, one space between words. */
const keyOf = (expr: SQL) => sql`lower(regexp_replace(btrim(regexp_replace(normalize(${expr}, NFC), ${INVISIBLE}, '', 'g')), '[[:space:]]+', ' ', 'g'))`;

/**
 * The records the rule reads, with each fact its limits read, in one bounded read (rule 12).
 *
 * Which records: with a `name`, every record of that name in this match (a seat, a waiting place or an
 * invite) or its crew (a membership); without one, as the match page asks for a browser that knows
 * nobody, only the records with a place in this match, so the page never reads the crew's members'
 * facts nor sends them anywhere. The browser's own record (`viewerId`) comes back beside them,
 * wherever it is, so a fold can be judged.
 *
 * What it costs: the places in this match down `slots_event_position_idx` (its capacity and waiting
 * list); the crew's members down the members' key, once, for their names only, so a namesake in the
 * crew is counted even when the page shows the match alone; then, for each record returned, one lookup
 * per fact down that table's own index: `push_subscriptions_player_idx`, `passkeys_player_idx`, `coaches_player_idx`,
 * `coach_managers_player_idx`, `coach_students_player_idx`, `clubs_claimed_by_idx`,
 * `events_creator_idx`, `group_members_player_idx` (an admin anywhere, a group that asks to join),
 * `groups_creator_idx`, `series_organizer_idx`, `competitions_organizer_idx`. A lesson package has no
 * index that leads with the student (`lesson_packages_student_idx` leads with the coach), so that one
 * fact goes through each coach (two coaches today) into that index; an index of its own would need a
 * migration.
 *
 * Names are compared in the database on both sides, composed and with invisible characters taken
 * out, so "José" typed two ways and "Аня" against "аня" meet.
 *
 * `extra`: one more record that is in this match's context, beside its places and its crew: a past
 * partner on the organiser's unreached list, which the server found for the name typed (the owner's
 * decision of 16 October 2026, D6; `unreachedNamed`). It counts as in context and in the namesake count,
 * and every other limit reads it as it reads any record.
 *
 * One statement. `thatsMeRowsMany` sends several of these reads as one statement, each with its own
 * context, counts and limit; both build their SQL with `thatsMeSql`.
 */
export async function thatsMeRows(db: Db, m: ThatsMeMatch, o: ThatsMeProbe & { now?: Date } = {}): Promise<ThatsMeRow[]> {
  // "Organises" means a match still to come or under way (the owner, 11 October 2026), as `endedBy` reads an end: as text (rule 1).
  const nowIso = (o.now ?? new Date()).toISOString();
  return rowsOf(await db.execute(thatsMeSql(m, o, nowIso))).map(thatsMeRowOf);
}

/** What one read of `thatsMeRows` asks for: a name, the browser's own record, one more record in context. */
export type ThatsMeProbe = { name?: string | null; viewerId?: string | null; extra?: string | null };

/**
 * Several reads of `thatsMeRows` in one statement, `(read 1) union all (read 2) …`, so a page that needs
 * more than one sends one statement, not one after another (rules 8 and 12). Each read keeps its own
 * `with` clause, so its context (its `extra`, its browser), its namesake counts and its limit are the
 * ones `thatsMeRows` gives for that read alone: one read's `extra` and browser are in no other read.
 * Each row carries the number of its read and its place in that read's own order; the rows come back
 * as one list for each read, in the order of `probes`. One `now` for all of them. No statement for no
 * read.
 */
export async function thatsMeRowsMany(db: Db, m: ThatsMeMatch, probes: readonly ThatsMeProbe[], now?: Date): Promise<ThatsMeRow[][]> {
  if (probes.length === 0) return [];
  const nowIso = (now ?? new Date()).toISOString();
  const reads = sql.join(
    probes.map((o, i) => sql`(${thatsMeSql(m, o, nowIso, i)})`),
    sql` union all `,
  );
  const res = await db.execute(sql`${reads} order by probe, ord`);
  const out = probes.map((): ThatsMeRow[] => []);
  for (const x of rowsOf(res)) out[Number(x.probe)].push(thatsMeRowOf(x));
  return out;
}

/**
 * The SQL of one read, for `thatsMeRows` and `thatsMeRowsMany` alike: the one place it is written.
 * `nowIso` is the read's moment as text (rule 1). With `probe`, each row also carries that number and
 * its place in the read's own order (`ord`), so reads can share a statement and be told apart.
 */
function thatsMeSql(m: ThatsMeMatch, o: ThatsMeProbe, nowIso: string, probe: number | null = null): SQL {
  const name = o.name?.trim() ? o.name : null;
  const extra = o.extra && /^[0-9a-f-]{36}$/i.test(o.extra) ? o.extra : null;
  const viewerId = o.viewerId && /^[0-9a-f-]{36}$/i.test(o.viewerId) ? o.viewerId : null;
  const tag = probe === null ? sql.empty() : sql`${probe}::int as probe, (row_number() over (order by p.created_at))::int as ord, `;
  return sql`
    with seats as (
      select s.player_id as id from slots s
       where s.event_id = ${m.id} and s.player_id is not null and s.status in ('joined', 'confirmed', 'invited')
    ),
    crew as (
      select gm.player_id as id from group_members gm where gm.group_id = ${m.groupId}
    ),
    ctx as (
      select id from seats union select id from crew union select p.id from players p where p.id = ${extra}
    ),
    keys as (
      select p.id, ${keyOf(sql`p.display_name`)} as key
      from players p
      where p.id in (select id from ctx) and p.display_name <> 'Deleted player'
    ),
    counts as (
      select key, count(*) as n from keys group by key
    ),
    pool as (
      select id from seats where ${name}::text is null
      union
      select k.id from keys k where ${name}::text is not null and k.key = ${keyOf(sql`${name}::text`)}
      union
      select p.id from players p where p.id = ${viewerId}
    )
    select ${tag}p.id, p.display_name, ${keyOf(sql`p.display_name`)} as key,
      (${name}::text is null or ${keyOf(sql`p.display_name`)} = ${keyOf(sql`${name}::text`)}) as named,
      coalesce((select c.n from counts c where c.key = ${keyOf(sql`p.display_name`)}), 0) as same_name,
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
      exists (select 1 from passkeys pk where pk.player_id = p.id) as passkey,
      (exists (select 1 from coaches c where c.player_id = p.id) or exists (select 1 from coach_managers cm where cm.player_id = p.id)) as coach_book,
      (exists (select 1 from coach_students cs where cs.player_id = p.id and cs.status = 'accepted')
        or exists (select 1 from coaches ck join lesson_packages lp on lp.coach_id = ck.id and lp.student_player_id = p.id)) as coach_student,
      exists (select 1 from clubs cl where cl.claimed_by = p.id) as claimed_club,
      p.public_profile,
      exists (select 1 from events e where e.creator_player_id = p.id and e.status in ('open', 'full')
        and e.starts_at + make_interval(mins => e.duration_minutes) > ${nowIso}::timestamptz) as organises_matches,
      (exists (select 1 from group_members ga where ga.player_id = p.id and ga.role = 'admin')
        or exists (select 1 from groups gc where gc.creator_player_id = p.id)) as runs_crew,
      (exists (select 1 from series sr where sr.organizer_player_id = p.id) or exists (select 1 from competitions cp where cp.organizer_player_id = p.id)) as organises_events,
      exists (select 1 from group_members gx join groups gg on gg.id = gx.group_id where gx.player_id = p.id and gg.ask_to_join) as in_asking_group
    from players p
    where p.id in (select id from pool) and p.display_name <> 'Deleted player'
    order by p.created_at
    limit ${THATS_ME_ROWS}`;
}

/** One row of the read, as the rule reads it. */
function thatsMeRowOf(x: Record<string, unknown>): ThatsMeRow {
  return {
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
    passkey: yes(x.passkey),
    coachBook: yes(x.coach_book),
    coachStudent: yes(x.coach_student),
    claimedClub: yes(x.claimed_club),
    publicProfile: yes(x.public_profile),
    organisesMatches: yes(x.organises_matches),
    runsCrew: yes(x.runs_crew),
    organisesEvents: yes(x.organises_events),
    inAskingGroup: yes(x.in_asking_group),
  };
}

/** How good a place in a match is: a seat taken beats a seat held for them, which beats a waiting place. */
export function placeRank(slot: { position: number; status: string }, capacity: number): number {
  if (slot.position > capacity) return 1;
  return slot.status === "invited" ? 2 : 3;
}

/** What a fold changed in this match: the place given up went the way a leave goes. */
export type SeatChange = { event: Event; promotion: Promotion | null; wasComplete: boolean };

/**
 * Before a fold, when both records hold a place in this match: the record that stays (`keepId`) takes
 * the better of the two places, and the other place goes through `vacateAndPromote`, the path every
 * leave takes (a waiting place is removed; a seat is freed and the first waiting player moves up). One
 * transaction under the event's lock. Null when only one of them holds a place here: the merge then
 * moves it to the record that stays, and the seat moves with it.
 */
export async function settleFoldSeats(db: Db, eventId: string, keepId: string, dropId: string): Promise<SeatChange | null> {
  return db.transaction(async (tx) => {
    const ev = await lockEvent(tx, eventId);
    const all = await tx.select().from(slots).where(eq(slots.eventId, ev.id));
    const keep = all.find((x) => x.playerId === keepId);
    const drop = all.find((x) => x.playerId === dropId);
    if (!keep || !drop) return null;
    const before = wasComplete({ roster: all, event: ev });
    let given = drop;
    if (placeRank(drop, ev.capacity) > placeRank(keep, ev.capacity)) {
      // The two rows trade players; through null, because one player holds one place per match (`slots_event_player_idx`).
      await tx.update(slots).set({ playerId: null }).where(eq(slots.id, keep.id));
      await tx.update(slots).set({ playerId: keepId }).where(eq(slots.id, drop.id));
      await tx.update(slots).set({ playerId: dropId }).where(eq(slots.id, keep.id));
      given = { ...keep, playerId: dropId };
    }
    const promotion = await vacateAndPromote(tx, ev, given);
    const status = await recomputeStatus(tx, ev);
    return { event: { ...ev, status }, promotion, wasComplete: before };
  });
}

export type ThatsMeResult = { ok: true; player: Player; folded: boolean; seats: SeatChange | null; via?: "unreached" } | { ok: false; reason: ThatsMeRefusal | "not_found" };

/** A record that gained a way to be reached or proved since the rule read it: asked just before a sign-in by name writes (`commitThatsMe`, `takeHeldLink`). */
export const reachedSince = (p: Player) => Boolean(p.email || p.recoveryEmail || p.phone || p.telegramId || p.discordId || p.lineId || p.publicProfile);

/** A passkey saved since the rule read the record (the save is a tap away on the same page): one lookup down `passkeys_player_idx`. */
export async function savedPasskey(db: Db, playerId: string): Promise<boolean> {
  const [row] = await db.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.playerId, playerId)).limit(1);
  return Boolean(row);
}

/**
 * A tap that passed the rule, before anything is changed: the match, the record named, and whether the
 * browser's own record folds into it. `via: "unreached"`: the record is a past partner on the
 * organiser's unreached list, not a record of this match or its crew (D6).
 */
export type ThatsMeDecision = { ok: true; event: { id: string; code: string }; id: string; fold: boolean; via?: "unreached" };

/** The record of the organiser's unreached list that a typed name names (`unreachedNamed` in src/lib/domain/unreached.ts), asked only when nothing in this match or its crew carries the name. */
export type UnreachedLookup = (name: string) => Promise<{ id: string; name: string } | null>;

/** The read `unreachedVerdict` makes for a record of the list: the record's own name, the record in context (`extra`), no browser. */
const listedProbe = (u: { id: string; name: string }): ThatsMeProbe => ({ name: u.name, extra: u.id });

/** The verdict for a record of the list, over the rows of `listedProbe`: the verdict every tap gets, and a namesake when it names another record. Pure. */
function listedVerdict(rows: readonly ThatsMeRow[], u: { id: string }): ThatsMeVerdict {
  const v = thatsMeVerdict(rows, null);
  return v.ok && v.id !== u.id ? { ok: false, reason: "namesake" } : v;
}

/** The tap's first step, over the rows of the typed name for a browser that knows nobody: true when nobody in this match or its crew carries it, the one case where the tap reads the list. Pure. */
function typedFindsNobody(rows: readonly ThatsMeRow[]): boolean {
  const first = thatsMeVerdict(rows, null);
  return !first.ok && first.reason === "nobody";
}

/**
 * Whether "That's me" signs in this past partner on the organiser's unreached list (D6): the rows read
 * for the record's own name with the record in context (`extra`), and the one verdict every tap gets,
 * for a browser that knows nobody. One bounded read. The join's offer (`unreachedOffer`) and the tap both
 * ask it after the same first step, for the same typed name, so what the question offers is what the tap does.
 */
export async function unreachedVerdict(db: Db, m: ThatsMeMatch, u: { id: string; name: string }, now?: Date): Promise<ThatsMeVerdict> {
  return listedVerdict(await thatsMeRows(db, m, { ...listedProbe(u), now }), u);
}

/**
 * Whether the join may ask "Played before as Tim?" for this typed name and this record of the list
 * (`joinAction`, D6): the tap's own two steps, in its order, for the same typed name. First the rows of
 * the typed name in this match and its crew, as `decideThatsMe` reads them for a browser that knows
 * nobody; only when nobody there carries it does the tap read the list, so only then may the join
 * offer it. Then the list record's own verdict (`unreachedVerdict`). A crew "Tim" beside a listed "Tim
 * Smith" is the case this keeps apart: the tap would sign in crew Tim, so the join never offers Tim Smith.
 * One bounded read, and a second only when nobody in this match or its crew carries the typed name.
 */
export async function unreachedOffer(db: Db, m: ThatsMeMatch, typed: string, u: { id: string; name: string }, now?: Date): Promise<boolean> {
  if (!typedFindsNobody(await thatsMeRows(db, m, { name: typed, now }))) return false;
  return (await unreachedVerdict(db, m, u, now)).ok;
}

/**
 * Whether the organiser's line may say "Send them the link: they sign in as themselves." (D6): only when
 * it is true of everybody it names. Each partner on the line, typing the first name the line shows, gets
 * the question and the tap signs in that partner (`unreachedOffer`), so a partner "That's me" refuses (an
 * address, a passkey, an upcoming match of their own) keeps the plain "Send them the link." for the whole
 * line. A line with more names than it shows ("and 3 more") keeps it too, and so does a line with nobody
 * on it; neither costs a read.
 *
 * One statement for the whole line (rules 8 and 12), on the organiser's own view of a match with a seat
 * open: `thatsMeRowsMany` with the two reads of `unreachedOffer` for each partner, at most
 * `UNREACHED_SHOWN` partners, so at most ten reads. Each read keeps its own context, as it has in
 * `unreachedOffer`: the typed first name's read has no partner in it, and a partner's own read has only
 * that partner. Then the same two steps, partner by partner, in the line's order: the rows of the
 * second read count only when the first finds nobody, as `unreachedOffer` sends the second read only then.
 */
export async function unreachedSignsIn(db: Db, m: ThatsMeMatch, partners: readonly { id: string; name: string }[], now?: Date): Promise<boolean> {
  if (partners.length === 0 || partners.length > UNREACHED_SHOWN) return false;
  const reads = await thatsMeRowsMany(
    db,
    m,
    partners.flatMap((u) => [{ name: firstName(u.name) }, listedProbe(u)]),
    now,
  );
  return partners.every((u, i) => typedFindsNobody(reads[2 * i]) && listedVerdict(reads[2 * i + 1], u).ok);
}

/**
 * The tap's first half. Takes the rate of the address first, so a refusal costs an attempt too and
 * names cannot be tried one after another; reads the rows for that one name; decides; then takes the
 * rate of the record named (a few sign-ins a day into one record, from anywhere). Changes nothing else.
 */
export async function decideThatsMe(db: Db, input: { code: string; name: string; viewerId: string | null; rateKey: string; now?: Date; unreached?: UnreachedLookup }): Promise<ThatsMeDecision | { ok: false; reason: ThatsMeRefusal | "not_found" }> {
  if (!(await takeRate(db, "thatsme", input.rateKey, LIMITS.thatsMePerIpPerDay, "day", input.now))) return { ok: false, reason: "too_many" };
  const [ev] = await db.select({ id: events.id, groupId: events.groupId, creatorPlayerId: events.creatorPlayerId, code: events.code, status: events.status }).from(events).where(eq(events.code, input.code)).limit(1);
  // The page offers nothing on a cancelled match, and the tap does no more than the page offers.
  if (!ev || ev.status === "cancelled") return { ok: false, reason: "not_found" };
  const rows = await thatsMeRows(db, ev, { name: input.name, viewerId: input.viewerId, now: input.now });
  let verdict = thatsMeVerdict(rows, input.viewerId);
  let via: "unreached" | undefined;
  // Nobody of the name in this match or its crew, and a browser that knows nobody: a past partner on the
  // organiser's unreached list may be the one meant (D6), inside every other limit.
  if (!verdict.ok && verdict.reason === "nobody" && !input.viewerId && input.unreached) {
    const u = await input.unreached(input.name);
    if (u) {
      verdict = await unreachedVerdict(db, ev, u, input.now);
      via = "unreached";
    }
  }
  if (!verdict.ok) {
    await bumpMetric(db, "thats_me_refused").catch(() => undefined);
    return verdict;
  }
  if (!(await takeRate(db, "thatsme_record", verdict.id, LIMITS.thatsMePerRecordPerDay, "day", input.now))) return { ok: false, reason: "too_many" };
  return { ok: true, event: { id: ev.id, code: ev.code }, id: verdict.id, fold: verdict.fold, ...(via ? { via } : {}) };
}

/**
 * The tap's second half. Reads the record named again, and the browser's own record, and refuses when
 * either gained a way to be reached since the rule read them (a code that came back, a Telegram linked
 * in the same moment); settles the places in this match and folds the browser's record when it
 * decided so; records the fact (no name in it). The caller sets the cookie to the player it returns,
 * marks the session, counts the way in (`signin_thats_me`) after answering, and tells the match about
 * any place a fold gave up (`seats`).
 */
export async function commitThatsMe(db: Db, d: ThatsMeDecision, input: { viewerId: string | null; now?: Date; counter?: MergeCounter }): Promise<ThatsMeResult> {
  const [target] = await db.select().from(players).where(eq(players.id, d.id)).limit(1);
  if (!target || reachedSince(target) || (await savedPasskey(db, target.id))) return { ok: false, reason: "nobody" };
  let seats: SeatChange | null = null;
  if (d.fold && input.viewerId) {
    const [mine] = await db.select().from(players).where(eq(players.id, input.viewerId)).limit(1);
    // The last word on every pair of records, as everywhere else a merge runs (`same_name_one_address`).
    if (!mine || reachedSince(mine) || (await savedPasskey(db, mine.id)) || !safeToMerge(target, mine).ok) return { ok: false, reason: "not_same_name" };
    seats = await settleFoldSeats(db, d.event.id, target.id, mine.id);
    await mergePlayers(db, target.id, [mine.id], { door: "thats_me", counter: input.counter });
  }
  await recordFact(db, { kind: "player.thats_me", channel: "web", actorPlayerId: target.id, subject: { type: "player", id: target.id }, code: d.event.code, data: d.via ? { folded: d.fold, via: d.via } : { folded: d.fold }, at: input.now });
  const [fresh] = await db.select().from(players).where(eq(players.id, target.id)).limit(1);
  return { ok: true, player: fresh ?? target, folded: d.fold, seats, ...(d.via ? { via: d.via } : {}) };
}

/** The tap: `decideThatsMe`, then `commitThatsMe`. */
export async function thatsMe(db: Db, input: { code: string; name: string; viewerId: string | null; rateKey: string; now?: Date; counter?: MergeCounter; unreached?: UnreachedLookup }): Promise<ThatsMeResult> {
  const d = await decideThatsMe(db, input);
  return d.ok ? commitThatsMe(db, d, input) : d;
}

/** What a match page offers: the records on this line-up a browser that knows nobody may tap, or the one its own new record folds into. */
export type ThatsMeOffer = { ids: Set<string>; names: string[]; fold: { id: string; name: string } | null };
export const NO_OFFER: ThatsMeOffer = { ids: new Set(), names: [], fold: null };

/**
 * The page's side of the rule, in at most one read. A browser that knows nobody reads only the records
 * with a place in this match: every one the rule allows wears "That's me" on its row, and the open spot
 * knows those same names for the person who types theirs. Nothing about the crew's other members is
 * read for it or sent to it: a crew member not on this line-up types their name, joins, and is offered
 * the fold into their old record (below). A browser signed in as a record with nothing to prove it reads
 * only its own name, and only when that name is in the match twice or the match has a crew; anybody
 * else, and every record that can be reached, costs no read at all.
 */
export async function thatsMeOffer(db: Db, m: ThatsMeMatch, viewer: Pick<Player, "id" | "displayName" | "email" | "recoveryEmail" | "phone" | "telegramId" | "discordId" | "lineId" | "publicProfile"> | null, namesHere: readonly string[], now = new Date()): Promise<ThatsMeOffer> {
  if (!viewer) {
    const ok = claimableRows(await thatsMeRows(db, m, { now }));
    return { ids: new Set(ok.map((r) => r.id)), names: ok.map((r) => r.name), fold: null };
  }
  const bare = !viewer.email && !viewer.recoveryEmail && !viewer.phone && !viewer.telegramId && !viewer.discordId && !viewer.lineId && !viewer.publicProfile;
  const twice = namesHere.filter((n) => normalName(n) === normalName(viewer.displayName)).length >= 2;
  if (!bare || !(twice || m.groupId)) return NO_OFFER;
  const rows = await thatsMeRows(db, m, { name: viewer.displayName, viewerId: viewer.id, now });
  const v = thatsMeVerdict(rows, viewer.id);
  const target = v.ok ? rows.find((r) => r.id === v.id) : undefined;
  return target ? { ids: new Set(), names: [], fold: { id: target.id, name: target.name } } : NO_OFFER;
}
