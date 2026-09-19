import "server-only";
import type { Db } from "@/db";
import type { Competition, CompetitionCategory, CompetitionMatch, CompetitionPair } from "@/db/schema";
import { roundKey } from "@/lib/domain/draw";
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

/**
 * The draw is out: every player of every pair in it hears where they start — their group, the round
 * of their first knockout match, or the qualifying. One message per person, in their language.
 */
export async function tellDrawPublished(db: Db, competition: Competition, category: CompetitionCategory, pairs: readonly CompetitionPair[], matches: readonly CompetitionMatch[]): Promise<void> {
  const mainRounds = Math.max(0, ...matches.filter((m) => m.phase === "main").map((m) => m.round));
  const firstOf = (pairId: string): { kind: "group"; label: string } | { kind: "qualifying" } | { kind: "knockout"; round: number } | null => {
    const mine = matches.filter((m) => m.pairAId === pairId || m.pairBId === pairId);
    const group = mine.find((m) => m.phase === "group");
    if (group?.groupLabel) return { kind: "group", label: group.groupLabel };
    if (mine.some((m) => m.phase === "qualifying")) return { kind: "qualifying" };
    const main = mine.filter((m) => m.phase === "main" && !m.bye).sort((a, b) => a.round - b.round)[0] ?? mine.filter((m) => m.phase === "main").sort((a, b) => a.round - b.round)[0];
    return main ? { kind: "knockout", round: main.round } : null;
  };
  for (const pair of pairs) {
    const start = firstOf(pair.id);
    if (!start) continue;
    for (const playerId of [pair.p1PlayerId, pair.p2PlayerId]) {
      await say(db, playerId, competition, (t) => {
        const line =
          start.kind === "group"
            ? t("tournament.noticeDrawGroup", { category: category.name, label: start.label })
            : start.kind === "qualifying"
              ? t("tournament.noticeDrawQualifying", { category: category.name })
              : t("tournament.noticeDrawKnockout", { category: category.name, round: roundName(t, start.round, mainRounds) });
        return [t("tournament.noticeDrawTitle", { name: competition.name }), line];
      });
    }
  }
}

/** "Final", "Semi-finals", "Round of 16" in the reader's language. */
export function roundName(t: (key: string, values?: Record<string, string | number>) => string, round: number, rounds: number): string {
  const k = roundKey(round, rounds);
  if (k.key === "final") return t("tournament.roundFinal");
  if (k.key === "semi") return t("tournament.roundSemi");
  if (k.key === "quarter") return t("tournament.roundQuarter");
  return t("tournament.roundOf", { n: k.of ?? 0 });
}
