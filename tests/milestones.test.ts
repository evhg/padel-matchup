import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events, scores, slots } from "@/db/schema";
import { createEvent } from "@/lib/domain/events";
import { awardMilestones, detectMilestones, listMilestones } from "@/lib/domain/milestones";
import { getEventPhoto, PHOTO_MAX_BYTES, removeEventPhoto, setEventPhoto } from "@/lib/domain/photos";
import type { MyEvent } from "@/lib/domain/queries";
import { joinEvent } from "@/lib/domain/slots";
import { createTestDb, makePlayer, DAY, HOUR } from "./helpers/db";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

const ev = (i: number, o: Partial<MyEvent> & { outcome?: MyEvent["outcome"]; type?: "match" | "tournament"; placement?: number | null }): MyEvent =>
  ({
    event: { id: `e${i}`, type: o.type ?? "match", status: "past", capacity: o.type === "tournament" ? 8 : 4, startsAt: new Date(2026, 0, 30 - i), standings: o.type === "tournament" ? ["p", "q", "r"] : null } as unknown as MyEvent["event"],
    slot: { position: 1, team: "a", status: "joined" } as unknown as MyEvent["slot"],
    scores: [],
    outcome: o.outcome ?? null,
    placement: o.placement ?? null,
    playerCount: o.type === "tournament" ? 8 : 4,
    isCreator: false,
  }) as MyEvent;

describe("moments, detected", () => {
  it("first win, only once, and not for a loss", () => {
    const past = [ev(0, { outcome: "won" }), ev(1, { outcome: "lost" }), ev(2, { outcome: "lost" })];
    expect(detectMilestones("me", "e0", past, new Map()).map((d) => d.kind)).toEqual(["first_win"]);
    const second = [ev(0, { outcome: "won" }), ev(1, { outcome: "won" })];
    expect(detectMilestones("me", "e0", second, new Map()).map((d) => d.kind)).toEqual([]);
    expect(detectMilestones("me", "e1", second, new Map()).map((d) => d.kind)).toEqual(["first_win"]);
    expect(detectMilestones("me", "e0", [ev(0, { outcome: "lost" })], new Map())).toEqual([]);
  });

  it("the tenth match, three wins in a row (not four), ten partners, a band up, a podium", () => {
    const ten = Array.from({ length: 10 }, (_, i) => ev(i, { outcome: i % 2 ? "lost" : "won" }));
    expect(detectMilestones("me", "e0", ten, new Map()).map((d) => d.kind)).toContain("matches_10");
    expect(detectMilestones("me", "e0", ten.slice(0, 9), new Map()).map((d) => d.kind)).not.toContain("matches_10");
    const streak = [ev(0, { outcome: "won" }), ev(1, { outcome: "won" }), ev(2, { outcome: "won" }), ev(3, { outcome: "lost" })];
    expect(detectMilestones("me", "e0", streak, new Map()).map((d) => d.kind)).toContain("streak_3");
    const four = [ev(0, { outcome: "won" }), ev(1, { outcome: "won" }), ev(2, { outcome: "won" }), ev(3, { outcome: "won" })];
    expect(detectMilestones("me", "e0", four, new Map()).map((d) => d.kind)).not.toContain("streak_3");
    const partners = new Map(Array.from({ length: 10 }, (_, i) => [`e${i}`, [`partner${i}`]]));
    expect(detectMilestones("me", "e0", ten, partners).map((d) => d.kind)).toContain("partners_10");
    expect(detectMilestones("me", "e0", ten.slice(0, 9), partners).map((d) => d.kind)).not.toContain("partners_10");
    expect(detectMilestones("me", "e0", [ev(0, { outcome: "won" }), ev(1, { outcome: "won" })], new Map(), { playerId: "me", from: 2.4, to: 2.55 })).toEqual(expect.arrayContaining([{ kind: "level_up", value: "intermediate" }]));
    expect(detectMilestones("me", "e0", [ev(0, { outcome: "won" }), ev(1, { outcome: "won" })], new Map(), { playerId: "me", from: 2.6, to: 2.7 }).map((d) => d.kind)).not.toContain("level_up");
    const podium = [ev(0, { type: "tournament", placement: 2 })];
    expect(detectMilestones("me", "e0", podium, new Map())).toEqual(expect.arrayContaining([{ kind: "podium", value: "e0:2" }]));
    expect(detectMilestones("me", "e0", [ev(0, { type: "tournament", placement: 5 })], new Map()).some((d) => d.kind === "podium")).toBe(false);
  });
});

