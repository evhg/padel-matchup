import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events, players, pushSubscriptions, slots } from "@/db/schema";
import { anonymizePlayer } from "@/lib/domain/anonymize";
import { createEvent } from "@/lib/domain/events";
import { changePlayerEmail } from "@/lib/domain/identity";
import { addOptOut, isOptedOut, optOutPath, optOutSignature, removeOptOut } from "@/lib/domain/optouts";
import { takeRate } from "@/lib/domain/ratelimit";
import { joinEvent } from "@/lib/domain/slots";
import { createTestDb, makePlayer, HOUR } from "./helpers/db";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

describe("rate limits", () => {
  it("allows `limit` calls per UTC day, then refuses, and resets on a new day", async () => {
    const day1 = new Date("2026-09-05T10:00:00Z");
    for (let i = 0; i < 3; i++) expect(await takeRate(db, "t", "ip1", 3, "day", day1)).toBe(true);
    expect(await takeRate(db, "t", "ip1", 3, "day", day1)).toBe(false);
    // another id is independent
    expect(await takeRate(db, "t", "ip2", 3, "day", day1)).toBe(true);
    // next day starts fresh
    expect(await takeRate(db, "t", "ip1", 3, "day", new Date("2026-09-06T00:00:01Z"))).toBe(true);
  });
  it("hourly windows are per UTC hour", async () => {
    const h10 = new Date("2026-09-05T10:30:00Z");
    for (let i = 0; i < 2; i++) expect(await takeRate(db, "h", "p", 2, "hour", h10)).toBe(true);
    expect(await takeRate(db, "h", "p", 2, "hour", h10)).toBe(false);
    expect(await takeRate(db, "h", "p", 2, "hour", new Date("2026-09-05T11:00:00Z"))).toBe(true);
  });
});

describe("email opt-outs", () => {
  it("stores normalized addresses, is idempotent, and can be lifted", async () => {
    expect(await isOptedOut(db, "Quiet@Example.com")).toBe(false);
    await addOptOut(db, " Quiet@Example.com ");
    await addOptOut(db, "quiet@example.com");
    expect(await isOptedOut(db, "quiet@example.com")).toBe(true);
    expect(await isOptedOut(db, "QUIET@example.com")).toBe(true);
    expect(await isOptedOut(db, null)).toBe(false);
    await removeOptOut(db, "Quiet@example.com");
    expect(await isOptedOut(db, "quiet@example.com")).toBe(false);
  });
  it("signs unsubscribe links per address", () => {
    const a = optOutSignature("a@example.com");
    expect(a).toHaveLength(20);
    expect(optOutSignature("A@Example.com")).toBe(a);
    expect(optOutSignature("b@example.com")).not.toBe(a);
    expect(optOutPath("A@Example.com")).toBe(`/unsubscribe?e=a%40example.com&s=${a}`);
  });
});

describe("changePlayerEmail", () => {
  it("never blanks an email, keeps the previous one for recovery, and reports what happened", async () => {
    const p = await makePlayer(db, "Eve", { email: "eve@one.io" });
    const kept = await changePlayerEmail(db, p.id, "");
    expect(kept).toMatchObject({ changed: false, kept: true });
    expect(kept.player.email).toBe("eve@one.io");
    const same = await changePlayerEmail(db, p.id, "EVE@one.io");
    expect(same).toMatchObject({ changed: false, kept: false });
    const moved = await changePlayerEmail(db, p.id, "eve@two.io");
    expect(moved.changed).toBe(true);
    expect(moved.player.email).toBe("eve@two.io");
    expect(moved.player.recoveryEmail).toBe("eve@one.io");
  });
});

describe("delete account", () => {
  it("cancels upcoming own matches, leaves joined ones, wipes personal data, keeps the row", async () => {
    const me = await makePlayer(db, "Gone", { email: "gone@example.com", phone: "+6512345678", personalToken: "abcdefghijkl" });
    const host = await makePlayer(db, "Host");
    const other = await makePlayer(db, "Other");
    const mine = await createEvent(db, { creatorPlayerId: me.id, type: "match", startsAt: new Date(Date.now() + HOUR), tz: "UTC", venueName: "Club", whenFull: "waitlist" });
    const theirs = await createEvent(db, { creatorPlayerId: host.id, type: "match", startsAt: new Date(Date.now() + HOUR), tz: "UTC", venueName: "Club", whenFull: "waitlist" });
    await joinEvent(db, { eventId: theirs.id, playerId: me.id });
    await joinEvent(db, { eventId: theirs.id, playerId: other.id });
    await db.insert(pushSubscriptions).values({ playerId: me.id, endpoint: "https://push.example/1", p256dh: "k", auth: "a" });

    const r = await anonymizePlayer(db, me.id);
    expect(r.cancelledEvents.map((e) => e.id)).toEqual([mine.id]);
    expect(r.leftEvents.map((l) => l.event.id)).toEqual([theirs.id]);

    const [row] = await db.select().from(players).where(eq(players.id, me.id));
    expect(row.displayName).toBe("Deleted player");
    expect(row.email).toBeNull();
    expect(row.phone).toBeNull();
    expect(row.personalToken).toBeNull();
    expect(row.emailNotifications).toBe(false);
    const [ev] = await db.select().from(events).where(eq(events.id, mine.id));
    expect(ev.status).toBe("cancelled");
    const stillIn = await db.select().from(slots).where(eq(slots.playerId, me.id));
    expect(stillIn.some((s) => s.eventId === theirs.id)).toBe(false);
    expect(await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.playerId, me.id))).toHaveLength(0);
  });
});
