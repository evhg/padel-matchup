import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { AutoRefresh } from "@/components/tournament/AutoRefresh";
import { sourceName } from "@/components/tournament/sourceName";
import { getDb } from "@/db";
import { utcToZonedParts } from "@/lib/dates";
import { liveBoard } from "@/lib/domain/competitionLive";
import type { PlayRow } from "@/lib/domain/competitionSchedule";
import { categoriesOf, getCompetition } from "@/lib/domain/competitions";
import { scoreText } from "@/lib/domain/draw";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ slug: string }> };
const SLUG = /^[a-z0-9][a-z0-9-]{0,59}$/;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const t = await getTranslations();
  return { title: `${t("tournament.tv")} · ${slug}`, robots: { index: false, follow: false } };
}

/**
 * The club's screen: big type, no header, what is on each court now and next, the latest results,
 * the champions. It asks the server again every thirty seconds.
 */
export default async function TvPage({ params }: Props) {
  const { slug } = await params;
  if (!SLUG.test(slug)) notFound();
  const db = await getDb();
  const c = await getCompetition(db, slug);
  if (!c) notFound();
  const [t, locale, categories] = await Promise.all([getTranslations(), getLocale(), categoriesOf(db, c.id)]);
  const board = await liveBoard(db, c.id, c.courtNames ?? [], categories);
  const time = (d: Date | null) => (d ? utcToZonedParts(d, c.tz).time : "");
  const loose = t as unknown as (key: string, values?: Record<string, string | number>) => string;
  // A side not known yet says where it comes from ("Winner of group A"), as on the page.
  const side = (m: PlayRow, s: "A" | "B") => (s === "A" ? m.aName : m.bName) ?? sourceName(loose, s === "A" ? m.sourceA : m.sourceB, (phase) => board.rounds[`${m.categoryId}:${phase}`] ?? 0) ?? t("tournament.tbd");
  const pair = (name: string | null) => name ?? t("tournament.tbd");
  void locale;
  return (
    <main className="min-h-screen bg-bg px-6 py-6 text-fg" data-testid="tv">
      <AutoRefresh seconds={30} />
      <header className="flex items-baseline justify-between gap-4">
        <h1 className="text-4xl font-extrabold tracking-tight">{c.name}</h1>
        <span className="text-xl font-semibold text-muted">{c.venueName ?? ""}</span>
      </header>
      {board.finished ? (
        // The weekend is over: the champions in the biggest type on the screen, not four free courts.
        <section className="card mt-8" data-testid="tv-over">
          <h2 className="text-3xl font-extrabold">🏆 {t("tournament.champion")}</h2>
          <ul className="mt-3 flex flex-col gap-2 text-3xl" data-testid="tv-champions">
            {board.champions.map((ch) => (
              <li key={ch.categoryName}>
                <span className="text-muted">{ch.categoryName}:</span> <span className="font-extrabold">{ch.name}</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xl text-muted">{t("tournament.tvOver")}</p>
        </section>
      ) : board.courts.length === 0 ? (
        <p className="mt-8 text-2xl text-muted">{t("tournament.tvNothing")}</p>
      ) : (
        <section className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3" data-testid="tv-courts">
          {board.courts.map((court) => (
            <div key={court.courtName} className="card">
              <div className="text-sm font-bold uppercase tracking-wide text-muted">{court.courtName}</div>
              <div className="mt-2 text-xs font-bold uppercase tracking-wide text-ok">{t("tournament.tvNow")}</div>
              {court.now ? (
                <div className="mt-1">
                  <div className="text-2xl font-extrabold leading-tight">{side(court.now, "A")}</div>
                  <div className="text-2xl font-extrabold leading-tight">{side(court.now, "B")}</div>
                  <div className="mt-1 text-sm text-muted">
                    {court.now.categoryName} · {time(court.now.scheduledAt)}
                  </div>
                  {court.now.streamUrl && (
                    <a href={court.now.streamUrl} target="_blank" rel="noopener noreferrer" className="btn-primary mt-2">
                      ▶ {t("tournament.watchLive")}
                    </a>
                  )}
                </div>
              ) : (
                <div className="mt-1 text-2xl font-bold text-faint">{t("tournament.tvFree")}</div>
              )}
              <div className="mt-3 text-xs font-bold uppercase tracking-wide text-muted">{t("tournament.tvNext")}</div>
              {court.next ? (
                <div className="mt-1 text-lg font-semibold">
                  {time(court.next.scheduledAt)} · {side(court.next, "A")} {t("tournament.vs")} {side(court.next, "B")}
                  <span className="text-muted"> · {court.next.categoryName}</span>
                </div>
              ) : (
                <div className="mt-1 text-lg text-faint">—</div>
              )}
            </div>
          ))}
        </section>
      )}
      <section className="mt-6 grid gap-4 md:grid-cols-2">
        <div className="card" data-testid="tv-latest">
          <h2 className="text-lg font-extrabold">{t("tournament.tvLatest")}</h2>
          {board.latest.length === 0 ? (
            <p className="mt-2 text-muted">—</p>
          ) : (
            <ul className="mt-2 divide-y divide-line text-lg">
              {board.latest.map((m) => (
                <li key={m.id} className="flex items-baseline gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className={`truncate ${m.winner === "A" ? "font-extrabold" : ""}`}>{pair(m.aName)}</div>
                    <div className={`truncate ${m.winner === "B" ? "font-extrabold" : ""}`}>{pair(m.bName)}</div>
                    <div className="text-xs text-muted">{m.categoryName}</div>
                  </div>
                  <div className="shrink-0 font-extrabold tabular-nums">{m.status === "walkover" ? t("tournament.walkover") : scoreText(m.scoreA, m.scoreB)}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
        {!board.finished && (
        <div className="card">
          <h2 className="text-lg font-extrabold">{t("tournament.tvUpcoming")}</h2>
          {board.upcoming.length === 0 ? (
            <p className="mt-2 text-muted">—</p>
          ) : (
            <ul className="mt-2 divide-y divide-line text-lg">
              {board.upcoming.map((m) => (
                <li key={m.id} className="flex items-baseline gap-3 py-2">
                  <div className="w-14 shrink-0 font-extrabold tabular-nums">{time(m.scheduledAt)}</div>
                  <div className="min-w-0 flex-1 truncate">
                    <span className="font-semibold">{m.courtName}</span> · {side(m, "A")} {t("tournament.vs")} {side(m, "B")}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {!board.finished && board.champions.length > 0 && (
            <div className="mt-4" data-testid="tv-champions">
              <h2 className="text-lg font-extrabold">🏆 {t("tournament.champion")}</h2>
              <ul className="mt-1 text-lg">
                {board.champions.map((ch) => (
                  <li key={ch.categoryName}>
                    <span className="text-muted">{ch.categoryName}:</span> <span className="font-extrabold">{ch.name}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        )}
      </section>
    </main>
  );
}
