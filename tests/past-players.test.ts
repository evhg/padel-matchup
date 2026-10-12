import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { createElement } from "react";
import { getDb, type Db } from "@/db";
import { createEventAction, pastPlayersAction } from "@/actions/events";
import { reserveAction, reserveManyAction } from "@/actions/slots";
import { events, players, slots, type Player } from "@/db/schema";
import { createEvent } from "@/lib/domain/events";
import { pastPlayerRows, pastViews, recordForAnswer, type PastPlayer } from "@/lib/domain/heldRecord";
import { askFor, namesTyped, type PastView } from "@/lib/domain/pastAsk";
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
