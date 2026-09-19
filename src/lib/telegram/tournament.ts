import type { Db } from "@/db";
import type { Player } from "@/db/schema";
import { enterMatchScore, matchRule } from "@/lib/domain/competitionDraw";
import { scoreText } from "@/lib/domain/draw";
import { isDomainError } from "@/lib/domain/errors";
import { translatorFor } from "@/lib/email/templates";
import { afterResult } from "@/lib/tournament/live";
import { esc, sendMessage, type TgMessage } from "./api";
import { unpackId } from "./taps";

/**
 * A score typed as a reply to a match notice ("In 15 minutes: Court 2", "Your match moved") lands
 * on that match: the notice carries "↳ ks:<match>" as its last line, so the reply names the match
 * without the player typing anything but the sets. Read before the general score reader, which
 * would otherwise take "6-4" for a match on the rotation side.
 */
export const SCORE_TRAILER = /↳ ks:([A-Za-z0-9_-]{22})/;

/** "6-4 3-6 10-8" as two arrays, or null when the text is not a score. */
export function parseScoreText(text: string): { a: number[]; b: number[] } | null {
  const sets = text
    .trim()
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map((s) => s.split(/[-:]/).map((n) => Number(n)));
  if (sets.length === 0 || sets.length > 3 || sets.some((s) => s.length !== 2 || s.some((n) => !Number.isInteger(n) || n < 0 || n > 30))) return null;
  return { a: sets.map((s) => s[0]), b: sets.map((s) => s[1]) };
}

export async function continueScoreReply(db: Db, msg: TgMessage, player: Player): Promise<string | null> {
  const hit = SCORE_TRAILER.exec(msg.reply_to_message?.text ?? "");
  if (!hit) return null;
  const matchId = unpackId(hit[1]);
  if (!matchId) return null;
  const { t } = await translatorFor(player.locale);
  const say = (text: string) => sendMessage(msg.chat.id, esc(text), { replyTo: msg.message_id, silent: true }).catch(() => undefined);
  const score = parseScoreText(msg.text ?? "");
  if (!score) {
    await say(t("tournament.scoreReplyHelp"));
    return "tournament:score:help";
  }
  try {
    const m = await enterMatchScore(db, { matchId, actorPlayerId: player.id, scoreA: score.a, scoreB: score.b });
    await say(t("tournament.scoreSaved", { score: scoreText(m.scoreA, m.scoreB) }));
    await afterResult(db, m.categoryId);
    return "tournament:score:saved";
  } catch (e) {
    if (!isDomainError(e)) throw e;
    if (e.code === "forbidden") await say(t("tournament.scoreNotYours"));
    else if (e.code === "invalid" && e.message.startsWith("score_")) {
      const rule = await matchRule(db, matchId);
      await say(t("tournament.errScore", { rule: rule ? t(`tournament.sc_${rule.code}`) : "" }));
    } else if (e.code === "locked") await say(t("tournament.errLocked"));
    else await say(t("tournament.scoreGone"));
    return "tournament:score:refused";
  }
}
