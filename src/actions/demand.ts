"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { dropWant, listWants, recordWant, resolvePlace, type WantInput } from "@/lib/domain/demand";
import { ActionFailure, requirePlayer, runA, type ActionResult } from "./shared";
import { getSessionPlayer } from "@/lib/session";

/**
 * A player saying when and where they want to play. The one thing the app never recorded: it knew
 * every match that existed and nothing about the matches people wished existed.
 */
export async function recordWantAction(input: { place: string; weekday: number | null; fromTime: string | null; toTime: string | null; name?: string | null }): Promise<ActionResult<{ id: string }>> {
  return runA(async () => {
    const db = await getDb();
    const me = await requirePlayer(db, input.name);
    const place = await resolvePlace(db, input.place);
    // The only thing that can be invalid here is the place, and the page says so in those words.
    if (!place) throw new ActionFailure("invalid");
    const want: WantInput = {
      playerId: me.id,
      weekday: input.weekday,
      fromTime: input.fromTime,
      toTime: input.toTime,
      venueSlug: place.venueSlug,
      citySlug: place.citySlug,
      source: "web",
    };
    const row = await recordWant(db, want);
    revalidatePath("/me");
    return { id: row.id };
  });
}

export async function dropWantAction(id: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const db = await getDb();
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    if (!(await dropWant(db, id, me.id))) throw new ActionFailure("not_found");
    revalidatePath("/me");
    return null;
  });
}

/** The player's own list, for the page that shows it. */
export async function myWantsAction(): Promise<ActionResult<{ id: string; weekday: number | null; fromTime: string | null; toTime: string | null; place: string }[]>> {
  return runA(async () => {
    const db = await getDb();
    const me = await getSessionPlayer(db);
    if (!me) return [];
    return (await listWants(db, me.id)).map((w) => ({
      id: w.id,
      weekday: w.weekday,
      fromTime: w.fromTime,
      toTime: w.toTime,
      place: w.venueSlug ?? w.citySlug ?? "",
    }));
  });
}
