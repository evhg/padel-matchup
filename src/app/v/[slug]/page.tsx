import type { Metadata } from "next";
import { localeAlternates } from "@/lib/seo";
import Link from "next/link";
import { FeedbackInline } from "@/components/FeedbackInline";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { Footer, Header } from "@/components/Header";
import { getDb } from "@/db";
import { getPlayer } from "@/lib/domain/players";
import { calendarTitle } from "@/lib/calendar";
import { baseUrl } from "@/lib/config";
import { addMs, formatEventDay, formatEventTime, isValidTimeZone, utcToZonedParts, zonedTimeToUtc } from "@/lib/dates";
import { getVenueBoard, isValidVenueSlug } from "@/lib/domain/venueBoard";
import { BookingButton, ClubBadges, FreeCourts } from "@/components/ClubBits";
import { getClub, isClubListed, isClubLive } from "@/lib/domain/clubs";
import { getSessionPlayerId } from "@/lib/session";
import { clubBusy, courtDay, courtsInUse, listCourts } from "@/lib/domain/courts";
import { coachesAtClub } from "@/lib/domain/coaching";
import { clubWeek, listClubSlots } from "@/lib/domain/clubWeek";
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
  return { title, description, alternates: { ...localeAlternates(`/v/${slug}`, await getLocale()), types: { "application/json+oembed": `${baseUrl()}/api/oembed?url=${encodeURIComponent(`${baseUrl()}/v/${slug}`)}&format=json` } }, openGraph: { title, description, type: "website", url: `${baseUrl()}/v/${slug}` } };
}

