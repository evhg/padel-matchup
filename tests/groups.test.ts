import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events, groupMembers, slots } from "@/db/schema";
import { createEvent, duplicateEvent } from "@/lib/domain/events";
import { autoCreateGroupMatches, createGroup, createGroupFromEvent, getGroupDetail, getPlayerGroups, joinGroup, leaveGroup, nextGroupSlot, recurrenceDue, removeGroupMember, updateGroup } from "@/lib/domain/groups";
import { joinEvent } from "@/lib/domain/slots";
import { createTestDb, makePlayer, DAY, HOUR } from "./helpers/db";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

describe("groups", () => {
  it("forms a group from a match: settings copied, players become members, match linked, idempotent", async () => {
    const org = await makePlayer(db, "Org");
    const p2 = await makePlayer(db, "P2");
    const p3 = await makePlayer(db, "P3");
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(Date.now() + HOUR), tz: "Asia/Singapore", venueName: "Club X", whenFull: "closed", levelMin: 3, levelMax: 4.5 });
    for (const p of [org, p2, p3]) await joinEvent(db, { eventId: ev.id, playerId: p.id });
    const g = await createGroupFromEvent(db, { eventId: ev.id, actorPlayerId: p2.id, fallbackName: "Padel crew" });
    expect(g.code).toHaveLength(6);
    expect(g.name).toBe("Padel crew");
    expect(g.venueName).toBe("Club X");
    expect(g.whenFull).toBe("closed");
    expect(g.levelMin).toBe(3);
    expect(g.creatorPlayerId).toBe(p2.id);
    const d = await getGroupDetail(db, g);
    expect(d.members.map((m) => m.playerId).sort()).toEqual([org.id, p2.id, p3.id].sort());
    expect(d.members[0].playerId).toBe(p2.id);
    expect(d.members[0].role).toBe("admin");
    expect(d.upcoming.map((e) => e.id)).toEqual([ev.id]);
    const again = await createGroupFromEvent(db, { eventId: ev.id, actorPlayerId: org.id, fallbackName: "x" });
    expect(again.id).toBe(g.id);
    // outsiders can't
    const stranger = await makePlayer(db, "Stranger");
    const ev2 = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(Date.now() + HOUR), tz: "UTC", whenFull: "waitlist" });
    await expect(createGroupFromEvent(db, { eventId: ev2.id, actorPlayerId: stranger.id, fallbackName: "x" })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("membership: join is idempotent, creator can't leave, only admins remove", async () => {
    const admin = await makePlayer(db, "Admin");
    const m1 = await makePlayer(db, "M1");
    const m2 = await makePlayer(db, "M2");
    const g = await createGroup(db, { name: "Crew", creatorPlayerId: admin.id, tz: "UTC" });
    await joinGroup(db, g.id, m1.id);
    await joinGroup(db, g.id, m1.id);
    await joinGroup(db, g.id, m2.id);
    expect((await getGroupDetail(db, g)).members).toHaveLength(3);
    await expect(leaveGroup(db, g.id, admin.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(removeGroupMember(db, g.id, m1.id, m2.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(removeGroupMember(db, g.id, admin.id, admin.id)).rejects.toMatchObject({ code: "forbidden" });
    await removeGroupMember(db, g.id, admin.id, m2.id);
    await leaveGroup(db, g.id, m1.id);
    expect((await getGroupDetail(db, g)).members.map((m) => m.playerId)).toEqual([admin.id]);
    await expect(updateGroup(db, g.id, m1.id, { name: "Nope" })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("weekly slot: due inside the lead window, once per occurrence, reset when the slot changes", async () => {
    const admin = await makePlayer(db, "Weekly");
    const g0 = await createGroup(db, { name: "Thursdays", creatorPlayerId: admin.id, tz: "UTC", venueName: "Court 9" });
    const now = new Date("2026-09-07T10:00:00Z"); // a Monday
    const g = await updateGroup(db, g0.id, admin.id, { recurDow: 4, recurTime: "19:00", recurLeadDays: 5 }); // Thursday 19:00
    const slot = nextGroupSlot(g, now)!;
    expect(slot.date).toBe("2026-09-10");
    expect(slot.startsAt.toISOString()).toBe("2026-09-10T19:00:00.000Z");
    expect(recurrenceDue(g, now)?.toISOString()).toBe("2026-09-10T19:00:00.000Z");
    // 8 days ahead with a 5-day lead: not yet
    expect(recurrenceDue({ ...g, recurLeadDays: 2 }, now)).toBeNull();
    expect(recurrenceDue({ ...g, recurLastCreatedFor: slot.startsAt }, now)).toBeNull();
    expect(recurrenceDue({ ...g, archivedAt: now }, now)).toBeNull();

    const created = await autoCreateGroupMatches(db, now);
    const mine = created.filter((c) => c.group.id === g.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].event.groupId).toBe(g.id);
    expect(mine[0].event.startsAt.toISOString()).toBe("2026-09-10T19:00:00.000Z");
    expect(mine[0].event.venueName).toBe("Court 9");
    const [seat] = await db.select().from(slots).where(and(eq(slots.eventId, mine[0].event.id), eq(slots.playerId, admin.id)));
    expect(seat?.status).toBe("joined");
    // same hour again: nothing
    expect((await autoCreateGroupMatches(db, new Date(now.getTime() + HOUR))).filter((c) => c.group.id === g.id)).toHaveLength(0);
    // next week, inside the lead window again: the following Thursday
    const nextWeek = new Date(now.getTime() + 7 * DAY);
    const again = (await autoCreateGroupMatches(db, nextWeek)).filter((c) => c.group.id === g.id);
    expect(again).toHaveLength(1);
    expect(again[0].event.startsAt.toISOString()).toBe("2026-09-17T19:00:00.000Z");
    // changing the slot forgets the guard
    const moved = await updateGroup(db, g.id, admin.id, { recurDow: 2, recurTime: "18:00" });
    expect(moved.recurLastCreatedFor).toBeNull();
    // switching it off
    const off = await updateGroup(db, g.id, admin.id, { recurDow: null });
    expect(off.recurDow).toBeNull();
    expect(off.recurTime).toBeNull();
    expect(recurrenceDue(off, now)).toBeNull();

    const mineList = await getPlayerGroups(db, admin.id, now);
    const row = mineList.find((r) => r.group.id === g.id)!;
    expect(row.memberCount).toBe(1);
    expect(row.nextEvent?.id).toBe(mine[0].event.id);
  });

  it("play again keeps the group link", async () => {
    const admin = await makePlayer(db, "Again");
    const g = await createGroup(db, { name: "Again crew", creatorPlayerId: admin.id, tz: "UTC" });
    const ev = await createEvent(db, { creatorPlayerId: admin.id, type: "match", startsAt: new Date(Date.now() - 3 * HOUR), tz: "UTC", whenFull: "waitlist", groupId: g.id });
    const copy = await duplicateEvent(db, { sourceEventId: ev.id, creatorPlayerId: admin.id });
    expect(copy.groupId).toBe(g.id);
    const [row] = await db.select().from(events).where(eq(events.id, copy.id));
    expect(row.groupId).toBe(g.id);
    expect(await db.select().from(groupMembers).where(eq(groupMembers.groupId, g.id))).toHaveLength(1);
  });
});
