import { getTranslations } from "next-intl/server";
import { getDb } from "@/db";
import { buildFeed, calendarTitle } from "@/lib/calendar";
import { apexHost, baseUrl } from "@/lib/config";
import { getVenueBoard, isValidVenueSlug } from "@/lib/domain/venueBoard";
import { venueWithCourt } from "@/lib/labels";

export const dynamic = "force-dynamic";

/** Subscribable feed of a venue's listed matches. */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!isValidVenueSlug(slug)) return new Response("Not found", { status: 404 });
  const db = await getDb();
  const board = await getVenueBoard(db, slug);
  if (!board) return new Response("Not found", { status: 404 });
  const t = await getTranslations();
  const base = baseUrl();
  const labelOpts = { venueTbd: t("event.venueTbd"), courtNumber: (n: string) => t("event.courtNumber", { n }) };
  const entries = board.events.map(({ event: ev }) => ({ event: ev, title: calendarTitle(ev, t(ev.type === "match" ? "event.match" : "event.tournament")), url: `${base}/${ev.code}`, location: venueWithCourt(ev, labelOpts) }));
  const body = buildFeed({ name: t("venue.boardTitle", { venue: board.name }), domain: apexHost(), entries, description: `${base}/v/${slug}` });
  return new Response(body, { headers: { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": `inline; filename="${slug}.ics"`, "Cache-Control": "public, max-age=0, s-maxage=300" } });
}
