import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { lineCards, lineRooms } from "@/db/schema";
import { materialKey } from "@/lib/channels/cards";
import { lineChannel, lineRoomOf } from "@/lib/channels/line";
import { verifySignature } from "@/lib/line/api";
import { renderLineCard } from "@/lib/line/card";
import { createEvent } from "@/lib/domain/events";
import { getEventByCode } from "@/lib/domain/queries";
import { joinEvent } from "@/lib/domain/slots";
import { createTestDb, makePlayer, HOUR } from "./helpers/db";
import { freezeClock } from "./helpers/clock";

/**
 * LINE cannot edit a sent message. Every other channel keeps one card and edits it; here an "edit"
 * is a new message in everyone's chat and a push against a metered monthly budget. These are the
 * rules that follow from that, and the one that costs real money if it is wrong.
 */
const NOW = new Date("2026-09-14T09:00:00.000Z");
freezeClock(NOW);
const SECRET = "e2e-line-secret";

describe("LINE as a channel that cannot edit", () => {
  let db: Db;
  let close: () => Promise<void>;
  let sent: { to: string | null; path: string }[] = [];

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  beforeEach(async () => {
    process.env.LINE_CHANNEL_TOKEN = "t";
    process.env.LINE_CHANNEL_SECRET = SECRET;
    sent = [];
    vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
      const b = JSON.parse(init.body) as { to?: string };
      sent.push({ to: b.to ?? null, path: new URL(url).pathname });
      return new Response("{}", { status: 200 });
    });
    await db.delete(lineCards);
    await db.delete(lineRooms);
  });

  const aMatch = async (tag: string) => {
    const org = await makePlayer(db, `${tag} organiser`);
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() + 24 * HOUR), tz: "Asia/Bangkok", venueName: "Rawai Padel", whenFull: "waitlist" });
    await joinEvent(db, { eventId: ev.id, playerId: org.id });
    return { ev, org };
  };
  const aRoom = async (id = "Croom1") => {
    await db.insert(lineRooms).values({ roomId: id, type: "group" }).onConflictDoNothing();
    const [row] = await db.select().from(lineRooms).where(eq(lineRooms.roomId, id)).limit(1);
    return lineRoomOf(row);
  };

  it("refuses a body that is not signed with the channel secret", () => {
    const body = JSON.stringify({ events: [] });
    const good = createHmac("sha256", SECRET).update(body, "utf8").digest("base64");
    expect(verifySignature(body, good)).toBe(true);
    expect(verifySignature(`${body} `, good)).toBe(false);
    expect(verifySignature(body, "not-a-signature")).toBe(false);
    expect(verifySignature(body, null)).toBe(false);
  });

  it("declares that it cannot edit, which is what makes the algorithm key on what a player notices", () => {
    expect(lineChannel.canEdit).toBe(false);
  });

  it("renders a card with the two taps and a way out to the web", async () => {
    const { ev } = await aMatch("render");
    const detail = (await getEventByCode(db, ev.code))!;
    const r = renderLineCard(detail, "https://kicksma.sh", "en");
    const [msg] = r.messages as [{ type: string; altText: string; contents: Record<string, never> }];
    expect(msg.type).toBe("flex");
    // The alt text is the notification and the chat-list line: it has to answer "worth opening?".
    expect(msg.altText).toMatch(/Rawai Padel|Padel match/);
    const json = JSON.stringify(msg.contents);
    expect(json).toContain(`"data":"j:${ev.code}"`);
    expect(json).toContain(`"data":"l:${ev.code}"`);
    expect(json).toContain(`https://kicksma.sh/${ev.code}`);
  });

  /**
   * The one that costs money. With `canEdit: false` the algorithm posts a *fresh* card on every
   * material change and lands in `saveCard` again for the same (event, room, kind). Discord's
   * `saveCard` does nothing on conflict, which is right for a channel that edits in place — copied
   * here it would leave the stored key stale, so the algorithm would decide the card was out of date
   * and push another one, on every tick, for ever.
   */
  it("keeps one row per room and moves its key forward, rather than pushing the same card for ever", async () => {
    const { ev } = await aMatch("upsert");
    const room = await aRoom();
    const before = (await getEventByCode(db, ev.code))!;
    await lineChannel.saveCard(db, ev.id, room, "m1", "card", materialKey(before));

    const joiner = await makePlayer(db, "Joiner");
    await joinEvent(db, { eventId: ev.id, playerId: joiner.id });
    const after = (await getEventByCode(db, ev.code))!;
    expect(materialKey(after)).not.toBe(materialKey(before));

    await lineChannel.saveCard(db, ev.id, room, "m2", "card", materialKey(after));
    const rows = await db.select().from(lineCards).where(eq(lineCards.eventId, ev.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].rendered).toBe(materialKey(after));
    expect(rows[0].messageId).toBe("m2");
  });

  it("pushes only when the app starts it, and replies when it is answering somebody", async () => {
    const { ev } = await aMatch("reply");
    const room = await aRoom("Croom2");
    const detail = (await getEventByCode(db, ev.code))!;
    const payload = lineChannel.render(detail, "en", NOW).payload;

    await lineChannel.post(db, room, payload, {});
    expect(sent.at(-1)?.path).toBe("/v2/bot/message/push");
    expect(sent.at(-1)?.to).toBe("Croom2");

    await lineChannel.post(db, room, payload, { replyTo: "reply-token-1" });
    expect(sent.at(-1)?.path).toBe("/v2/bot/message/reply");
  });

  it("stops pushing into a room it was removed from", async () => {
    const { ev } = await aMatch("gone");
    const room = await aRoom("Croom3");
    vi.stubGlobal("fetch", async () => new Response("no", { status: 403 }));
    const detail = (await getEventByCode(db, ev.code))!;
    const res = await lineChannel.post(db, room, lineChannel.render(detail, "en", NOW).payload, {});
    expect(res.ok).toBe(false);
    const [row] = await db.select().from(lineRooms).where(eq(lineRooms.roomId, "Croom3"));
    expect(row.leftAt).not.toBe(null);
    // And a room the bot has left is no longer a place a card lives.
    expect(await lineChannel.cardsOf(db, ev.id)).toEqual([]);
  });
});
