import { eq } from "drizzle-orm";
import type { Logger } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { events, groupMembers, groups, passkeys, players, pushSubscriptions, slots } from "@/db/schema";
import { createEvent } from "@/lib/domain/events";
import { joinEvent } from "@/lib/domain/slots";
import { THATS_ME_ROWS, thatsMeRows, thatsMeRowsMany, unreachedOffer, unreachedSignsIn, type ThatsMeMatch, type ThatsMeProbe } from "@/lib/domain/thatsMe";
import { firstName, UNREACHED_SHOWN } from "@/lib/domain/unreached";
import { freezeClock } from "./helpers/clock";
import { createTestDb, DAY, HOUR, makePlayer } from "./helpers/db";

/**
 * The organiser's line, "Send them the link: they sign in as themselves." (D6, `unreachedSignsIn`), asks
 * two "That's me" reads for each partner it names, at most five partners. Until 17 October 2026 it sent
 * them one after another, up to ten statements on the organiser's own match page. Now it sends one
 * statement (`thatsMeRowsMany`), and the answer must be the one the reads one by one gave, for every line.
 *
 * The answer of the old way is still in the code: `unreachedOffer` for each partner in the line's order,
 * which reads one statement at a time. Each fixture below asks both and wants the same answer. The
 * statements are counted where drizzle sends them (the session's logger), so a read that went back to
 * one statement for each partner shows up here, whatever function sends it.
 *
 * On PGlite, and on a real Postgres when TEST_DATABASE_URL is set (`createTestDb`).
 */
const NOW = new Date(Date.UTC(2026, 9, 17, 4, 0));
freezeClock(NOW);

type Partner = { id: string; name: string };

