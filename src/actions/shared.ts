import "server-only";
import { getLocale } from "next-intl/server";
import { getDb, type Db } from "@/db";
import type { Player } from "@/db/schema";
import { isDomainError, type DomainErrorCode } from "@/lib/domain/errors";
import { getEventByCode, type EventDetail } from "@/lib/domain/queries";
import { createPlayer, normalizeName } from "@/lib/domain/players";
import { getSessionPlayer, hasManageAccess, setSessionPlayer } from "@/lib/session";

export type ActionError = DomainErrorCode | "generic" | "name_required" | "no_identity" | "email_disabled" | "too_many";
export type ActionResult<T = null> = { ok: true; data: T } | { ok: false; error: ActionError };

export async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (isDomainError(e)) return { ok: false, error: e.code };
    console.error("[action]", e);
    return { ok: false, error: "generic" };
  }
}

export class ActionFailure extends Error {
  constructor(public readonly code: ActionError) {
    super(code);
  }
}

export async function runA<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (e instanceof ActionFailure) return { ok: false, error: e.code };
    if (isDomainError(e)) return { ok: false, error: e.code };
    console.error("[action]", e);
    return { ok: false, error: "generic" };
  }
}

/** Returns the current player, creating one from `name` when there is no identity yet. */
export async function requirePlayer(db: Db, name?: string | null): Promise<Player> {
  const existing = await getSessionPlayer(db);
  if (existing) return existing;
  const clean = normalizeName(name ?? "");
  if (!clean) throw new ActionFailure("name_required");
  const locale = await getLocale();
  const player = await createPlayer(db, { displayName: clean, locale });
  await setSessionPlayer(player.id);
  return player;
}

export type Viewer = { player: Player | null; isCreator: boolean };

export async function getViewer(db: Db, detail: EventDetail): Promise<Viewer> {
  const player = await getSessionPlayer(db);
  const isCreator = (player && player.id === detail.event.creatorPlayerId) || (await hasManageAccess(detail.event.code, detail.event.manageCode));
  return { player, isCreator: Boolean(isCreator) };
}

export async function loadEvent(code: string): Promise<{ db: Db; detail: EventDetail }> {
  const db = await getDb();
  const detail = await getEventByCode(db, code);
  if (!detail) throw new ActionFailure("not_found");
  return { db, detail };
}

export async function requireCreator(code: string): Promise<{ db: Db; detail: EventDetail; viewer: Viewer }> {
  const { db, detail } = await loadEvent(code);
  const viewer = await getViewer(db, detail);
  if (!viewer.isCreator) throw new ActionFailure("forbidden");
  return { db, detail, viewer };
}
