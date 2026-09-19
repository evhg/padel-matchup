import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { Footer, Header } from "@/components/Header";
import { getDb } from "@/db";
import { seriesRanking } from "@/lib/domain/competitionExtras";
import { dayRange } from "@/lib/tournamentText";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ tag: string }> };
const TAG = /^[\p{L}\p{N}-]{1,40}$/u;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { tag } = await params;
  const t = await getTranslations();
  return { title: t("tournament.rankingTitle", { tag: decodeURIComponent(tag) }), description: t("tournament.rankingSub") };
}

/** The ranking across the editions that share a tag, and the editions themselves. */
export default async function SeriesRankingPage({ params }: Props) {
  const raw = decodeURIComponent((await params).tag).toLowerCase();
  if (!TAG.test(raw)) notFound();
  const db = await getDb();
  const [t, locale, ranking] = await Promise.all([getTranslations(), getLocale(), seriesRanking(db, raw)]);
  if (ranking.competitions.length === 0) notFound();
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12">
        <section className="card">
          <span className="chip-muted">🏆 {t("tournament.ranking")}</span>
          <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight">{t("tournament.rankingTitle", { tag: raw })}</h1>
          <p className="mt-2 text-sm text-muted">{t("tournament.rankingSub")}</p>
        </section>
        <section className="card" data-testid="ranking">
          {ranking.rows.length === 0 ? (
            <p className="text-sm text-muted">{t("tournament.rankingNone")}</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th className="font-semibold"></th>
                  <th className="w-16 text-right font-semibold">{t("tournament.rankingPoints")}</th>
                  <th className="w-16 text-right font-semibold">{t("tournament.rankingPodiums")}</th>
                  <th className="w-16 text-right font-semibold">{t("tournament.rankingEditions")}</th>
                </tr>
              </thead>
              <tbody>
                {ranking.rows.map((r, i) => (
                  <tr key={r.playerId} className={i < 3 ? "font-bold" : ""}>
                    <td className="max-w-0 truncate py-1 pr-2">
                      {i + 1}. {r.name}
                    </td>
                    <td className="text-right tabular-nums">{r.points}</td>
                    <td className="text-right tabular-nums">{r.podiums}</td>
                    <td className="text-right tabular-nums">{r.editions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <section className="card">
          <h2 className="text-lg font-extrabold">{t("tournament.listTitle")}</h2>
          <ul className="mt-1 flex flex-col divide-y divide-line">
            {ranking.competitions.map((c) => (
              <li key={c.id}>
                <Link href={`/t/${c.slug}`} prefetch={false} className="block py-3 hover:underline">
                  <div className="font-bold">{c.name}</div>
                  <div className="text-sm text-muted">
                    {dayRange(c.startsOn, c.endsOn, locale)}
                    {c.venueName ? ` · ${c.venueName}` : ""}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </main>
      <Footer />
    </>
  );
}
