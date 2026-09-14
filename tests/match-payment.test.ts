import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { createEvent } from "@/lib/domain/events";
import { claimSlotPaid, joinEvent, paymentsFor, setSlotPaid } from "@/lib/domain/slots";
import { createTestDb, makePlayer, HOUR } from "./helpers/db";
import { freezeClock } from "./helpers/clock";

/**
 * No money passes through Kicksmash, so the app can only remember two different claims by two
 * different people: the player says it is sent, the organiser says it arrived. One flag would let
 * either side write the other's sentence, which is the whole reason there are two fields.
 */
const NOW = new Date("2026-09-16T09:00:00.000Z");
freezeClock(NOW);

describe("who has paid for a match", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  const aMatch = async (name: string) => {
    const org = await makePlayer(db, `${name} organiser`);
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() + 48 * HOUR), tz: "Asia/Bangkok", whenFull: "waitlist", cost: "400 ฿" });
    const player = await makePlayer(db, `${name} player`);
    await joinEvent(db, { eventId: ev.id, playerId: org.id });
    await joinEvent(db, { eventId: ev.id, playerId: player.id });
    return { org, ev, player };
  };

  it("starts with nobody having said anything", async () => {
    const { ev } = await aMatch("Olga");
    const rows = await paymentsFor(db, ev.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.claimedAt === null && r.paidAt === null)).toBe(true);
  });

  it("lets a player say they have paid, and the organiser say it arrived", async () => {
    const { org, ev, player } = await aMatch("Nok");
    expect(await claimSlotPaid(db, { eventId: ev.id, playerId: player.id })).toBe(true);
    const claimed = (await paymentsFor(db, ev.id)).find((r) => r.playerId === player.id)!;
    expect(claimed.claimedAt).not.toBeNull();
    // A claim is not an answer: until the organiser taps, nothing is settled.
    expect(claimed.paidAt).toBeNull();

    expect(await setSlotPaid(db, { eventId: ev.id, slotId: claimed.slotId, actorPlayerId: org.id, paid: true })).toBe(true);
    expect((await paymentsFor(db, ev.id)).find((r) => r.playerId === player.id)!.paidAt).not.toBeNull();
  });

  it("lets the organiser take it back, for the money that never actually arrived", async () => {
    const { org, ev, player } = await aMatch("Ana");
    const row = (await paymentsFor(db, ev.id)).find((r) => r.playerId === player.id)!;
    await setSlotPaid(db, { eventId: ev.id, slotId: row.slotId, actorPlayerId: org.id, paid: true });
    await setSlotPaid(db, { eventId: ev.id, slotId: row.slotId, actorPlayerId: org.id, paid: false });
    expect((await paymentsFor(db, ev.id)).find((r) => r.playerId === player.id)!.paidAt).toBeNull();
  });

  it("refuses anyone but the organiser, including the player whose own row it is", async () => {
    const { ev, player } = await aMatch("Bea");
    const row = (await paymentsFor(db, ev.id)).find((r) => r.playerId === player.id)!;
    await expect(setSlotPaid(db, { eventId: ev.id, slotId: row.slotId, actorPlayerId: player.id, paid: true })).rejects.toThrow(/forbidden/);
    expect((await paymentsFor(db, ev.id)).find((r) => r.playerId === player.id)!.paidAt).toBeNull();
  });

  it("will not let a player un-say a confirmed payment by claiming again", async () => {
    const { org, ev, player } = await aMatch("Cara");
    const row = (await paymentsFor(db, ev.id)).find((r) => r.playerId === player.id)!;
    await setSlotPaid(db, { eventId: ev.id, slotId: row.slotId, actorPlayerId: org.id, paid: true });
    // Already settled: the claim finds nothing to write.
    expect(await claimSlotPaid(db, { eventId: ev.id, playerId: player.id })).toBe(false);
    expect((await paymentsFor(db, ev.id)).find((r) => r.playerId === player.id)!.paidAt).not.toBeNull();
  });

  it("only ever knows about people who are actually in the match", async () => {
    const { ev } = await aMatch("Dee");
    const stranger = await makePlayer(db, "Stranger");
    expect(await claimSlotPaid(db, { eventId: ev.id, playerId: stranger.id })).toBe(false);
    expect((await paymentsFor(db, ev.id)).some((r) => r.playerId === stranger.id)).toBe(false);
  });
});
