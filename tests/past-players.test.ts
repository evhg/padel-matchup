import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { createElement } from "react";
import { getDb, type Db } from "@/db";
import { createEventAction, pastPlayersAction } from "@/actions/events";
import { attachHeldRecordAction, reserveAction, reserveManyAction, reservePickedAction } from "@/actions/slots";
import { events, metricsDaily, players, slots, type Player } from "@/db/schema";
import { createEvent } from "@/lib/domain/events";
import { PAST_PLAYERS_SHOWN, pastPlayerRows, pastViews, recordForAnswer, type PastPlayer } from "@/lib/domain/heldRecord";
import { dayKey } from "@/lib/domain/metrics";
import { askFor, cleanPickedNames, namesTyped, PICK_CHIPS, PICKED_MAX, togglePick, type PastView } from "@/lib/domain/pastAsk";
import { joinEvent } from "@/lib/domain/slots";
import { PLAYER_COOKIE, sealPlayerId } from "@/lib/session";
import { PastAsk } from "@/components/PastAsk";
import { asAction } from "./helpers/action";
import { freezeClock } from "./helpers/clock";
import { DAY, makePlayer } from "./helpers/db";
import { renderIn } from "./helpers/render";

/**
 * The owner, 12 October 2026: "Has an Alberto played with Erik before? As organizer before and after
 * creating the match should be able to select from players they played with before, and if manually
 * typed and it matches a previously played person it should ask if its this person to avoid creating
 * dupes."
 *
 * So a name the organiser types (the create form, the open spot, "Paste the names") that a past player
 * carries gets a question before the place is held: "Is this Danny, who played with you on Sep 13 at
 * Kross Padel?" Yes keeps old Danny's record on the place; No holds it by name. The browser gets names,
 * days and clubs only; the server finds the record again from the answer, among the organiser's own
 * past players, and holds by name whatever it cannot find there.
 *
 * NOW is Sunday 11 October 2026, 06:00 UTC (13:00 in Bangkok). Old Danny's match R8n7 was 28 days
 * earlier: 13 September, 13:00 in Bangkok. A second Danny played on 2 October at Warehaus.
 */
const NOW = new Date(Date.UTC(2026, 9, 11, 6, 0));
const at = (days: number) => new Date(NOW.getTime() + days * DAY);
freezeClock(NOW);

// ------------------------------------------------------------------ the question, pure

const pp = (id: string, name: string, days: number, club: string | null = "Kross Padel"): PastPlayer => ({ id, name, last: at(days), club, tz: "Asia/Bangkok" });

describe("which past players a typed name asks about", () => {
  const list = [pp("d1", "Danny", -28), pp("d2", "Danny", -9, "Warehaus"), pp("a1", "Ana", -12), pp("j1", "Jakob", -5, null)];
  const views = pastViews(list, new Set());

  it("gives the browser a name, the day in the match's own zone, and the club: never an id", () => {
    expect(views).toContainEqual({ name: "Ana", day: "2026-09-29", club: "Kross Padel" });
    expect(views.find((v) => v.name === "Jakob")).toEqual({ name: "Jakob", day: "2026-10-06", club: null });
    expect(JSON.stringify(views)).not.toMatch(/"d1"|"d2"|"a1"|"j1"/);
    expect(pastViews(list, new Set(["a1"])).map((v) => v.name), "a record already in the match is not asked about").not.toContain("Ana");
  });

  it("asks about the one past player of a name, typed any way, and about each of two, latest first", () => {
    expect(askFor(views, " ana ")).toEqual([{ name: "Ana", day: "2026-09-29", club: "Kross Padel" }]);
    expect(askFor(views, "DANNY")).toEqual([
      { name: "Danny", day: "2026-10-02", club: "Warehaus" },
      { name: "Danny", day: "2026-09-13", club: "Kross Padel" },
    ]);
  });

  it("asks nothing about a name nobody played with, or an empty one", () => {
    expect(askFor(views, "Alberto")).toEqual([]);
    expect(askFor(views, "")).toEqual([]);
  });

  it("never offers two records the browser cannot tell apart: the same name, day and club", () => {
    const twins = pastViews([pp("b1", "Bo", -12), pp("b2", "Bo", -12)], new Set());
    expect(askFor(twins, "Bo")).toEqual([]);
  });

  it("reads the names of the create form's box as the server will: one a line, blank lines dropped", () => {
    expect(namesTyped("Danny\n\n  Alberto \n")).toEqual(["Danny", "Alberto"]);
  });
});

