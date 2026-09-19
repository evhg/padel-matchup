import { getTranslations } from "next-intl/server";
import { getDb } from "@/db";
import { resultsCsv } from "@/lib/domain/competitionExtras";
import { orderOfPlay } from "@/lib/domain/competitionSchedule";
import { getCompetition } from "@/lib/domain/competitions";

export const dynamic = "force-dynamic";

/** Every match with a time or a result, one line each: `/t/<slug>/results.csv`. What the page shows, as a file. */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(slug)) return new Response("Not found", { status: 404 });
  const db = await getDb();
  const c = await getCompetition(db, slug);
  if (!c) return new Response("Not found", { status: 404 });
  const t = await getTranslations();
  const csv = resultsCsv(await orderOfPlay(db, c.id, { all: true }), c.tz, {
    category: t("tournament.csvCategory"),
    phase: t("tournament.csvPhase"),
    round: t("tournament.csvRound"),
    when: t("tournament.csvWhen"),
    court: t("tournament.csvCourt"),
    a: t("tournament.csvA"),
    b: t("tournament.csvB"),
    score: t("tournament.csvScore"),
    winner: t("tournament.csvWinner"),
  });
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="results-${c.slug}.csv"`, "cache-control": "no-store", "x-robots-tag": "noindex" } });
}