describe("the organiser's line asks \"That's me\" for every partner in one statement", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  /** Every statement drizzle sends while `fn` runs, with its parameters: the session's own logger, for the length of `fn`. */
  const counted = async <T>(fn: () => Promise<T>): Promise<{ value: T; statements: { sql: string; params: unknown[] }[] }> => {
    const session = (db as unknown as { session: { logger: Logger } }).session;
    const before = session.logger;
    const statements: { sql: string; params: unknown[] }[] = [];
    session.logger = { logQuery: (q, params) => void statements.push({ sql: q, params }) };
    try {
      return { value: await fn(), statements };
    } finally {
      session.logger = before;
    }
  };

  /** The answer of the reads one by one: each partner in the line's order, with the first name the line shows. */
  const oneByOne = async (m: ThatsMeMatch, partners: readonly Partner[]): Promise<boolean> => {
    if (partners.length === 0 || partners.length > UNREACHED_SHOWN) return false;
    for (const u of partners) if (!(await unreachedOffer(db, m, firstName(u.name), u, NOW))) return false;
    return true;
  };

  let n = 0;
  /** A match to come with its organiser (an address, so never a record "That's me" signs in) and a bare "Bo" seated; a crew when asked. */
  const matchOf = async (o: { organiser?: string; crew?: boolean } = {}) => {
    const org = await makePlayer(db, o.organiser ?? `Rosa ${++n}`, { email: `org-${++n}@example.com` });
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() + 6 * HOUR), tz: "Asia/Bangkok", whenFull: "waitlist", venueName: "Warehaus" });
    const bo = await makePlayer(db, `Bo ${++n}`);
    for (const p of [org, bo]) await joinEvent(db, { eventId: ev.id, playerId: p.id, now: NOW });
    let groupId: string | null = null;
    if (o.crew) {
      const [g] = await db.insert(groups).values({ code: `U${String(++n).padStart(5, "0")}`, name: `Crew ${n}`, creatorPlayerId: org.id, tz: "Asia/Bangkok" }).returning();
      await db.update(events).set({ groupId: g.id }).where(eq(events.id, ev.id));
      groupId = g.id;
    }
    const m: ThatsMeMatch = { id: ev.id, groupId, creatorPlayerId: org.id };
    return { m, org, ev };
  };
  const seat = async (eventId: string, name: string) => {
    const p = await makePlayer(db, name);
    await joinEvent(db, { eventId, playerId: p.id, now: NOW });
    return p;
  };
  const member = async (groupId: string | null, name: string) => {
    const p = await makePlayer(db, name);
    await db.insert(groupMembers).values({ groupId: groupId!, playerId: p.id, role: "member" });
    return p;
  };
  /** A past partner with nothing to prove them, as `unreachedRecords` gives one: an id and the whole name. */
  const partner = async (name: string, extra: Parameters<typeof makePlayer>[2] = {}): Promise<Partner> => {
    const p = await makePlayer(db, name, extra);
    return { id: p.id, name: p.displayName };
  };

  /** Each fixture builds its own match and line, and says the answer it expects. */
  const CASES: [string, () => Promise<{ m: ThatsMeMatch; partners: Partner[] }>, boolean][] = [
    [
      "every partner signs in: a first and last name, and a name of one word",
      async () => ({ m: (await matchOf()).m, partners: [await partner("Tomasz Vale"), await partner("Ugo Whole"), await partner("Yan")] }),
      true,
    ],
    ["one partner has an address", async () => ({ m: (await matchOf()).m, partners: [await partner("Ada Fine"), await partner("Ula Mailed", { email: `ula-${++n}@example.com` })] }), false],
    [
      "one partner has a passkey",
      async () => {
        const pia = await partner("Pia Keyed");
        await db.insert(passkeys).values({ id: `cred-one-read-${pia.id}`, playerId: pia.id, publicKey: "pk", deviceType: "multiDevice" });
        return { m: (await matchOf()).m, partners: [await partner("Ada Fine"), pia] };
      },
      false,
    ],
    [
      "one partner has push",
      async () => {
        const pu = await partner("Pu Pushed");
        await db.insert(pushSubscriptions).values({ playerId: pu.id, endpoint: `https://push.example/${pu.id}`, p256dh: "k", auth: "a" });
        return { m: (await matchOf()).m, partners: [pu, await partner("Ada Fine")] };
      },
      false,
    ],
    [
      "one partner organises a match of their own still to come",
      async () => {
        const ola = await partner("Ola Organises");
        await createEvent(db, { creatorPlayerId: ola.id, type: "match", startsAt: new Date(NOW.getTime() + 3 * DAY), tz: "Asia/Bangkok", whenFull: "waitlist", venueName: "Warehaus" });
        return { m: (await matchOf()).m, partners: [await partner("Ada Fine"), ola] };
      },
      false,
    ],
    [
      "a seated record carries a partner's first name (other case, a zero-width space inside): the tap signs that record in",
      async () => {
        const { m, ev } = await matchOf();
        await seat(ev.id, "ti​M");
        return { m, partners: [await partner("Ada Fine"), await partner("Tim Smith")] };
      },
      false,
    ],
    [
      "a crew member carries a partner's first name",
      async () => {
        const { m } = await matchOf({ crew: true });
        await member(m.groupId, "Tim");
        return { m, partners: [await partner("Tim Smith"), await partner("Ada Fine")] };
      },
      false,
    ],
    [
      "the first name the line shows is the organiser's",
      async () => ({ m: (await matchOf({ organiser: "Rosa" })).m, partners: [await partner("Rosa Lind")] }),
      false,
    ],
    [
      "a partner's whole name is another partner's first name: each first name's read has no partner in it",
      async () => ({ m: (await matchOf()).m, partners: [await partner("Tim"), await partner("Tim Smith")] }),
      true,
    ],
    [
      "the same two, the other way round",
      async () => ({ m: (await matchOf()).m, partners: [await partner("Tim Smith"), await partner("Tim")] }),
      true,
    ],
    [
      "two partners of one whole name: each partner's own read has that partner alone",
      async () => ({ m: (await matchOf()).m, partners: [await partner("Kit Same"), await partner("Kit Same")] }),
      true,
    ],
    [
      "a seated namesake of a partner's whole name",
      async () => {
        const { m, ev } = await matchOf();
        await seat(ev.id, "Tim Smith");
        return { m, partners: [await partner("Ada Fine"), await partner("Tim Smith")] };
      },
      false,
    ],
    [
      "a crew namesake of a partner's whole name",
      async () => {
        const { m } = await matchOf({ crew: true });
        await member(m.groupId, "tim  smith");
        return { m, partners: [await partner("Tim Smith")] };
      },
      false,
    ],
    [
      "a partner who refuses comes first, a partner who signs in after",
      async () => ({ m: (await matchOf()).m, partners: [await partner("Ula Mailed", { email: `ula-${++n}@example.com` }), await partner("Ada Fine")] }),
      false,
    ],
    [
      "a partner who holds a seat here too",
      async () => {
        const { m, ev } = await matchOf();
        const kim = await seat(ev.id, "Kim Seated");
        return { m, partners: [{ id: kim.id, name: kim.displayName }, await partner("Ada Fine")] };
      },
      true,
    ],
    [
      "a partner whose name is blank: the first name's read is the read with no name",
      async () => ({ m: (await matchOf()).m, partners: [await partner("Ada Fine"), await partner("   ")] }),
      false,
    ],
    [
      "five partners who all sign in",
      async () => ({ m: (await matchOf()).m, partners: [await partner("Ana Five"), await partner("Ben Five"), await partner("Cy Five"), await partner("Di Five"), await partner("Ed Five")] }),
      true,
    ],
    ["nobody on the line", async () => ({ m: (await matchOf()).m, partners: [] }), false],
    [
      "more partners than the line shows, every one of whom would sign in",
      async () => ({ m: (await matchOf()).m, partners: [await partner("Ana Six"), await partner("Ben Six"), await partner("Cy Six"), await partner("Di Six"), await partner("Ed Six"), await partner("Flo Six")] }),
      false,
    ],
  ];

  it.each(CASES)("%s", async (_why, build, expected) => {
    const { m, partners } = await build();
    const before = await oneByOne(m, partners);
    const { value: now, statements } = await counted(() => unreachedSignsIn(db, m, partners, NOW));
    expect(before, "the reads one by one").toBe(expected);
    expect(now, "the one statement").toBe(before);
    expect(statements.length).toBe(partners.length === 0 || partners.length > UNREACHED_SHOWN ? 0 : 1);
  });

  it("one statement for one, four and five partners, and none for nobody or for six; the statement holds two reads for each partner", async () => {
    const { m } = await matchOf();
    const six: Partner[] = [];
    for (const name of ["Gil Count", "Hal Count", "Ivy Count", "Jo Count", "Kai Count", "Lu Count"]) six.push(await partner(name));
    // One read alone, for the number of parameters a read binds.
    const single = await counted(() => thatsMeRows(db, m, { name: "Gil", now: NOW }));
    expect(single.statements).toHaveLength(1);
    const perRead = single.statements[0].params.length;
    for (const k of [1, 4, 5]) {
      const line = six.slice(0, k);
      const { value, statements } = await counted(() => unreachedSignsIn(db, m, line, NOW));
      expect(value, `${k} partners`).toBe(true);
      expect(statements, `${k} partners`).toHaveLength(1);
      expect(statements[0].sql.match(/\bunion all\b/g) ?? [], `${k} partners`).toHaveLength(2 * k - 1);
      // Each read binds its own parameters and its number: at most ten reads, so a few hundred at most.
      expect(statements[0].params, `${k} partners`).toHaveLength(2 * k * (perRead + 1));
    }
    for (const line of [[], six]) {
      const { value, statements } = await counted(() => unreachedSignsIn(db, m, line, NOW));
      expect(value).toBe(false);
      expect(statements).toHaveLength(0);
    }
  });

  it("each read in the one statement gives the rows its own read gives: its context, its counts, its order", async () => {
    const { m, ev, org } = await matchOf({ crew: true });
    const tim = await partner("Tim");
    const timSmith = await partner("Tim Smith");
    await seat(ev.id, "Tim Smith");
    await member(m.groupId, "Nia Crew");
    const viewer = await makePlayer(db, "Bo");
    const probes: ThatsMeProbe[] = [
      {},
      { name: "Tim" },
      { name: "Tim Smith", extra: timSmith.id },
      { name: "Tim", extra: tim.id },
      { name: "Nia Crew" },
      { viewerId: viewer.id },
      { name: "bo", viewerId: viewer.id },
      { name: firstName(org.displayName) },
    ];
    const { value: many, statements } = await counted(() => thatsMeRowsMany(db, m, probes, NOW));
    expect(statements).toHaveLength(1);
    expect(many).toHaveLength(probes.length);
    for (const [i, o] of probes.entries()) expect(many[i], JSON.stringify(o)).toEqual(await thatsMeRows(db, m, { ...o, now: NOW }));
    // The fixture is one where the reads differ, so a mix of them could not pass.
    expect(many[2].filter((r) => r.named && r.inContext).map((r) => r.sameName)).toEqual([2, 2]);
    expect(many[1].filter((r) => r.named)).toEqual([]);
    expect(many[3].filter((r) => r.named).map((r) => r.id)).toEqual([tim.id]);
    // No read, no statement.
    const none = await counted(() => thatsMeRowsMany(db, m, [], NOW));
    expect([none.value, none.statements.length]).toEqual([[], 0]);
  });

  /**
   * The limit is each read's own (`THATS_ME_ROWS`), not one limit on the whole statement. A field one
   * larger than a read returns fills two reads, and a third read comes after them. A limit on the whole
   * statement loses the second and third reads; a read with no limit returns the whole field.
   */
  it("each read in the one statement keeps its own limit: two full reads come back whole, and the read after them too", async () => {
    const { m } = await matchOf();
    // Each record of the field gets its own created_at, years before the database's clock, so the limit cuts the same records in every read.
    const FIELD_FROM = Date.UTC(2020, 0, 1);
    const field = await db
      .insert(players)
      .values(Array.from({ length: THATS_ME_ROWS + 1 }, (_, k) => ({ displayName: `Field ${k}`, locale: "en", createdAt: new Date(FIELD_FROM + k * 1000) })))
      .returning({ id: players.id });
    // Positions from 100 up, clear of the match's own positions (1 to its capacity).
    await db.insert(slots).values(field.map((p, k) => ({ eventId: m.id, playerId: p.id, status: "joined" as const, position: 100 + k })));
    const pat = await partner("Pat Over");
    const probes: ThatsMeProbe[] = [{}, {}, { name: pat.name, extra: pat.id }];
    const { value: many, statements } = await counted(() => thatsMeRowsMany(db, m, probes, NOW));
    expect(statements).toHaveLength(1);
    expect(many).toHaveLength(probes.length);
    // The read alone stops at its limit: the first THATS_ME_ROWS records of the field. The last record of the field, the organiser and Bo are left out.
    const whole = await thatsMeRows(db, m, { now: NOW });
    expect(whole.map((r) => r.id)).toEqual(field.slice(0, THATS_ME_ROWS).map((p) => p.id));
    for (const i of [0, 1]) {
      expect(many[i], `read ${i}`).toHaveLength(THATS_ME_ROWS);
      expect(many[i], `read ${i}`).toEqual(whole);
    }
    expect(many[2].map((r) => r.id)).toEqual([pat.id]);
    expect(many[2]).toEqual(await thatsMeRows(db, m, { ...probes[2], now: NOW }));
  });
});
