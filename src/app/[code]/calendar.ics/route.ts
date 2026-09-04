import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { isValidShareCode } from "@/lib/codes";
import { getEventByCode } from "@/lib/domain/queries";
import { icsForDownload } from "@/lib/notify";
import { getSessionPlayer } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Downloadable .ics (Apple Calendar and friends). Signed-in viewers get their
 * private event link inside; the title carries "- COMPLETE" once the line-up is.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!isValidShareCode(code)) return new NextResponse("Not found", { status: 404 });
  const db = await getDb();
  const detail = await getEventByCode(db, code);
  if (!detail) return new NextResponse("Not found", { status: 404 });
  const me = await getSessionPlayer(db);
  const ics = await icsForDownload(db, detail, me);
  return new NextResponse(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="kicksmash-${code}.ics"`,
      "Cache-Control": "private, no-store",
    },
  });
}
