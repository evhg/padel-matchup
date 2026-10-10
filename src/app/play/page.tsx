import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { EventRow } from "@/components/EventRow";
import { Footer, Header } from "@/components/Header";
import { getDb } from "@/db";
import { baseUrl } from "@/lib/config";
import { CITIES, cityBySlug } from "@/lib/domain/cities";
import { visitorCity } from "@/lib/domain/countries";
import { clubsOf, filterGames, findGames, homeCity, parsePlayFilters, playCities, playHref, playWindow, type PlayDay, type PlayFilters } from "@/lib/domain/findGame";
import { courtOfferLink } from "@/lib/domain/courtOffers";
import { courtsFreeInCity, PLAY_FEW_GAMES } from "@/lib/domain/freeCourts";
import { formatEventDay, formatEventTime } from "@/lib/dates";
import { localeAlternates } from "@/lib/seo";
import { getSessionPlayer } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  const title = t("city.playTitle");
  const description = t("city.playMetaDescription", { cities: playCities(locale) });
  return { title, description, alternates: localeAlternates("/play", locale), openGraph: { title, description, type: "website", url: `${baseUrl()}/play` } };
}

const DAY_KEY: Record<PlayDay, "city.playToday" | "city.playTomorrow" | "city.playWeek"> = { today: "city.playToday", tomorrow: "city.playTomorrow", week: "city.playWeek" };

/** One filter chip: a link to the list with that filter changed, dark when it is the one in force. */
function Chip({ href, on, children, testId }: { href: string; on: boolean; children: React.ReactNode; testId?: string }) {
  return (
    <Link href={href} prefetch={false} aria-current={on ? "true" : undefined} data-testid={testId} className={`inline-flex min-h-9 items-center rounded-full px-3.5 text-sm font-bold ring-1 transition ${on ? "bg-ink text-on-ink ring-ink" : "bg-card text-ink ring-line-strong hover:bg-bg"}`}>
      {children}
    </Link>
  );
}

/**
 * /play: the open games a visitor can join, filtered by chips kept in the URL. The landing page's
 * "Find a game" chip and the More menu lead here (the owner's decision C, 9 October 2026). The rules
 * and the one read are `src/lib/domain/findGame.ts`.
 */
