import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { Footer, Header } from "@/components/Header";
import { ShareButtons } from "@/components/ShareSheet";
import { AutoRefresh } from "@/components/tournament/AutoRefresh";
import { ClaimCard } from "@/components/tournament/ClaimCard";
import { DrawView } from "@/components/tournament/DrawView";
import { EnterForm } from "@/components/tournament/EnterForm";
import { OrderOfPlay } from "@/components/tournament/OrderOfPlay";
import { WithdrawButton } from "@/components/tournament/WithdrawButton";
import { getDb } from "@/db";
import { baseUrl, shortHost } from "@/lib/config";
import { competitionDraws } from "@/lib/domain/competitionDraw";
import { orderOfPlay } from "@/lib/domain/competitionSchedule";
import { competitionPage, entriesOf, getCompetition, isOrganizer, pairByClaimToken, pairSummary } from "@/lib/domain/competitions";
import { localeAlternates } from "@/lib/seo";
import { getSessionPlayer } from "@/lib/session";
import { bandLabel, dayRange } from "@/lib/tournamentText";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ slug: string }>; searchParams: Promise<{ claim?: string; claimed?: string }> };

const SLUG = /^[a-z0-9][a-z0-9-]{0,59}$/;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  if (!SLUG.test(slug)) return {};
  const db = await getDb();
  const c = await getCompetition(db, slug);
  if (!c) return {};
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  const title = t("tournament.metaTitle", { name: c.name });
  const description = t("tournament.metaDescription");
  return { title, description, alternates: localeAlternates(`/t/${slug}`, locale), openGraph: { title, description, type: "website", url: `${baseUrl()}/t/${slug}` } };
}

