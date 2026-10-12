import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import type { Db } from "@/db";
import { metricsDaily, players, slots } from "@/db/schema";
import { createEvent } from "@/lib/domain/events";
import { restoreByEmail } from "@/lib/domain/identity";
import { mergePlayers } from "@/lib/domain/merge";
import { claimSameNameRow } from "@/lib/domain/sameName";
import { MERGE_DOORS, type MergeDoor } from "@/lib/domain/signins";
import { confirmInvite, joinEvent, reserveSlot } from "@/lib/domain/slots";
import { mergesLater } from "@/lib/mergeCount";
import { linkTelegram } from "@/lib/telegram/identity";
import { freezeClock } from "./helpers/clock";
import { createTestDb, DAY, makePlayer } from "./helpers/db";

/**
 * Every merge of two player records counts itself, by the door that folded them (`merge_<door>` in
 * `metrics_daily`, the number of records that went). Until 12 October 2026 nothing counted a merge,
 * so the owner could not see how often one person ended up with two records, or which door found it.
 */

// A fixed clock (rule 11): matches start a day or two after NOW, and every count lands on its day.
const NOW = new Date(Date.UTC(2026, 9, 12, 4, 0));
const at = (days: number) => new Date(NOW.getTime() + days * DAY);
freezeClock(NOW);

