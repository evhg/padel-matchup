import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Footer, Header } from "@/components/Header";
import { RankingOptIn } from "@/components/RankingOptIn";
import { RankingTable } from "@/components/RankingTable";
import { getDb } from "@/db";
import { baseUrl } from "@/lib/config";
import { getRanking } from "@/lib/domain/ranking";
import { getVenueName, isValidVenueSlug } from "@/lib/domain/venueBoard";
import { getSessionPlayer } from "@/lib/session";

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
export default async function VenueRankingPage({ params }: Props) {
  const { slug } = await params;
  if (!isValidVenueSlug(slug)) notFound();
  const db = await getDb();
  const venue = await getVenueName(db, slug);
  if (!venue) notFound();
  const [t, me, ranking] = await Promise.all([getTranslations(), getSessionPlayer(db), getRanking(db, { venueSlug: slug })]);
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
