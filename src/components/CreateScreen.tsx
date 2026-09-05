import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import { CreateEventForm } from "@/components/CreateEventForm";
import { getDb } from "@/db";
import Link from "next/link";
import { isValidInviteCode } from "@/lib/codes";
import { isValidTimeZone, utcToZonedParts } from "@/lib/dates";
import { getGroupByCode, getGroupMember, nextGroupSlot } from "@/lib/domain/groups";
import { getPlayerTimePatterns, getVenues } from "@/lib/domain/queries";
import { getSessionPlayer } from "@/lib/session";
import type { EventFormValues } from "./EventFields";

/** The create form with its data. Rendered on / and /new. */
export async function CreateScreen({ heading, sub, prefill }: { heading: string; sub?: string; prefill?: { type?: string; capacity?: string; group?: string } }) {
  const t = await getTranslations();
  const hdrs = await headers();
  const headerTz = hdrs.get("x-vercel-ip-timezone");
  const tzFromHeader = Boolean(headerTz && isValidTimeZone(headerTz));
  const defaultTz = tzFromHeader ? headerTz! : "UTC";
  const db = await getDb();
  const me = await getSessionPlayer(db);
  const [venues, patterns] = me ? await Promise.all([getVenues(db, me.id), getPlayerTimePatterns(db, me.id)]) : [[], []];

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
  return (
    <>
      <div>
        <h1 className="text-3xl font-extrabold tracking-tight">{group && isMember ? t("group.forGroup", { name: group.name }) : heading}</h1>
        {sub && !(group && isMember) && <p className="mt-1 text-muted">{sub}</p>}
        {group && isMember && <p className="mt-1 text-muted">{t("group.nextMatchHelp")}</p>}
      </div>
      {group && !isMember && (
        <Link href={`/g/${group.code}`} prefetch={false} className="card flex items-center justify-between bg-accent-soft border-accent text-sm font-bold">
          <span>👥 {group.name}</span>
          <span className="text-muted">{t("group.memberOnly")} →</span>
        </Link>
      )}
      <CreateEventForm defaultTz={defaultTz} tzFromHeader={tzFromHeader} venues={venues.map((v) => ({ name: v.name, mapUrl: v.mapUrl }))} hasIdentity={Boolean(me)} patterns={patterns.map((p) => ({ dow: p.dow, time: p.time }))} hasLevel={me?.level != null} initialType={prefill?.type === "tournament" ? "tournament" : "match"} initialCapacity={prefill?.capacity ? Number(prefill.capacity) : undefined} groupCode={group && isMember ? group.code : undefined} initialValues={groupValues} />
    </>
  );
}
