import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { and, eq, ilike } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { emailMarks, players, slots, type Player } from "@/db/schema";
import { bePartnerAction, setPaidAction } from "@/actions/slots";
import { GET as manageRoute } from "@/app/[code]/manage/[manage]/route";
import { JoinRequests } from "@/components/JoinRequests";
import { cancelEvent, createEvent } from "@/lib/domain/events";
import { mailBlocksAmong } from "@/lib/domain/emailMarks";
import { inviteStateOf, inviteView } from "@/lib/domain/heldByName";
import { joinStateOf, type JoinState } from "@/lib/domain/joinState";
import { joinBarLevel, partnerOffered } from "@/lib/domain/levels";
import { addOptOut } from "@/lib/domain/optouts";
import { findInviteRemindersDue } from "@/lib/domain/reminders";
import { joinEvent, reserveSlot } from "@/lib/domain/slots";
import { deleteLastRound, generateRound } from "@/lib/domain/tournament";
import { ERROR_LINES, errorLine } from "@/lib/errorLine";
import { sendInviteReminder } from "@/lib/notify";
import { grantManageAccess, manageCookieName, PLAYER_COOKIE, sealPlayerId } from "@/lib/session";
import { asAction } from "./helpers/action";
import { freezeClock } from "./helpers/clock";
import { createTestDb, DAY, HOUR, makePlayer } from "./helpers/db";
import { catalogue, renderIn } from "./helpers/render";

/**
 * The owner, 9 November 2026: "check all the buttons in the app so they are actually doing what they are
 * supposed to do". Two audits of the match page, the organiser's and the player's, found buttons that did
 * nothing, did harm, or said something the tap did not do. Each server-side fix has its case here; the
 * edit form's are in tests/match-edit.test.ts, the Telegram share's in tests/group-line.test.ts and the
 * question with no way in in tests/seated-doors.test.ts.
 *
 * NOW is Monday 9 November 2026, 12:00 UTC. Every match starts a day after it, or ended before it.
 */
const NOW = new Date(Date.UTC(2026, 10, 9, 12, 0));
freezeClock(NOW);
const TZ = "Asia/Bangkok";

describe("every refusal has a line to show", () => {
  it("each code errorLine names has its line in en, ru and es; any other code reads the plain one", () => {
    for (const locale of ["en", "ru", "es"] as const) {
      const lines = catalogue(locale).errors as Record<string, string>;
      for (const code of ERROR_LINES) expect(typeof lines[code], `${locale} errors.${code}`).toBe("string");
    }
    expect(errorLine("past")).toBe("past");
    expect(errorLine("no_identity")).toBe("generic");
    expect(errorLine("needs_approval")).toBe("generic");
  });
});

describe("the join bar's state (F1: a waiting place once the match is on)", () => {
  const base = { cancelled: false, over: false, started: false, member: false, waitlisted: false, held: false, request: null, spotsLeft: 1, whenFull: "waitlist" as const };
  const TABLE: [string, Partial<Parameters<typeof joinStateOf>[0]>, JoinState][] = [
    ["a waiting place before the start: Leave waitlist", { waitlisted: true, spotsLeft: 0 }, "leave_waitlist"],
    ["a waiting place once the match is on: no Leave, which the server refuses", { waitlisted: true, spotsLeft: 0, started: true }, "waitlist_live"],
    ["a seat once the match is on", { member: true, started: true }, "member_live"],
    ["a seat before the start", { member: true }, "leave"],
    ["called off wins over everything", { cancelled: true, member: true }, "cancelled"],
    ["over", { over: true, waitlisted: true, started: true }, "past"],
    ["a held place of the viewer's own, on a full match", { held: true, spotsLeft: 0 }, "join"],
    ["an ask waiting", { request: "pending" }, "requested"],
    ["full with a waiting list", { spotsLeft: 0 }, "join_waitlist"],
    ["full with none", { spotsLeft: 0, whenFull: "closed" }, "full"],
  ];
  for (const [name, o, want] of TABLE) it(name, () => expect(joinStateOf({ ...base, ...o })).toBe(want));
});

