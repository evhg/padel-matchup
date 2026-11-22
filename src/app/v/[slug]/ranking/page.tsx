import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { Footer, Header } from "@/components/Header";
import { RankingOptIn } from "@/components/RankingOptIn";
import { RankingTable } from "@/components/RankingTable";
import { getDb } from "@/db";
import { baseUrl } from "@/lib/config";
import { getRanking } from "@/lib/domain/ranking";
import { venueRecords } from "@/lib/domain/matchStats";
import { StatTiles, pairName } from "@/components/StatTiles";
import { getVenueName, isValidVenueSlug } from "@/lib/domain/venueBoard";
import { getSessionPlayer } from "@/lib/session";
import { withClientMessages } from "@/i18n/withClientMessages";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const t = await getTranslations();
  const db = await getDb();
  const venue = isValidVenueSlug(slug) ? await getVenueName(db, slug) : null;
  if (!venue) return { title: t("ranking.title") };
  const title = t("ranking.clubTitle", { venue: venue.name });
  const description = t("ranking.metaDescription", { name: venue.name });
  return { title, description, alternates: { canonical: `/v/${slug}/ranking` }, openGraph: { title, description, type: "website", url: `${baseUrl()}/v/${slug}/ranking` } };
}

/** Club ranking: finalized results from the last 90 days, opted-in players only. */
async function VenueRankingPage({ params }: Props) {
  const { slug } = await params;
  if (!isValidVenueSlug(slug)) notFound();
  const db = await getDb();
  const venue = await getVenueName(db, slug);
  if (!venue) notFound();
  const [t, me, ranking] = await Promise.all([getTranslations(), getSessionPlayer(db), getRanking(db, { venueSlug: slug })]);
  // The club's records from filmed matches, opted-in players only, like the ranking above them.
  const records = await venueRecords(db, slug);
  const day = new Intl.DateTimeFormat(await getLocale(), { day: "numeric", month: "short", year: "numeric" });
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12">
        <section className="card">
          <span className="chip-muted">🏆 {t("ranking.title")}</span>
          <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight">{t("ranking.clubTitle", { venue: venue.name })}</h1>
          <p className="mt-2 text-sm text-muted">{t("ranking.sub")}</p>
          <RankingTable rows={ranking.rows} events={ranking.events} highlightId={me?.id ?? null} />
          {me ? <RankingOptIn optedIn={me.rankingOptIn} /> : <p className="mt-3 text-xs text-faint">{t("ranking.optInOnly")}</p>}
        </section>
        {records.size > 0 && (
          <section className="card" data-testid="club-records">
            <h2 className="text-lg font-extrabold">{t("stats.recordsTitle")}</h2>
            <p className="mt-1 text-xs text-muted">{t("stats.recordsLead")}</p>
            <StatTiles rows={[...records.values()].flatMap((board) => board.map((r) => ({ kind: r.kind, value: r.value, margin: r.margin, who: pairName(r.name, r.partnerName), note: day.format(r.startsAt) })))} />
          </section>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <Link href={`/v/${slug}`} prefetch={false} className="link">
            📍 {t("venue.board")}
          </Link>
          <Link href={`/?venue=${encodeURIComponent(venue.name)}`} prefetch={false} className="link">
            + {t("common.newMatch")}
          </Link>
        </div>
      </main>
      <Footer />
    </>
  );
}

export default withClientMessages(["common", "ranking"], VenueRankingPage);
