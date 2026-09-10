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
import { praiseLine } from "@/lib/domain/praise";
import { getEventPhoto } from "@/lib/domain/photos";
import { taggedUrl } from "@/lib/source";
import { getSessionPlayer } from "@/lib/session";
import { fnv1a } from "@/lib/hash";
import { isOccupied, isSeated } from "@/lib/domain/events";
import { getEventByCode } from "@/lib/domain/queries";
import { matchResult } from "@/lib/domain/result";
import { getTournamentState } from "@/lib/domain/tournament";

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
  const photo = await getEventPhoto(db, detail.event.id).catch(() => null);
  const image = { url: `${baseUrl()}/${code}/card/opengraph-image?v=${resultVersion(detail)}${photo ? `-p${photo.createdAt.getTime().toString(36)}` : ""}`, width: 1200, height: 630 };
  return { title, robots: { index: false, follow: true }, openGraph: { title, type: "website", url: `${baseUrl()}/${code}/card`, images: [image] }, twitter: { card: "summary_large_image", title, images: [image.url] } };
}

/** Changes exactly when what the picture shows changes: the recorded sets, the match state, and who stands on which side under what name. */
const resultVersion = (detail: { scores: unknown; event: { status: string }; roster: { status: string; team: string | null; player: { displayName: string } | null; invitedName: string | null }[] }) =>
  fnv1a(JSON.stringify(detail.scores) + detail.event.status + JSON.stringify(detail.roster.map((s) => [s.status, s.team, s.player?.displayName ?? s.invitedName ?? ""])));

/** A page whose link unfurls with the result picture, plus the picture itself to save. The viral loop ends in "organize your own". */
export default async function CardPage({ params }: Props) {
  const { code } = await params;
  if (!isValidShareCode(code)) notFound();
  const db = await getDb();
  const detail = await getEventByCode(db, code);
  if (!detail) notFound();
  const [t, locale, me, photo] = await Promise.all([getTranslations(), getLocale(), getSessionPlayer(db), getEventPhoto(db, detail.event.id).catch(() => null)]);
  const ev = detail.event;
  const participant = Boolean(me && (ev.creatorPlayerId === me.id || isSeated({ roster: detail.roster }, me.id)));
  const nameOf = (s: (typeof detail.roster)[number]) => s.player?.displayName ?? s.invitedName ?? "?";
  // One count per render: the funnel's last step.
  void bumpMetric(db, "card_views").catch(() => undefined);
  let line: string;
  let praise: string | null = null;
  if (ev.type === "match") {
    const r = matchResult(detail.scores, detail.roster.map((s) => ({ team: s.team, status: s.status, name: nameOf(s) })));
    if (!r) redirect(`/${code}`);
    const a = r.hasTeams ? r.a.join(" & ") : t("card.teamA");
    const b = r.hasTeams ? r.b.join(" & ") : t("card.teamB");
    line = (r.winner === "draw" ? `${t("card.draw", { a, b })} ${r.score}` : r.winner === "a" ? `${t("card.won", { a, b })} ${r.score}` : `${t("card.won", { a: b, b: a })} ${r.sets.map((s) => `${s.sideB}-${s.sideA}`).join(" ")}`).trim();
    if (r.hasTeams && r.winner !== "draw") praise = praiseLine(locale, ev.code, (r.winner === "a" ? r.a : r.b).join(" & "));
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
  const version = `${resultVersion(detail)}${photo ? `-p${photo.createdAt.getTime().toString(36)}` : ""}`;
  return (
    <>
      <Header minimal />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12">
        <h1 className="text-2xl font-extrabold tracking-tight">{t("card.title")}</h1>
        <div className="overflow-hidden rounded-2xl border border-line bg-white shadow-sm">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/${code}/card/opengraph-image?v=${version}`} alt={line} width={1200} height={630} className="block h-auto w-full" />
        </div>
        <p className="text-sm font-semibold">{line}</p>
        {praise && <p className="text-sm text-muted" data-testid="praise">{praise}</p>}
        <p className="text-xs text-faint">{t("card.saveHint")}</p>
        {participant && ev.type === "match" && <PhotoButton code={code} hasPhoto={Boolean(photo)} canRemove={Boolean(me && photo && (photo.uploadedByPlayerId === me.id || ev.creatorPlayerId === me.id))} />}
        <ShareButtons url={shareUrl} text={text} imageUrl={`/${code}/card/opengraph-image?v=${version}`} />
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