describe("which record an answer names, found again on the server", () => {
  const list = [pp("d1", "Danny", -28), pp("d2", "Danny", -9, "Warehaus"), pp("a1", "Ana", -12)];

  it("\"Yes, that's Danny\" with the day and the club it was shown finds that record", () => {
    expect(recordForAnswer(list, "Danny", { day: "2026-09-13", club: "Kross Padel" })?.id).toBe("d1");
    expect(recordForAnswer(list, "danny ", { day: "2026-10-02", club: "Warehaus" })?.id).toBe("d2");
  });

  it("a chip (a name one record carries) finds it; the same chip for a name two carry finds nobody", () => {
    expect(recordForAnswer(list, "Ana", true)?.id).toBe("a1");
    expect(recordForAnswer(list, "Danny", true)).toBeNull();
  });

  it("\"No, someone new\", no answer, a day or a club that does not match, or a stranger's name finds nobody", () => {
    expect(recordForAnswer(list, "Danny", "new")).toBeNull();
    expect(recordForAnswer(list, "Danny", undefined)).toBeNull();
    expect(recordForAnswer(list, "Danny", { day: "2026-09-14", club: "Kross Padel" })).toBeNull();
    expect(recordForAnswer(list, "Danny", { day: "2026-09-13", club: "Warehaus" })).toBeNull();
    expect(recordForAnswer(list, "Alberto", { day: "2026-09-13", club: "Kross Padel" })).toBeNull();
  });
});

describe("the question on the screen", () => {
  const one: PastView[] = [{ name: "Danny", day: "2026-09-13", club: "Kross Padel" }];
  const two: PastView[] = [{ name: "Danny", day: "2026-10-02", club: "Warehaus" }, ...one];
  const html = (locale: "en" | "ru" | "es", options: PastView[]) => renderIn(locale, createElement(PastAsk, { name: "Danny", options, onAnswer: () => undefined }));

  it("asks about one past player with the day and the club of the last match together", () => {
    const en = html("en", one);
    expect(en).toContain("Is this Danny, who played with you on Sep 13 at Kross Padel?");
    expect(en).toContain(">Yes, that&#x27;s Danny<");
    expect(en).toContain(">No, someone new<");
    expect(html("ru", one)).toContain("Это Danny? Вы играли вместе 13 сент. в Kross Padel.");
    expect(html("es", one)).toContain("¿Es Danny, que jugó contigo el 13 sept en Kross Padel?");
  });

  it("asks which one when two past players carry the name, with the day and the club of each", () => {
    const en = html("en", two);
    expect(en).toContain("Which Danny is it? More than one played with you.");
    expect(en).toContain(">Played Oct 2 at Warehaus<");
    expect(en).toContain(">Played Sep 13 at Kross Padel<");
    expect(en).toContain(">No, someone new<");
  });
});

// ------------------------------------------------------------------ through the actions, as a browser calls them

