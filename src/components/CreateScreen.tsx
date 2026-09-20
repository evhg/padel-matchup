import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import { CreateEventForm } from "@/components/CreateEventForm";
import { ReturningPlayer } from "@/components/ReturningPlayer";
import { getDb } from "@/db";
import Link from "next/link";
import { isValidInviteCode } from "@/lib/codes";
import { isValidTimeZone, utcToZonedParts } from "@/lib/dates";
import { getGroupByCode, getGroupMember, nextGroupSlot } from "@/lib/domain/groups";
import { venuesForPicking } from "@/lib/domain/clubs";
import { getPlayerTimePatterns } from "@/lib/domain/queries";
import { getSessionPlayer } from "@/lib/session";
import { SEAT_NAMES_MAX } from "@/lib/domain/slots";
import type { EventFormValues } from "./EventFields";

/** The create form with its data. Rendered on / and /new. */
export async function CreateScreen({ heading, sub, prefill }: { heading: string; sub?: string; prefill?: { type?: string; capacity?: string; group?: string; venue?: string; tg?: string; dc?: string; names?: string } }) {
  const t = await getTranslations();
  const hdrs = await headers();
  const headerTz = hdrs.get("x-vercel-ip-timezone");
  const tzFromHeader = Boolean(headerTz && isValidTimeZone(headerTz));
  const defaultTz = tzFromHeader ? headerTz! : "UTC";
  const db = await getDb();
  const me = await getSessionPlayer(db);
  // Sequential, not parallel: the pooler stalls on pipelined bursts (rule 8).
  // Anybody sees the clubs, signed in or not — the list is the point of it.
  // The time zone alone puts Phuket and Bangkok in the same bucket, and Bangkok has twice the clubs
  // and sorts first, so the city the edge reports is what makes the list start where the person is.
  const headerCity = hdrs.get("x-vercel-ip-city");
  const venues = await venuesForPicking(db, me?.id ?? null, { tz: tzFromHeader ? headerTz : null, city: headerCity ? decodeURIComponent(headerCity) : null });
  const patterns = me ? await getPlayerTimePatterns(db, me.id) : [];

  // From a group page: the group's usual settings prefill the form and every member gets pinged on create.
  const group = prefill?.group && isValidInviteCode(prefill.group) ? await getGroupByCode(db, prefill.group) : null;
  const isMember = group && me ? Boolean(await getGroupMember(db, group.id, me.id)) : false;
  let groupValues: Partial<EventFormValues> | undefined;
  if (group && isMember) {
    const slot = nextGroupSlot(group);
    const when = slot ? { date: slot.date, time: slot.time } : undefined;
    groupValues = {
      type: group.type,
      capacity: group.capacity,
      whenFull: group.whenFull,
      venueName: group.venueName ?? "",
      venueMapUrl: group.venueMapUrl ?? "",
      court: group.court ?? "",
      levelMin: group.levelMin,
      levelMax: group.levelMax,
      tz: group.tz,
      ...when,
    };
    void utcToZonedParts;
  }
  // From a venue board: the venue is prefilled and the listing switched on.
  const venuePrefill = prefill?.venue?.trim().slice(0, 80);
  if (venuePrefill && !groupValues) groupValues = { venueName: venuePrefill, venueMapUrl: venues.find((v) => v.name === venuePrefill)?.mapUrl ?? "", publicListing: true };
  // From the americano generator: the schedule was built for these people, so they travel with the
  // tap. Landing on a page that reads "Set up a match in 10 seconds" made the tap look like nothing
  // happened, which is what the owner reported on 20 September.
  const fromGenerator = prefill?.type === "tournament";
  const carried = (prefill?.names ?? "")
    .split(",")
    .map((n) => n.trim().slice(0, 60))
    .filter(Boolean)
    .slice(0, SEAT_NAMES_MAX);
  // A device that has never seen this person shows a name field. Somebody who has played before is
  // looking for their own matches, and the only door was navigating to My matches and knowing to.
  const returning = me ? null : <ReturningPlayer collapsed />;

  return (
    <>
      <div>
        <h1 className="text-3xl font-extrabold tracking-tight">{group && isMember ? t("group.forGroup", { name: group.name }) : fromGenerator ? t("landing.fromGeneratorTitle") : heading}</h1>
        {sub && !(group && isMember) && <p className="mt-1 text-muted">{fromGenerator ? t("landing.fromGeneratorSub") : sub}</p>}
        {group && isMember && <p className="mt-1 text-muted">{t("group.nextMatchHelp")}</p>}
      </div>
      {group && !isMember && (
        <Link href={`/g/${group.code}`} prefetch={false} className="card flex items-center justify-between bg-accent-soft border-accent text-sm font-bold">
          <span>👥 {group.name}</span>
          <span className="text-muted">{t("group.memberOnly")} →</span>
        </Link>
      )}
      {carried.length > 0 && (
        <section className="card border-accent bg-accent-soft" data-testid="carried-players">
          <p className="text-sm font-extrabold">{t("landing.carriedTitle", { count: carried.length })}</p>
          <p className="mt-1 text-sm text-muted">{carried.join(" · ")}</p>
          <p className="mt-2 text-xs text-muted">{t("landing.carriedHelp")}</p>
        </section>
      )}
      <CreateEventForm carriedNames={carried} defaultTz={defaultTz} tzFromHeader={tzFromHeader} venues={venues.map((v) => ({ name: v.name, mapUrl: v.mapUrl, where: v.where, country: v.country, province: v.province, courts: v.courts, courtNames: v.courtNames }))} hasIdentity={Boolean(me)} returning={returning} patterns={patterns.map((p) => ({ dow: p.dow, time: p.time }))} hasLevel={me?.level != null} initialType={prefill?.type === "tournament" ? "tournament" : "match"} initialCapacity={prefill?.capacity ? Number(prefill.capacity) : undefined} groupCode={group && isMember ? group.code : undefined} initialValues={groupValues} telegramTicket={prefill?.tg?.slice(0, 80)} discordTicket={prefill?.dc?.slice(0, 80)} />
    </>
  );
}