describe("the personal link's page on a match that is over (F2)", () => {
  it("a place still held or declined offers nothing to tap; a place taken stays confirmed", () => {
    const st = (o: Partial<Parameters<typeof inviteStateOf>[0]>) => inviteStateOf({ cancelled: false, over: false, slotStatus: "invited", mine: false, ...o });
    expect(st({ over: true })).toBe("past");
    expect(st({ over: true, slotStatus: "declined" })).toBe("past");
    expect(inviteView(st({ over: true }), false, true)).toBe("past");
    expect(st({})).toBe("invited");
    expect(st({ slotStatus: "declined" })).toBe("declined");
    expect(st({ over: true, slotStatus: "confirmed", mine: true })).toBe("confirmed_mine");
    expect(st({ over: true, cancelled: true })).toBe("cancelled");
    expect(st({ slotStatus: "joined" })).toBe("gone");
  });
});

describe("the bar and the partner button read the level as the server does (F9, F14)", () => {
  const range = { min: 3, max: 4.5 };
  it("a place held for the viewer's own record asks no level and no range: Join, never Ask to join", () => {
    expect(joinBarLevel({ range, level: 2, verifiedOnly: false, verified: false, waived: null, held: true })).toEqual({ needsLevel: false, outOfRange: false, unverified: false });
    expect(joinBarLevel({ range, level: null, verifiedOnly: true, verified: false, waived: null, held: true })).toEqual({ needsLevel: false, outOfRange: false, unverified: false });
    expect(joinBarLevel({ range, level: 2, verifiedOnly: false, verified: false, waived: null })).toMatchObject({ outOfRange: true });
  });
  it("Be their partner: only where partnerAdmission lets the viewer in", () => {
    const ranged = { levelMin: 3, levelMax: 4.5, levelVerifiedOnly: false };
    const offered = (me: { level: number | null } | null, o: Partial<{ organiser: boolean; seated: boolean; waived: "ok" | "unverified" | null }> = {}) => partnerOffered(ranged, me, { organiser: false, seated: false, waived: null, ...o });
    expect(offered({ level: 3.5 })).toBe(true);
    expect(offered({ level: 2 })).toBe(false);
    expect(offered({ level: 2 }, { waived: "ok" })).toBe(true);
    expect(offered({ level: null })).toBe(false);
    expect(offered(null)).toBe(false);
    expect(offered(null, { organiser: true })).toBe(true);
    expect(offered({ level: 2 }, { seated: true })).toBe(true);
    expect(partnerOffered({ levelMin: null, levelMax: null }, null, { organiser: false, seated: false, waived: null })).toBe(true);
    expect(partnerOffered({ ...ranged, levelVerifiedOnly: true }, { level: 3.5, levelVerifiedLevel: null }, { organiser: false, seated: false, waived: null })).toBe(false);
  });
});

describe("join requests on a match with no waiting list (#12)", () => {
  it("the help says a yes needs an open spot", () => {
    const items = [{ id: "r1", name: "Bea", level: 2, ago: "now" }];
    expect(renderIn("en", createElement(JoinRequests, { code: "ABCD", items, waitlist: false }))).toContain("Approving seats them while a spot is open.");
    expect(renderIn("en", createElement(JoinRequests, { code: "ABCD", items }))).toContain("or waitlists them when full");
  });
});

