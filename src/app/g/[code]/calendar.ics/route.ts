import { getTranslations } from "next-intl/server";
import { getDb } from "@/db";
import { buildFeed, calendarTitle } from "@/lib/calendar";
import { isValidInviteCode } from "@/lib/codes";
import { apexHost, baseUrl } from "@/lib/config";
import { getGroupByCode, getGroupDetail } from "@/lib/domain/groups";
import { venueWithCourt } from "@/lib/labels";

export const dynamic = "force-dynamic";

/** Subscribable feed of a group's matches: every member's calendar stays current without email. */
export async function GET(_req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!isValidInviteCode(code)) return new Response("Not found", { status: 404 });
  const db = await getDb();
  const group = await getGroupByCode(db, code);
  if (!group) return new Response("Not found", { status: 404 });
  const [t, detail] = await Promise.all([getTranslations(), getGroupDetail(db, group)]);
  const base = baseUrl();
  const labelOpts = { venueTbd: t("event.venueTbd"), courtNumber: (n: string) => t("event.courtNumber", { n }) };
  const entries = [...detail.upcoming, ...detail.past].map((ev) => ({ event: ev, title: calendarTitle(ev, t(ev.type === "match" ? "event.match" : "event.tournament")), url: `${base}/${ev.code}`, location: venueWithCourt(ev, labelOpts) }));
  const body = buildFeed({ name: group.name, domain: apexHost(), entries, description: `${base}/g/${code}` });
  return new Response(body, { headers: { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": `inline; filename="${code}.ics"`, "Cache-Control": "public, max-age=0, s-maxage=300" } });
}
