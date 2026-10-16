import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, type Db } from "@/db";
import { events, metricsDaily, passkeys, players, type Event, type Player } from "@/db/schema";
import { thatsMeAction } from "@/actions/identity";
import { joinAction } from "@/actions/slots";
import { channelsOffered } from "@/lib/coach/reach";
import { createEvent } from "@/lib/domain/events";
import { dayKey } from "@/lib/domain/metrics";
import { getEventByCode } from "@/lib/domain/queries";
import { joinEvent } from "@/lib/domain/slots";
import { unreachedHereOf, unreachedNamed, unreachedPartners, unreachedSignInDue } from "@/lib/domain/unreached";
import { PLAYER_COOKIE, sealPlayerId } from "@/lib/session";
import { asAction } from "./helpers/action";
import { freezeClock } from "./helpers/clock";
import { DAY, HOUR, makePlayer } from "./helpers/db";

/**
 * The owner's decision of 16 October 2026 (D6, DECIDING rule 34). The question: "Tim has no email or
 * Telegram. When you send him the plain link from "Kicksmash can't reach Tim", he types "Tim" and
 * Kicksmash makes a second Tim. What should the line offer?" The owner chose "Let That's me sign him in":
 * ""That's me" accepts a name from your unreached list on the plain link. Pro: no place held. Con: widens
 * sign-in by name beyond your rule 34." (Over the recommended "Hold a place for Tim".)
 *
 * On the plain link, in a browser that knows nobody, a typed name that the organiser's unreached list
 * names (its first name or its whole name) is asked "Sign in as Tim?" before a record is made
 * (`name_unreached`), and "That's me" signs that record in, inside every other limit of rule 34. The
 * server decides; the browser never gets the list or an id. Counted as `signin_thats_me` and
 * `thats_me_unreached`.
 */
const NOW = new Date(Date.UTC(2026, 9, 16, 4, 0));
freezeClock(NOW);
const DAYS = 24 * 60;

describe("when the list may sign a name in", () => {
  const match: Pick<Event, "type" | "status" | "startsAt"> = { type: "match", status: "open", startsAt: new Date(NOW.getTime() + 2 * DAY) };
  const TABLE: [string, Partial<typeof match>, Date, boolean][] = [
    ["a match to come, full or not: the time the organiser sends the link", {}, NOW, true],
    ["a match called off", { status: "cancelled" }, NOW, false],
    ["a match the sweep marked past", { status: "past" }, NOW, false],
    ["a match that started", {}, new Date(match.startsAt.getTime() + HOUR), false],
    ["a tournament: no partners there", { type: "tournament" }, NOW, false],
  ];
  it.each(TABLE)("%s", (_why, over, now, expected) => {
    expect(unreachedSignInDue({ ...match, ...over }, now)).toBe(expected);
  });

  it("leaves out the page's own people: every record here, every name here (a held place's too), and whoever left", () => {
    const here = unreachedHereOf({
      roster: [
        { status: "joined", playerId: "a", invitedName: null, player: { displayName: "Ann" } },
        { status: "invited", playerId: null, invitedName: "Danny", player: null },
        { status: "declined", playerId: "d", invitedName: "Dora", player: { displayName: "Dora" } },
        { status: "empty", playerId: null, invitedName: null, player: null },
      ],
      waitlist: [{ status: "joined", playerId: "w", invitedName: null, player: { displayName: "Wes" } }],
      activity: [
        { verb: "left", actorPlayerId: "l", meta: null },
        { verb: "removed", actorPlayerId: "org", meta: { targetPlayerId: "r" } },
        { verb: "joined", actorPlayerId: "j", meta: null },
      ],
    });
    expect([...here.ids].sort()).toEqual(["a", "d", "w"]);
    expect(here.names).toEqual(["Ann", "Danny", "Wes"]);
    expect([...here.gone].sort()).toEqual(["l", "r"]);
  });
});