describe("the create form, the open spot and the pasted names, called as a browser calls them", () => {
  let app: Db;
  beforeAll(async () => {
    app = await getDb();
  });
  afterAll(() => undefined);
  let n = 0;
  const as = (p: Player): Record<string, string> => ({ [PLAYER_COOKIE]: sealPlayerId(p.id) });
  /** A past match `creator` made `days` from NOW at `club`, with `seated` in it, as the sweep leaves it. */
  const past = async (creator: Player, days: number, seated: Player[], club: string) => {
    const ev = await createEvent(app, { creatorPlayerId: creator.id, type: "match", startsAt: at(1), tz: "Asia/Bangkok", whenFull: "waitlist", venueName: club });
    for (const p of seated) await joinEvent(app, { eventId: ev.id, playerId: p.id, now: NOW });
    await app.update(events).set({ startsAt: at(days), status: "past" }).where(eq(events.id, ev.id));
  };
  /** Production on 11 October 2026: old Danny made R8n7 on 13 September at Kross Padel and Erik joined it. */
  const owners = async () => {
    const erik = await makePlayer(app, `Erik ${++n}`, { email: `erik-past${n}@example.com` });
    const danny = await makePlayer(app, "Danny");
    await past(danny, -28, [danny, erik], "Kross Padel");
    return { erik, danny };
  };
  const day = new Date(NOW.getTime() + 6 * DAY).toISOString().slice(0, 10);
  /** Erik's create form, sent the way the form sends it. The action answers a made match with a redirect to its share page. */
  const create = async (who: Player, names: string[], picks?: unknown) => {
    const { result } = await asAction(as(who), () =>
      createEventAction({ type: "match", date: day, time: "18:00", tz: "Asia/Bangkok", whenFull: "waitlist", venueName: "Warehaus", names, ...(picks ? { picks } : {}) } as never).catch((e: unknown) => e),
    );
    const digest = String((result as { digest?: string })?.digest ?? "");
    const code = digest.match(/\/([^/;]+)\/share/)?.[1];
    if (!code) throw new Error(`no match made: ${JSON.stringify(result)}`);
    const [ev] = await app.select().from(events).where(eq(events.code, code));
    return ev;
  };
  const heldIn = async (eventId: string) => app.select().from(slots).where(and(eq(slots.eventId, eventId), eq(slots.kind, "reserved"))).orderBy(asc(slots.position));
  const dannys = async () => (await app.select({ id: players.id }).from(players).where(eq(players.displayName, "Danny"))).length;

  it("the owner's case: Erik types Danny on the create form and answers \"Yes, that's Danny\": the place keeps old Danny's record, and no second Danny", async () => {
    const { erik, danny } = await owners();
    const before = await dannys();
    const ev = await create(erik, ["Danny"], [{ name: "Danny", day: "2026-09-13", club: "Kross Padel" }]);
    expect(await heldIn(ev.id)).toMatchObject([{ invitedName: "Danny", playerId: danny.id, status: "invited" }]);
    expect(await dannys()).toBe(before);
  });

  it("\"No, someone new\" holds the place by name: the form sends no answer for it", async () => {
    const { erik } = await owners();
    const ev = await create(erik, ["Danny"]);
    expect(await heldIn(ev.id)).toMatchObject([{ invitedName: "Danny", playerId: null }]);
  });

  it("two past players named Danny: the answer's day and club pick the one the organiser meant", async () => {
    const { erik } = await owners();
    const other = await makePlayer(app, "Danny");
    await past(erik, -9, [erik, other], "Warehaus");
    const ev = await create(erik, ["Danny"], [{ name: "Danny", day: "2026-10-02", club: "Warehaus" }]);
    expect((await heldIn(ev.id))[0].playerId).toBe(other.id);
  });

  it("a crafted submit holds by name: a player id in the answer, a stranger's name, an answer for a name not held", async () => {
    const { erik, danny } = await owners();
    // A record Erik never played with: Zoe played with somebody else on 13 September at Kross Padel.
    const zoe = await makePlayer(app, `Zoe ${n}`);
    const host = await makePlayer(app, `Host ${n}`);
    await past(host, -28, [host, zoe], "Kross Padel");
    // Old Danny's id put on Bo, Zoe's real last match named for Zoe, an answer for Cy whom nobody typed,
    // and Danny himself with no answer.
    const ev = await create(erik, ["Danny", zoe.displayName, "Bo"], [
      { name: "Bo", playerId: danny.id, id: danny.id },
      { name: zoe.displayName, day: "2026-09-13", club: "Kross Padel", playerId: zoe.id },
      { name: "Cy", day: "2026-09-13", club: "Kross Padel" },
    ]);
    const held = await heldIn(ev.id);
    expect(held.map((s) => [s.invitedName, s.playerId])).toEqual([
      ["Danny", null],
      [zoe.displayName, null],
      ["Bo", null],
    ]);
  });

  it("a name nobody played with is held by name, whatever the answer says", async () => {
    const { erik } = await owners();
    const ev = await create(erik, ["Alberto"], [{ name: "Alberto", day: "2026-09-13", club: "Kross Padel" }]);
    expect(await heldIn(ev.id)).toMatchObject([{ invitedName: "Alberto", playerId: null }]);
  });

  it("the open spot: the answer keeps the record, a wrong day holds by name", async () => {
    const { erik, danny } = await owners();
    const tdsv = await createEvent(app, { creatorPlayerId: erik.id, type: "match", startsAt: at(6), tz: "Asia/Bangkok", whenFull: "waitlist", venueName: "Warehaus" });
    await joinEvent(app, { eventId: tdsv.id, playerId: erik.id, now: NOW });
    const wrong = await asAction(as(erik), () => reserveAction(tdsv.code, { name: "Danny", pick: { day: "2026-09-14", club: "Kross Padel" } }));
    expect(wrong.result).toMatchObject({ ok: true });
    expect((await heldIn(tdsv.id))[0].playerId).toBeNull();
    const right = await asAction(as(erik), () => reserveAction(tdsv.code, { name: "Danny", pick: { day: "2026-09-13", club: "Kross Padel" } }));
    expect(right.result).toMatchObject({ ok: true, data: { name: "Danny" } });
    expect((await heldIn(tdsv.id)).map((s) => s.playerId)).toEqual([null, danny.id]);
  });

  it("\"Paste the names\": an answered name keeps its record, the others are held by name", async () => {
    const { erik, danny } = await owners();
    const tdsv = await createEvent(app, { creatorPlayerId: erik.id, type: "match", startsAt: at(6), tz: "Asia/Bangkok", whenFull: "waitlist", venueName: "Warehaus" });
    await joinEvent(app, { eventId: tdsv.id, playerId: erik.id, now: NOW });
    const { result } = await asAction(as(erik), () => reserveManyAction(tdsv.code, "Danny\nAlberto", [{ name: "Danny", day: "2026-09-13", club: "Kross Padel" }]));
    expect(result).toMatchObject({ ok: true, data: { held: ["Danny", "Alberto"] } });
    expect((await heldIn(tdsv.id)).map((s) => [s.invitedName, s.playerId])).toEqual([
      ["Danny", danny.id],
      ["Alberto", null],
    ]);
  });

  it("the create form's \"Played with you\" and question: names, days and clubs of the organiser's own past players, never an id, and nothing for a browser that knows nobody", async () => {
    const { erik, danny } = await owners();
    const { result } = await asAction(as(erik), () => pastPlayersAction());
    expect(result.chips).toContain("Danny");
    expect(result.past).toContainEqual({ name: "Danny", day: "2026-09-13", club: "Kross Padel" });
    expect(JSON.stringify(result)).not.toContain(danny.id);
    expect(JSON.stringify(result)).not.toContain(erik.id);
    expect((await asAction({}, () => pastPlayersAction())).result).toEqual({ chips: [], past: [] });
  });

  it("the organiser's past players, as the create form gets them, carry the club and the zone of the last match together", async () => {
    const { erik, danny } = await owners();
    const list = await pastPlayerRows(app, erik.id, NOW);
    expect(list.find((p) => p.id === danny.id)).toMatchObject({ name: "Danny", club: "Kross Padel", tz: "Asia/Bangkok" });
  });
});

