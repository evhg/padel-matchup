import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events, players, slots, venues } from "@/db/schema";
import { createEvent } from "@/lib/domain/events";
import { consumeEmailCode, findPlayerByPersonalToken, getOrCreatePersonalToken, issueEmailCode, mergePlayers, playersWithEmail, restoreByEmail, rotatePersonalToken } from "@/lib/domain/identity";
import { joinEvent } from "@/lib/domain/slots";
import { createTestDb, makePlayer, HOUR } from "./helpers/db";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

describe("personal link", () => {
  it("issues a stable short token, resolves it, and can rotate it", async () => {
    const p = await makePlayer(db, "Tok");
    const t1 = await getOrCreatePersonalToken(db, p.id);
    expect(t1).toHaveLength(12);
    expect(await getOrCreatePersonalToken(db, p.id)).toBe(t1);
    expect((await findPlayerByPersonalToken(db, t1))?.id).toBe(p.id);
    const t2 = await rotatePersonalToken(db, p.id);
    expect(t2).not.toBe(t1);
    expect(await findPlayerByPersonalToken(db, t1)).toBeNull();
    expect((await findPlayerByPersonalToken(db, t2))?.id).toBe(p.id);
    expect(await findPlayerByPersonalToken(db, "nope")).toBeNull();
  });
});

describe("email codes", () => {
  it("accepts the right code once, rejects wrong/expired ones, rate-limits issuing", async () => {
    const issued = await issueEmailCode(db, " Ana@Example.com ");
    expect(issued?.email).toBe("ana@example.com");
    expect(issued?.code).toMatch(/^\d{6}$/);
    await expect(consumeEmailCode(db, "ana@example.com", "000000")).rejects.toMatchObject({ code: "invalid" });
    expect(await consumeEmailCode(db, "ana@example.com", issued!.code)).toBe("ana@example.com");
    // consumed → cannot reuse
    await expect(consumeEmailCode(db, "ana@example.com", issued!.code)).rejects.toMatchObject({ code: "invalid" });
    // expired
    const old = await issueEmailCode(db, "old@example.com", new Date(Date.now() - 2 * HOUR));
    await expect(consumeEmailCode(db, "old@example.com", old!.code)).rejects.toMatchObject({ code: "invalid" });
    // rate limit: 5 per hour
    for (let i = 0; i < 5; i++) expect(await issueEmailCode(db, "busy@example.com")).not.toBeNull();
    expect(await issueEmailCode(db, "busy@example.com")).toBeNull();
  });
  it("locks a code after too many wrong attempts", async () => {
    const issued = (await issueEmailCode(db, "lock@example.com"))!;
    for (let i = 0; i < 5; i++) await consumeEmailCode(db, "lock@example.com", "111111").catch(() => undefined);
    await expect(consumeEmailCode(db, "lock@example.com", issued.code)).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("merge", () => {
  it("folds a second device identity into the canonical one across events, slots and venues", async () => {
    const phone = await makePlayer(db, "Dana", { email: "dana@x.io" });
    const laptop = await makePlayer(db, "Dana (laptop)");
    const other = await makePlayer(db, "Other");
    const evA = await createEvent(db, { creatorPlayerId: phone.id, type: "match", startsAt: new Date(Date.now() + HOUR), tz: "UTC", venueName: "Club", whenFull: "waitlist" });
    const evB = await createEvent(db, { creatorPlayerId: laptop.id, type: "match", startsAt: new Date(Date.now() + 2 * HOUR), tz: "UTC", venueName: "Club", whenFull: "waitlist" });
    const evC = await createEvent(db, { creatorPlayerId: other.id, type: "match", startsAt: new Date(Date.now() + 3 * HOUR), tz: "UTC", venueName: "Elsewhere", whenFull: "waitlist" });
    await joinEvent(db, { eventId: evA.id, playerId: phone.id });
    await joinEvent(db, { eventId: evA.id, playerId: laptop.id }); // both identities in the same match
    await joinEvent(db, { eventId: evC.id, playerId: laptop.id });

    await mergePlayers(db, phone.id, [laptop.id]);

    expect((await db.select().from(players).where(eq(players.id, laptop.id))).length).toBe(0);
    const [b] = await db.select().from(events).where(eq(events.id, evB.id));
    expect(b.creatorPlayerId).toBe(phone.id);
    const inA = await db.select().from(slots).where(and(eq(slots.eventId, evA.id), eq(slots.playerId, phone.id)));
    expect(inA).toHaveLength(1);
    const emptyA = await db.select().from(slots).where(and(eq(slots.eventId, evA.id), eq(slots.status, "empty")));
    expect(emptyA).toHaveLength(3); // the duplicate slot was freed
    const inC = await db.select().from(slots).where(and(eq(slots.eventId, evC.id), eq(slots.playerId, phone.id)));
    expect(inC).toHaveLength(1);
    const v = await db.select().from(venues).where(eq(venues.creatorPlayerId, phone.id));
    expect(v.map((x) => x.name)).toEqual(["Club"]);
  });

  it("restoreByEmail merges every identity with that email plus the current device, and verifies", async () => {
    const a = await makePlayer(db, "Sam", { email: "sam@x.io" });
    const b = await makePlayer(db, "Sam 2", { email: "sam@x.io" });
    const fresh = await makePlayer(db, "New device");
    const ev = await createEvent(db, { creatorPlayerId: b.id, type: "match", startsAt: new Date(Date.now() + HOUR), tz: "UTC", venueName: "X", whenFull: "waitlist" });
    await joinEvent(db, { eventId: ev.id, playerId: fresh.id });
    const canonical = await restoreByEmail(db, "sam@x.io", fresh.id);
    expect(canonical.id).toBe(a.id); // oldest with that email
    expect(canonical.emailVerifiedAt).toBeTruthy();
    const remaining = await db.select().from(players).where(eq(players.email, "sam@x.io"));
    expect(remaining).toHaveLength(1);
    const [e] = await db.select().from(events).where(eq(events.id, ev.id));
    expect(e.creatorPlayerId).toBe(a.id);
    const mine = await db.select().from(slots).where(and(eq(slots.eventId, ev.id), eq(slots.playerId, a.id)));
    expect(mine).toHaveLength(1);
    expect((await db.select().from(players).where(eq(players.id, fresh.id))).length).toBe(0);
  });
});

describe("email change safety", () => {
  it("keeps the previous address for restores and refuses to blank an existing one", async () => {
    const { changePlayerEmail } = await import("@/lib/domain/identity");
    const p = await makePlayer(db, "Change", { email: "old@example.com" });
    const kept = await changePlayerEmail(db, p.id, "");
    expect(kept.kept).toBe(true);
    expect(kept.player.email).toBe("old@example.com");
    const changed = await changePlayerEmail(db, p.id, "New@Example.com");
    expect(changed.changed).toBe(true);
    expect(changed.player.email).toBe("new@example.com");
    expect(changed.player.recoveryEmail).toBe("old@example.com");
    // Both addresses find the identity; a code to the old one restores it.
    expect((await playersWithEmail(db, "old@example.com")).map((x) => x.id)).toContain(p.id);
    expect((await playersWithEmail(db, "new@example.com")).map((x) => x.id)).toContain(p.id);
    const restored = await restoreByEmail(db, "old@example.com", null);
    expect(restored.id).toBe(p.id);
  });
});
