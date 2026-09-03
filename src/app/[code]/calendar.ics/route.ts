import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { buildIcs } from "@/lib/calendar";
import { isValidShareCode } from "@/lib/codes";
import { baseUrl, emailFrom, shortHost } from "@/lib/config";
import { getEventByCode } from "@/lib/domain/queries";
import { eventTitleLine, venueWithCourt } from "@/lib/labels";
import { translatorFor } from "@/lib/email/templates";
import { eventUrl } from "@/lib/share";
import { getSessionPlayer } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Downloadable .ics (Apple Calendar and friends) — works with zero email. */
export async function GET(_req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!isValidShareCode(code)) return new NextResponse("Not found", { status: 404 });
  const db = await getDb();
  const detail = await getEventByCode(db, code);
  if (!detail) return new NextResponse("Not found", { status: 404 });
  const me = await getSessionPlayer(db);
  const { t } = await translatorFor(me?.locale ?? detail.creator.locale);
  const courtNumber = (n: string) => t("event.courtNumber", { n });
  const ev = detail.event;
  const m = emailFrom().match(/<([^>]+)>/);
  const ics = buildIcs({
    event: ev,
    title: eventTitleLine(ev, { fallback: t(ev.type === "match" ? "event.match" : "event.tournament"), courtNumber }),
    url: eventUrl(baseUrl(), code),
    organizer: { name: detail.creator.displayName, email: m ? m[1] : emailFrom() },
    method: "PUBLISH",
    domain: shortHost(),
    location: venueWithCourt(ev, { venueTbd: t("event.venueTbd"), courtNumber }),
  });
  return new NextResponse(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="kicksmash-${code}.ics"`,
      "Cache-Control": "private, no-store",
    },
  });
}
