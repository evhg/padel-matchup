import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { groupRequests } from "@/db/schema";
import { joinAsPlayer, NO_SIDE_EFFECTS } from "@/lib/api/operations";
import { groupToPublic } from "@/lib/api/serialize";
import { createEvent } from "@/lib/domain/events";
import { ASK_AGAIN_DAYS, askAgainFrom, canSeeMemberLevels, cleanAskNote, joinDoor, memberLevelFor, nextAsk } from "@/lib/domain/groupAccess";
import { createGroup, decideGroupRequest, getGroupByCode, getGroupDetail, getGroupMember, getGroupRequest, joinGroup, pendingGroupRequests, updateGroup, withdrawGroupRequest } from "@/lib/domain/groups";
import { joinWithPolicy } from "@/lib/domain/joining";
import { getEventByCode } from "@/lib/domain/queries";
import { notifyGroupAsk, notifyGroupAskDecided } from "@/lib/notify";
import { freezeClock } from "./helpers/clock";
import { createTestDb, makePlayer, DAY, HOUR } from "./helpers/db";

/**
 * The owner's decision E, 9 October 2026: "What does a visitor see on a group page, and who can
 * join?" — "names visible, levels hidden, optional Ask to join". A visitor sees the crew's first
 * names and the count, never a member's level; a group may ask new people to ask first, and then a
 * seat in one of its matches never makes a member on the quiet.
 */

// A Friday morning in Bangkok. Every date below is counted from it, never from the real clock.
const NOW = new Date("2026-10-09T02:00:00Z");
freezeClock(NOW);
const BASE = "https://kicksma.sh";

describe("who sees a member's level", () => {
  it("members and admins do; a visitor, a signed-out reader and the public API do not", () => {
    expect(canSeeMemberLevels({ role: "member" })).toBe(true);
    expect(canSeeMemberLevels({ role: "admin" })).toBe(true);
    expect(canSeeMemberLevels(null)).toBe(false);
    expect(canSeeMemberLevels(undefined)).toBe(false);
    expect(memberLevelFor(3.5, { role: "member" })).toBe(3.5);
    expect(memberLevelFor(3.5, null)).toBeNull();
  });
});

describe("what a join does to a group", () => {
  it("with Ask to join off, every caller adds, exactly as before decision E", () => {
    for (const via of ["self", "match", "admin"] as const) expect(joinDoor({ askToJoin: false }, via)).toBe("add");
  });

  it("with it on, only an admin adds; the person's own tap asks; a match seat adds nobody", () => {
    expect(joinDoor({ askToJoin: true }, "admin")).toBe("add");
    expect(joinDoor({ askToJoin: true }, "self")).toBe("ask");
    expect(joinDoor({ askToJoin: true }, "match")).toBe("none");
  });
});

describe("asking, and asking again", () => {
  const at = (days: number) => new Date(NOW.getTime() + days * DAY);

  it("a first ask inserts and tells the admins; a waiting one changes nothing", () => {
    expect(nextAsk(null, NOW)).toEqual({ kind: "insert", notify: true });
    expect(nextAsk({ status: "pending", createdAt: NOW, decidedAt: null }, at(3))).toEqual({ kind: "keep", notify: false });
  });

  it(`a declined person waits ${ASK_AGAIN_DAYS} days from the decision, then the same row reopens`, () => {
    const declined = { status: "declined" as const, createdAt: at(-1), decidedAt: NOW };
    expect(askAgainFrom(declined)).toEqual(at(7));
    expect(nextAsk(declined, at(6.9))).toEqual({ kind: "wait", notify: false, from: at(7) });
    expect(nextAsk(declined, at(7))).toEqual({ kind: "reopen", notify: true });
  });

  it("a withdrawn ask reopens at once, and tells the admins again only once a day", () => {
    const withdrawn = { status: "withdrawn" as const, createdAt: NOW, decidedAt: NOW };
    expect(nextAsk(withdrawn, new Date(NOW.getTime() + HOUR))).toEqual({ kind: "reopen", notify: false });
    expect(nextAsk(withdrawn, at(1))).toEqual({ kind: "reopen", notify: true });
    // Approved, then the member left or was removed: asking again is a fresh question for the admins.
    expect(nextAsk({ status: "approved", createdAt: at(-30), decidedAt: at(-29) }, NOW)).toEqual({ kind: "reopen", notify: true });
    expect(askAgainFrom(withdrawn)).toBeNull();
  });

  it("the note is cleaned: one line, at most 200 characters, never half an emoji, empty is nothing", () => {
    expect(cleanAskNote("  Ladies'   night\n\tregular  ")).toBe("Ladies' night regular");
    expect(cleanAskNote("a\u0000b")).toBe("a b");
    expect(cleanAskNote("   ")).toBeNull();
    expect(cleanAskNote(undefined)).toBeNull();
    expect(cleanAskNote("x".repeat(250))).toHaveLength(200);
    const emoji = cleanAskNote("🎾".repeat(201))!;
    expect(Array.from(emoji)).toHaveLength(200);
    expect(emoji.endsWith("🎾")).toBe(true);
  });
});

