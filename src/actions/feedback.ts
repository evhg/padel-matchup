"use server";

import { getLocale } from "next-intl/server";
import { getDb } from "@/db";
import { after } from "next/server";
import { composeAck } from "@/lib/feedback/ack";
import { proposeToOwner } from "@/lib/feedback/propose";
import { createFeedback, feedbackCountToday, FeedbackError, markAcknowledged, markNotFeedback } from "@/lib/feedback/store";
import { LIMITS } from "@/lib/domain/ratelimit";
import { getSessionPlayer } from "@/lib/session";
import { ActionFailure, assertRate, clientIp, runA, type ActionResult } from "./shared";

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** The web form: stored and thanked; the person hears back where a reply can reach them if something gets built. */
export async function sendFeedbackAction(text: string, contact: string, context: string): Promise<ActionResult<{ id: string; channel: "telegram" | "email" | "none"; kind: "feedback" | "not_feedback"; reply: string }>> {
  return runA(async () => {
    const db = await getDb();
    const clean = text.trim();
    if (clean.length < 3) throw new ActionFailure("generic");
    await assertRate(db, "feedback", await clientIp(), LIMITS.feedbackPerIpPerDay);
    const player = await getSessionPlayer(db);
    const email = EMAIL_RE.test(contact.trim()) ? contact.trim().toLowerCase() : null;
    if ((await feedbackCountToday(db, { playerId: player?.id ?? null, email, telegramUserId: player?.telegramId ?? null })) >= 10) throw new ActionFailure("too_many");
    const locale = await getLocale();
    const row = await createFeedback(db, {
      source: "web",
      text: clean,
      locale,
      name: player?.displayName ?? null,
      playerId: player?.id ?? null,
      context: context.startsWith("/") ? context.slice(0, 200) : null,
      email,
      telegramUserId: player?.telegramId ?? null,
      telegramChatId: player?.telegramId ?? null,
    }).catch((e) => {
      if (e instanceof FeedbackError) throw new ActionFailure("generic");
      throw e;
    });
    const replyVia = player?.telegramId ? "telegram" : email ? "email" : null;
    const ack = await composeAck(db, { text: clean, name: player?.displayName ?? null, locale, source: "web", canReply: replyVia !== null, replyVia });
    if (ack.kind === "not_feedback") await markNotFeedback(db, row.id, ack.reply);
    else {
      await markAcknowledged(db, row.id, ack.reply);
      // The note is the trigger: the owner gets the proposal right after the thank-you, off the request path.
      const propose = () => proposeToOwner(db, row.id).catch(() => undefined);
      try {
        after(propose);
      } catch {
        await propose();
      }
    }
    return { id: row.id, channel: replyVia ?? "none", kind: ack.kind, reply: ack.reply };
  });
}
