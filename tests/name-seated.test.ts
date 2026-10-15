import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { joinAction } from "@/actions/slots";
import { thatsMeAction } from "@/actions/identity";
import { metricsDaily, players, slots, type Player, type Slot } from "@/db/schema";
import { fail } from "@/lib/api/http";
import { handleMcpPost } from "@/lib/api/mcp";
import { joinMatch, NameSeatedError, NO_SIDE_EFFECTS } from "@/lib/api/operations";
import { createEvent } from "@/lib/domain/events";
import { seatedNamed, whoJoins } from "@/lib/domain/heldByName";
import { getOrCreatePersonalToken } from "@/lib/domain/identity";
import { dayKey } from "@/lib/domain/metrics";
import { getEventByCode } from "@/lib/domain/queries";
import { joinEvent } from "@/lib/domain/slots";
import { PLAYER_COOKIE, sealPlayerId } from "@/lib/session";
import { asAction } from "./helpers/action";
import { freezeClock } from "./helpers/clock";
import { createTestDb, DAY, makePlayer } from "./helpers/db";

/**
 * The owner's decision of 15 October 2026 (D2, DECIDING rule 34). The question: "A returning player opens
 * a match in a browser that does not know them and types their own name, but they are already in the
 * match. What should happen?" The answer: "Ask first (Recommended)": ""Danny is in this match. Sign in as
 * Danny?" in two taps, as a held place does. A record with an email or a passkey gets its own sign-in."
 *
 * Until now the plain join made a second Danny, which hid the real Danny's "That's me" (rule 34 never
 * signs in one of two records of a name) and, in a walk, locked that browser out after "Leave waitlist".
 * The web's join and `join_match` without a token now refuse that name (`name_seated`) before any record
 * is made; only "I'm a different Danny" (`differentPerson`) joins it as typed. A chat's join carries the
 * platform's identity and never asks.
 */

// A fixed clock (rule 11): every match starts days after NOW.
const NOW = new Date(Date.UTC(2026, 9, 15, 4, 0));
const at = (days: number) => new Date(NOW.getTime() + days * DAY);
freezeClock(NOW);

// ------------------------------------------------------------------ the rule, as a table

type SlotStatus = Slot["status"];
type Seat = { status: SlotStatus; playerId: string | null; player: { displayName: string } | null };
const seat = (name: string, status: SlotStatus = "joined"): Seat => ({ status, playerId: `p-${name}`, player: { displayName: name } });
const SEATS: Seat[] = [seat("Erik"), seat("Danny"), { status: "empty", playerId: null, player: null }];

/** Each line changes one thing from the owner's case, so the change named is the only thing that decides. */
const TABLE: [string, { seats?: Seat[]; known?: { id: string } | null; typed?: string | null; different?: boolean }, string | null][] = [
  ["the owner's case: a seated Danny, \"danny\" typed in a browser that knows nobody", { typed: " danny " }, "Danny"],
  ["the same name in capitals and with spaces inside", { typed: "DANNY" }, "Danny"],
  ["a Danny confirmed by his personal link", { seats: [seat("Erik"), seat("Danny", "confirmed")], typed: "Danny" }, "Danny"],
  ["a Danny on the waiting list (a waiting place is a place)", { seats: [seat("Erik"), seat("Bo"), seat("Danny")], typed: "Danny" }, "Danny"],
  ["the organiser's own name, seated", { typed: "erik" }, "Erik"],
  ["\"I'm a different Danny\"", { typed: "Danny", different: true }, null],
  ["a browser that knows a record: it joins as that record, never as the typed name", { typed: "Danny", known: { id: "v1" } }, null],
  ["another name", { typed: "Dan" }, null],
  ["a name of one letter", { seats: [seat("D")], typed: "d" }, null],
  ["no name at all", { typed: null }, null],
  ["a place held for Danny by name, which nobody took (the held-place rule's own case)", { seats: [seat("Erik"), { status: "invited", playerId: null, player: null }], typed: "Danny" }, null],
  ["a place held for Danny's record, not taken yet (the held-record rule's own case)", { seats: [seat("Erik"), { status: "invited", playerId: "p-Danny", player: { displayName: "Danny" } }], typed: "Danny" }, null],
  ["a Danny who declined", { seats: [seat("Erik"), { status: "declined", playerId: "p-Danny", player: { displayName: "Danny" } }], typed: "Danny" }, null],
];

