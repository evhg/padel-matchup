import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { players, slots } from "@/db/schema";
import { createEvent } from "@/lib/domain/events";
import { confirmInvite, declineInvite, joinEvent, reserveSlot } from "@/lib/domain/slots";
import { getRolodex } from "@/lib/domain/queries";
import { createTestDb, makePlayer, HOUR } from "./helpers/db";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

const future = () => new Date(Date.now() + 24 * HOUR);

describe("invite transitions", () => {
  it("invited → confirmed binds the player and stores an email", async () => {
    const creator = await makePlayer(db, "Org");
    const ev = await createEvent(db, { creatorPlayerId: creator.id, type: "match", startsAt: future(), tz: "UTC", venueName: "V", whenFull: "waitlist" });
    const { slot } = await reserveSlot(db, { eventId: ev.id, actorPlayerId: creator.id, name: "Nina", phone: "+34 600 000 000" });
    expect(slot.status).toBe("invited");
    expect(slot.kind).toBe("reserved");
    expect(slot.inviteCode).toHaveLength(6);
    expect(slot.invitedPhone).toBe("+34600000000");

    const nina = await makePlayer(db, "Nina");
    const res = await confirmInvite(db, { inviteCode: slot.inviteCode!, playerId: nina.id, email: "Nina@Example.com " });
    expect(res.outcome).toBe("confirmed");
    if (res.outcome !== "confirmed") throw new Error();
    expect(res.slot.playerId).toBe(nina.id);
    expect(res.slot.invitedEmail).toBe("nina@example.com");
    const [p] = await db.select().from(players).where(eq(players.id, nina.id));
    expect(p.email).toBe("nina@example.com");

    // Confirming again is a no-op for the same player; another player finds it gone.
    expect((await confirmInvite(db, { inviteCode: slot.inviteCode!, playerId: nina.id })).outcome).toBe("already_confirmed");
    const other = await makePlayer(db, "Other");
    expect((await confirmInvite(db, { inviteCode: slot.inviteCode!, playerId: other.id })).outcome).toBe("gone");
  });

  it("invited → declined converts the slot into an open spot", async () => {
    const creator = await makePlayer(db, "Org2");
    const ev = await createEvent(db, { creatorPlayerId: creator.id, type: "match", startsAt: future(), tz: "UTC", venueName: "V", whenFull: "waitlist" });
    const { slot } = await reserveSlot(db, { eventId: ev.id, actorPlayerId: creator.id, name: "Max" });
    const res = await declineInvite(db, { inviteCode: slot.inviteCode! });
    expect(res.outcome).toBe("declined");
    expect((await declineInvite(db, { inviteCode: slot.inviteCode! })).outcome).toBe("already_declined");

    // Walk-in can now claim it (declined = open).
    const p = await makePlayer(db, "Walkin");
    const j = await joinEvent(db, { eventId: ev.id, playerId: p.id });
    expect(j.outcome).toBe("joined");
    if (j.outcome !== "joined") throw new Error();
    expect(j.slot.position).toBe(slot.position);
    expect(j.slot.kind).toBe("open");
    expect(j.slot.invitedName).toBeNull();
    // Invite link is dead afterwards (code was cleared when the slot was claimed).
    await expect(confirmInvite(db, { inviteCode: slot.inviteCode!, playerId: p.id })).rejects.toMatchObject({ code: "not_found" });
  });

  it("declining with a waitlist promotes the first waitlisted player", async () => {
    const creator = await makePlayer(db, "Org3");
    const ev = await createEvent(db, { creatorPlayerId: creator.id, type: "match", startsAt: future(), tz: "UTC", venueName: "V", whenFull: "waitlist" });
    const { slot } = await reserveSlot(db, { eventId: ev.id, actorPlayerId: creator.id, name: "Reserved" });
    const ps = [];
    for (let i = 0; i < 4; i++) {
      const p = await makePlayer(db, `J${i}`);
      ps.push(p);
      await joinEvent(db, { eventId: ev.id, playerId: p.id });
    }
    // 3 joined in roster + 1 reserved = full; 4th player waitlisted.
    const rows = await db.select().from(slots).where(eq(slots.eventId, ev.id));
    expect(rows.filter((s) => s.position > 4)).toHaveLength(1);

    const res = await declineInvite(db, { inviteCode: slot.inviteCode! });
    expect(res.outcome).toBe("declined");
    if (res.outcome !== "declined") throw new Error();
    expect(res.promotion?.playerId).toBe(ps[3].id);
    expect(res.event.status).toBe("full");
  });

  it("a player who already joined via the public link releases their reservation on confirm", async () => {
    const creator = await makePlayer(db, "Org4");
    const ev = await createEvent(db, { creatorPlayerId: creator.id, type: "match", startsAt: future(), tz: "UTC", venueName: "V", whenFull: "waitlist" });
    const { slot } = await reserveSlot(db, { eventId: ev.id, actorPlayerId: creator.id, name: "Zed" });
    const zed = await makePlayer(db, "Zed");
    await joinEvent(db, { eventId: ev.id, playerId: zed.id });
    const res = await confirmInvite(db, { inviteCode: slot.inviteCode!, playerId: zed.id });
    expect(res.outcome).toBe("already_in");
    const [released] = await db.select().from(slots).where(eq(slots.id, slot.id));
    expect(released.status).toBe("empty");
    expect(released.inviteCode).toBeNull();
  });

  it("rolodex remembers everyone who joined or was invited, with their contact fields", async () => {
    const creator = await makePlayer(db, "Org5");
    const ev = await createEvent(db, { creatorPlayerId: creator.id, type: "match", startsAt: future(), tz: "UTC", venueName: "V", whenFull: "waitlist" });
    await reserveSlot(db, { eventId: ev.id, actorPlayerId: creator.id, name: "Lena", email: "lena@x.io", phone: "+1 555 1234" });
    const bob = await makePlayer(db, "Bob", { email: "bob@x.io" });
    await joinEvent(db, { eventId: ev.id, playerId: bob.id });
    const list = await getRolodex(db, creator.id);
    const names = list.map((e) => e.name).sort();
    expect(names).toEqual(["Bob", "Lena"]);
    expect(list.find((e) => e.name === "Lena")).toMatchObject({ email: "lena@x.io", phone: "+15551234" });
    expect(list.find((e) => e.name === "Bob")).toMatchObject({ email: "bob@x.io", playerId: bob.id });
  });
});
