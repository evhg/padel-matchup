import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { lineRooms, players, type Player } from "@/db/schema";
import { postCard, syncCards } from "@/lib/channels/cards";
import { lineChannel, lineRoomOf, roomLocale } from "@/lib/channels/line";
import { joinAsPlayer, leaveAsPlayer, type OpContext } from "@/lib/api/operations";
import { baseUrl } from "@/lib/config";
import { isDomainError } from "@/lib/domain/errors";
import { createPlayer } from "@/lib/domain/players";
import { getEventByCode } from "@/lib/domain/queries";
import { strings, type BotLocale } from "@/lib/telegram/card";
import { codesInText } from "@/lib/telegram/text";
import { reply, sourceId, type LineEvent, type LineWebhookBody } from "./api";

/**
 * The LINE router. Small on purpose: this channel exists to carry the card into a Thai crew's group
 * chat, and everything a person does to a card is one of two taps.
 *
 * Every answer here goes out on the event's reply token, which is free. The pushes — a fresh card
 * after a roster change, the reminder, the result — are started by the app elsewhere and are the
 * only things that touch the monthly budget.
 */

/** A LINE user, as a player. The id is scoped to our own channel, so it identifies without naming. */
export async function findOrCreateLinePlayer(db: Db, lineId: string, displayName: string | null, locale: BotLocale): Promise<Player> {
  const [hit] = await db.select().from(players).where(eq(players.lineId, lineId)).limit(1);
  if (hit) return hit;
  const created = await createPlayer(db, { displayName: (displayName ?? "").trim().slice(0, 40) || "Player", locale });
  const [updated] = await db.update(players).set({ lineId, lineDisplayName: displayName ?? null }).where(eq(players.id, created.id)).returning();
  return updated ?? created;
}

/** The room this event happened in, remembered the first time the bot hears from it. */
async function rememberRoom(db: Db, ev: LineEvent) {
  const id = sourceId(ev.source);
  if (!id) return null;
  await db.insert(lineRooms).values({ roomId: id, type: ev.source.type }).onConflictDoNothing();
  const [row] = await db.select().from(lineRooms).where(eq(lineRooms.roomId, id)).limit(1);
  return row ?? null;
}

async function handleEvent(db: Db, ev: LineEvent, ctx: OpContext): Promise<string> {
  const id = sourceId(ev.source);
  if (!id) return "no_source";

  if (ev.type === "leave" || ev.type === "unfollow") {
    await db.update(lineRooms).set({ leftAt: new Date() }).where(eq(lineRooms.roomId, id));
    return "line:left";
  }

  const room = await rememberRoom(db, ev);
  if (!room) return "line:no_room";
  // A room the bot was removed from and then added back to is live again.
  if (room.leftAt) await db.update(lineRooms).set({ leftAt: null }).where(and(eq(lineRooms.roomId, id), eq(lineRooms.roomId, room.roomId)));
  const locale = roomLocale(room);
  const s = strings(locale);

  if (ev.type === "join" || ev.type === "follow") {
    if (ev.replyToken) await reply(ev.replyToken, [{ type: "text", text: s.help }]);
    return "line:joined";
  }

  if (ev.type === "postback" && ev.postback) {
    const m = /^([jl]):([A-Za-z0-9]{4})$/.exec(ev.postback.data);
    if (!m) return "line:postback_unknown";
    const [, action, code] = m;
    const detail = await getEventByCode(db, code);
    if (!detail) {
      if (ev.replyToken) await reply(ev.replyToken, [{ type: "text", text: s.toastError }]);
      return "line:gone";
    }
    const player = await findOrCreateLinePlayer(db, ev.source.userId ?? id, null, locale);
    let text: string;
    try {
      if (action === "j") {
        const r = await joinAsPlayer(db, detail, player, ctx);
        text = r.outcome === "joined" ? s.toastJoined : r.outcome === "waitlisted" ? s.toastWaitlisted : r.outcome === "already_in" ? s.toastAlready : r.outcome === "requested" ? s.toastRequested : s.toastClosed;
      } else {
        const r = await leaveAsPlayer(db, detail, player, ctx);
        text = r.outcome === "left" ? s.toastLeft : s.toastNotIn;
      }
    } catch (e) {
      if (!isDomainError(e)) throw e;
      text = e.code === "past" ? s.toastPast : e.code === "already_in" ? s.toastAlready : e.code === "full" || e.code === "closed" ? s.toastClosed : s.toastError;
    }
    // The answer rides the free reply token; the fresh card that follows is the one metered push,
    // and only when the roster actually moved (the algorithm decides, not this handler).
    if (ev.replyToken) await reply(ev.replyToken, [{ type: "text", text }]);
    ctx.afterwards(async () => {
      await syncCards(lineChannel, db, code);
    });
    return `line:${action === "j" ? "join" : "leave"}`;
  }

  if (ev.type === "message" && ev.message?.type === "text") {
    const codes = codesInText(ev.message.text, baseUrl());
    const code = codes[0] ?? null;
    if (!code) return "line:other";
    const detail = await getEventByCode(db, code);
    if (!detail) return "line:gone";
    // A pasted link becomes the live card, answered on the reply token, so it costs nothing.
    const r = lineChannel.render(detail, locale, new Date());
    if (ev.replyToken) await reply(ev.replyToken, r.payload.messages);
    await postCard(lineChannel, db, detail, lineRoomOf(room), {});
    return `line:card:${code}`;
  }

  return "line:ignored";
}

export async function handleLineWebhook(db: Db, body: LineWebhookBody, ctx: OpContext): Promise<string> {
  const outcomes: string[] = [];
  for (const ev of (body.events ?? []).slice(0, 20)) {
    try {
      outcomes.push(await handleEvent(db, ev, ctx));
    } catch (e) {
      outcomes.push("error");
      console.error("line event", e);
    }
  }
  return outcomes.join(",") || "line:empty";
}
