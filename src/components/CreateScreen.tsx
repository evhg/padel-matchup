import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import { CreateEventForm } from "@/components/CreateEventForm";
import { ReturningPlayer } from "@/components/ReturningPlayer";
import { getDb } from "@/db";
import Link from "next/link";
import { isValidInviteCode } from "@/lib/codes";
import { isValidTimeZone, utcToZonedParts } from "@/lib/dates";
import { readCreateLink, type CreateLink } from "@/lib/domain/createPrefill";
import { getGroupByCode, getGroupMember, latestGroupMatch, nextGroupSlot } from "@/lib/domain/groups";
import { cleanAgeMin, cleanCategory } from "@/lib/domain/eventTags";
import { parseMatchLength } from "@/lib/domain/matchLength";
import { venuesForPicking } from "@/lib/domain/clubs";
import { getPlayerTimePatterns } from "@/lib/domain/queries";
import { getSessionPlayer } from "@/lib/session";
import type { EventFormValues } from "./EventFields";

/** The create form with its data. Rendered on / and /new. `below` sits under the heading (the landing page's "Find a game" and "Paste it"). */
export async function CreateScreen({ heading, below, prefill }: { heading: string; below?: React.ReactNode; prefill?: CreateLink & { type?: string; capacity?: string; group?: string; tg?: string; dc?: string } }) {
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
  // What the link carries, each value checked against the form's own bounds (`readCreateLink`).
  const link = readCreateLink(prefill ?? {});
  const venues = await venuesForPicking(db, me?.id ?? null, { tz: tzFromHeader ? headerTz : null, city: headerCity ? decodeURIComponent(headerCity) : null }, new Date(), link.venue);
  const patterns = me ? await getPlayerTimePatterns(db, me.id) : [];

  // From a group page: the group's usual settings prefill the form and every member gets pinged on create.
  const group = prefill?.group && isValidInviteCode(prefill.group) ? await getGroupByCode(db, prefill.group) : null;
  const isMember = group && me ? Boolean(await getGroupMember(db, group.id, me.id)) : false;
  let groupValues: Partial<EventFormValues> | undefined;
  if (group && isMember) {
    const slot = nextGroupSlot(group);
    const when = slot ? { date: slot.date, time: slot.time } : undefined;
    // The crew's usual length and tag: as the match before the next slot has them (one read, members only).
    const latest = await latestGroupMatch(db, group, slot?.startsAt ?? new Date());
    const length = parseMatchLength(latest?.durationMinutes);
    groupValues = {
      type: group.type,
      ...(length ? { durationMinutes: length } : {}),
      capacity: group.capacity,
      whenFull: group.whenFull,
      venueName: group.venueName ?? "",
      venueMapUrl: group.venueMapUrl ?? "",
      court: group.court ?? "",
      levelMin: group.levelMin,
      levelMax: group.levelMax,
      category: cleanCategory(latest?.category),
      ageMin: cleanAgeMin(latest?.ageMin),
      tz: group.tz,
      ...when,
    };
    void utcToZonedParts;
  }
  // From a venue board: the venue is prefilled and the listing switched on. From a free court offered
  // to a player who asked for that hour (`offerFreeCourts`): the day and the time come too, in the
  // club's zone. From a pasted booking (`src=paste`): whatever the booking said; a day or a time it did
  // not say stays the form's own (the usual slot, else tomorrow at 18:00), marked as not from the
  // booking; the zone is the booking's, else the person's own; and the listing is off, so the match
  // reaches the venue board only when the organiser switches it on.
  if ((link.venue || link.fromPaste) && !groupValues) {
    const hour = link.fromPaste
      ? { ...(link.date ? { date: link.date } : {}), ...(link.time ? { time: link.time } : {}), ...(link.tz ? { tz: link.tz } : {}) }
      : link.date && link.time && link.tz
        ? { date: link.date, time: link.time, tz: link.tz }
        : {};
    groupValues = {
      venueName: link.venue ?? "",
      venueMapUrl: link.venue ? (venues.find((v) => v.name === link.venue)?.mapUrl ?? "") : "",
      publicListing: link.publicListing,
      ...hour,
      ...(link.durationMinutes ? { durationMinutes: link.durationMinutes } : {}),
      ...(link.court ? { court: link.court } : {}),
      ...(link.cost ? { cost: link.cost } : {}),
    };
  }
  // From the americano generator: the schedule was built for these people, so they travel with the
  // tap. Landing on a page that reads "Set up a match in 10 seconds" made the tap look like nothing
  // happened, which is what the owner reported on 20 September.
  const fromGenerator = prefill?.type === "tournament";
  const carried = link.names;
  // "Court booked by me", under the form, for a booking pasted or a link that says it is booked.
  const booking = link.fromPaste || link.booked ? { booked: link.booked, missing: link.missing, check: link.check, invite: link.invite } : undefined;
  // A new paste on this page is a new address on the same page: the form starts again from it.
  const formKey = JSON.stringify(prefill ?? {});
  // A device that has never seen this person shows a name field. Somebody who has played before is
  // looking for their own matches, and the only door was navigating to My matches and knowing to.
  const returning = me ? null : <ReturningPlayer collapsed />;

  return (
    <>
      <div>
        <h1 className="text-3xl font-extrabold tracking-tight">{group && isMember ? t("group.forGroup", { name: group.name }) : fromGenerator ? t("landing.fromGeneratorTitle") : heading}</h1>
        {fromGenerator && !(group && isMember) && <p className="mt-1 text-muted">{t("landing.fromGeneratorSub")}</p>}
        {group && isMember && <p className="mt-1 text-muted">{t("group.nextMatchHelp")}</p>}
        {/* The landing page's way to a game somebody else made. Inside the heading's block, so it
            costs the form one short line and no extra gap; a crew or a generator hand-off has its own job. */}
        {below && !(group && isMember) && !fromGenerator && below}
      </div>
      {group && !isMember && (
        <Link href={`/g/${group.code}`} prefetch={false} className="card flex items-center justify-between bg-accent-soft border-accent text-sm font-bold">
          <span>👥 {group.name}</span>
          <span className="text-muted">{t("group.memberOnly")} →</span>
        </Link>
      )}
      {carried.length > 0 && (
        <section className="card border-accent bg-accent-soft" data-testid="carried-players">
          <p className="text-sm font-extrabold">{t(link.fromPaste ? "landing.carriedFromBooking" : "landing.carriedTitle", { count: carried.length })}</p>
          <p className="mt-1 text-sm text-muted">{carried.join(" · ")}</p>
          <p className="mt-2 text-xs text-muted">{t("landing.carriedHelp")}</p>
        </section>
      )}
      <CreateEventForm key={formKey} booking={booking} carriedNames={carried} defaultTz={defaultTz} tzFromHeader={tzFromHeader} venues={venues.map((v) => ({ name: v.name, mapUrl: v.mapUrl, where: v.where, country: v.country, province: v.province, courts: v.courts, courtNames: v.courtNames, ...(v.free ? { free: v.free } : {}) }))} hasIdentity={Boolean(me)} returning={returning} patterns={patterns.map((p) => ({ dow: p.dow, time: p.time }))} hasLevel={me?.level != null} initialType={prefill?.type === "tournament" ? "tournament" : "match"} initialCapacity={prefill?.capacity ? Number(prefill.capacity) : undefined} groupCode={group && isMember ? group.code : undefined} initialValues={groupValues} telegramTicket={prefill?.tg?.slice(0, 80)} discordTicket={prefill?.dc?.slice(0, 80)} />
    </>
  );
}