describe("a group that asks to join", () => {
  let db: Db;
  let close: () => Promise<void>;
  const sent: { chatId: number; text: string }[] = [];
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TELEGRAM_BOT_TOKEN;
    sent.length = 0;
  });
  /** Telegram on, every sendMessage captured: who was told, and what. */
  const captureTelegram = () => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:TEST";
    vi.stubGlobal("fetch", async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { chat_id: number; text: string };
      sent.push({ chatId: Number(body.chat_id), text: String(body.text) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: body.chat_id } } }), { headers: { "content-type": "application/json" } });
    });
  };
  const isMember = async (groupId: string, playerId: string) => Boolean(await getGroupMember(db, groupId, playerId));
  let nextTelegramId = 9100;
  const askingGroup = async (name: string) => {
    const olga = await makePlayer(db, "Olga", { telegramId: nextTelegramId++, level: 4.25 });
    const g = await createGroup(db, { name, creatorPlayerId: olga.id, tz: "Asia/Bangkok", levelMin: 3, levelMax: 4.5 });
    await updateGroup(db, g.id, olga.id, { askToJoin: true });
    return { olga, g };
  };

  it("a visitor's view carries names and the count, never a level; a member's view carries the levels", async () => {
    const olga = await makePlayer(db, "Olga", { level: 4.25 });
    const bea = await makePlayer(db, "Bea", { level: 3.75 });
    const g = await createGroup(db, { name: "Ladies crew", creatorPlayerId: olga.id, tz: "Asia/Bangkok", levelMin: 3, levelMax: 4.5, memberIds: [bea.id] });
    const visitor = await makePlayer(db, "Vera");
    await updateGroup(db, g.id, olga.id, { askToJoin: true });
    await joinGroup(db, g.id, visitor.id, "self", { note: "LEAKNOTE ladies night", now: NOW });
    const detail = await getGroupDetail(db, (await getGroupByCode(db, g.code))!, NOW);

    const seen = groupToPublic(detail, BASE);
    expect(seen.members.map((m) => m.name).sort()).toEqual(["Bea", "Olga"]);
    expect(seen.memberCount).toBe(2);
    expect(seen.members.every((m) => m.level === null)).toBe(true);
    // The crew's own range stays: it describes the group, not a person.
    expect(seen.level).toMatchObject({ min: 3, max: 4.5 });
    const text = JSON.stringify(seen);
    expect(text).not.toContain("4.25");
    expect(text).not.toContain("3.75");
    // An ask and its note are the admins' alone: never in the public shape.
    expect(text).not.toContain("LEAKNOTE");
    expect(text).not.toContain("Vera");

    const asMember = groupToPublic(detail, BASE, { role: "member" });
    expect(asMember.members.find((m) => m.name === "Bea")?.level).toBe(3.75);
    expect(asMember.members.find((m) => m.name === "Olga")?.level).toBe(4.25);
  });

  it("the API and MCP shape says whether the group asks to join", async () => {
    const { g } = await askingGroup("Level crew");
    const detail = await getGroupDetail(db, (await getGroupByCode(db, g.code))!, NOW);
    expect(groupToPublic(detail, BASE).askToJoin).toBe(true);
  });

  it("ask, withdraw, ask again, approve: a member, and both sides told", async () => {
    const { olga, g } = await askingGroup("Tuesday ladies");
    const dee = await makePlayer(db, "Dee", { telegramId: 9002, level: 3.5 });

    const asked = await joinGroup(db, g.id, dee.id, "self", { note: "  Ladies'   night\n regular ", now: NOW });
    expect(asked).toMatchObject({ outcome: "requested", notify: true });
    expect(await isMember(g.id, dee.id)).toBe(false);
    const list = await pendingGroupRequests(db, g.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ note: "Ladies' night regular", player: { displayName: "Dee", level: 3.5 } });
    // A second tap while it waits changes nothing and tells nobody twice.
    expect((await joinGroup(db, g.id, dee.id, "self", { now: NOW })).outcome).toBe("pending");

    captureTelegram();
    expect(await notifyGroupAsk(db, g, dee, list[0].note)).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe(olga.telegramId);
    expect(sent[0].text).toContain("Dee asks to join Tuesday ladies");
    expect(sent[0].text).toContain("night regular");
    sent.length = 0;

    expect(await withdrawGroupRequest(db, g.id, dee.id, NOW)).toBe(true);
    expect(await pendingGroupRequests(db, g.id)).toHaveLength(0);
    // Asking again the same day reopens the same row, quietly: ask, withdraw, ask is one notice.
    const again = await joinGroup(db, g.id, dee.id, "self", { now: new Date(NOW.getTime() + HOUR) });
    expect(again).toMatchObject({ outcome: "requested", notify: false });
    const rows = await db.select().from(groupRequests).where(and(eq(groupRequests.groupId, g.id), eq(groupRequests.playerId, dee.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toBeNull();

    // Only an admin decides.
    await expect(decideGroupRequest(db, { groupId: g.id, requestId: rows[0].id, approve: true, actorPlayerId: dee.id, now: NOW })).rejects.toMatchObject({ code: "forbidden" });
    const res = await decideGroupRequest(db, { groupId: g.id, requestId: rows[0].id, approve: true, actorPlayerId: olga.id, now: NOW });
    expect(res.request).toMatchObject({ status: "approved", decidedByPlayerId: olga.id });
    expect(await isMember(g.id, dee.id)).toBe(true);
    await expect(decideGroupRequest(db, { groupId: g.id, requestId: rows[0].id, approve: false, actorPlayerId: olga.id, now: NOW })).rejects.toMatchObject({ code: "invalid" });

    await notifyGroupAskDecided(db, g, res.player!, true);
    expect(sent.map((m) => m.chatId)).toEqual([9002]);
    expect(sent[0].text).toContain("You're in Tuesday ladies");
  });

  it("decline: not a member, told kindly; a new ask waits seven days, then the same row reopens", async () => {
    const { olga, g } = await askingGroup("Level four crew");
    const eve = await makePlayer(db, "Eve", { telegramId: 9003, level: 2 });
    const first = await joinGroup(db, g.id, eve.id, "self", { note: "I am improving fast", now: NOW });
    if (first.outcome !== "requested") throw new Error(`expected an ask, got ${first.outcome}`);
    const res = await decideGroupRequest(db, { groupId: g.id, requestId: first.request.id, approve: false, actorPlayerId: olga.id, now: NOW });
    expect(res.request.status).toBe("declined");
    expect(await isMember(g.id, eve.id)).toBe(false);

    captureTelegram();
    await notifyGroupAskDecided(db, g, res.player!, false);
    expect(sent.map((m) => m.chatId)).toEqual([9003]);
    expect(sent[0].text).toContain("No place in Level four crew for now");
    expect(sent[0].text).toContain("ask again in a week");

    // Six days on: nothing changes, nobody is told, and the screen can say from when.
    const early = await joinGroup(db, g.id, eve.id, "self", { now: new Date(NOW.getTime() + 6 * DAY) });
    expect(early).toEqual({ outcome: "declined", askAgainFrom: new Date(NOW.getTime() + 7 * DAY) });
    expect((await getGroupRequest(db, g.id, eve.id))?.status).toBe("declined");
    expect(await pendingGroupRequests(db, g.id)).toHaveLength(0);

    // Seven days on: the same row is back at pending, and the admins hear.
    const later = await joinGroup(db, g.id, eve.id, "self", { note: "Played twice a week since", now: new Date(NOW.getTime() + 7 * DAY) });
    expect(later).toMatchObject({ outcome: "requested", notify: true, request: { id: first.request.id, status: "pending", note: "Played twice a week since", decidedAt: null } });
    expect(await isMember(g.id, eve.id)).toBe(false);
  });

  it("an admin's add goes past the ask; a match seat adds nobody and asks nothing", async () => {
    const { g } = await askingGroup("Admins add");
    const fay = await makePlayer(db, "Fay");
    const gus = await makePlayer(db, "Gus");
    expect((await joinGroup(db, g.id, fay.id, "admin")).outcome).toBe("joined");
    expect(await isMember(g.id, fay.id)).toBe(true);
    expect((await joinGroup(db, g.id, gus.id, "match")).outcome).toBe("skipped");
    expect(await isMember(g.id, gus.id)).toBe(false);
    expect(await getGroupRequest(db, g.id, gus.id)).toBeNull();
    // A member is a member whichever door they come back through.
    expect((await joinGroup(db, g.id, fay.id, "self")).outcome).toBe("already");
    expect((await joinGroup(db, g.id, fay.id, "match")).outcome).toBe("already");
  });

  it("an ask whose person got in another way meanwhile is not left on the admins' list", async () => {
    const { olga, g } = await askingGroup("Door opened");
    const lea = await makePlayer(db, "Lea");
    expect((await joinGroup(db, g.id, lea.id, "self", { now: NOW })).outcome).toBe("requested");
    expect(await pendingGroupRequests(db, g.id)).toHaveLength(1);
    // The admin opens the door again, and Lea taps Join: a member, and no longer a question.
    await updateGroup(db, g.id, olga.id, { askToJoin: false });
    expect((await joinGroup(db, g.id, lea.id, "self", { now: NOW })).outcome).toBe("joined");
    expect(await pendingGroupRequests(db, g.id)).toHaveLength(0);
  });

  it("with Ask to join off, every caller adds, as before", async () => {
    const olga = await makePlayer(db, "Olga");
    const g = await createGroup(db, { name: "Open crew", creatorPlayerId: olga.id, tz: "Asia/Bangkok" });
    for (const via of ["self", "match", "admin"] as const) {
      const p = await makePlayer(db, `Open ${via}`);
      expect((await joinGroup(db, g.id, p.id, via)).outcome).toBe("joined");
      expect(await isMember(g.id, p.id)).toBe(true);
    }
  });

  it("joining the group's match: a seat, and a member only where the group lets anyone in", async () => {
    const olga = await makePlayer(db, "Olga");
    const g = await createGroup(db, { name: "Match crew", creatorPlayerId: olga.id, tz: "Asia/Bangkok" });
    const ev = await createEvent(db, { creatorPlayerId: olga.id, type: "tournament", capacity: 8, startsAt: new Date(NOW.getTime() + 2 * DAY), tz: "Asia/Bangkok", whenFull: "waitlist", groupId: g.id });
    const detail = async () => (await getEventByCode(db, ev.code))!;

    // Open group: the web (and WhatsApp) door seats and makes a member, as it always did.
    const hal = await makePlayer(db, "Hal");
    expect((await joinWithPolicy(db, await detail(), hal, null)).kind).toBe("joined");
    expect(await isMember(g.id, hal.id)).toBe(true);
    // The API (and Telegram, Discord, LINE) door says so in its answer.
    const ida = await makePlayer(db, "Ida");
    const open = await joinAsPlayer(db, await detail(), ida, NO_SIDE_EFFECTS);
    expect(open.outcome).toBe("joined");
    expect(open.group).toMatchObject({ code: g.code, askToJoin: false, member: true });
    expect(open.group?.url.endsWith(`/g/${g.code}`)).toBe(true);

    // The group starts asking: the seat follows the match's rules, and nobody becomes a member.
    await updateGroup(db, g.id, olga.id, { askToJoin: true });
    const jon = await makePlayer(db, "Jon");
    const web = await joinWithPolicy(db, await detail(), jon, null);
    expect(web.kind === "joined" && web.result.outcome).toBe("joined");
    expect(await isMember(g.id, jon.id)).toBe(false);
    expect(await getGroupRequest(db, g.id, jon.id)).toBeNull();

    const kim = await makePlayer(db, "Kim");
    const api = await joinAsPlayer(db, await detail(), kim, NO_SIDE_EFFECTS);
    expect(api.outcome).toBe("joined");
    expect(api.group).toMatchObject({ code: g.code, askToJoin: true, member: false });
    expect(api.next).toContain("asks to join");
    expect(await isMember(g.id, kim.id)).toBe(false);
    expect(await getGroupRequest(db, g.id, kim.id)).toBeNull();
    // Somebody who is already a member keeps the plain answer.
    const already = await joinAsPlayer(db, await detail(), hal, NO_SIDE_EFFECTS);
    expect(already.group).toMatchObject({ askToJoin: true, member: true });
    expect(already.next).not.toContain("asks to join");
  });
});
