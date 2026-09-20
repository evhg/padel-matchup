"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { refreshClubAvailability } from "@/lib/booking/availability";
import { isValidTimeZone } from "@/lib/dates";
import { emailEnabled } from "@/lib/config";
import type { Club } from "@/db/schema";
import { CLAIM_ROLES, CLUB_LIMITS, claimClub, claimEmailForCode, getClubByToken, isClubLive, markClaimVerified, updateClub } from "@/lib/domain/clubs";
import { getSessionPlayer } from "@/lib/session";
import { consumeEmailCode, issueEmailCode } from "@/lib/domain/identity";
import { sendClaimCodeEmail } from "@/lib/notify";
import { replaceCourts } from "@/lib/domain/courts";
import { askOwnerAboutClub, tellOwnerClaimVerified } from "@/lib/telegram/clubs";
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
  courtsIndoor: z.coerce.number().int().min(0).max(64).optional().nullable(),
  courtsOutdoor: z.coerce.number().int().min(0).max(64).optional().nullable(),
  about: z.string().max(CLUB_LIMITS.aboutMax).optional(),
  city: z.string().max(40).optional(),
  place: z.string().max(60).optional(),
  country: z.string().length(2).optional(),
  opensAt: z.string().max(5).optional(),
  closesAt: z.string().max(5).optional(),
  tz: z.string().max(64).optional(),
  claimRole: z.enum(CLAIM_ROLES).optional(),
  claimContact: z.string().max(120).optional(),
});
export type ClaimClubInput = z.infer<typeof claimSchema>;

const updateSchema = z.object({
  website: url,
  bookingUrl: url,
  mapUrl: url,
  courts: z.coerce.number().int().min(1).max(64).optional().nullable(),
  courtsIndoor: z.coerce.number().int().min(0).max(64).optional().nullable(),
  courtsOutdoor: z.coerce.number().int().min(0).max(64).optional().nullable(),
  about: z.string().max(CLUB_LIMITS.aboutMax).optional(),
  city: z.string().max(40).optional(),
  place: z.string().max(60).optional(),
  country: z.string().length(2).optional(),
  opensAt: z.string().max(5).optional(),
  closesAt: z.string().max(5).optional(),
  availabilityUrl: url,
  availabilityKind: z.string().max(20).optional(),
});
export type UpdateClubInput = z.infer<typeof updateSchema>;

/** Self-serve claim; the owner gets one Telegram message with Approve and Reject. */
/**
 * A work email at the club's own domain gets a 6-digit code at once; the address it went to comes
 * back so the screen can ask for the code. Null when the contact proves nothing by itself, or email is off.
 */
async function sendClaimCode(db: Awaited<ReturnType<typeof getDb>>, club: Club, locale: string | null | undefined): Promise<string | null> {
  const email = claimEmailForCode(club);
  if (!email || !emailEnabled()) return null;
  const issued = await issueEmailCode(db, email);
  if (!issued) return null;
  const sent = await sendClaimCodeEmail(issued.email, issued.code, club.name, locale);
  return sent ? email : null;
}

export async function claimClubAction(raw: ClaimClubInput): Promise<ActionResult<{ slug: string; token: string; codeSentTo: string | null }>> {
  return runA(async () => {
    const input = claimSchema.parse(raw);
    const db = await getDb();
    const me = await requirePlayer(db, input.name);
    await assertRate(db, "club_claim", me.id, CLUB_LIMITS.claimsPerPlayerPerDay);
    const club = await claimClub(db, { name: input.clubName, playerId: me.id, place: input.place, country: input.country, claimRole: input.claimRole, claimContact: input.claimContact, tz: input.tz && isValidTimeZone(input.tz) ? input.tz : null, website: input.website, bookingUrl: input.bookingUrl, mapUrl: input.mapUrl, courts: input.courts, courtsIndoor: input.courtsIndoor, courtsOutdoor: input.courtsOutdoor, opensAt: input.opensAt, closesAt: input.closesAt, about: input.about, city: input.city });
    after(async () => {
      await askOwnerAboutClub(db, club, me);
    });
    revalidatePath(`/v/${club.slug}`);
    revalidatePath("/clubs");
    revalidatePath("/me");
    const codeSentTo = await sendClaimCode(db, club, me.locale);
    return { slug: club.slug, token: club.manageToken, codeSentTo };
  });
}

/** A new code to the same work email, from the done screen or the manage page. */
export async function sendClaimCodeAction(token: string): Promise<ActionResult<{ sentTo: string | null }>> {
  return runA(async () => {
    const db = await getDb();
    const club = await getClubByToken(db, token);
    if (!club) throw new ActionFailure("not_found");
    if (club.claimVerifiedAt) return { sentTo: null };
    await assertRate(db, "claim_code", club.slug, 6);
    // The manage link works without a session; the code's language then follows the site's default.
    const me = await getSessionPlayer(db);
    return { sentTo: await sendClaimCode(db, club, me?.locale) };
  });
}

/** The code typed back: right, and the claim is confirmed by the club's own mail; the owner hears it. */
export async function confirmClaimCodeAction(token: string, code: string): Promise<ActionResult<{ verified: boolean }>> {
  return runA(async () => {
    const db = await getDb();
    const club = await getClubByToken(db, token);
    if (!club) throw new ActionFailure("not_found");
    if (club.claimVerifiedAt) return { verified: true };
    const email = claimEmailForCode(club);
    if (!email) throw new ActionFailure("invalid");
    await consumeEmailCode(db, email, String(code ?? "").trim());
    const row = await markClaimVerified(db, club.slug);
    if (row && !isClubLive(row)) after(() => tellOwnerClaimVerified(row, email));
    revalidatePath(`/v/${club.slug}/manage/${token}`);
    return { verified: true };
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

const courtsSchema = z.array(z.object({ name: z.string().max(40), kind: z.enum(["indoor", "outdoor"]).nullable().optional(), number: z.coerce.number().int().min(1).max(999).nullable().optional() })).max(64);

/** The club's courts as a set, through the manage link; the three counts follow the rows. */
export async function setClubCourtsAction(token: string, raw: unknown): Promise<ActionResult<{ courts: { name: string; kind: string | null }[]; total: number | null }>> {
  return runA(async () => {
    const input = courtsSchema.parse(raw);
    const db = await getDb();
    const r = await replaceCourts(db, token, input);
    if (!r) throw new ActionFailure("not_found");
    revalidatePath(`/v/${r.club.slug}`);
    revalidatePath(`/v/${r.club.slug}/manage/${token}`);
    revalidatePath("/");
    return { courts: r.courts.map((c) => ({ name: c.name, kind: c.kind })), total: r.club.courts };
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
