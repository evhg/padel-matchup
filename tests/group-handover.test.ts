import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { groupMembers, groups } from "@/db/schema";
import { createEvent } from "@/lib/domain/events";
import { createGroup, getGroupDetail, handOverGroup, joinGroup, leaveGroup, removeGroupMember } from "@/lib/domain/groups";
import { joinEvent } from "@/lib/domain/slots";
import { fillOf, withCounts } from "@/lib/domain/venueBoard";
import { freezeClock } from "./helpers/clock";
import { createTestDb, makePlayer, DAY } from "./helpers/db";

// A Thursday morning in Bangkok; every match below is two or three days after it.
const NOW = new Date("2026-09-10T02:00:00Z");
freezeClock(NOW);

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

const roleOf = async (groupId: string, playerId: string) => (await db.select({ role: groupMembers.role }).from(groupMembers).where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.playerId, playerId))))[0]?.role ?? null;

describe("handing a group over", () => {
  it("the admin hands it to a current member: both marks move, the old admin stays and may now leave", async () => {
    const olga = await makePlayer(db, "Olga");
    const bea = await makePlayer(db, "Bea");
    const cal = await makePlayer(db, "Cal");
    const g = await createGroup(db, { name: "Thursday crew", creatorPlayerId: olga.id, tz: "Asia/Bangkok", memberIds: [bea.id, cal.id] });

    const handed = await handOverGroup(db, g.id, olga.id, bea.id);
    expect(handed.creatorPlayerId).toBe(bea.id);
    expect(await roleOf(g.id, bea.id)).toBe("admin");
    expect(await roleOf(g.id, olga.id)).toBe("member");
    expect(await roleOf(g.id, cal.id)).toBe("member");
    const detail = await getGroupDetail(db, handed, NOW);
    expect(detail.members.filter((m) => m.role === "admin").map((m) => m.playerId)).toEqual([bea.id]);
    expect(detail.members).toHaveLength(3);
    // The new admin runs it: removing somebody works for Bea, and no longer for Olga.
    await expect(removeGroupMember(db, g.id, olga.id, cal.id)).rejects.toMatchObject({ code: "forbidden" });
    // The hand-over is one way: Olga cannot take it back.
    await expect(handOverGroup(db, g.id, olga.id, olga.id)).rejects.toMatchObject({ code: "forbidden" });
    // Olga is a plain member now, so she can leave; Bea, the admin, cannot.
    await leaveGroup(db, g.id, olga.id);
    await expect(leaveGroup(db, g.id, bea.id)).rejects.toMatchObject({ code: "forbidden" });
    await removeGroupMember(db, g.id, bea.id, cal.id);
    expect((await getGroupDetail(db, handed, NOW)).members.map((m) => m.playerId)).toEqual([bea.id]);
  });

  it("only the admin can hand it over", async () => {
    const olga = await makePlayer(db, "Olga");
    const bea = await makePlayer(db, "Bea");
    const cal = await makePlayer(db, "Cal");
    const stranger = await makePlayer(db, "Stranger");
    const g = await createGroup(db, { name: "Sunday crew", creatorPlayerId: olga.id, tz: "Asia/Bangkok", memberIds: [bea.id, cal.id] });
    // A member hands it to another member, or to themselves: refused, and nothing moves.
    await expect(handOverGroup(db, g.id, bea.id, cal.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(handOverGroup(db, g.id, bea.id, bea.id)).rejects.toMatchObject({ code: "forbidden" });
    // Somebody outside the group: refused too.
    await expect(handOverGroup(db, g.id, stranger.id, bea.id)).rejects.toMatchObject({ code: "forbidden" });
    const [row] = await db.select().from(groups).where(eq(groups.id, g.id));
    expect(row.creatorPlayerId).toBe(olga.id);
    expect(await roleOf(g.id, olga.id)).toBe("admin");
    expect(await roleOf(g.id, bea.id)).toBe("member");
  });

  it("only to somebody in the group now", async () => {
    const olga = await makePlayer(db, "Olga");
    const bea = await makePlayer(db, "Bea");
    const stranger = await makePlayer(db, "Stranger");
    const g = await createGroup(db, { name: "Late crew", creatorPlayerId: olga.id, tz: "Asia/Bangkok", memberIds: [bea.id] });
    await expect(handOverGroup(db, g.id, olga.id, stranger.id)).rejects.toMatchObject({ code: "not_member" });
    // Bea was a member and left: she is not one now.
    await leaveGroup(db, g.id, bea.id);
    await expect(handOverGroup(db, g.id, olga.id, bea.id)).rejects.toMatchObject({ code: "not_member" });
    // To yourself is not a hand-over.
    await expect(handOverGroup(db, g.id, olga.id, olga.id)).rejects.toMatchObject({ code: "invalid" });
    const [row] = await db.select().from(groups).where(eq(groups.id, g.id));
    expect(row.creatorPlayerId).toBe(olga.id);
    expect(await roleOf(g.id, olga.id)).toBe("admin");
    // A player who rejoins is a member again and can take it.
    await joinGroup(db, g.id, bea.id, "self");
    expect((await handOverGroup(db, g.id, olga.id, bea.id)).creatorPlayerId).toBe(bea.id);
  });
});

describe("the seats on a group's upcoming rows", () => {
  it("counts every row's seats in one read, and says spots left, full, or a tournament's field", async () => {
    const org = await makePlayer(db, "Org");
    const others = await Promise.all(["A", "B", "C", "D", "E"].map((n) => makePlayer(db, n)));
    const at = (days: number) => new Date(NOW.getTime() + days * DAY);
    const open = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: at(2), tz: "Asia/Bangkok", whenFull: "waitlist", capacity: 4 });
    const full = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: at(2), tz: "Asia/Bangkok", whenFull: "closed", capacity: 4 });
    const cup = await createEvent(db, { creatorPlayerId: org.id, type: "tournament", startsAt: at(3), tz: "Asia/Bangkok", whenFull: "waitlist", capacity: 8 });
    for (const p of [org, others[0]]) await joinEvent(db, { eventId: open.id, playerId: p.id, now: NOW });
    for (const p of [org, ...others.slice(0, 3)]) await joinEvent(db, { eventId: full.id, playerId: p.id, now: NOW });
    for (const p of [org, ...others]) await joinEvent(db, { eventId: cup.id, playerId: p.id, now: NOW });

    const select = vi.spyOn(db, "select");
    const counted = await withCounts(db, [open, full, cup]);
    expect(select).toHaveBeenCalledTimes(1);
    select.mockRestore();

    const by = new Map(counted.map((b) => [b.event.id, b]));
    expect(by.get(open.id)).toMatchObject({ occupied: 2, spotsLeft: 2 });
    expect(by.get(full.id)).toMatchObject({ occupied: 4, spotsLeft: 0 });
    expect(by.get(cup.id)).toMatchObject({ occupied: 6, spotsLeft: 2 });
    expect(fillOf(by.get(open.id)!)).toEqual({ kind: "left", count: 2 });
    expect(fillOf(by.get(full.id)!)).toEqual({ kind: "full" });
    expect(fillOf(by.get(cup.id)!)).toEqual({ kind: "field", count: 6, capacity: 8 });
    // A full tournament says full, like a match.
    expect(fillOf({ event: { type: "tournament", capacity: 8 }, occupied: 8, spotsLeft: 0 })).toEqual({ kind: "full" });
    expect(await withCounts(db, [])).toEqual([]);
  });
});