/** Public board of organizer-listed open matches at one venue: what the poster's QR code points to. */
export default async function VenueBoardPage({ params }: Props) {
  const { slug } = await params;
  if (!isValidVenueSlug(slug)) notFound();
  const db = await getDb();
  const [boardRow, clubRow] = await Promise.all([getVenueBoard(db, slug), getClub(db, slug)]);
  // A live club page stands even before its first match; an unclaimed venue needs one.
  const club = isClubLive(clubRow) ? clubRow : null;
  // What we may show about this club, theirs or ours. A club Kicksmash listed from public sources
  // has a name, a place, a court count and a booking link, and hiding all of it behind a claim that
  // nobody had made left sixty-six clubs invisible to the very owners who might claim them.
  const shown = isClubListed(clubRow) ? clubRow! : null;
  const unclaimed = shown && !club ? shown : null;
  const courts = club ? await listCourts(db, club.slug) : [];
  // Roadmap item 4, the first half: the club has its courts as rows and could not see which of them
  // were busy. A match already names a court, so the day can be drawn today, from what is there.
  // Sequential after the courts, not beside them: the pooler stalls on pipelined bursts (rule 8).
  const clubTz = club?.tz && isValidTimeZone(club.tz) ? club.tz : "UTC";
  const dayFrom = club ? zonedTimeToUtc(utcToZonedParts(new Date(), clubTz).date, "00:00", clubTz) : null;
  const busy = club && courts.length > 0 && dayFrom ? await clubBusy(db, club.slug, dayFrom, addMs(dayFrom, 24 * 60 * 60 * 1000)) : [];
  const day = busy.length > 0 ? courtDay(courts.map((c) => c.name), busy) : [];
  // A claimed club whose check is still to come has a page too, for the person who claimed it: the
  // board, empty, under its name, opened from the done screen. To anybody else nothing of a pending
  // claim shows: a stranger's wrong map link must not stand on a club's page before the check.
  const pending = clubRow && !club && !clubRow.rejectedAt ? clubRow : null;
  const known = club ?? (pending?.claimedBy && pending.claimedBy === (await getSessionPlayerId()) ? pending : null);
  // A club we list is a page, with or without a match on it yet. Sixty-three of the sixty-six listed
  // clubs answered 404 here while /clubs linked to every one of them and the sitemap named them all:
  // the guard asked for a venue board, and a board exists only once somebody plays there.
  const page = known ?? shown;
  if (!boardRow && !page) notFound();
  const board = boardRow ?? { slug, name: page!.name, mapUrl: page!.mapUrl, events: [] };
  const mapUrl = shown?.mapUrl ?? board.mapUrl;
  // Eternal glory: the person who put this club on the map is named on it. One read, and only when
  // the page is an unclaimed listing somebody actually listed.
  const addedByName = unclaimed?.addedBy ? ((await getPlayer(db, unclaimed.addedBy))?.displayName ?? null) : null;
  const [t, locale, coachesHere] = await Promise.all([getTranslations(), getLocale(), coachesAtClub(db, slug).catch(() => [])]);
  // A live club with a programme shows its week, day by day; matches beyond the week stay in the list below.
  const programme = club ? await listClubSlots(db, club.slug) : [];
  const week = club && programme.length > 0 ? await clubWeek(db, club) : null;
  // The week card already shows these; the list below carries only what comes after it.
  const inWeek = new Set((week ?? []).flatMap((d) => d.events.map((b) => b.event.id)));
  const later = week ? board.events.filter((b) => !inWeek.has(b.event.id)) : board.events;
  const tz = club?.tz ?? "UTC";
  const dayLabel = (date: string) => new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone: tz }).format(zonedTimeToUtc(date, "12:00", tz));
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12">
        <section className="card">
          <span className="chip-muted">📍 {t("venue.board")}</span>
          <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight">{t("venue.boardTitle", { venue: shown?.name ?? board.name })}</h1>
          <p className="mt-1 text-muted">{shown?.about ?? t("venue.boardSub")}</p>
          {shown && (
            <div className="mt-3">
              <ClubBadges club={shown} />
              {courts.length > 0 && (
                <ul className="mt-2 flex flex-wrap gap-1.5" data-testid="club-courts" aria-label={t("club.courtsTitle")}>
                  {courts.map((c) => (
                    <li key={c.id} className="rounded-lg border border-line px-2 py-0.5 text-xs">
                      {c.name}
                      {c.kind && <span className="text-faint"> · {c.kind === "indoor" ? t("club.courtsIndoor") : t("club.courtsOutdoor")}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {shown && <BookingButton club={shown} />}
            {shown?.website && (
              <a href={shown.website} target="_blank" rel="noopener noreferrer" className="btn-ghost btn-sm">
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
        {/* A club listed from public sources says so, on its own page, with both doors: the one that
            makes it theirs and the one that fixes what is wrong. A directory that sends players
            without a cut is free marketing; one that is wrong and unanswerable is a nuisance. */}
        {unclaimed && (
          <section className="card" data-testid="club-unclaimed">
            <p className="text-sm text-muted">{t("club.unclaimed")}</p>
            {addedByName && <p className="mt-1 text-sm font-bold" data-testid="club-added-by">{t("club.addedBy", { name: addedByName })}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              <Link href={`/clubs/claim?name=${encodeURIComponent(unclaimed.name)}`} prefetch={false} className="btn-secondary btn-sm" data-testid="club-claim-door">
                {t("club.isThisYours")}
              </Link>
            </div>
            <div className="mt-3">
              <FeedbackInline variant="line" signedInVia="none" />
            </div>
          </section>
        )}
        {club && (club.availabilityUrl || club.availability) && (
          <section className="card">
            <h2 className="text-lg font-extrabold">{t("club.freeToday")}</h2>
            <div className="mt-2">
              <FreeCourts club={club} />
            </div>
          </section>
        )}
        {day.length > 0 && (
          <section className="card" data-testid="club-day">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-lg font-extrabold">{t("club.dayTitle")}</h2>
              <span className="text-sm font-semibold text-muted tabular-nums">{t("club.dayInUse", { used: courtsInUse(day), total: courts.length })}</span>
            </div>
            <ul className="mt-3 flex flex-col divide-y divide-line">
              {day.map((row) => (
                <li key={row.name ?? "-"} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                  <span className={`w-28 shrink-0 text-sm font-extrabold ${row.name ? "" : "text-faint"}`}>{row.name ?? t("club.dayNoCourt")}</span>
                  {row.blocks.length === 0 ? (
                    <span className="text-sm text-faint">·</span>
                  ) : (
                    row.blocks.map((b, i) => (
                      <span key={i} className="rounded-lg border border-line px-2 py-0.5 text-xs">
                        <span className="font-bold tabular-nums">{formatEventTime(b.startsAt, clubTz, locale)}</span>{" "}
                        <span className="text-muted">{b.title ?? t(b.kind === "lesson" ? "club.dayLesson" : "club.dayMatch")}</span>
                      </span>
                    ))
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
        {week && (
          <section className="card" data-testid="club-week">
            <h2 className="text-lg font-extrabold">{t("club.week.title")}</h2>
            <p className="text-xs text-muted">{t("club.week.help")}</p>
            <ul className="mt-3 flex flex-col divide-y divide-line">
              {week.map((d) => (
                <li key={d.date} className="flex gap-3 py-2">
                  <div className="w-20 shrink-0 pt-0.5 text-xs font-bold uppercase text-faint">{dayLabel(d.date)}</div>
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    {d.events.length === 0 ? (
                      <span className="text-sm text-faint">{t("club.week.none")}</span>
                    ) : (
                      d.events.map(({ event: ev, occupied, spotsLeft }) => {
                        const level = rangeChip(t, { min: ev.levelMin, max: ev.levelMax });
                        return (
                          <Link key={ev.id} href={`/${ev.code}`} prefetch={false} className="flex items-center gap-2 text-sm hover:underline">
                            <span className="font-extrabold tabular-nums">{formatEventTime(ev.startsAt, ev.tz, locale)}</span>
                            <span className="truncate font-bold">{calendarTitle(ev, t(ev.type === "match" ? "event.match" : "event.tournament"))}</span>
                            {level && <span className="chip-muted">{level}</span>}
                            <span className={`ml-auto shrink-0 tabular-nums ${spotsLeft > 0 ? "text-ok" : "text-warn"}`}>
                              {occupied}/{ev.capacity}
                            </span>
                          </Link>
                        );
                      })
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
        {later.length === 0 ? (
          !week && (
            <section className="card text-center">
              <p className="text-muted">{t("venue.empty", { venue: board.name })}</p>
              <Link href={`/?venue=${encodeURIComponent(board.name)}`} prefetch={false} className="btn-primary mt-4 w-full">
                {t("venue.emptyCta")}
              </Link>
            </section>
          )
        ) : (
          <ul className="flex flex-col gap-2">
            {later.map(({ event: ev, occupied, spotsLeft }) => {
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
        {coachesHere.length > 0 && (
          <section className="card" data-testid="club-coaches">
            <h2 className="text-lg font-extrabold">{t("venue.coaches")}</h2>
            <p className="text-xs text-muted">{t("venue.coachesHelp")}</p>
            <ul className="mt-3 flex flex-col gap-2">
              {coachesHere.map((c) => (
                <li key={c.id}>
                  <Link href={`/c/${c.handle}`} prefetch={false} className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-white px-4 py-3 hover:border-ink/30">
                    <span className="font-bold">{c.displayName}</span>
                    <span className="text-xs text-muted">{t("coach.page.lesson", { minutes: c.lessonMinutes })} ›</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
        <Link href={`/coach?s=club&club=${encodeURIComponent(club?.name ?? board.name)}`} prefetch={false} className="px-1 text-xs text-faint hover:text-muted" data-testid="coach-here">
          {t("venue.coachHere", { venue: club?.name ?? board.name })}
        </Link>
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