describe("moments, awarded", () => {
  it("awards a first win once for the winners of a confirmed match, never for the losers", async () => {
    const [a, b, c, d] = await Promise.all(["Ana", "Bo", "Cy", "Di"].map((n) => makePlayer(db, n)));
    const startsAt = new Date(Date.now() - 3 * HOUR);
    const e = await createEvent(db, { creatorPlayerId: a.id, type: "match", startsAt, tz: "UTC", whenFull: "closed" });
    for (const p of [a, b, c, d]) await joinEvent(db, { eventId: e.id, playerId: p.id }).catch(() => undefined);
    await db.update(slots).set({ team: "a" }).where(eq(slots.playerId, a.id));
    await db.update(slots).set({ team: "a" }).where(eq(slots.playerId, b.id));
    await db.update(slots).set({ team: "b" }).where(eq(slots.playerId, c.id));
    await db.update(slots).set({ team: "b" }).where(eq(slots.playerId, d.id));
    await db.insert(scores).values([{ eventId: e.id, setNumber: 1, sideA: 6, sideB: 3, enteredByPlayerId: a.id }]);
    await db.update(events).set({ status: "past", scoreLockedByCreator: true }).where(eq(events.id, e.id));
    const first = await awardMilestones(db, e.id);
    expect(first.map((x) => [x.player.displayName, x.milestone.kind]).sort()).toEqual([["Ana", "first_win"], ["Bo", "first_win"]]);
    expect(await awardMilestones(db, e.id)).toEqual([]);
    expect((await listMilestones(db, a.id)).map((m) => m.kind)).toEqual(["first_win"]);
    expect(await listMilestones(db, c.id)).toEqual([]);
  });
});

describe("the court photo", () => {
  it("takes one small picture from a participant after the start, replaces it, and lets the uploader or the organizer remove it", async () => {
    const org = await makePlayer(db, "Org");
    const mate = await makePlayer(db, "Mate");
    const stranger = await makePlayer(db, "Stranger");
    const e = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(Date.now() - HOUR), tz: "UTC", whenFull: "closed" });
    await joinEvent(db, { eventId: e.id, playerId: mate.id });
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");
    await expect(setEventPhoto(db, { eventId: e.id, playerId: stranger.id, mime: "image/png", dataBase64: png })).rejects.toMatchObject({ code: "forbidden" });
    await expect(setEventPhoto(db, { eventId: e.id, playerId: mate.id, mime: "image/gif", dataBase64: png })).rejects.toMatchObject({ code: "invalid" });
    await expect(setEventPhoto(db, { eventId: e.id, playerId: mate.id, mime: "image/png", dataBase64: "A".repeat(Math.ceil((PHOTO_MAX_BYTES + 10) * 4 / 3)) })).rejects.toMatchObject({ code: "invalid" });
    const future = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(Date.now() + DAY), tz: "UTC", whenFull: "closed" });
    await expect(setEventPhoto(db, { eventId: future.id, playerId: org.id, mime: "image/png", dataBase64: png })).rejects.toMatchObject({ code: "not_started" });
    const saved = await setEventPhoto(db, { eventId: e.id, playerId: mate.id, mime: "image/png", dataBase64: png });
    expect(saved.uploadedByPlayerId).toBe(mate.id);
    const replaced = await setEventPhoto(db, { eventId: e.id, playerId: org.id, mime: "image/jpeg", dataBase64: png });
    expect(replaced.mime).toBe("image/jpeg");
    await expect(removeEventPhoto(db, e.id, stranger.id)).rejects.toMatchObject({ code: "forbidden" });
    await removeEventPhoto(db, e.id, mate.id).catch(() => undefined); // mate no longer the uploader: forbidden, swallowed
    expect(await getEventPhoto(db, e.id)).not.toBeNull();
    await removeEventPhoto(db, e.id, org.id);
    expect(await getEventPhoto(db, e.id)).toBeNull();
  });
});
