import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { Footer, Header } from "@/components/Header";
import { SeriesPauseButton } from "@/components/SeriesBits";
import { ShareButtons } from "@/components/ShareSheet";
import { getDb } from "@/db";
import { baseUrl, shortHost } from "@/lib/config";
import { formatEventDayLong, formatEventTime } from "@/lib/dates";
import { getSeries, seriesPage } from "@/lib/domain/series";
import { rangeChip } from "@/lib/levelText";
import { localeAlternates } from "@/lib/seo";
import { rhythmLabel } from "@/lib/seriesText";
import { getSessionPlayer } from "@/lib/session";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ slug: string }> };

const SLUG = /^[a-z0-9][a-z0-9-]{0,59}$/;
const MEDALS = ["🥇", "🥈", "🥉"];

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  if (!SLUG.test(slug)) return {};
  const db = await getDb();
  const s = await getSeries(db, slug);
  if (!s) return {};
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  const title = t("series.metaTitle", { name: s.name });
  const description = t("series.metaDescription", { rhythm: rhythmLabel(t, locale, s), venue: s.venueName ? ` ${t("series.at", { venue: s.venueName })}` : "" });
  return { title, description, alternates: localeAlternates(`/s/${slug}`, locale), openGraph: { title, description, type: "website", url: `${baseUrl()}/s/${slug}` } };
}

/** An Open that repeats: the next edition to sign up for, the past ones with their podiums, one link for all of them. */
export default async function SeriesPage({ params }: Props) {
  const { slug } = await params;
  if (!SLUG.test(slug)) notFound();
  const db = await getDb();
  const s = await getSeries(db, slug);
  if (!s) notFound();
  const now = new Date();
  const [t, locale, me, page] = await Promise.all([getTranslations(), getLocale(), getSessionPlayer(db), seriesPage(db, s, now)]);
  const mine = me?.id === s.organizerPlayerId;
  const url = `${baseUrl()}/s/${s.slug}`;
  const rhythm = rhythmLabel(t, locale, s);
  const level = rangeChip(t, { min: s.levelMin, max: s.levelMax });
  const next = page.next;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "EventSeries",
    name: s.name,
    url,
    description: t("series.metaDescription", { rhythm, venue: s.venueName ? ` ${t("series.at", { venue: s.venueName })}` : "" }),
    organizer: { "@type": "Person", name: page.organizerName },
    ...(s.venueName ? { location: { "@type": "Place", name: s.venueName, ...(s.venueMapUrl ? { hasMap: s.venueMapUrl } : {}) } } : {}),
    ...(next
      ? {
          subEvent: {
            "@type": "SportsEvent",
            name: s.name,
            sport: "Padel",
            startDate: next.event.startsAt.toISOString(),
            url: `${baseUrl()}/${next.event.code}`,
            eventStatus: "https://schema.org/EventScheduled",
            eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
            ...(s.venueName ? { location: { "@type": "Place", name: s.venueName } } : {}),
            ...(s.cost ? { offers: { "@type": "Offer", description: s.cost, url: `${baseUrl()}/${next.event.code}` } } : { isAccessibleForFree: true }),
          },
        }
      : {}),
  };
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
        <section className="card">
          <span className="chip-muted">🏆 {t("series.eyebrow")}</span>
          <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight">{s.name}</h1>
          <p className="mt-1 font-semibold">
            {rhythm}
            {s.venueName ? ` · ${t("series.at", { venue: s.venueName })}` : ""}
          </p>
          <p className="mt-1 text-sm text-muted">{t("series.by", { name: page.organizerName })}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <span className="chip-muted">{t(`club.week.kind.${s.format}`)}</span>
            {level && <span className="chip-muted">{level}</span>}
            {s.cost && <span className="chip-muted">{t("series.perPlayer", { cost: s.cost })}</span>}
            <span className="chip-muted">{t("series.editions", { count: page.editions })}</span>
          </div>
          {s.venueMapUrl && (
            <a href={s.venueMapUrl} target="_blank" rel="noopener noreferrer" className="btn-ghost btn-sm mt-3">
              📍 {t("event.openMap")}
            </a>
          )}
          {mine && <SeriesPauseButton slug={s.slug} active={s.active} />}
        </section>

        <section className="card" data-testid="series-next">
          <h2 className="text-lg font-extrabold">{t("series.next")}</h2>
          {next ? (
            <div className="mt-3 flex items-center gap-4">
              <div className="min-w-0 flex-1">
                <div className="font-bold">{formatEventDayLong(next.event.startsAt, next.event.tz, locale)}</div>
                <div className="text-sm text-muted">
                  {formatEventTime(next.event.startsAt, next.event.tz, locale)}
                  {next.event.venueName ? ` · ${next.event.venueName}` : ""}
                </div>
                <div className={`mt-1 text-sm font-bold ${next.spotsLeft > 0 ? "text-ok" : "text-warn"}`}>{next.spotsLeft > 0 ? t("event.spotsLeft", { count: next.spotsLeft }) : t("venue.full")}</div>
              </div>
              {next.spotsLeft > 0 || next.event.whenFull !== "closed" ? (
                <Link href={`/${next.event.code}?s=series`} prefetch={false} className="btn-primary shrink-0">
                  {next.spotsLeft > 0 ? t("series.join") : t("event.joinWaitlist")}
                </Link>
              ) : (
                <Link href={`/${next.event.code}?s=series`} prefetch={false} className="btn-ghost shrink-0">
                  {t("venue.full")}
                </Link>
              )}
            </div>
          ) : (
            <p className="mt-2 text-sm text-muted">{s.active ? t("series.nextNone") : t("series.paused")}</p>
          )}
          {next && !s.active && <p className="mt-3 text-sm text-muted">{t("series.paused")}</p>}
        </section>

        <section className="card">
          <h2 className="text-lg font-extrabold">{t("series.past")}</h2>
          {page.past.length === 0 ? (
            <p className="mt-2 text-sm text-muted">{t("series.pastNone")}</p>
          ) : (
            <ul className="mt-3 flex flex-col divide-y divide-line">
              {page.past.map(({ event: ev, podium }) => (
                <li key={ev.id} className="py-3">
                  <Link href={`/${ev.code}`} prefetch={false} className="font-bold hover:underline">
                    {formatEventDayLong(ev.startsAt, ev.tz, locale)}
                  </Link>
                  {podium.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm">
                      {podium.map((p) => (
                        <span key={p.playerId}>
                          {MEDALS[p.rank - 1]} {p.name}
                        </span>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <h2 className="text-lg font-extrabold">{t("series.share")}</h2>
          <p className="mt-1 text-sm text-muted">{t("series.shareHelp")}</p>
          <div className="mt-2 mb-3 truncate text-sm font-semibold text-muted">
            {shortHost()}/s/{s.slug}
          </div>
          <ShareButtons url={url} text={`${s.name} · ${rhythm}${s.venueName ? ` · ${s.venueName}` : ""}`} />
        </section>
      </main>
      <Footer />
    </>
  );
}
