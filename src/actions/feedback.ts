"use server";

import { getLocale } from "next-intl/server";
import { getDb } from "@/db";
import { createFeedback, feedbackCountToday, FeedbackError, markAcknowledged } from "@/lib/feedback/store";
import { feedbackStrings } from "@/lib/feedback/strings";
import { LIMITS } from "@/lib/domain/ratelimit";
import { getSessionPlayer } from "@/lib/session";
import { ActionFailure, assertRate, clientIp, runA, type ActionResult } from "./shared";

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** The web form: stored, thanked, answered within a day where an answer can reach the person. */
export async function sendFeedbackAction(text: string, contact: string, context: string): Promise<ActionResult<{ id: string; channel: "telegram" | "email" | "none" }>> {
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
    await markAcknowledged(db, row.id, feedbackStrings(locale).thanks(player?.displayName ?? ""));
    return { id: row.id, channel: player?.telegramId ? "telegram" : email ? "email" : "none" };
  });
}
