import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { materialKey, postCard, postCardsForGroup, postResult, sendReminders, syncCards, type Card, type CardChannel, type Room } from "@/lib/channels";
import { createEvent } from "@/lib/domain/events";
import { createGroup } from "@/lib/domain/groups";
import { getEventByCode, type EventDetail } from "@/lib/domain/queries";
import { saveMatchScore } from "@/lib/domain/scores";
import { joinEvent } from "@/lib/domain/slots";
import { freezeClock } from "./helpers/clock";
import { createTestDb, DAY, HOUR, makePlayer } from "./helpers/db";

/**
 * The card algorithm proven on a channel that exists only here: rooms and cards in memory, every call
 * to the transport counted. Telegram and Discord are two adapters over the same algorithm; a LINE
 * adapter would be a third, with `canEdit: false`, which the last test covers.
 */
const NOW = new Date("2026-09-08T09:00:00Z");
freezeClock(NOW);

type Payload = { text: string; occupied: number };
type FakeRoom = { key: string; locale: "en" | "ru"; groupId: string | null; type: string };
type FakeCard = { id: string; eventId: string; roomKey: string; messageId: number; kind: string; rendered: string | null; completeNotedAt: Date | null };

function fakeChannel(o: { canEdit: boolean; enabled?: boolean }) {
  const rooms: FakeRoom[] = [];
  const cards: FakeCard[] = [];
  const sent: { room: string; kind: "post" | "edit" | "note" | "result"; text: string; silent?: boolean }[] = [];
  const reminded = new Set<string>();
  let nextId = 1;
  let failPosts = false;
  const roomOf = (r: FakeRoom): Room<FakeRoom> => ({ id: r.key, locale: r.locale, groupId: r.groupId, raw: r });
  const cardOf = (c: FakeCard): Card<FakeCard> => ({ id: c.id, kind: c.kind, messageId: c.messageId, rendered: c.rendered, completeNotedAt: c.completeNotedAt, raw: c });
  const ch: CardChannel<Payload, FakeRoom, FakeCard> = {
    name: "line",
    enabled: () => o.enabled ?? true,
    canEdit: o.canEdit,
    async roomsOfGroup(_db, groupId) {
      return rooms.filter((r) => r.groupId === groupId).map(roomOf);
    },
    async cardsOf(_db, eventId, kinds) {
      return cards.filter((c) => c.eventId === eventId && (!kinds?.length || kinds.includes(c.kind))).map((c) => ({ card: cardOf(c), room: roomOf(rooms.find((r) => r.key === c.roomKey)!) }));
    },
    render(detail: EventDetail, locale) {
      const occupied = detail.roster.filter((x) => x.position <= detail.event.capacity && (x.status === "joined" || x.status === "confirmed")).length;
      const text = `${locale}:${detail.event.code}:${occupied}/${detail.event.capacity}`;
      return { payload: { text, occupied }, hash: `h:${text}`, complete: occupied >= detail.event.capacity };
    },
    async post(_db, room, payload, po = {}) {
      if (failPosts) return { ok: false };
      sent.push({ room: room.id, kind: "post", text: payload.text, silent: po.silent });
      return { ok: true, messageId: nextId++ };
    },
    async edit(_db, room, _card, payload) {
      sent.push({ room: room.id, kind: "edit", text: payload.text });
      return true;
    },
    async note(_db, room, text, po = {}) {
      sent.push({ room: room.id, kind: "note", text, silent: po.silent });
      return true;
    },
    async result(_db, room, summary) {
      sent.push({ room: room.id, kind: "result", text: `${summary.title} ${summary.score ?? ""} ${summary.winners ?? ""}`.trim() });
      return { ok: true, messageId: nextId++ };
    },
    async saveCard(_db, eventId, room, messageId, kind, rendered) {
      const existing = cards.find((c) => c.eventId === eventId && c.roomKey === room.id && c.kind === kind);
      if (existing) Object.assign(existing, { messageId: Number(messageId), rendered });
      else cards.push({ id: `c${cards.length + 1}`, eventId, roomKey: room.id, messageId: Number(messageId), kind, rendered, completeNotedAt: null });
    },
    async markRendered(_db, card, rendered) {
      card.raw.rendered = rendered;
    },
    async markCompleteNoted(_db, card) {
      card.raw.completeNotedAt = new Date();
    },
    async bindGroup(_db, room, groupId) {
      if (room.raw.type === "group") room.raw.groupId = groupId;
    },
    async remindersDue(db, now, soon) {
      const { events } = await import("@/db/schema");
      const { and, gt, lte } = await import("drizzle-orm");
      const rows = await db.select({ id: events.id, code: events.code }).from(events).where(and(gt(events.startsAt, now), lte(events.startsAt, soon)));
      return rows.filter((r) => !reminded.has(r.id) && cards.some((c) => c.eventId === r.id && c.kind === "card"));
    },
    async markReminded(_db, eventId) {
      reminded.add(eventId);
    },
  };
  return { ch, rooms, cards, sent, setFailPosts: (v: boolean) => (failPosts = v) };
}

