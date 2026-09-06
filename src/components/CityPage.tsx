import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { Footer, Header } from "@/components/Header";
import { RankingOptIn } from "@/components/RankingOptIn";
import { RankingTable } from "@/components/RankingTable";
import { getDb } from "@/db";
import { calendarTitle } from "@/lib/calendar";
import { formatEventDay, formatEventTime } from "@/lib/dates";
import type { City } from "@/lib/domain/cities";
import { getRanking } from "@/lib/domain/ranking";
import { getCityBoard } from "@/lib/domain/venueBoard";
import { ClubRow } from "@/components/ClubBits";
import { CLUB_LIMITS, listLiveClubs } from "@/lib/domain/clubs";
import { rangeChip } from "@/lib/levelText";
import { getSessionPlayer } from "@/lib/session";

/** /phuket, /singapore: open matches across the city's clubs, the city ranking, and the pitch in four lines. */
export async function CityPage({ city }: { city: City }) {
  const db = await getDb();
  const [t, locale, me, board, ranking, clubs] = await Promise.all([getTranslations(), getLocale(), getSessionPlayer(db), getCityBoard(db, city), getRanking(db, { city }), listLiveClubs(db, city.slug)]);
  const liveSlugs = new Set(clubs.map((c) => c.slug));
  const otherClubs = board.clubs.filter((c) => !liveSlugs.has(c.slug));
  const foundingLeft = Math.max(0, CLUB_LIMITS.foundingPerCity - clubs.filter((c) => c.founding).length);
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12">
        <section className="card">
          <span className="chip-muted">📍 {city.name}</span>
          <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight">{t("city.title", { city: city.name })}</h1>
          <p className="mt-2 text-sm text-muted">{t("city.sub", { city: city.name })}</p>
          <Link href="/" prefetch={false} className="btn-primary mt-4 w-full">
            {t("city.create", { city: city.name })}
          </Link>
        </section>

        <section className="card">
          <h2 className="text-lg font-extrabold">{t("city.openMatches")}</h2>
          {board.events.length === 0 ? (
            <p className="mt-2 text-sm text-muted">{t("city.noMatches")}</p>
          ) : (
            <ul className="mt-3 flex flex-col gap-2">
              {board.events.map(({ event: ev, spotsLeft }) => {
                const chip = rangeChip(t, { min: ev.levelMin, max: ev.levelMax });
                return (
                  <li key={ev.id}>
                    <Link href={`/${ev.code}`} prefetch={false} className="flex items-center gap-4 rounded-2xl border border-line px-4 py-3 hover:border-ink/30">
                      <div className="w-16 shrink-0 text-center">
                        <div className="text-xs font-bold uppercase text-muted">{formatEventDay(ev.startsAt, ev.tz, locale)}</div>
                        <div className="text-lg font-extrabold tabular-nums">{formatEventTime(ev.startsAt, ev.tz, locale)}</div>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-bold">{calendarTitle(ev, t(ev.type === "match" ? "event.match" : "event.tournament"))}</div>
                        <div className="truncate text-sm text-muted">
                          {ev.venueName}
                          {chip ? ` · ${chip}` : ""}
                        </div>
                        <div className={`mt-1 text-sm font-bold ${spotsLeft > 0 ? "text-ok" : "text-warn"}`}>{spotsLeft > 0 ? t("event.spotsLeft", { count: spotsLeft }) : t("venue.full")}</div>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="card">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-lg font-extrabold">{t("club.inCity", { city: city.name })}</h2>
            <Link href="/clubs" prefetch={false} className="link text-sm">
              {t("club.seeAll")} →
            </Link>
          </div>
          {clubs.length > 0 && (
            <ul className="mt-3 flex flex-col gap-2">
              {clubs.map((c) => (
                <ClubRow key={c.slug} club={c} />
              ))}
            </ul>
          )}
          {otherClubs.length > 0 && (
            <div className={clubs.length > 0 ? "mt-4 border-t border-line pt-3" : "mt-2"}>
              <div className="text-xs font-bold uppercase tracking-wider text-faint">{t("city.clubs")}</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {otherClubs.map((c) => (
                  <Link key={c.slug} href={`/v/${c.slug}`} prefetch={false} className="chip-muted hover:bg-line">
                    {c.name}
                  </Link>
                ))}
              </div>
            </div>
          )}
          {clubs.length === 0 && otherClubs.length === 0 && <p className="mt-2 text-sm text-muted">{t("club.noClubs")}</p>}
          <div className="mt-4 rounded-2xl bg-bg px-4 py-3">
            <div className="text-sm font-bold">🌱 {t("club.founding")}</div>
            <p className="mt-1 text-xs text-muted">{t("club.foundingBody")}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Link href="/clubs/claim" prefetch={false} className="btn-secondary btn-sm">
                {t("club.claimCta")}
              </Link>
              <span className="text-xs text-faint">{t("club.foundingLeft", { count: foundingLeft, city: city.name })}</span>
            </div>
          </div>
        </section>

        <section className="card">
          <h2 className="text-lg font-extrabold">🏆 {t("city.ranking", { city: city.name })}</h2>
          <p className="mt-1 text-sm text-muted">{t("ranking.sub")}</p>
          <RankingTable rows={ranking.rows.slice(0, 25)} events={ranking.events} highlightId={me?.id ?? null} />
          {me ? <RankingOptIn optedIn={me.rankingOptIn} /> : <p className="mt-3 text-xs text-faint">{t("ranking.optInOnly")}</p>}
        </section>

        <section className="card">
          <h2 className="text-lg font-extrabold">{t("city.how")}</h2>
          <ol className="mt-2 flex flex-col gap-2 text-sm text-muted">
            {(["city.how1", "city.how2", "city.how3", "city.how4"] as const).map((k, i) => (
              <li key={k} className="flex gap-3">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-ink text-xs font-extrabold text-accent">{i + 1}</span>
                <span>{t(k)}</span>
              </li>
            ))}
          </ol>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <Link href="/americano" prefetch={false} className="link">
              {t("americano.gen.title")} →
            </Link>
            <Link href="/developers" prefetch={false} className="link">
              API · MCP →
            </Link>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