// ------------------------------------------------------------------ several past players in one hold

/**
 * The owner, 6 November 2026, option A: "'Played with you' lets Erik pick several names and hold them
 * with one tap." Each tap on a chip adds a name, a second tap takes it away (`togglePick`), and one
 * request holds them all (`reservePickedAction`, `holdNames`): one rate check for all, one transaction.
 */
describe("picking several past players", () => {
  it("a tap adds a name, a tap on a picked name takes it away, and the open places cap the picks", () => {
    expect(togglePick([], "Maria", 3)).toEqual(["Maria"]);
    expect(togglePick(["Maria"], "Jordi", 3)).toEqual(["Maria", "Jordi"]);
    expect(togglePick(["Maria", "Jordi"], " maria ", 3)).toEqual(["Jordi"]);
    expect(togglePick(["Maria", "Jordi"], "Alex", 2), "no room for a third").toEqual(["Maria", "Jordi"]);
    // Taking one away always works, also at the cap.
    expect(togglePick(["Maria", "Jordi"], "JORDI", 2)).toEqual(["Maria"]);
    expect(PICK_CHIPS).toBe(8);
  });

  it("keeps strings only, trimmed, each name once, none empty or longer than 60, and twenty at most: the names the page sends", () => {
    expect(cleanPickedNames([" Maria ", "maria", 7, null, { name: "Bo" }, "", "   ", "x".repeat(61), "Ana de la Cruz", "Jo 2"])).toEqual(["Maria", "Ana de la Cruz", "Jo 2"]);
    expect(cleanPickedNames("Maria")).toEqual([]);
    expect(cleanPickedNames(undefined)).toEqual([]);
    const many = Array.from({ length: 30 }, (_, i) => `Player ${i + 1}`);
    expect(cleanPickedNames(many)).toEqual(many.slice(0, PAST_PLAYERS_SHOWN));
    // The browser-safe file keeps its own twenty: it must stay the page's twenty.
    expect(PICKED_MAX).toBe(PAST_PLAYERS_SHOWN);
  });
});

