"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { getClubByToken } from "@/lib/domain/clubs";
import { addClubSlot, removeClubSlot, updateClubSlot } from "@/lib/domain/clubWeek";
import { ActionFailure, runA, type ActionResult } from "./shared";

const slotSchema = z.object({
  dow: z.number().int().min(0).max(6),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  type: z.enum(["match", "tournament"]).optional(),
  format: z.enum(["americano", "mexicano", "king"]).nullable().optional(),
  capacity: z.number().int().min(4).max(64).optional(),
  levelMin: z.number().min(0).max(7).nullable().optional(),
  levelMax: z.number().min(0).max(7).nullable().optional(),
  verifiedOnly: z.boolean().optional(),
  title: z.string().max(80).optional(),
  leadDays: z.number().int().min(1).max(14).optional(),
});
export type ClubSlotInput = z.infer<typeof slotSchema>;

async function clubFor(token: string) {
  const db = await getDb();
  const club = await getClubByToken(db, token);
  if (!club) throw new ActionFailure("not_found");
  return { db, club };
}
const revalidate = (slug: string, token: string) => {
  revalidatePath(`/v/${slug}`);
  revalidatePath(`/v/${slug}/manage/${token}`);
};

/** The club adds one line to its week; the hourly job turns it into matches from then on. */
export async function addClubSlotAction(token: string, raw: ClubSlotInput): Promise<ActionResult<{ id: string }>> {
  return runA(async () => {
    const input = slotSchema.parse(raw);
    const { db, club } = await clubFor(token);
    const slot = await addClubSlot(db, club.slug, input);
    revalidate(club.slug, token);
    return { id: slot.id };
  });
}

export async function setClubSlotActiveAction(token: string, id: string, active: boolean): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, club } = await clubFor(token);
    const row = await updateClubSlot(db, club.slug, id, { active });
    if (!row) throw new ActionFailure("not_found");
    revalidate(club.slug, token);
    return null;
  });
}

export async function removeClubSlotAction(token: string, id: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, club } = await clubFor(token);
    if (!(await removeClubSlot(db, club.slug, id))) throw new ActionFailure("not_found");
    revalidate(club.slug, token);
    return null;
  });
}