describe("rules in the domain", () => {
  let db: Db;
  beforeAll(async () => {
    ({ db } = await createTestDb());
  });

  it("#3: a match that is over cannot be called off; the organiser's \"We didn't play\" still can", async () => {
    const org = await makePlayer(db, "Olga");
    const played = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() - 3 * HOUR), tz: TZ, venueName: "Rawai Padel", whenFull: "waitlist" });
    await expect(cancelEvent(db, played.id, org.id, { now: NOW })).rejects.toMatchObject({ code: "past" });
    expect((await cancelEvent(db, played.id, org.id, { now: NOW, didntPlay: true })).status).toBe("cancelled");
    const coming = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() + DAY), tz: TZ, venueName: "Rawai Padel", whenFull: "waitlist" });
    expect((await cancelEvent(db, coming.id, org.id, { now: NOW })).status).toBe("cancelled");
  });

  it("#19: a tournament called off keeps its rounds", async () => {
    const org = await makePlayer(db, "Tara");
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "tournament", capacity: 4, startsAt: new Date(NOW.getTime() + DAY), tz: TZ, venueName: "Rawai Padel", whenFull: "waitlist", pointsPerMatch: 21 });
    await joinEvent(db, { eventId: ev.id, playerId: org.id });
    for (const n of ["T1", "T2", "T3"]) await joinEvent(db, { eventId: ev.id, playerId: (await makePlayer(db, n)).id });
    await generateRound(db, { eventId: ev.id, actorPlayerId: org.id });
    await cancelEvent(db, ev.id, org.id, { now: NOW });
    await expect(deleteLastRound(db, { eventId: ev.id })).rejects.toMatchObject({ code: "cancelled" });
  });

  it("#7: an address that opted out gets no reminder, and the line-up reads its opt-out with the marks in one statement", async () => {
    const org = await makePlayer(db, "Rémi");
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() + 3 * DAY), tz: TZ, venueName: "Rawai Padel", whenFull: "waitlist" });
    const at = new Date(NOW.getTime() - 30 * HOUR);
    const kept = await reserveSlot(db, { eventId: ev.id, actorPlayerId: org.id, name: "Kim", email: "kim-reminded@example.com", now: at });
    const out = await reserveSlot(db, { eventId: ev.id, actorPlayerId: org.id, name: "Oto", email: "oto-optout@example.com", now: at });
    await addOptOut(db, "oto-optout@example.com");
    await db.insert(emailMarks).values({ address: "bounced@example.com", kind: "hard", markedAt: NOW });
    expect((await findInviteRemindersDue(db, NOW)).map((d) => d.slot.id)).toEqual([kept.slot.id]);
    const blocks = await mailBlocksAmong(db, ["Oto-Optout@example.com", "kim-reminded@example.com", "bounced@example.com", null]);
    expect([...blocks.optedOut]).toEqual(["oto-optout@example.com"]);
    expect([...blocks.marked]).toEqual(["bounced@example.com"]);
    // The send itself says nothing went, so the job never marks it as reminded.
    process.env.RESEND_API_KEY = "re_test_button_truth";
    try {
      expect(await sendInviteReminder(db, ev, out.slot, org)).toBe(false);
    } finally {
      delete process.env.RESEND_API_KEY;
    }
  });
});

