import { getTranslations } from "next-intl/server";
import { getDb } from "@/db";
import { monthRange } from "@/lib/coach/chains";
import { coachStatement, statementCsv } from "@/lib/coach/statement";
import { statementLabels } from "@/lib/coach/wrap";
import { getCoachForActor } from "@/lib/domain/coaching";
import { getSessionPlayer } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * The coach's month as a file: `/coach/statement.csv?month=2026-09`. The signed-in coach or their
 * manager only; a 404 to everybody else, so the address gives nothing away. No month: the current one.
 */
export async function GET(req: Request) {
  const db = await getDb();
  const me = await getSessionPlayer(db);
  const found = me ? await getCoachForActor(db, me.id) : null;
  if (!found) return new Response("Not found", { status: 404 });
  const { coach } = found;
  const wanted = new URL(req.url).searchParams.get("month") ?? "";
  const anchor = /^\d{4}-(0[1-9]|1[0-2])$/.test(wanted) ? new Date(`${wanted}-15T12:00:00Z`) : new Date();
  const month = monthRange(coach.tz, anchor);
  const t = await getTranslations();
  const csv = statementCsv(await coachStatement(db, coach, month.from, month.to), statementLabels((key) => t(key as "wrap.stStudent")));
  return new Response(csv, {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="statement-${month.label}.csv"`, "cache-control": "private, no-store", "x-robots-tag": "noindex" },
  });
}
