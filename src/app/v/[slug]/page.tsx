import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { Footer, Header } from "@/components/Header";
import { getDb } from "@/db";
import { calendarTitle } from "@/lib/calendar";
import { baseUrl } from "@/lib/config";
import { formatEventDay, formatEventTime } from "@/lib/dates";
import { getVenueBoard, isValidVenueSlug } from "@/lib/domain/venueBoard";
import { rangeChip } from "@/lib/levelText";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const t = await getTranslations();
  const db = await getDb();
  const board = isValidVenueSlug(slug) ? await getVenueBoard(db, slug) : null;
  if (!board) return { title: t("venue.board") };
  const title = t("venue.boardTitle", { venue: board.name });
  return { title, description: t("venue.boardSub"), alternates: { canonical: `/v/${slug}` }, openGraph: { title, description: t("venue.boardSub"), type: "website", url: `${baseUrl()}/v/${slug}` } };
}

/** Public board of organizer-listed open matches at one venue: what the poster's QR code points to. */
export default async function VenueBoardPage({ params }: Props) {
  const { slug } = await params;
  if (!isValidVenueSlug(slug)) notFound();
  const db = await getDb();
  const board = await getVenueBoard(db, slug);
  if (!board) notFound();
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12">
        <section className="card">
          <span className="chip-muted">📍 {t("venue.board")}</span>
          <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight">{t("venue.boardTitle", { venue: board.name })}</h1>
          <p className="mt-1 text-muted">{t("venue.boardSub")}</p>
          {board.mapUrl && (
            <a href={board.mapUrl} target="_blank" rel="noopener noreferrer" className="btn-ghost btn-sm mt-3">
              📍 {t("event.openMap")}
            </a>
          )}
        </section>
        {board.events.length === 0 ? (
          <section className="card text-center">
            <p className="text-muted">{t("venue.empty", { venue: board.name })}</p>
            <Link href={`/?venue=${encodeURIComponent(board.name)}`} prefetch={false} className="btn-primary mt-4 w-full">
              {t("venue.emptyCta")}
            </Link>
          </section>
        ) : (
          <ul className="flex flex-col gap-2">
            {board.events.map(({ event: ev, occupied, spotsLeft }) => {
              const level = rangeChip(t, { min: ev.levelMin, max: ev.levelMax });
              return (
                <li key={ev.id}>
                  <Link href={`/${ev.code}`} prefetch={false} className="card flex items-center gap-4 py-4 hover:border-ink/30">
                    <div className="w-14 shrink-0 text-center">
                      <div className="text-xs font-bold uppercase text-faint">{formatEventDay(ev.startsAt, ev.tz, locale).split(" ")[0]}</div>
                      <div className="text-2xl font-extrabold leading-none tabular-nums">{formatEventTime(ev.startsAt, ev.tz, locale)}</div>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="truncate font-bold">{calendarTitle(ev, t(ev.type === "match" ? "event.match" : "event.tournament"))}</span>
                        {level && <span className="chip-muted">{level}</span>}
                      </div>
                      <div className="truncate text-sm text-muted">
                        {formatEventDay(ev.startsAt, ev.tz, locale)} · {t("event.players", { count: occupied, capacity: ev.capacity })}
                      </div>
                      <div className={`mt-1 text-sm font-bold ${spotsLeft > 0 ? "text-ok" : "text-warn"}`}>{spotsLeft > 0 ? t("event.spotsLeft", { count: spotsLeft }) : t("venue.full")}</div>
                    </div>
                    <span className="text-faint">›</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <Link href={`/v/${slug}/poster`} prefetch={false} className="link">
            🖨 {t("venue.poster")}
          </Link>
          <Link href={`/?venue=${encodeURIComponent(board.name)}`} prefetch={false} className="link">
            + {t("common.newMatch")}
          </Link>
        </div>
      </main>
      <Footer />
    </>
  );
}