describe("actions as a browser calls them", () => {
  let app: Db;
  beforeAll(async () => {
    app = await getDb();
  });
  afterAll(() => {
    delete process.env.RESEND_API_KEY;
  });
  const as = (p: Player): Record<string, string> => ({ [PLAYER_COOKIE]: sealPlayerId(p.id) });
  /** The seat a join took (a full match takes none, and none of these is full). */
  const seat = async (eventId: string, playerId: string) => {
    const r = await joinEvent(app, { eventId, playerId });
    if (r.outcome === "full") throw new Error("full");
    return r.slot;
  };
  let n = 0;
  const tap = () => ({ headers: { "x-forwarded-for": `button-truth-${++n}` } });

  it("#4: the manage link's organiser sets the paid chips, with no session or with a session of their own", async () => {
    const org = await makePlayer(app, "Paula");
    const ev = await createEvent(app, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() + DAY), tz: TZ, venueName: "Rawai Padel", whenFull: "waitlist", cost: "300 THB" });
    const bo = await makePlayer(app, "Bodhi");
    const slot = await seat(ev.id, bo.id);
    const granted = await asAction({}, async () => grantManageAccess(ev.code, ev.manageCode));
    const manage = { [manageCookieName(ev.code)]: granted.cookies[manageCookieName(ev.code)] };
    const paidAt = async () => (await app.select({ paidAt: slots.paidAt }).from(slots).where(eq(slots.id, slot.id)))[0].paidAt;

    expect((await asAction(manage, () => setPaidAction(ev.code, slot.id, true), tap())).result).toEqual({ ok: true, data: null });
    expect(await paidAt()).not.toBeNull();
    const coOrganiser = await makePlayer(app, "Cora");
    expect((await asAction({ ...manage, ...as(coOrganiser) }, () => setPaidAction(ev.code, slot.id, false), tap())).result).toEqual({ ok: true, data: null });
    expect(await paidAt()).toBeNull();
    // Nobody else: a stranger's session alone is refused before the domain.
    expect((await asAction(as(coOrganiser), () => setPaidAction(ev.code, slot.id, true), tap())).result).toMatchObject({ ok: false, error: "forbidden" });
  });

  it("#21: a wrong organizer link lands on the match page with ?manage=wrong; the right one does not", async () => {
    const org = await makePlayer(app, "Manon");
    const ev = await createEvent(app, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() + DAY), tz: TZ, venueName: "Rawai Padel", whenFull: "waitlist" });
    const open = async (manage: string) => {
      const res = await asAction({}, () => manageRoute(new Request(`http://localhost/${ev.code}/manage/${manage}`), { params: Promise.resolve({ code: ev.code, manage }) }));
      return new URL(res.result.headers.get("location")!);
    };
    const swapped = `${ev.manageCode.slice(0, 9)}${ev.manageCode.endsWith("a") ? "b" : "a"}`;
    expect((await open(swapped)).search).toBe("?manage=wrong");
    expect((await open("short")).search).toBe("?manage=wrong");
    const right = await open(ev.manageCode);
    expect([right.pathname, right.search]).toEqual([`/${ev.code}`, ""]);
    expect(catalogue("en").creator).toMatchObject({ manageWrong: "This organizer link does not work. Check that you copied all of it." });
  });

  it("F14: Be their partner refuses before it makes a record: a ranged night's newcomer, a seated name", async () => {
    const records = async (name: string) => (await app.select({ id: players.id }).from(players).where(ilike(players.displayName, name))).length;
    const org = await makePlayer(app, "Fern");
    const ranged = await createEvent(app, { creatorPlayerId: org.id, type: "tournament", capacity: 8, fixedPairs: true, startsAt: new Date(NOW.getTime() + DAY), tz: TZ, venueName: "Rawai Padel", whenFull: "waitlist", pointsPerMatch: 21, levelMin: 3, levelMax: 4.5 });
    const ana = await makePlayer(app, "Anouk", { level: 3.5 });
    const anaSeat = await seat(ranged.id, ana.id);
    const newcomer = await asAction({}, () => bePartnerAction(ranged.code, anaSeat.id, "Newbie Partner"), tap());
    expect(newcomer.result).toEqual({ ok: false, error: "level_required" });
    expect(await records("Newbie Partner")).toBe(0);

    const open = await createEvent(app, { creatorPlayerId: org.id, type: "tournament", capacity: 8, fixedPairs: true, startsAt: new Date(NOW.getTime() + DAY), tz: TZ, venueName: "Rawai Padel", whenFull: "waitlist", pointsPerMatch: 21 });
    const dax = await makePlayer(app, "Daxton");
    await joinEvent(app, { eventId: open.id, playerId: dax.id });
    const single = await seat(open.id, (await makePlayer(app, "Solo")).id);
    const seated = await asAction({}, () => bePartnerAction(open.code, single.id, "daxton"), tap());
    expect(seated.result).toEqual({ ok: false, error: "name_seated" });
    expect(await records("Daxton")).toBe(1);
    // A known browser is itself, whatever it types: the name rules ask nothing of it.
    expect((await asAction(as(org), () => bePartnerAction(open.code, single.id, "daxton"), tap())).result).toMatchObject({ ok: true });
    expect(await app.select({ id: slots.id }).from(slots).where(and(eq(slots.eventId, open.id), eq(slots.playerId, org.id)))).toHaveLength(1);
  });
});
