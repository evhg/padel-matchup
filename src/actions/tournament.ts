"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import type { TournamentFormat } from "@/db/schema";
import { emitMatchEvent } from "@/lib/api/webhooks";
import { applyEventLevels } from "@/lib/domain/rating";
import { MAX_TOURNAMENT_CAPACITY } from "@/lib/config";
import { DomainError } from "@/lib/domain/errors";
import { fieldInFours } from "@/lib/domain/events";
import { deleteLastRound, generateRound, saveTournamentMatchScore, setTournamentLock, setTournamentSettings, type CheckIn } from "@/lib/domain/tournament";
import { notifyRemoved } from "@/lib/notify";
import { updateEventAction } from "./events";
import { getViewer, loadEvent, requireCreator, runA, type ActionResult } from "./shared";
import { reserveAction } from "./slots";

export async function setTournamentSettingsAction(code: string, input: { courts?: number | null; pointsPerMatch?: number | null; gamesTo?: number | null; courtNames?: string[] | null; format?: TournamentFormat }): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, detail, viewer } = await requireCreator(code);
    await setTournamentSettings(db, { eventId: detail.event.id, actorPlayerId: viewer.player?.id ?? null, ...input });
    revalidatePath(`/${code}`);
    return null;
  });
}

/** The next round. Round 1 may carry the check-in ("Who is here?"): whoever it left out hears that the night started without them, by the removal's own notice. */
export async function generateRoundAction(code: string, checkIn?: CheckIn): Promise<ActionResult<{ roundNumber: number }>> {
  return runA(async () => {
    const { db, detail, viewer } = await requireCreator(code);
    const round = await generateRound(db, { eventId: detail.event.id, actorPlayerId: viewer.player?.id ?? null, checkIn: cleanCheckIn(checkIn) });
    if (round.absent.length) {
      after(async () => {
        // Bounded by the names unticked, sequential (rule 8); each notice is one email at most.
        for (const a of round.absent) await notifyRemoved(db, detail.event, a.playerId, { absent: true });
      });
    }
    revalidatePath(`/${code}`);
    return { roundNumber: round.roundNumber };
  });
}

/** A check-in from the browser, as plain arrays of ids and a whole count, or nothing. */
function cleanCheckIn(raw: CheckIn | undefined): CheckIn | undefined {
  if (!raw) return undefined;
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, MAX_TOURNAMENT_CAPACITY * 2) : []);
  const count = Number(raw.count);
  if (!Number.isInteger(count) || count < 0) throw new DomainError("invalid", "roster_changed");
  return { away: ids(raw.away), waitingIn: ids(raw.waitingIn), count };
}

/**
 * A walk-in: somebody turned up who was not on the list. It is the organiser's "Open spot" reserve,
 * the same row and the same notices (`reserveAction`). When no spot is left it first opens another
 * court's worth, through the same edit the organiser's capacity picker makes (`updateEventAction`,
 * which moves the waiting list up as it always has); round 1 then closes whatever stays open.
 */
export async function addWalkInAction(code: string, name: string): Promise<ActionResult<{ name: string }>> {
  const first = await reserveAction(code, { name });
  if (first.ok) return { ok: true, data: { name: first.data.name } };
  if (first.error !== "full") return first;
  const loaded = await runA(() => loadEvent(code));
  if (!loaded.ok) return loaded;
  const ev = loaded.data.detail.event;
  if (ev.type !== "tournament" || ev.capacity >= MAX_TOURNAMENT_CAPACITY) return first;
  const grown = await updateEventAction(code, { capacity: fieldInFours(ev.capacity + 1) });
  if (!grown.ok) return grown;
  const again = await reserveAction(code, { name });
  return again.ok ? { ok: true, data: { name: again.data.name } } : again;
}

export async function deleteLastRoundAction(code: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, detail } = await requireCreator(code);
    await deleteLastRound(db, { eventId: detail.event.id });
    revalidatePath(`/${code}`);
    return null;
  });
}

export async function saveTournamentMatchAction(code: string, matchId: string, sideA: number | null, sideB: number | null): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, detail } = await loadEvent(code);
    const viewer = await getViewer(db, detail);
    await saveTournamentMatchScore(db, { eventId: detail.event.id, matchId, sideA, sideB, playerId: viewer.player?.id ?? null, isCreator: viewer.isCreator });
    revalidatePath(`/${code}`);
    return null;
  });
}

export async function setTournamentLockAction(code: string, locked: boolean): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, detail, viewer } = await requireCreator(code);
    await setTournamentLock(db, { eventId: detail.event.id, locked, actorPlayerId: viewer.player?.id ?? null });
    if (locked) await applyEventLevels(db, detail.event.id).catch(() => undefined);
    if (locked) {
      after(async () => {
        await emitMatchEvent(db, "match.result", code, { confirmed: true });
      });
    }
    revalidatePath(`/${code}`);
    revalidatePath("/me");
    return null;
  });
}
