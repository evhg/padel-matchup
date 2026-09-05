import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import { CreateEventForm } from "@/components/CreateEventForm";
import { getDb } from "@/db";
import { isValidTimeZone } from "@/lib/dates";
import { getPlayerTimePatterns, getVenues } from "@/lib/domain/queries";
import { getSessionPlayer } from "@/lib/session";

/** The create form with its data. Rendered on / and /new. */
export async function CreateScreen({ heading, sub, prefill }: { heading: string; sub?: string; prefill?: { type?: string; capacity?: string } }) {
  const t = await getTranslations();
  const hdrs = await headers();
  const headerTz = hdrs.get("x-vercel-ip-timezone");
  const tzFromHeader = Boolean(headerTz && isValidTimeZone(headerTz));
  const defaultTz = tzFromHeader ? headerTz! : "UTC";
  const db = await getDb();
  const me = await getSessionPlayer(db);
  const [venues, patterns] = me ? await Promise.all([getVenues(db, me.id), getPlayerTimePatterns(db, me.id)]) : [[], []];
  void t;
  return (
    <>
      <div>
        <h1 className="text-3xl font-extrabold tracking-tight">{heading}</h1>
        {sub && <p className="mt-1 text-muted">{sub}</p>}
      </div>
      <CreateEventForm defaultTz={defaultTz} tzFromHeader={tzFromHeader} venues={venues.map((v) => ({ name: v.name, mapUrl: v.mapUrl }))} hasIdentity={Boolean(me)} patterns={patterns.map((p) => ({ dow: p.dow, time: p.time }))} hasLevel={me?.level != null} initialType={prefill?.type === "tournament" ? "tournament" : "match"} initialCapacity={prefill?.capacity ? Number(prefill.capacity) : undefined} />
    </>
  );
}
