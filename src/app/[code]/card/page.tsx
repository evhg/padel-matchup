import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { Footer, Header } from "@/components/Header";
import { ShareButtons } from "@/components/ShareSheet";
import { getDb } from "@/db";
import { calendarTitle } from "@/lib/calendar";
import { isValidShareCode } from "@/lib/codes";
import { baseUrl } from "@/lib/config";
import { formatEventDay } from "@/lib/dates";
import { isOccupied } from "@/lib/domain/events";
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
  return { title, robots: { index: false, follow: true }, openGraph: { title, type: "website", url: `${baseUrl()}/${code}/card` }, twitter: { card: "summary_large_image", title } };
}

/** A page whose link unfurls with the result picture, plus the picture itself to save. The viral loop ends in "organize your own". */
export default async function CardPage({ params }: Props) {
  const { code } = await params;
  if (!isValidShareCode(code)) notFound();
  const db = await getDb();
  const detail = await getEventByCode(db, code);
  if (!detail) notFound();
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  const ev = detail.event;
  const nameOf = (s: (typeof detail.roster)[number]) => s.player?.displayName ?? s.invitedName ?? "?";
  let line: string;
  if (ev.type === "match") {
    const r = matchResult(detail.scores, detail.roster.map((s) => ({ team: s.team, status: s.status, name: nameOf(s) })));
    if (!r) redirect(`/${code}`);
    const a = r.hasTeams ? r.a.join(" & ") : t("card.teamA");
    const b = r.hasTeams ? r.b.join(" & ") : t("card.teamB");
    line = r.winner === "draw" ? `${t("card.draw", { a, b })} ${r.score}` : r.winner === "a" ? `${t("card.won", { a, b })} ${r.score}` : `${t("card.won", { a: b, b: a })} ${r.sets.map((s) => `${s.sideB}-${s.sideA}`).join(" ")}`;
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
  const day = formatEventDay(ev.startsAt, ev.tz, locale);
  const text = t("shareText.result", { line, day, url });
  return (
    <>
      <Header minimal />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12">
        <h1 className="text-2xl font-extrabold tracking-tight">{t("card.title")}</h1>
        <div className="overflow-hidden rounded-2xl border border-line bg-white shadow-sm">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/${code}/card/opengraph-image`} alt={line} width={1200} height={630} className="block h-auto w-full" />
        </div>
        <p className="text-sm font-semibold">{line}</p>
        <p className="text-xs text-faint">{t("card.saveHint")}</p>
        <ShareButtons url={url} text={text} />
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
