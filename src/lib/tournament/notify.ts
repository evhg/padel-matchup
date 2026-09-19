import "server-only";
import type { Db } from "@/db";
import type { Competition, CompetitionCategory, CompetitionPair } from "@/db/schema";
import { baseUrl } from "@/lib/config";
import { tell } from "@/lib/coach/notify";
import { getPlayer } from "@/lib/domain/players";
import { translatorFor } from "@/lib/email/templates";

/**
 * What leaves a competition when something changes: one quiet line to the person it concerns,
 * on whichever channel they have (`tell`: Telegram, else email, else push). The organiser hears
 * of every entry; a pair that moves up from the waiting list hears it is in; the player who named
 * a partner hears when the partner confirmed. Nothing to a placeholder: it has no channel.
 */

const pageUrl = (c: Pick<Competition, "slug">) => `${baseUrl()}/t/${c.slug}`;

async function say(db: Db, playerId: string | null | undefined, c: Pick<Competition, "slug">, lines: (t: (key: string, values?: Record<string, string | number>) => string) => [string, string]): Promise<void> {
  if (!playerId) return;
  const p = await getPlayer(db, playerId);
  if (!p) return;
  const { t } = await translatorFor(p.locale);
  const [head, body] = lines(t);
  await tell(db, p, `${head}\n${body}`, { inline_keyboard: [[{ text: t("tournament.open"), url: pageUrl(c) }]] });
}

export async function tellOrganizerOfEntry(db: Db, e: { competition: Competition; category: CompetitionCategory; player: { displayName: string }; partner: { displayName: string } }, pairsInCategory: number): Promise<void> {
  await say(db, e.competition.organizerPlayerId, e.competition, (t) => [
    t("tournament.noticeEntry", { category: e.category.name, p1: e.player.displayName, p2: e.partner.displayName }),
    t("tournament.noticeEntryLine", { name: e.competition.name, count: pairsInCategory }),
  ]);
}

/** Both players of the pair that moved up, each in their own language; a placeholder hears nothing. */
export async function tellMovedUp(db: Db, moved: CompetitionPair, competition: Competition, category: CompetitionCategory): Promise<void> {
  const [p1, p2] = await Promise.all([getPlayer(db, moved.p1PlayerId), getPlayer(db, moved.p2PlayerId)]);
  for (const [me, other] of [[p1, p2], [p2, p1]] as const) {
    if (!me) continue;
    await say(db, me.id, competition, (t) => [t("tournament.noticeMovedUp", { category: category.name, name: competition.name }), t("tournament.noticeMovedUpLine", { partner: other?.displayName ?? "" })]);
  }
}

export async function tellPartnerClaimed(db: Db, pair: CompetitionPair, competition: Competition, category: CompetitionCategory, partnerName: string): Promise<void> {
  await say(db, pair.p1PlayerId, competition, (t) => [t("tournament.noticePartnerClaimed", { partner: partnerName, category: category.name }), competition.name]);
}
