"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { refreshClubAvailability } from "@/lib/booking/availability";
import { isValidTimeZone } from "@/lib/dates";
import { CLUB_LIMITS, claimClub, getClubByToken, updateClub } from "@/lib/domain/clubs";
import { askOwnerAboutClub } from "@/lib/telegram/clubs";
import { ActionFailure, assertRate, requirePlayer, runA, type ActionResult } from "./shared";

const url = z.string().max(500).optional();
const claimSchema = z.object({
  /** First name, for people without an identity yet. */
  name: z.string().max(60).optional(),
  clubName: z.string().min(2).max(80),
  website: url,
  bookingUrl: url,
  mapUrl: url,
  courts: z.coerce.number().int().min(1).max(64).optional().nullable(),
  about: z.string().max(CLUB_LIMITS.aboutMax).optional(),
  city: z.string().max(40).optional(),
  tz: z.string().max(64).optional(),
});
export type ClaimClubInput = z.infer<typeof claimSchema>;

const updateSchema = z.object({
  website: url,
  bookingUrl: url,
  mapUrl: url,
  courts: z.coerce.number().int().min(1).max(64).optional().nullable(),
  about: z.string().max(CLUB_LIMITS.aboutMax).optional(),
  city: z.string().max(40).optional(),
  opensAt: z.string().max(5).optional(),
  closesAt: z.string().max(5).optional(),
  availabilityUrl: url,
  availabilityKind: z.string().max(20).optional(),
});
export type UpdateClubInput = z.infer<typeof updateSchema>;

/** Self-serve claim; the owner gets one Telegram message with Approve and Reject. */
export async function claimClubAction(raw: ClaimClubInput): Promise<ActionResult<{ slug: string; token: string }>> {
  return runA(async () => {
    const input = claimSchema.parse(raw);
    const db = await getDb();
    const me = await requirePlayer(db, input.name);
    await assertRate(db, "club_claim", me.id, CLUB_LIMITS.claimsPerPlayerPerDay);
    const club = await claimClub(db, { name: input.clubName, playerId: me.id, tz: input.tz && isValidTimeZone(input.tz) ? input.tz : null, website: input.website, bookingUrl: input.bookingUrl, mapUrl: input.mapUrl, courts: input.courts, about: input.about, city: input.city });
    after(async () => {
      await askOwnerAboutClub(db, club, me);
    });
    revalidatePath(`/v/${club.slug}`);
    revalidatePath("/clubs");
    revalidatePath("/me");
    return { slug: club.slug, token: club.manageToken };
  });
}

export async function updateClubAction(token: string, raw: UpdateClubInput): Promise<ActionResult<{ slots: number | null; feedError: string | null }>> {
  return runA(async () => {
    const input = updateSchema.parse(raw);
    const db = await getDb();
    const club = await updateClub(db, token, input);
    if (!club) throw new ActionFailure("not_found");
    let slots: number | null = null;
    let feedError: string | null = null;
    if (club.availabilityUrl && club.availabilityKind) {
      const a = await refreshClubAvailability(db, club);
      slots = a?.slots.length ?? null;
      feedError = a?.error ?? null;
    }
    revalidatePath(`/v/${club.slug}`);
    revalidatePath(`/v/${club.slug}/manage/${token}`);
    revalidatePath("/clubs");
    return { slots, feedError };
  });
}

export async function refreshClubAction(token: string): Promise<ActionResult<{ slots: number | null; feedError: string | null }>> {
  return runA(async () => {
    const db = await getDb();
    const club = await getClubByToken(db, token);
    if (!club) throw new ActionFailure("not_found");
    const a = await refreshClubAvailability(db, club);
    revalidatePath(`/v/${club.slug}`);
    return { slots: a?.slots.length ?? null, feedError: a?.error ?? null };
  });
}