describe("merges are counted by their door", () => {
  let db: Db;
  let close: () => Promise<void>;
  let n = 0;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  const counted = async (door: MergeDoor) => Number((await db.select().from(metricsDaily).where(eq(metricsDaily.key, `merge_${door}`)))[0]?.value ?? 0);
  const all = async () => Object.fromEntries((await db.select().from(metricsDaily).where(like(metricsDaily.key, "merge_%"))).map((r) => [r.key, Number(r.value)]));
  const exists = async (id: string) => (await db.select({ id: players.id }).from(players).where(eq(players.id, id))).length === 1;
  const match = async (organiser: { id: string }, days: number, ...seated: { id: string }[]) => {
    const ev = await createEvent(db, { creatorPlayerId: organiser.id, type: "match", startsAt: at(days), tz: "Asia/Bangkok", whenFull: "closed", venueName: `Club ${++n}` });
    for (const p of seated) await joinEvent(db, { eventId: ev.id, playerId: p.id, now: NOW });
    return ev;
  };

  it("names the keys it writes, one per door, each a plain word", () => {
    expect(MERGE_DOORS.map((d) => `merge_${d}`)).toEqual(["merge_operator", "merge_email_code", "merge_same_name", "merge_same_name_claim", "merge_claim", "merge_thats_me", "merge_held_link", "merge_telegram", "merge_whatsapp"]);
    for (const d of MERGE_DOORS) expect(d).toMatch(/^[a-z_]+$/);
  });

  it("an email code that comes back folds the address's other record and counts merge_email_code, and the same-name row it then folds as merge_same_name", async () => {
    const before = await all();
    const org = await makePlayer(db, "Micky", { email: "micky@example.com" });
    // The proved record: a code from this address came back before, so it is the one that stays.
    const nacho = await makePlayer(db, "Nacho Garcia", { email: "nacho@example.com", emailVerifiedAt: NOW });
    const sameAddress = await makePlayer(db, "N. Garcia", { email: "nacho@example.com" });
    // The same person in a browser that did not know him, with a seat beside the same organiser.
    const sameName = await makePlayer(db, "nacho  garcia");
    await match(org, 1, nacho);
    await match(org, 2, sameName);
    await restoreByEmail(db, "nacho@example.com", nacho.id);
    expect(await exists(sameAddress.id)).toBe(false);
    expect(await exists(sameName.id)).toBe(false);
    expect(await counted("email_code")).toBe((before.merge_email_code ?? 0) + 1);
    expect(await counted("same_name")).toBe((before.merge_same_name ?? 0) + 1);
  });

  it("a Telegram account another record already held counts merge_telegram, whichever record survives", async () => {
    const before = await counted("telegram");
    const bot = await makePlayer(db, "Nina", { telegramId: 4401 });
    const web = await makePlayer(db, "Nina Web");
    const kept = await linkTelegram(db, web.id, { id: 4401, first_name: "Nina", username: "nina_tg" });
    expect([bot.id, web.id]).toContain(kept.id);
    expect(await counted("telegram")).toBe(before + 1);
    // Linked again: nothing left to fold, nothing counted.
    await linkTelegram(db, kept.id, { id: 4401, first_name: "Nina", username: "nina_tg" });
    expect(await counted("telegram")).toBe(before + 1);
  });

  it("\"These are mine\" counts merge_same_name_claim, and a refused claim counts nothing", async () => {
    const before = await counted("same_name_claim");
    const org1 = await makePlayer(db, "Org One", { email: "org1@example.com" });
    const org2 = await makePlayer(db, "Org Two", { email: "org2@example.com" });
    const alex = await makePlayer(db, "Alex", { email: "alex@example.com", emailVerifiedAt: NOW });
    const other = await makePlayer(db, "Alex");
    await match(org1, 1, alex);
    await match(org2, 2, other);
    expect(await claimSameNameRow(db, alex.id, other.id)).toBe(true);
    expect(await counted("same_name_claim")).toBe(before + 1);
    const stranger = await makePlayer(db, "Somebody Else");
    expect(await claimSameNameRow(db, alex.id, stranger.id)).toBe(false);
    expect(await counted("same_name_claim")).toBe(before + 1);
  });

  it("a held place's link that folds its placeholder counts merge_held_link once its transaction is done, through the counter a request hands in", async () => {
    const before = await counted("held_link");
    const org = await makePlayer(db, `Host ${++n}`, { email: `host${n}@example.com` });
    const ev = await match(org, 2, org);
    const { slot } = await reserveSlot(db, { eventId: ev.id, actorPlayerId: org.id, name: "Pat", now: NOW });
    // A tournament's placeholder: a record on the place with no life outside this match.
    const placeholder = await makePlayer(db, "Pat");
    await db.update(slots).set({ playerId: placeholder.id }).where(eq(slots.id, slot.id));
    const pat = await makePlayer(db, "Pat Real");
    const told: [MergeDoor, number][] = [];
    const res = await confirmInvite(db, { inviteCode: slot.inviteCode!, playerId: pat.id, now: NOW, counter: async (door, records) => void told.push([door, records]) });
    expect(res.outcome).toBe("confirmed");
    expect(await exists(placeholder.id)).toBe(false);
    // Handed to the request's counter once, after the write; nothing written in the path itself.
    expect(told).toEqual([["held_link", 1]]);
    expect(await counted("held_link")).toBe(before);
    // With no counter (a script, a test), the count is written at once.
    const { slot: second } = await reserveSlot(db, { eventId: ev.id, actorPlayerId: org.id, name: "Quin", now: NOW });
    const ph2 = await makePlayer(db, "Quin");
    await db.update(slots).set({ playerId: ph2.id }).where(eq(slots.id, second.id));
    await confirmInvite(db, { inviteCode: second.inviteCode!, playerId: (await makePlayer(db, "Quin Real")).id, now: NOW });
    expect(await counted("held_link")).toBe(before + 1);
    // A link with no placeholder behind it folds nobody and counts nothing.
    const { slot: third } = await reserveSlot(db, { eventId: ev.id, actorPlayerId: org.id, name: "Rui", now: NOW });
    await confirmInvite(db, { inviteCode: third.inviteCode!, playerId: (await makePlayer(db, "Rui")).id, now: NOW });
    expect(await counted("held_link")).toBe(before + 1);
    expect((await db.select().from(slots).where(and(eq(slots.eventId, ev.id), eq(slots.status, "confirmed")))).length).toBe(3);
  });

  it("the operator's merge counts every record that went, through the after-answer counter, which writes at once outside a request", async () => {
    const before = await counted("operator");
    const keep = await makePlayer(db, "Erik");
    const a = await makePlayer(db, "Erik");
    const b = await makePlayer(db, "erik");
    expect(await mergePlayers(db, keep.id, [a.id, b.id, keep.id], { door: "operator", counter: mergesLater(db) })).toBe(2);
    expect(await counted("operator")).toBe(before + 2);
    // Nothing to fold: no transaction, no count.
    expect(await mergePlayers(db, keep.id, [keep.id], { door: "operator", counter: mergesLater(db) })).toBe(0);
    expect(await counted("operator")).toBe(before + 2);
  });
});
