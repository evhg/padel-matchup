import "server-only";
import type { Db } from "@/db";
import type { Competition, CompetitionCategory, CompetitionMatch, CompetitionPair } from "@/db/schema";
import { roundKey } from "@/lib/domain/draw";
import type { PlayRow } from "@/lib/domain/competitionSchedule";
import { whenLabel } from "@/lib/tournamentText";
import { packId } from "@/lib/telegram/taps";
import type { PodiumAward } from "@/lib/domain/competitionLive";
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

async function say(db: Db, playerId: string | null | undefined, c: Pick<Competition, "slug">, lines: (t: (key: string, values?: Record<string, string | number>) => string) => [string, string], o: { trailer?: string; url?: string } = {}): Promise<void> {
  if (!playerId) return;
  const p = await getPlayer(db, playerId);
  if (!p) return;
  const { t } = await translatorFor(p.locale);
  const [head, body] = lines(t);
  await tell(db, p, `${head}\n${body}`, { inline_keyboard: [[{ text: t("tournament.open"), url: o.url ?? pageUrl(c) }]] }, { trailer: o.trailer });
}

/** The last line of a one-match notice in Telegram: a reply with the score lands on this match. */
const scoreTrailer = (matchId: string) => `↳ ks:${packId(matchId)}`;

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

const opponentOf = (t: (key: string, values?: Record<string, string | number>) => string, row: PlayRow, playerId: string): string => {
  const mineIsA = row.aPlayers.includes(playerId);
  const other = mineIsA ? row.bName : row.aName;
  return other ?? t("tournament.opponentTbd");
};

/** Every player with a time hears their own list: day and time, court, category, the opponent or "the winner to come". */
export async function tellSchedule(db: Db, competition: Competition, rows: readonly PlayRow[]): Promise<void> {
  const byPlayer = new Map<string, PlayRow[]>();
  for (const r of rows) for (const id of [...r.aPlayers, ...r.bPlayers]) byPlayer.set(id, [...(byPlayer.get(id) ?? []), r]);
  for (const [playerId, mine] of byPlayer) {
    const p = await getPlayer(db, playerId);
    if (!p) continue;
    await say(db, playerId, competition, (t) => [
      t("tournament.noticeScheduleTitle", { name: competition.name }),
      mine
        .filter((r) => r.scheduledAt)
        .sort((a, b) => a.scheduledAt!.getTime() - b.scheduledAt!.getTime())
        .map((r) => t("tournament.noticeScheduleLine", { when: whenLabel(r.scheduledAt!, competition.tz, p.locale), court: r.courtName ?? "", category: r.categoryName, opponent: opponentOf(t, r, playerId) }))
        .join("\n"),
    ]);
  }
}

/** Both pairs of a moved match hear the new court and time. */
export async function tellMoved(db: Db, competition: Competition, row: PlayRow): Promise<void> {
  for (const playerId of [...row.aPlayers, ...row.bPlayers]) {
    const p = await getPlayer(db, playerId);
    if (!p || !row.scheduledAt) continue;
    await say(db, playerId, competition, (t) => [t("tournament.noticeMovedTitle", { name: competition.name }), t("tournament.noticeScheduleLine", { when: whenLabel(row.scheduledAt!, competition.tz, p.locale), court: row.courtName ?? "", category: row.categoryName, opponent: opponentOf(t, row, playerId) })], { trailer: scoreTrailer(row.id) });
  }
}

/** Fifteen minutes before: the court, the opponent, the category. */
export async function tellMatchSoon(db: Db, competition: Competition, row: PlayRow): Promise<void> {
  for (const playerId of [...row.aPlayers, ...row.bPlayers]) {
    await say(db, playerId, competition, (t) => [t("tournament.noticeSoonTitle", { court: row.courtName ?? "" }), `${t("tournament.noticeSoonLine", { category: row.categoryName, opponent: opponentOf(t, row, playerId), name: competition.name })}\n${t("tournament.scoreReplyHelp")}`], { trailer: scoreTrailer(row.id) });
  }
}

/** The podium, once, to every player on it: the place, the category, the partner, and the moment's own page. */
export async function tellPodium(db: Db, competition: Competition, category: CompetitionCategory, awards: readonly PodiumAward[]): Promise<void> {
  for (const a of awards) {
    await say(db, a.player.id, competition, (t) => [t("tournament.noticePodiumTitle", { place: t(`tournament.place${a.place}`), name: competition.name }), t("tournament.noticePodiumLine", { category: category.name, partner: a.partnerName })], { url: `${baseUrl()}/m/${a.milestone.id}` });
  }
}
