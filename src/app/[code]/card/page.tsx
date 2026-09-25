import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { Footer, Header } from "@/components/Header";
import { PhotoButton } from "@/components/PhotoButton";
import { SameTimeButton } from "@/components/SameTimeButton";
import { ShareButtons } from "@/components/ShareSheet";
import { getDb } from "@/db";
import { calendarTitle } from "@/lib/calendar";
import { isValidShareCode } from "@/lib/codes";
import { baseUrl } from "@/lib/config";
import { formatEventDay, formatEventTime } from "@/lib/dates";
import { bumpMetric } from "@/lib/domain/metrics";
import { later } from "@/lib/alerts";
import { streakLine, winStreakFor } from "@/lib/domain/banter";
import { praiseLine } from "@/lib/domain/praise";
import { getEventPhotoMeta } from "@/lib/domain/photos";
import { taggedUrl } from "@/lib/source";
import { getSessionPlayer } from "@/lib/session";
import { isOccupied, isSeated } from "@/lib/domain/events";
import { getEventByCode } from "@/lib/domain/queries";
import { getTournamentState } from "@/lib/domain/tournament";
import { cardImagePath, cardVersion, matchLine } from "@/lib/resultCard";

type Props = { params: Promise<{ code: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { code } = await params;
  const t = await getTranslations();
  if (!isValidShareCode(code)) return {};
  const db = await getDb();
  const detail = await getEventByCode(db, code);
  if (!detail) return {};
  const title = `${t("card.title")} · ${calendarTitle(detail.event, t(detail.event.type === "match" ? "event.match" : "event.tournament"))}`;
  // The picture's URL carries the score's version, so an edited score is never served from a cache of the old one.
  const photo = await getEventPhotoMeta(db, detail.event.id).catch(() => null);
  const image = { url: `${baseUrl()}${cardImagePath(code, cardVersion(detail, photo))}`, width: 1200, height: 630 };
  return { title, robots: { index: false, follow: true }, openGraph: { title, type: "website", url: `${baseUrl()}/${code}/card`, images: [image] }, twitter: { card: "summary_large_image", title, images: [image.url] } };
}

/** A page whose link unfurls with the result picture, plus the picture itself to save. The viral loop ends in "organize your own". */
export default async function CardPage({ params }: Props) {
  const { code } = await params;
  if (!isValidShareCode(code)) notFound();
  const db = await getDb();
  const detail = await getEventByCode(db, code);
  if (!detail) notFound();
  const [t, locale, me, photo] = await Promise.all([getTranslations(), getLocale(), getSessionPlayer(db), getEventPhotoMeta(db, detail.event.id).catch(() => null)]);
  const ev = detail.event;
  const participant = Boolean(me && (ev.creatorPlayerId === me.id || isSeated({ roster: detail.roster }, me.id)));
  const nameOf = (s: (typeof detail.roster)[number]) => s.player?.displayName ?? s.invitedName ?? "?";
  // One count per render: the funnel's last step.
  await later(() => bumpMetric(db, "card_views"));
  let line: string;
  let praise: string | null = null;
  let banter: string | null = null;
  if (ev.type === "match") {
    const r = matchLine(t as unknown as (key: string, values?: Record<string, string | number>) => string, detail);
    if (!r) redirect(`/${code}`);
    line = r.line;
    if (r.winners) praise = praiseLine(locale, ev.code, r.winners);
    // The same line the picture carries, in the reader's language. One bounded read, only for a match with winners.
    const streak = r.winners ? await winStreakFor(db, detail).catch(() => null) : null;
    if (streak) banter = streakLine(locale, ev.code, streak);
  } else {
    const named = detail.roster.filter((s) => isOccupied(s) || s.status === "invited");
    const ids = named.map((s) => s.playerId).filter((x): x is string => Boolean(x));
    const state = await getTournamentState(db, ev, ids);
    if (state.scoredMatches === 0) redirect(`/${code}`);
    const first = state.standings[0];
    const name = named.find((s) => s.playerId === first?.playerId);
    line = first ? `${t("card.winner", { name: name ? nameOf(name) : "?" })} · ${t("card.pts", { points: first.points })}` : t("card.result");
  }
  const url = `${baseUrl()}/${code}/card`;
  const shareUrl = taggedUrl(url, "card");
  const day = formatEventDay(ev.startsAt, ev.tz, locale);
  const text = t("shareText.result", { line, day, url: shareUrl });
  const image = cardImagePath(code, cardVersion(detail, photo));
  return (
    <>
      <Header minimal />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12">
        <h1 className="text-2xl font-extrabold tracking-tight">{t("card.title")}</h1>
        <div className="overflow-hidden rounded-2xl border border-line bg-white shadow-sm">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={image} alt={line} width={1200} height={630} className="block h-auto w-full" />
        </div>
        <p className="text-sm font-semibold">{line}</p>
        {praise && <p className="text-sm text-muted" data-testid="praise">{praise}</p>}
        {banter && (
          <p className="text-sm font-semibold" data-testid="banter">
            {banter}
          </p>
        )}
        <p className="text-xs text-faint">{t("card.saveHint")}</p>
        {participant && ev.type === "match" && <PhotoButton code={code} hasPhoto={Boolean(photo)} canRemove={Boolean(me && photo && (photo.uploadedByPlayerId === me.id || ev.creatorPlayerId === me.id))} />}
        <ShareButtons url={shareUrl} text={text} imageUrl={image} />
        {ev.type === "match" && me && !ev.groupId && (ev.creatorPlayerId === me.id || isSeated({ roster: detail.roster }, me.id)) && <SameTimeButton code={code} when={`${formatEventDay(ev.startsAt, ev.tz, locale).split(" ")[0]} ${formatEventTime(ev.startsAt, ev.tz, locale)}`} />}
        <Link href="/" prefetch={false} className="btn-primary w-full text-lg">
          {t("card.organize")}
        </Link>
        <Link href={`/${code}`} prefetch={false} className="btn-ghost w-full">
          ← {t("card.back")}
        </Link>
      </main>
      <Footer />
    </>
  );
}