describe("\"That's me\" for a name on the organiser's unreached list", () => {
  let db: Db;
  beforeAll(async () => {
    db = await getDb();
  });
  beforeEach(() => {
    // Mail runs, so an address with activity mail off is one the offer cannot reach: on the list, and refused by "That's me".
    process.env.RESEND_API_KEY = "re_test_only";
  });
  const metric = async (key: string) => Number((await db.select().from(metricsDaily).where(and(eq(metricsDaily.day, dayKey(NOW)), eq(metricsDaily.key, key))))[0]?.value ?? 0);
  const named = async (name: string) => (await db.select({ id: players.id }).from(players).where(eq(players.displayName, name))).length;

  let n = 0;
  /**
   * Rosa's match ten days ago with her partners (each made for this test alone), over now; then her next
   * match, Rosa and Bo in it, a seat open. The partners are on her unreached list unless a channel reaches them.
   */
  const rosaWith = async (partners: Player[]) => {
    const rosa = await makePlayer(db, `Rosa ${++n}`, { email: `rosa-${n}@example.com` });
    const past = await createEvent(db, { creatorPlayerId: rosa.id, type: "match", startsAt: new Date(NOW.getTime() + DAY), tz: "Asia/Bangkok", whenFull: "waitlist", venueName: "Warehaus" });
    for (const p of [rosa, ...partners]) await joinEvent(db, { eventId: past.id, playerId: p.id, now: NOW });
    await db.update(events).set({ startsAt: new Date(NOW.getTime() - 10 * DAYS * 60_000), status: "past" }).where(eq(events.id, past.id));
    const bo = await makePlayer(db, `Bo ${n}`);
    const ev = await createEvent(db, { creatorPlayerId: rosa.id, type: "match", startsAt: new Date(NOW.getTime() + 6 * HOUR), tz: "Asia/Bangkok", whenFull: "waitlist", venueName: "Warehaus" });
    for (const p of [rosa, bo]) await joinEvent(db, { eventId: ev.id, playerId: p.id, now: NOW });
    return { rosa, ev };
  };
  const listOf = async (ev: { code: string }) => {
    const detail = (await getEventByCode(db, ev.code))!;
    return unreachedPartners(db, detail.event, unreachedHereOf(detail), channelsOffered(), NOW);
  };

  it("a stranger's browser typing an unreached partner's first name is asked first, and \"That's me\" signs it in as that record: one record remains", async () => {
    const tomasz = await makePlayer(db, "Tomasz Unreached");
    const { ev } = await rosaWith([tomasz]);
    expect(await listOf(ev)).toEqual(["Tomasz"]);
    const asked = await metric("join_name_unreached");
    const join = await asAction({}, () => joinAction(ev.code, " tomasz "));
    // The question names the first name as the record writes it, and nothing more.
    expect(join.result).toEqual({ ok: false, error: "name_unreached", detail: "Tomasz" });
    expect(join.cookies[PLAYER_COOKIE], "no record was made for the browser").toBeUndefined();
    expect(await named("Tomasz Unreached")).toBe(1);
    expect(await metric("join_name_unreached")).toBe(asked + 1);
    // The yes: the existing two taps of "That's me", with the name as typed. The server finds the record again.
    const [signins, viaList] = [await metric("signin_thats_me"), await metric("thats_me_unreached")];
    const signed = await asAction({}, () => thatsMeAction(ev.code, "Tomasz"));
    expect(signed.result).toMatchObject({ ok: true, data: { name: "Tomasz Unreached", folded: false } });
    expect(signed.cookies[PLAYER_COOKIE]).toBe(sealPlayerId(tomasz.id, { byName: true }));
    expect(await named("Tomasz Unreached")).toBe(1);
    expect([await metric("signin_thats_me"), await metric("thats_me_unreached")]).toEqual([signins + 1, viaList + 1]);
    // The browser was told nothing but the offer: the refusal names no record, no id.
    expect(JSON.stringify(join.result)).not.toContain(tomasz.id);
  });

  it("\"I'm a different Tim\" passes the question: the flag is the only thing that lets the typed name past it", async () => {
    const tim = await makePlayer(db, "Tim Different");
    const { ev } = await rosaWith([tim]);
    expect((await asAction({}, () => joinAction(ev.code, "Tim"))).result).toMatchObject({ ok: false, error: "name_unreached" });
    // The record itself is made in the browser (see "a name not on the list" below): here, the question is passed.
    const { result } = await asAction({}, () => joinAction(ev.code, "Tim", undefined, undefined, { differentPerson: true }));
    expect(result).not.toMatchObject({ error: "name_unreached" });
  });

  it("the whole name finds the record too", async () => {
    const ugo = await makePlayer(db, "Ugo Whole");
    const { ev } = await rosaWith([ugo]);
    expect((await asAction({}, () => joinAction(ev.code, "ugo whole"))).result).toEqual({ ok: false, error: "name_unreached", detail: "Ugo" });
  });

  it("a name not on the list gets no offer: the join goes on to make a record as before, and \"That's me\" signs nobody in", async () => {
    const vic = await makePlayer(db, "Vic Listed");
    const { ev } = await rosaWith([vic]);
    const join = (await asAction({}, () => joinAction(ev.code, "Zed Nobody"))).result;
    // A new record takes the request's language, which next-intl gives only inside a page (tests/name-seated.test.ts):
    // the action stops at that step here, past every question. The record itself is made in the browser suite.
    expect(join).not.toMatchObject({ error: "name_unreached" });
    expect(join).not.toMatchObject({ error: "name_seated" });
    expect((await asAction({}, () => thatsMeAction(ev.code, "Zed Nobody"))).result).toEqual({ ok: false, error: "invalid" });
  });

  it("a record with an email on the list is refused \"That's me\", and the join does not ask (the D4 doors are for seated records)", async () => {
    const ula = await makePlayer(db, "Ula Mailed", { email: "ula-unreached@example.com", emailNotifications: false });
    const { ev } = await rosaWith([ula]);
    expect(await listOf(ev)).toEqual(["Ula"]);
    expect((await asAction({}, () => joinAction(ev.code, "Ula"))).result).not.toMatchObject({ error: "name_unreached" });
    const refused = await metric("thats_me_refused");
    expect((await asAction({}, () => thatsMeAction(ev.code, "Ula"))).result).toEqual({ ok: false, error: "invalid" });
    expect(await metric("thats_me_refused")).toBe(refused + 1);
    // The reason, as the rule gives it.
    const detail = (await getEventByCode(db, ev.code))!;
    expect(await unreachedNamed(db, detail, "Ula", channelsOffered(), NOW)).toMatchObject({ id: ula.id });
  });

  it("every other limit of rule 34 holds: a passkey, an upcoming match of its own", async () => {
    const pia = await makePlayer(db, "Pia Keyed");
    await db.insert(passkeys).values({ id: `cred-unreached-${pia.id}`, playerId: pia.id, publicKey: "pk", deviceType: "multiDevice" });
    const ola = await makePlayer(db, "Ola Organises");
    const { ev } = await rosaWith([pia, ola]);
    await createEvent(db, { creatorPlayerId: ola.id, type: "match", startsAt: new Date(NOW.getTime() + 3 * DAY), tz: "Asia/Bangkok", whenFull: "waitlist", venueName: "Warehaus" });
    expect((await listOf(ev)).sort()).toEqual(["Ola", "Pia"]);
    for (const name of ["Pia", "Ola"]) {
      expect((await asAction({}, () => joinAction(ev.code, name))).result, name).not.toMatchObject({ error: "name_unreached" });
      expect((await asAction({}, () => thatsMeAction(ev.code, name))).result, name).toEqual({ ok: false, error: "invalid" });
    }
  });

  it("a browser that knows a record joins as that record and is never asked", async () => {
    const tim = await makePlayer(db, "Timo Known");
    const { ev } = await rosaWith([tim]);
    const eve = await makePlayer(db, "Eve Known");
    expect((await asAction({ [PLAYER_COOKIE]: sealPlayerId(eve.id) }, () => joinAction(ev.code, "Timo"))).result).toMatchObject({ ok: true, data: { outcome: "joined" } });
  });

  it("once the match has started, the list signs nobody in", async () => {
    const wim = await makePlayer(db, "Wim Late");
    const { ev } = await rosaWith([wim]);
    await db.update(events).set({ startsAt: new Date(NOW.getTime() - 10 * 60_000) }).where(eq(events.code, ev.code));
    expect((await asAction({}, () => thatsMeAction(ev.code, "Wim"))).result).toEqual({ ok: false, error: "invalid" });
  });
});
