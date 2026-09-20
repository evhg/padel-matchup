import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Footer, Header } from "@/components/Header";
import { CompetitionForm } from "@/components/tournament/CompetitionForm";
import { CourtsForm } from "@/components/tournament/CourtsForm";
import { DrawControls } from "@/components/tournament/DrawControls";
import { OrderOfPlay } from "@/components/tournament/OrderOfPlay";
import { WeekendStrip, type Stage } from "@/components/tournament/WeekendStrip";
import { DrawView } from "@/components/tournament/DrawView";
import { ManagePanel } from "@/components/tournament/ManagePanel";
import { getDb } from "@/db";
import { CITIES } from "@/lib/domain/cities";
import { listClubsForPicking } from "@/lib/domain/clubs";
import { competitionDraws } from "@/lib/domain/competitionDraw";
import { COURTS, orderOfPlay } from "@/lib/domain/competitionSchedule";
import { competitionPage, getCompetition, isOrganizer } from "@/lib/domain/competitions";
import { utcToZonedParts } from "@/lib/dates";
import { getSessionPlayer } from "@/lib/session";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ slug: string }> };
const SLUG = /^[a-z0-9][a-z0-9-]{0,59}$/;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t("tournament.manage"), robots: { index: false, follow: false } };
}

/** The organiser's desk; anyone else lands on the public page. */
export default async function ManageTournamentPage({ params }: Props) {
  const { slug } = await params;
  if (!SLUG.test(slug)) notFound();
  const db = await getDb();
  const c = await getCompetition(db, slug);
  if (!c) notFound();
  const me = await getSessionPlayer(db);
  if (!isOrganizer(c, me?.id)) redirect(`/t/${slug}`);
  const [t, page, clubs] = await Promise.all([getTranslations(), competitionPage(db, c), listClubsForPicking(db)]);
  const draws = await competitionDraws(db, c.id, page.categories.map((k) => k.category));
  const play = await orderOfPlay(db, c.id);
  // How a weekend runs, read off the data: pairs entered, every category with pairs drawn and
  // published, courts named and every match given a time, the days of play, the days after.
  const entered = page.categories.reduce((n, k) => n + k.entered.length, 0);
  const withPairs = page.categories.filter((k) => k.entered.length > 0);
  const published = withPairs.filter((k) => k.category.drawStatus === "published" || k.category.drawStatus === "done");
  const today = utcToZonedParts(new Date(), c.tz).date;
  const over = today > c.endsOn;
  const stages: Stage[] = [
    { key: "entries", href: "#entries", done: entered > 0, count: t("tournament.strip.pairs", { count: entered }) },
    { key: "draw", href: "#draw", done: withPairs.length > 0 && published.length === withPairs.length, count: page.categories.length ? `${published.length}/${page.categories.length}` : null },
    { key: "courts", href: "#courts", done: (c.courtNames?.length ?? 0) > 0 && play.length > 0, count: c.courtNames?.length ? t("tournament.strip.courtsCount", { count: c.courtNames.length }) : null },
    { key: "live", href: `/t/${c.slug}/tv`, done: over },
    { key: "results", href: `/t/${c.slug}/results.csv`, done: over },
  ];
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12">
        <section className="card">
          <span className="chip-muted">🏆 {t("tournament.manage")}</span>
          <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight">{c.name}</h1>
          <Link href={`/t/${c.slug}`} prefetch={false} className="btn-ghost btn-sm mt-3">
            {t("tournament.open")}
          </Link>
        </section>
        <WeekendStrip stages={stages} />
        <div id="entries" className="flex flex-col gap-4">
        <ManagePanel
          slug={c.slug}
          status={c.status}
          categories={page.categories.map((k) => ({
            id: k.category.id,
            name: k.category.name,
            levelMin: k.category.levelMin,
            levelMax: k.category.levelMax,
            maxPairs: k.category.maxPairs,
            drawStatus: k.category.drawStatus,
            entered: k.entered.map((p) => ({ id: p.id, p1: p.p1.name, p2: p.p2.name, paid: p.paid, claimed: p.claimed, position: p.position, seed: p.seed, wildcard: p.wildcard, checkedIn: p.checkedIn })),
            waiting: k.waiting.map((p) => ({ id: p.id, p1: p.p1.name, p2: p.p2.name, paid: p.paid, claimed: p.claimed, position: p.position, seed: p.seed, wildcard: p.wildcard, checkedIn: p.checkedIn })),
          }))}
        />
        </div>
        <div id="courts">
          <CourtsForm slug={c.slug} courtNames={c.courtNames ?? []} dayStart={c.dayStart ?? COURTS.defaultStart} dayEnd={c.dayEnd ?? COURTS.defaultEnd} hasDraw={draws.size > 0} />
        </div>
        {play.length > 0 && <OrderOfPlay rows={play} tz={c.tz} />}
        {page.categories.map(({ category }, i) => {
          const view = draws.get(category.id);
          return (
            <section key={category.id} id={i === 0 ? "draw" : undefined} className="flex flex-col gap-4">
              <DrawControls
                slug={c.slug}
                categoryId={category.id}
                categoryName={category.name}
                settings={{ format: category.format, groupSize: category.groupSize, groupsThrough: category.groupsThrough, consolation: category.consolation, qualifyingSpots: category.qualifyingSpots, scoringGroup: category.scoringGroup, scoringKnockout: category.scoringKnockout, scoringFinal: category.scoringFinal, goldenPoint: category.goldenPoint, drawStatus: category.drawStatus, maxPairs: category.maxPairs }}
              />
              {view && (
                <section className="card">
                  <h2 className="text-lg font-extrabold">
                    {t("tournament.draw")} · {category.name}
                  </h2>
                  <DrawView view={view} slug={c.slug} organizer tz={c.tz} courtNames={c.courtNames ?? []} />
                </section>
              )}
            </section>
          );
        })}
        <section className="flex flex-col gap-2">
          <h2 className="px-1 text-lg font-extrabold">{t("tournament.details")}</h2>
          <CompetitionForm
            hasIdentity
            slug={c.slug}
            cities={CITIES.map((x) => ({ slug: x.slug, name: x.name, tz: x.tz }))}
            listed={clubs.map((x) => x.name)}
            initial={{ name: c.name, startsOn: c.startsOn, endsOn: c.endsOn, venueName: c.venueName ?? "", city: c.city ?? "", entryNote: c.entryNote ?? "", seriesTag: c.seriesTag ?? "" }}
          />
        </section>
      </main>
      <Footer />
    </>
  );
}