export default async function PlayPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [t, locale, sp, hdrs] = await Promise.all([getTranslations(), getLocale(), searchParams, headers()]);
  const home = homeCity({ city: visitorCity(hdrs.get("x-vercel-ip-city")), tz: hdrs.get("x-vercel-ip-timezone") });
  const f: PlayFilters = parsePlayFilters(sp, home.slug);
  const city = cityBySlug(f.city)!;
  const db = await getDb();
  // Sequential, not parallel: the pooler stalls on pipelined bursts (rule 8).
  const me = await getSessionPlayer(db);
  const now = new Date();
  const window = playWindow(f.day, now, city.tz);
  const rows = await findGames(db, city, window, now);
  const level = me?.level ?? null;
  const shown = filterGames(rows, f, window, level);
  const clubs = clubsOf(rows);
  // Few games to join: the courts the city's clubs show free, each row one link to the form at that
  // club and hour (the owner's choice of 10 October 2026), below the games and their own primary
  // action, never a button beside it (rule 1). One bounded read of the clubs' cache, and nothing at
  // all when no court is free.
  const free = rows.length < PLAY_FEW_GAMES ? await courtsFreeInCity(db, city, me?.id ?? null, now) : [];

  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12">
        <section className="card">
          <h1 className="text-3xl font-extrabold leading-tight tracking-tight">{t("city.playTitle")}</h1>
          <p className="mt-2 text-sm text-muted">{t("city.playSub")}</p>
          <nav aria-label={t("city.playFilters")} className="mt-4 flex flex-col gap-2" data-testid="play-filters">
            <div className="flex flex-wrap gap-2">
              {CITIES.map((c) => (
                <Chip key={c.slug} href={playHref(f, { city: c.slug })} on={c.slug === f.city}>
                  📍 {c.name}
                </Chip>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              {(Object.keys(DAY_KEY) as PlayDay[]).map((d) => (
                <Chip key={d} href={playHref(f, { day: d })} on={d === f.day} testId={`play-day-${d}`}>
                  {t(DAY_KEY[d])}
                </Chip>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              {/* Only somebody with a level can be matched to one; the chip is not offered before it can be useful (rule 3). */}
              {level != null && (
                <Chip href={playHref(f, { fits: !f.fits })} on={f.fits} testId="play-fits">
                  {t("city.playFits")}
                </Chip>
              )}
              <Chip href={playHref(f, { spots: !f.spots })} on={f.spots} testId="play-spots">
                {t("city.playSpots")}
              </Chip>
            </div>
            {(clubs.length > 1 || f.club) && (
              <div className="flex flex-wrap gap-2" data-testid="play-clubs">
                <Chip href={playHref(f, { club: null })} on={!f.club}>
                  {t("city.playAllClubs")}
                </Chip>
                {clubs.map((c) => (
                  <Chip key={c.slug} href={playHref(f, { club: c.slug })} on={c.slug === f.club}>
                    {c.name}
                  </Chip>
                ))}
              </div>
            )}
          </nav>
        </section>

        {rows.length === 0 ? (
          // Honest and useful: nothing is open, so the next step is making the first one.
          <section className="card" data-testid="play-empty">
            <p className="font-bold">{t("city.playEmpty", { city: city.name, day: f.day })}</p>
            <Link href="/" prefetch={false} className="btn-primary mt-4 w-full">
              {t("city.playEmptyCta")}
            </Link>
          </section>
        ) : shown.length === 0 ? (
          // Games exist, the chips hid them: say so, and give the way back in one tap.
          <section className="card" data-testid="play-none-fit">
            <p className="text-sm text-muted">{t("city.playNoneFit", { count: rows.length })}</p>
            <Link href={playHref(f, { club: null, fits: false, spots: false })} prefetch={false} className="btn-ghost btn-sm mt-3">
              {t("city.playClear")}
            </Link>
          </section>
        ) : (
          <section className="flex flex-col gap-2" data-testid="play-list">
            <h2 className="px-1 text-xs font-bold uppercase tracking-wider text-faint">{t("city.playCount", { count: shown.length })}</h2>
            <ul className="flex flex-col gap-2">
              {shown.map((g) => (
                <li key={g.id}>
                  <EventRow ev={g} t={t} locale={locale} />
                </li>
              ))}
            </ul>
          </section>
        )}

        {free.length > 0 && (
          <section className="card" data-testid="play-free">
            <h2 className="text-lg font-extrabold">{t("city.playFreeTitle")}</h2>
            <p className="mt-0.5 text-xs text-muted">{t("city.playFreeHelp")}</p>
            <ul className="mt-2 flex flex-col divide-y divide-line">
              {free.map((b) => (
                <li key={`${b.slug}-${b.start.toISOString()}`}>
                  {/* The whole row is the link: the club on its own line, never cut, and whose times these are. */}
                  <Link href={courtOfferLink("", { club: { name: b.name, tz: b.tz }, hour: { date: b.date, time: b.time } })} prefetch={false} className="-mx-2 flex min-h-11 items-center gap-3 rounded-lg px-2 py-2 hover:bg-bg" data-testid="play-free-row">
                    <span className="min-w-0 flex-1">
                      <span className="block font-bold tabular-nums">
                        {formatEventDay(b.start, b.tz, locale)} · {formatEventTime(b.start, b.tz, locale)}
                      </span>
                      <span className="block text-sm">{b.name}</span>
                      <span className="block text-xs text-muted">
                        {t("club.freeSlot", { count: b.free })}
                        {b.platform ? ` · ${t("city.playFreeOn", { platform: b.platform })}` : ""}
                      </span>
                    </span>
                    <span aria-hidden className="text-faint">
                      ›
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
      <Footer />
    </>
  );
}