describe("several \"Played with you\" names held in one tap, called as a browser calls it", () => {
  let app: Db;
  const mailKey = process.env.RESEND_API_KEY;
  beforeAll(async () => {
    app = await getDb();
    // No mail goes out in these tests: the machine's own key never sends a test's notice.
    delete process.env.RESEND_API_KEY;
  });
  afterAll(() => {
    if (mailKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = mailKey;
  });
  let n = 0;
  const as = (p: Player): Record<string, string> => ({ [PLAYER_COOKIE]: sealPlayerId(p.id) });
  const byName = (p: Player): Record<string, string> => ({ [PLAYER_COOKIE]: sealPlayerId(p.id, { byName: true }) });
  const metric = async (key: string) => Number((await app.select().from(metricsDaily).where(and(eq(metricsDaily.day, dayKey()), eq(metricsDaily.key, key))))[0]?.value ?? 0);
  /**
   * Erik's crew of 13 September at Kross Padel: Maria, Jordi and Danny played with Erik there. Then
   * Erik's new match of four, Erik seated, three places open. `organiser`: Erik's record, bare unless given.
   */
  const crew = async (organiser: Partial<typeof players.$inferInsert> = {}) => {
    const erik = await makePlayer(app, `Erik ${++n}`, organiser);
    const [maria, jordi, danny] = [await makePlayer(app, "Maria"), await makePlayer(app, "Jordi"), await makePlayer(app, "Danny")];
    const sept = await createEvent(app, { creatorPlayerId: erik.id, type: "match", startsAt: at(1), tz: "Asia/Bangkok", whenFull: "waitlist", venueName: "Kross Padel" });
    for (const p of [erik, maria, jordi, danny]) await joinEvent(app, { eventId: sept.id, playerId: p.id, now: NOW });
    await app.update(events).set({ startsAt: at(-28), status: "past" }).where(eq(events.id, sept.id));
    const tdsv = await createEvent(app, { creatorPlayerId: erik.id, type: "match", startsAt: at(6), tz: "Asia/Bangkok", whenFull: "waitlist", venueName: "Warehaus" });
    await joinEvent(app, { eventId: tdsv.id, playerId: erik.id, now: NOW });
    return { erik, maria, jordi, danny, tdsv };
  };
  const heldIn = async (eventId: string) => (await app.select().from(slots).where(and(eq(slots.eventId, eventId), eq(slots.kind, "reserved"))).orderBy(asc(slots.position))).map((s) => [s.invitedName, s.playerId]);
  const reserveRate = (erikId: string) => metric(`rl:reserve:${erikId}`);

  it("the owner's case: three picks hold three places in one request, each keeps its record, the rate counts three, and the hold is counted", async () => {
    const { erik, maria, jordi, danny, tdsv } = await crew();
    const [holds, places] = [await metric("hold_picks"), await metric("hold_picked")];
    const { result } = await asAction(as(erik), () => reservePickedAction(tdsv.code, ["Maria", "Jordi", "Danny"]));
    expect(result).toEqual({ ok: true, data: { held: ["Maria", "Jordi", "Danny"], already: [], noSpot: [] } });
    expect(await heldIn(tdsv.id)).toEqual([
      ["Maria", maria.id],
      ["Jordi", jordi.id],
      ["Danny", danny.id],
    ]);
    expect(await reserveRate(erik.id), "one rate check that counts every place").toBe(3);
    expect([await metric("hold_picks"), await metric("hold_picked")]).toEqual([holds + 1, places + 3]);
  });

  it("three picks on two open places: the first two are held in pick order, the third comes back in noSpot, and the rate counts two", async () => {
    const { erik, maria, jordi, tdsv } = await crew();
    await joinEvent(app, { eventId: tdsv.id, playerId: (await makePlayer(app, `Sam ${n}`)).id, now: NOW });
    const { result } = await asAction(as(erik), () => reservePickedAction(tdsv.code, ["Jordi", "Maria", "Danny"]));
    expect(result).toEqual({ ok: true, data: { held: ["Jordi", "Maria"], already: [], noSpot: ["Danny"] } });
    expect(await heldIn(tdsv.id)).toEqual([
      ["Jordi", jordi.id],
      ["Maria", maria.id],
    ]);
    expect(await reserveRate(erik.id)).toBe(2);
  });

  it("a pick already in the match comes back in already, and nothing is held: never a second Maria", async () => {
    const { erik, maria, tdsv } = await crew();
    await asAction(as(erik), () => reservePickedAction(tdsv.code, ["Maria"]));
    const holds = await metric("hold_picks");
    const { result } = await asAction(as(erik), () => reservePickedAction(tdsv.code, [" maria "]));
    expect(result).toEqual({ ok: true, data: { held: [], already: ["maria"], noSpot: [] } });
    expect(await metric("hold_picks"), "a request that held nothing is no hold").toBe(holds);
    expect(await heldIn(tdsv.id)).toEqual([["Maria", maria.id]]);
  });

  it("holds a name with a chat word in it as given: \"Ana de la Cruz\" and \"Jo 2\"", async () => {
    const { erik, tdsv } = await crew();
    const { result } = await asAction(as(erik), () => reservePickedAction(tdsv.code, ["Ana de la Cruz", "Jo 2"]));
    expect(result).toEqual({ ok: true, data: { held: ["Ana de la Cruz", "Jo 2"], already: [], noSpot: [] } });
    expect(await heldIn(tdsv.id)).toEqual([
      ["Ana de la Cruz", null],
      ["Jo 2", null],
    ]);
  });

  it("holds by name a name nobody played with, a name two past players carry, and an id-shaped string", async () => {
    const { erik, danny, tdsv } = await crew();
    const sept2 = await createEvent(app, { creatorPlayerId: erik.id, type: "match", startsAt: at(1), tz: "Asia/Bangkok", whenFull: "waitlist", venueName: "Warehaus" });
    const otherJordi = await makePlayer(app, "jordi");
    for (const p of [erik, otherJordi]) await joinEvent(app, { eventId: sept2.id, playerId: p.id, now: NOW });
    await app.update(events).set({ startsAt: at(-9), status: "past" }).where(eq(events.id, sept2.id));
    const { result } = await asAction(as(erik), () => reservePickedAction(tdsv.code, ["Alberto", "Jordi", danny.id]));
    expect(result).toMatchObject({ ok: true, data: { held: ["Alberto", "Jordi", danny.id] } });
    expect(await heldIn(tdsv.id)).toEqual([
      ["Alberto", null],
      ["Jordi", null],
      [danny.id, null],
    ]);
  });

  it("one of each name, and twenty names at most: the rest of a long list is neither held nor answered", async () => {
    const { erik, maria, tdsv } = await crew();
    const { result } = await asAction(as(erik), () => reservePickedAction(tdsv.code, ["Maria", "maria", " MARIA "]));
    expect(result).toEqual({ ok: true, data: { held: ["Maria"], already: [], noSpot: [] } });
    expect(await heldIn(tdsv.id)).toEqual([["Maria", maria.id]]);
    const second = await crew();
    const many = Array.from({ length: 25 }, (_, i) => `Player ${i + 1}`);
    const long = await asAction(as(second.erik), () => reservePickedAction(second.tdsv.code, many));
    expect(long.result).toEqual({ ok: true, data: { held: many.slice(0, 3), already: [], noSpot: many.slice(3, PAST_PLAYERS_SHOWN) } });
    expect(await reserveRate(second.erik.id)).toBe(3);
  });

  it("refuses a browser that does not organise the match, and a request with no name", async () => {
    const { erik, tdsv } = await crew();
    const stranger = await makePlayer(app, `Stranger ${n}`);
    expect((await asAction(as(stranger), () => reservePickedAction(tdsv.code, ["Maria"]))).result).toEqual({ ok: false, error: "forbidden" });
    expect((await asAction(as(erik), () => reservePickedAction(tdsv.code, []))).result).toEqual({ ok: false, error: "invalid" });
    expect((await asAction(as(erik), () => reservePickedAction(tdsv.code, "Maria"))).result).toEqual({ ok: false, error: "invalid" });
    expect(await heldIn(tdsv.id)).toEqual([]);
  });

  // A session by name that proved nothing (DECIDING rule 34, since 6 November 2026) holds no record at
  // any door that turns a pick into a record: otherwise "That's me" as an old organiser, then a pick of
  // each of that record's past players, then "I'm Maria" on each row, signs a stranger in as each of them.
  it("a session by name that proved nothing holds every name with no record, at every door, and gets no past players", async () => {
    const { erik, tdsv } = await crew();
    const jar = byName(erik);
    // The open spot's several picks, one pick, "Paste the names" with an answer, and the create form with a pick.
    expect((await asAction(jar, () => reservePickedAction(tdsv.code, ["Maria"]))).result).toMatchObject({ ok: true, data: { held: ["Maria"] } });
    expect((await asAction(jar, () => reserveAction(tdsv.code, { name: "Jordi", pick: true }))).result).toMatchObject({ ok: true });
    expect((await asAction(jar, () => reserveManyAction(tdsv.code, "Danny", [{ name: "Danny", day: "2026-09-13", club: "Kross Padel" }]))).result).toMatchObject({ ok: true, data: { held: ["Danny"] } });
    expect(await heldIn(tdsv.id)).toEqual([
      ["Maria", null],
      ["Jordi", null],
      ["Danny", null],
    ]);
    const made = await asAction(jar, () =>
      createEventAction({ type: "match", date: new Date(NOW.getTime() + 7 * DAY).toISOString().slice(0, 10), time: "18:00", tz: "Asia/Bangkok", whenFull: "waitlist", venueName: "Warehaus", names: ["Maria"], picks: [{ name: "Maria" }] } as never).catch((e: unknown) => e),
    );
    const code = String((made.result as { digest?: string })?.digest ?? "").match(/\/([^/;]+)\/share/)?.[1];
    expect(code, JSON.stringify(made.result)).toBeTruthy();
    const [ev] = await app.select().from(events).where(eq(events.code, code!));
    expect(await heldIn(ev.id)).toEqual([["Maria", null]]);
    // "Keep Danny's matches" and the create form's "Played with you".
    const [danny] = await app.select().from(slots).where(and(eq(slots.eventId, tdsv.id), eq(slots.invitedName, "Danny")));
    expect((await asAction(jar, () => attachHeldRecordAction(tdsv.code, danny.id))).result).toEqual({ ok: false, error: "proof_required" });
    expect((await asAction(jar, () => pastPlayersAction())).result).toEqual({ chips: [], past: [] });
    // The same record, signed in with proof, keeps its picks: only the session by name is held back.
    expect((await asAction(as(erik), () => attachHeldRecordAction(tdsv.code, danny.id))).result).toEqual({ ok: true, data: { name: "Danny" } });
    expect((await asAction(as(erik), () => pastPlayersAction())).result.chips.length).toBeGreaterThan(0);
  });
});
