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
import { BookingButton, ClubBadges, FreeCourts } from "@/components/ClubBits";
import { getClub, isClubLive } from "@/lib/domain/clubs";
import { EmbedSnippet } from "@/components/EmbedSnippet";
import { embedHtml } from "@/lib/embed";
import { rangeChip } from "@/lib/levelText";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const t = await getTranslations();
  const db = await getDb();
  const [board, club] = isValidVenueSlug(slug) ? await Promise.all([getVenueBoard(db, slug), getClub(db, slug)]) : [null, null];
  const live = isClubLive(club) ? club : null;
  const name = live?.name ?? board?.name;
  if (!name) return { title: t("venue.board") };
  const title = t("venue.boardTitle", { venue: name });
  const description = live?.about ?? t("venue.boardSub");
  return { title, description, alternates: { canonical: `/v/${slug}`, types: { "application/json+oembed": `${baseUrl()}/api/oembed?url=${encodeURIComponent(`${baseUrl()}/v/${slug}`)}&format=json` } }, openGraph: { title, description, type: "website", url: `${baseUrl()}/v/${slug}` } };
}

/** Public board of organizer-listed open matches at one venue: what the poster's QR code points to. */
export default async function VenueBoardPage({ params }: Props) {
  const { slug } = await params;
  if (!isValidVenueSlug(slug)) notFound();
  const db = await getDb();
  const [boardRow, clubRow] = await Promise.all([getVenueBoard(db, slug), getClub(db, slug)]);
  // A live club page stands even before its first match; an unclaimed venue needs one.
  const club = isClubLive(clubRow) ? clubRow : null;
  if (!boardRow && !club) notFound();
  const board = boardRow ?? { slug, name: club!.name, mapUrl: club!.mapUrl, events: [] };
  const mapUrl = club?.mapUrl ?? board.mapUrl;
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12">
        <section className="card">
          <span className="chip-muted">📍 {t("venue.board")}</span>
          <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight">{t("venue.boardTitle", { venue: club?.name ?? board.name })}</h1>
          <p className="mt-1 text-muted">{club?.about ?? t("venue.boardSub")}</p>
          {club && (
            <div className="mt-3">
              <ClubBadges club={club} />
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {club && <BookingButton club={club} />}
            {club?.website && (
              <a href={club.website} target="_blank" rel="noopener noreferrer" className="btn-ghost btn-sm">
                🌐 {t("club.website")}
              </a>
            )}
            {mapUrl && (
              <a href={mapUrl} target="_blank" rel="noopener noreferrer" className="btn-ghost btn-sm">
                📍 {t("event.openMap")}
              </a>
            )}
          </div>
        </section>
        {club && (club.availabilityUrl || club.availability) && (
          <section className="card">
            <h2 className="text-lg font-extrabold">{t("club.freeToday")}</h2>
            <div className="mt-2">
              <FreeCourts club={club} />
            </div>
          </section>
        )}
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
          <Link href={`/v/${slug}/ranking`} prefetch={false} className="link">
            🏆 {t("ranking.title")}
          </Link>
          <Link href={`/v/${slug}/poster`} prefetch={false} className="link">
            🖨 {t("venue.poster")}
          </Link>
          <Link href={`/?venue=${encodeURIComponent(board.name)}`} prefetch={false} className="link">
            + {t("common.newMatch")}
          </Link>
        </div>
        {!club && (!clubRow || clubRow.rejectedAt) && (
          <Link href={`/clubs/claim?name=${encodeURIComponent(board.name)}`} prefetch={false} className="card flex items-center justify-between gap-3 py-3 hover:border-ink/30">
            <span>
              <span className="block text-sm font-bold">{t("club.isYours")}</span>
              <span className="block text-xs text-muted">{t("club.isYoursHelp")}</span>
            </span>
            <span className="text-faint">›</span>
          </Link>
        )}
        <EmbedSnippet html={embedHtml(baseUrl(), { kind: "board", slug }, t("venue.boardTitle", { venue: board.name }))} />
      </main>
      <Footer />
    </>
  );
}