/** The poster: the days and the place, the categories with who is in, the door to enter, the waiting list. */
export default async function TournamentPage({ params, searchParams }: Props) {
  const { slug } = await params;
  if (!SLUG.test(slug)) notFound();
  const sp = await searchParams;
  const db = await getDb();
  const c = await getCompetition(db, slug);
  if (!c) notFound();
  const [t, locale, me, page] = await Promise.all([getTranslations(), getLocale(), getSessionPlayer(db), competitionPage(db, c)]);
  const mine = me ? await entriesOf(db, c.id, me.id) : [];
  const draws = await competitionDraws(
    db,
    c.id,
    page.categories.map((k) => k.category).filter((k) => k.drawStatus === "published" || k.drawStatus === "done"),
  );
  const myPairIds = new Set(mine.map((e) => e.id));
  const play = draws.size > 0 ? await orderOfPlay(db, c.id) : [];
  // During the days of play the page asks again every minute: the tables and the brackets move with the scores.
  const today = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const live = play.length > 0 && c.startsOn <= today && today <= c.endsOn;
  const claim = sp.claim ? await pairByClaimToken(db, sp.claim) : null;
  const claimedPair = sp.claimed && me ? await pairSummary(db, sp.claimed) : null;
  const claimed = claimedPair && claimedPair.p2PlayerId === me?.id ? claimedPair : null;
  const organizer = isOrganizer(c, me?.id);
  const url = `${baseUrl()}/t/${c.slug}`;
  const days = dayRange(c.startsOn, c.endsOn, locale);
  const byId = new Map(page.categories.flatMap((k) => [...k.entered, ...k.waiting].map((p) => [p.id, { pair: p, category: k.category }] as const)));
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "SportsEvent",
    name: c.name,
    sport: "Padel",
    url,
    startDate: c.startsOn,
    endDate: c.endsOn,
    eventStatus: "https://schema.org/EventScheduled",
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    organizer: { "@type": "Person", name: page.organizerName },
    ...(c.venueName ? { location: { "@type": "Place", name: c.venueName } } : {}),
  };
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
        {live && <AutoRefresh seconds={60} />}
        <section className="card">
          <span className="chip-muted">🏆 {t("tournament.eyebrow")}</span>
          <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight">{c.name}</h1>
          <p className="mt-1 font-semibold">
            {days}
            {c.venueName ? ` · ${t("tournament.at", { venue: c.venueName })}` : ""}
          </p>
          <p className="mt-1 text-sm text-muted">{t("tournament.by", { name: page.organizerName })}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <span className={`chip-muted ${c.status === "open" ? "text-ok" : ""}`} data-testid="status-chip">
              {c.status === "open" ? t("tournament.statusOpen") : t("tournament.statusClosed")}
            </span>
          </div>
          {c.entryNote && (
            <p className="mt-3 text-sm">
              <span className="font-bold">{t("tournament.entryFee")}:</span> {c.entryNote}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {organizer && (
              <Link href={`/t/${c.slug}/manage`} prefetch={false} className="btn-ghost btn-sm inline-block" data-testid="manage-link">
                {t("tournament.manage")}
              </Link>
            )}
            {play.length > 0 && (
              <Link href={`/t/${c.slug}/tv`} prefetch={false} className="btn-ghost btn-sm inline-block" data-testid="tv-link">
                📺 {t("tournament.tvOpen")}
              </Link>
            )}
          </div>
        </section>

        {claimed && (
          <section className="card" data-testid="claim-card">
            <p className="font-bold text-ok">{t("tournament.claimed", { category: claimed.categoryName, p1: claimed.p1Name })}</p>
          </section>
        )}
        {sp.claim &&
          (claim ? (
            <ClaimCard slug={c.slug} token={sp.claim} p1Name={claim.p1Name} categoryName={claim.categoryName} hasIdentity={Boolean(me)} own={me?.id === claim.p1PlayerId} />
          ) : (
            <section className="card" data-testid="claim-card">
              <p className="font-bold">{t("tournament.claimGone")}</p>
            </section>
          ))}

        {play.length > 0 && <OrderOfPlay rows={play} tz={c.tz} />}
        {mine.length > 0 && (
          <section className="card" data-testid="my-entries">
            <h2 className="text-lg font-extrabold">{t("tournament.yourEntries")}</h2>
            <ul className="mt-2 flex flex-col divide-y divide-line">
              {mine.map((e) => {
                const v = byId.get(e.id);
                if (!v) return null;
                const partner = v.pair.p1.id === me?.id ? v.pair.p2 : v.pair.p1;
                return (
                  <li key={e.id} className="flex flex-col gap-2 py-3">
                    <div className="flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-semibold">
                          {v.category.name} · {partner.name}
                        </div>
                        <div className="text-sm text-muted">{e.status === "waiting" ? `${t("tournament.waiting")} · #${e.position}` : t("tournament.entered", { category: v.category.name })}</div>
                      </div>
                      <WithdrawButton slug={c.slug} pairId={e.id} />
                    </div>
                    {e.claimToken && e.p1PlayerId === me?.id && (
                      <div className="text-xs">
                        <span className="font-bold">{t("tournament.claimLink")}:</span> <span className="break-all text-muted">{`${baseUrl()}/t/${c.slug}?claim=${e.claimToken}`}</span>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {page.categories.length === 0 ? (
          <section className="card">
            <h2 className="text-lg font-extrabold">{t("tournament.categories")}</h2>
            <p className="mt-2 text-sm text-muted">{t("tournament.categoriesNone")}</p>
          </section>
        ) : (
          page.categories.map(({ category, entered, waiting }) => {
            const band = bandLabel(category.levelMin, category.levelMax);
            const full = entered.length >= category.maxPairs;
            return (
              <section key={category.id} className="card" data-testid={`category-${category.id}`}>
                <h2 className="text-lg font-extrabold">{category.name}</h2>
                <div className="mt-1 flex flex-wrap gap-2 text-sm">
                  {band && <span className="chip-muted">{band}</span>}
                  <span className="chip-muted">{t("tournament.pairsOf", { count: entered.length, max: category.maxPairs })}</span>
                </div>
                {entered.length === 0 ? (
                  <p className="mt-3 text-sm text-muted">{t("tournament.noPairs")}</p>
                ) : (
                  <ol className="mt-3 flex flex-col gap-1 text-sm">
                    {entered.map((p, i) => (
                      <li key={p.id} className="flex gap-2">
                        <span className="w-6 shrink-0 text-right text-faint">{i + 1}.</span>
                        <span className="min-w-0 truncate font-semibold">
                          {p.p1.name} & {p.p2.name}
                          {!p.claimed && <span className="ml-1 font-normal text-faint">({t("tournament.unclaimed")})</span>}
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
                {waiting.length > 0 && (
                  <div className="mt-3">
                    <div className="text-sm font-bold">{t("tournament.waiting")}</div>
                    <ol className="mt-1 flex flex-col gap-1 text-sm text-muted">
                      {waiting.map((p, i) => (
                        <li key={p.id} className="flex gap-2">
                          <span className="w-6 shrink-0 text-right">{i + 1}.</span>
                          <span className="min-w-0 truncate">
                            {p.p1.name} & {p.p2.name}
                          </span>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
                {c.status === "open" && category.drawStatus === "none" && <EnterForm slug={c.slug} categoryId={category.id} categoryName={category.name} hasIdentity={Boolean(me)} full={full} />}
                {draws.get(category.id) && (
                  <DrawView
                    view={draws.get(category.id)!}
                    slug={c.slug}
                    tz={c.tz}
                    myMatchIds={[...draws.get(category.id)!.groups.flatMap((g) => g.matches), ...draws.get(category.id)!.qualifying.flat(), ...draws.get(category.id)!.main.flat(), ...draws.get(category.id)!.consolation.flat()].filter((m) => (m.pairAId && myPairIds.has(m.pairAId)) || (m.pairBId && myPairIds.has(m.pairBId))).map((m) => m.id)}
                  />
                )}
              </section>
            );
          })
        )}

        <section className="card">
          <h2 className="text-lg font-extrabold">{t("tournament.share")}</h2>
          <p className="mt-1 text-sm text-muted">{t("tournament.shareHelp")}</p>
          <div className="mt-2 mb-3 truncate text-sm font-semibold text-muted">
            {shortHost()}/t/{c.slug}
          </div>
          <ShareButtons url={url} text={`${c.name} · ${days}${c.venueName ? ` · ${c.venueName}` : ""}`} />
        </section>
      </main>
      <Footer />
    </>
  );
}