describe("the card algorithm on a channel of its own", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await createTestDb()));
  afterAll(() => close());

  async function match(o: { startsAt?: Date; groupId?: string | null } = {}) {
    const org = await makePlayer(db, "Org");
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: o.startsAt ?? new Date(NOW.getTime() + 2 * DAY), tz: "Asia/Bangkok", venueName: "Rawai Padel Club", whenFull: "waitlist", groupId: o.groupId ?? null });
    return { org, ev, detail: async () => (await getEventByCode(db, ev.code))! };
  }

  it("posts once, refreshes instead of reposting, edits only when the card changed, notes a complete line-up once", async () => {
    const f = fakeChannel({ canEdit: true });
    f.rooms.push({ key: "r1", locale: "en", groupId: null, type: "group" });
    const { org, ev, detail } = await match();
    const room = { id: "r1", locale: "en" as const, groupId: null, raw: f.rooms[0] };
    expect(await postCard(f.ch, db, await detail(), room, {}, NOW)).toBe("posted");
    expect(await postCard(f.ch, db, await detail(), room, {}, NOW)).toBe("refreshed");
    expect(f.sent.map((x) => x.kind)).toEqual(["post"]);
    // Nothing changed: no edit.
    expect(await syncCards(f.ch, db, ev.code, NOW)).toBe(0);
    // The organiser and three more join (creating does not take a slot): one edit per sync, then the complete note once, silently.
    await joinEvent(db, { eventId: ev.id, playerId: org.id, now: NOW });
    for (const name of ["Bo", "Cy", "Di"]) await joinEvent(db, { eventId: ev.id, playerId: (await makePlayer(db, name)).id, now: NOW });
    expect(await syncCards(f.ch, db, ev.code, NOW)).toBe(1);
    expect(await syncCards(f.ch, db, ev.code, NOW)).toBe(0);
    const kinds = f.sent.map((x) => x.kind);
    expect(kinds).toEqual(["post", "edit", "note"]);
    expect(f.sent[2].silent).toBe(true);
    expect(f.cards[0].completeNotedAt).not.toBeNull();
  });

  it("a group's match lands in every room tied to the group; the first card binds a group room, never a private one", async () => {
    const f = fakeChannel({ canEdit: true });
    const org = await makePlayer(db, "Org2");
    const group = await createGroup(db, { name: "Crew", creatorPlayerId: org.id, tz: "Asia/Bangkok", memberIds: [org.id] });
    f.rooms.push({ key: "g1", locale: "ru", groupId: group.id, type: "group" }, { key: "g2", locale: "en", groupId: group.id, type: "group" }, { key: "p1", locale: "en", groupId: null, type: "private" }, { key: "g3", locale: "en", groupId: null, type: "group" });
    const { ev, detail } = await match({ groupId: group.id });
    expect(await postCardsForGroup(f.ch, db, ev.code, NOW)).toBe(2);
    expect(f.sent.map((x) => [x.room, x.text.slice(0, 2)])).toEqual([
      ["g1", "ru"],
      ["g2", "en"],
    ]);
    // A card posted by hand into an unbound room ties it to the group, unless the room is private.
    await postCard(f.ch, db, await detail(), { id: "p1", locale: "en", groupId: null, raw: f.rooms[2] }, {}, NOW);
    await postCard(f.ch, db, await detail(), { id: "g3", locale: "en", groupId: null, raw: f.rooms[3] }, {}, NOW);
    expect(f.rooms.map((r) => r.groupId)).toEqual([group.id, group.id, null, group.id]);
  });

  it("reminds once per match into each room, and posts the result once per room", async () => {
    const f = fakeChannel({ canEdit: true });
    f.rooms.push({ key: "r1", locale: "en", groupId: null, type: "group" }, { key: "r2", locale: "ru", groupId: null, type: "group" });
    const { org, ev, detail } = await match({ startsAt: new Date(NOW.getTime() + HOUR) });
    for (const r of f.rooms) await postCard(f.ch, db, await detail(), { id: r.key, locale: r.locale, groupId: null, raw: r }, {}, NOW);
    expect(await sendReminders(f.ch, db, NOW)).toBe(2);
    expect(await sendReminders(f.ch, db, NOW)).toBe(0);
    // No score yet: nothing to post. Then a score by the organizer: once per room, and not again.
    expect(await postResult(f.ch, db, ev.code)).toBe(0);
    const players = [org];
    await joinEvent(db, { eventId: ev.id, playerId: org.id, now: NOW });
    for (const name of ["Bo", "Cy", "Di"]) {
      const p = await makePlayer(db, name);
      await joinEvent(db, { eventId: ev.id, playerId: p.id, now: NOW });
      players.push(p);
    }
    await saveMatchScore(db, { eventId: ev.id, playerId: org.id, isCreator: true, sets: [{ setNumber: 1, sideA: 6, sideB: 4 }], teamA: [players[0].id, players[1].id], now: new Date(NOW.getTime() + 3 * HOUR) });
    expect(await postResult(f.ch, db, ev.code)).toBe(2);
    expect(await postResult(f.ch, db, ev.code)).toBe(0);
    expect(f.sent.filter((x) => x.kind === "result").map((x) => x.text)).toHaveLength(2);
    expect(f.sent.filter((x) => x.kind === "result")[0].text).toContain("6-4");
  });

  it("a channel that cannot edit gets a fresh card only when the roster changes, never for a cosmetic re-render; a disabled channel does nothing", async () => {
    const f = fakeChannel({ canEdit: false });
    f.rooms.push({ key: "r1", locale: "en", groupId: null, type: "group" });
    const { ev, detail } = await match();
    const room = { id: "r1", locale: "en" as const, groupId: null, raw: f.rooms[0] };
    await postCard(f.ch, db, await detail(), room, {}, NOW);
    expect(f.cards[0].rendered).toBe(materialKey(await detail()));
    // Same roster, a different render (the room switched language): no new card.
    f.rooms[0].locale = "ru";
    expect(await syncCards(f.ch, db, ev.code, NOW)).toBe(0);
    // A join: one new card, and the stored key moves on.
    await joinEvent(db, { eventId: ev.id, playerId: (await makePlayer(db, "Bo")).id, now: NOW });
    expect(await syncCards(f.ch, db, ev.code, NOW)).toBe(1);
    expect(f.sent.map((x) => x.kind)).toEqual(["post", "post"]);
    expect(f.cards).toHaveLength(1);
    // A post that fails leaves the old card in place and is tried again next time.
    f.setFailPosts(true);
    await joinEvent(db, { eventId: ev.id, playerId: (await makePlayer(db, "Cy")).id, now: NOW });
    expect(await syncCards(f.ch, db, ev.code, NOW)).toBe(0);
    f.setFailPosts(false);
    expect(await syncCards(f.ch, db, ev.code, NOW)).toBe(1);
    const off = fakeChannel({ canEdit: true, enabled: false });
    expect(await syncCards(off.ch, db, ev.code, NOW)).toBe(0);
    expect(await sendReminders(off.ch, db, NOW)).toBe(0);
  });
});