describe("who a typed name meets: \"Sign in as Danny?\" before a second Danny", () => {
  it.each(TABLE)("%s", (_why, c, expected) => {
    expect(seatedNamed(c.seats ?? SEATS, c.known ?? null, c.typed === undefined ? "Danny" : c.typed, c.different)).toBe(expected);
  });
});

// ------------------------------------------------------------------ on a real match

describe("the web's plain join and join_match, before any record is made", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  let n = 0;
  /** Erik's match with Erik and Danny seated, Danny with nothing to prove him (`record` adds what he has). */
  const match = async (record: Partial<typeof players.$inferInsert> = {}, d: Db = db) => {
    const erik = await makePlayer(d, `Erik ${++n}`, { email: `erik-seated${n}@example.com` });
    const danny = await makePlayer(d, "Danny", record);
    const ev = await createEvent(d, { creatorPlayerId: erik.id, type: "match", startsAt: at(2), tz: "Asia/Bangkok", whenFull: "waitlist", venueName: "Warehaus" });
    for (const p of [erik, danny]) await joinEvent(d, { eventId: ev.id, playerId: p.id, now: NOW });
    return { erik, danny, ev };
  };
  const dannysIn = async (d: Db, eventId: string) =>
    (await d.select({ id: players.id }).from(slots).innerJoin(players, eq(players.id, slots.playerId)).where(and(eq(slots.eventId, eventId), eq(players.displayName, "Danny")))).length;

  it("whoJoins answers { seated } and makes nothing; \"I'm a different Danny\" makes the record", async () => {
    const { ev } = await match();
    const detail = (await getEventByCode(db, ev.code))!;
    let made = 0;
    const make = async () => {
      made += 1;
      return makePlayer(db, "Danny");
    };
    expect(await whoJoins(detail, null, " danny ", NOW, make)).toEqual({ seated: "Danny" });
    expect(made).toBe(0);
    const different = await whoJoins(detail, null, "Danny", NOW, make, { different: true });
    expect("player" in different && different.player.displayName).toBe("Danny");
    expect(made).toBe(1);
  });

  describe("the API and MCP (join_match)", () => {
    it("refuses a typed Danny with 409 name_seated and writes nothing; a fuller name and Danny's own token join", async () => {
      const { danny, ev } = await match();
      const everybody = async () => (await db.select({ id: players.id }).from(players)).length;
      const before = await everybody();
      const err = await joinMatch(db, { code: ev.code, name: " danny " }, NO_SIDE_EFFECTS).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NameSeatedError);
      expect(err).toMatchObject({ status: 409, code: "name_seated", seated: "Danny" });
      expect((err as NameSeatedError).hint).toContain("personal token");
      expect((err as NameSeatedError).hint).toContain("last name");
      expect(await everybody()).toBe(before);
      expect(await dannysIn(db, ev.id)).toBe(1);
      // The same call with any other name joins, so the refusal above is the only thing that kept Danny out.
      expect((await joinMatch(db, { code: ev.code, name: "Danny K" }, NO_SIDE_EFFECTS)).outcome).toBe("joined");
      // A token is the record's own proof: never asked.
      const token = await getOrCreatePersonalToken(db, danny.id);
      expect((await joinMatch(db, { code: ev.code, token }, NO_SIDE_EFFECTS)).outcome).toBe("already_in");
    });

    it("says it as an HTTP body and as an MCP tool error an assistant can act on", async () => {
      const { ev } = await match();
      const res = fail(new NameSeatedError("Danny"));
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string; message: string; hint: string } };
      expect(body.error.code).toBe("name_seated");
      expect(body.error.message).toContain("Danny is in this match already");
      const r = await handleMcpPost(db, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "join_match", arguments: { code: ev.code, name: "Danny" } } }, NO_SIDE_EFFECTS);
      const result = (r.body as { result: { isError: boolean; content: { text: string }[] } }).result;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Danny is in this match already");
      expect(await dannysIn(db, ev.id)).toBe(1);
    });
  });

  // The actions run against the app's own database, as a browser reaches them.
  describe("the web's join, called as a browser calls it", () => {
    let app: Db;
    beforeAll(async () => {
      app = await getDb();
    });
    const as = (p: Player): Record<string, string> => ({ [PLAYER_COOKIE]: sealPlayerId(p.id) });
    const metric = async (key: string) => Number((await app.select().from(metricsDaily).where(and(eq(metricsDaily.day, dayKey(NOW)), eq(metricsDaily.key, key))))[0]?.value ?? 0);

    it("the owner's case: a fresh browser types \"danny\" and taps Join: refused before any record, then two taps of \"That's me\" sign it in as Danny, and there is one Danny", async () => {
      const { danny, ev } = await match({}, app);
      const asked = await metric("join_name_seated");
      const everybody = async () => (await app.select({ id: players.id }).from(players)).length;
      const before = await everybody();
      const { result, cookies } = await asAction({}, () => joinAction(ev.code, " danny "));
      expect(result).toEqual({ ok: false, error: "name_seated" });
      expect(cookies[PLAYER_COOKIE], "no record was made for the browser").toBeUndefined();
      expect(await everybody()).toBe(before);
      expect(await metric("join_name_seated")).toBe(asked + 1);
      // The yes: the existing "That's me", which the page offers for this record (nothing proves it).
      const signed = await asAction({}, () => thatsMeAction(ev.code, "Danny"));
      expect(signed.result).toMatchObject({ ok: true, data: { name: "Danny", folded: false } });
      expect(signed.cookies[PLAYER_COOKIE]).toBe(sealPlayerId(danny.id, { byName: true }));
      expect(await dannysIn(app, ev.id)).toBe(1);
    });

    it("a seated record with an email is refused the same way (its page shows the email and passkey doors), and so is a name on the waiting list", async () => {
      const { ev } = await match({ email: "danny-seated@example.com" }, app);
      expect((await asAction({}, () => joinAction(ev.code, "Danny"))).result).toEqual({ ok: false, error: "name_seated" });
      // Fill the match, then Bo waits; a fresh browser typing "bo" is asked before it waits beside him.
      for (const name of ["Cy", "Di", "Bo"]) await joinEvent(app, { eventId: ev.id, playerId: (await makePlayer(app, name)).id, now: NOW });
      const detail = (await getEventByCode(app, ev.code))!;
      expect(detail.waitlist.map((s) => s.player?.displayName)).toContain("Bo");
      expect((await asAction({}, () => joinAction(ev.code, "bo"))).result).toEqual({ ok: false, error: "name_seated" });
    });

    // A new record takes the request's language (`requirePlayer` reads `getLocale`), which next-intl gives
    // only inside a page Next.js renders, so an action called here stops at that step with "generic". The
    // flag's whole job ends before it: the refusal is passed and the tap is counted. The join itself, a
    // second Danny with his own cookie, is proven in the browser (`e2e/player-states.mjs`).
    it("\"I'm a different Danny\" passes the question: the flag is the only thing that lets the typed name past it, and the tap is counted", async () => {
      const { ev } = await match({}, app);
      const different = await metric("join_name_different");
      expect((await asAction({}, () => joinAction(ev.code, "Danny"))).result).toEqual({ ok: false, error: "name_seated" });
      expect(await metric("join_name_different")).toBe(different);
      const { result } = await asAction({}, () => joinAction(ev.code, "Danny", undefined, undefined, { differentPerson: true }));
      expect(result).not.toMatchObject({ error: "name_seated" });
      expect(await metric("join_name_different")).toBe(different + 1);
    });

    it("a browser that knows a record joins as that record, whatever name it types, and is never asked", async () => {
      const { ev } = await match({}, app);
      const eve = await makePlayer(app, "Eve");
      expect((await asAction(as(eve), () => joinAction(ev.code, "Danny"))).result).toMatchObject({ ok: true, data: { outcome: "joined" } });
      expect(await dannysIn(app, ev.id)).toBe(1);
    });
  });
});
