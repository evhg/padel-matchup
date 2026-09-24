import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Footer, Header } from "@/components/Header";
import { DeleteAccount } from "@/components/DeleteAccount";
import { SameNameCard } from "@/components/SameNameCard";
import { MyMatches } from "@/components/MyMatches";
import { MySettings } from "@/components/MySettings";
import { NameGate } from "@/components/NameGate";
import { canRestore, ReturningPlayer } from "@/components/ReturningPlayer";
import { getDb } from "@/db";
import { baseUrl } from "@/lib/config";
import { getOrCreatePersonalToken } from "@/lib/domain/identity";
import { getSessionPlayer } from "@/lib/session";
import { clubStatus, listClubsClaimedBy } from "@/lib/domain/clubs";
import { FeedbackInline } from "@/components/FeedbackInline";
import { countShipped, showsShipped } from "@/lib/feedback/store";
import { CoachCard } from "@/components/coach/CoachCard";
import { getCoachForActor } from "@/lib/domain/coaching";
import { MomentsStrip } from "@/components/MomentsStrip";
import { WhenIPlay } from "@/components/WhenIPlay";
import { listWants } from "@/lib/domain/demand";
import { getVenues, playerHasEvents } from "@/lib/domain/queries";
import { PassportCard } from "@/components/PassportCard";
import Link from "next/link";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t("me.title") };
}

type Props = { searchParams: Promise<{ telegram?: string }> };

export default async function MePage({ searchParams }: Props) {
  const db = await getDb();
  const [me, { telegram }] = await Promise.all([getSessionPlayer(db), searchParams]);
  // Back from Telegram: one line about how it went, nothing else changes.
  const note = telegram === "linked" ? "linked" : telegram === "invalid" ? "invalid" : null;

  if (!me) {
    const t = await getTranslations();
    // Most people arriving here signed out have played before (another phone, another browser):
    // the way back comes first, the first-time path second.
    const returning = canRestore();
    return (
      <>
        <Header minimal />
        <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2">
          <h1 className="text-3xl font-extrabold tracking-tight">{t("me.title")}</h1>
          {note === "invalid" && <p className="rounded-2xl bg-danger-soft px-4 py-3 text-sm font-semibold text-danger">{t("telegram.invalid")}</p>}
          {returning && (
            <section className="card">
              <ReturningPlayer />
            </section>
          )}
          <NameGate title={t("me.firstTimeTitle")} autoFocus={!returning} />
        </main>
        <Footer />
      </>
    );
  }

  const [token, myClubs, t, asCoach, shipped] = await Promise.all([getOrCreatePersonalToken(db, me.id), listClubsClaimedBy(db, me.id), getTranslations(), getCoachForActor(db, me.id), countShipped(db)]);
  // Sequential, not folded into the batch above: the pooler stalls on pipelined bursts (rule 8).
  const wants = (await listWants(db, me.id)).map((w) => ({ id: w.id, weekday: w.weekday, fromTime: w.fromTime, toTime: w.toTime, place: w.venueSlug ?? w.citySlug ?? "" }));
  // Their usual court, offered as the starting value: most people want to play where they already play.
  const lastVenue = (await getVenues(db, me.id))[0]?.name ?? null;
  // One bounded row: the settings block needs only the yes-or-no, not the list MyMatches fetches.
  const hasMatches = await playerHasEvents(db, me.id);
  return (
    <>
      {/* The doors belong here too: this screen used to be a room with only the logo to leave by, so a coach who landed on it lost their book. */}
      <Header current="play" />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-5 px-4 pt-2">
        {note === "linked" && <p className="rounded-2xl bg-ok-soft px-4 py-3 text-sm font-semibold text-ok">✓ {t("telegram.justLinked")}</p>}
        {note === "invalid" && <p className="rounded-2xl bg-danger-soft px-4 py-3 text-sm font-semibold text-danger">{t("telegram.invalid")}</p>}
        {asCoach && <CoachCard db={db} coach={asCoach.coach} />}
        <MyMatches player={me} />
        <SameNameCard db={db} player={me} />
        <WhenIPlay initial={wants} suggestedPlace={lastVenue} />
        <MomentsStrip db={db} playerId={me.id} />
        <PassportCard publicOn={me.publicProfile} slug={me.publicSlug} base={baseUrl()} />
        {myClubs.length > 0 && (
          <section className="card">
            <h2 className="text-lg font-extrabold">{t("club.yourClubs")}</h2>
            <p className="mt-1 text-xs text-muted">{t("club.yourClubsHelp")}</p>
            <ul className="mt-3 flex flex-col gap-2">
              {myClubs.map((c) => {
                const status = clubStatus(c);
                return (
                  <li key={c.slug} className="flex items-center justify-between gap-3 rounded-2xl border border-line px-4 py-3">
                    <div className="min-w-0">
                      <div className="truncate font-bold">{c.name}</div>
                      <div className="text-xs text-muted">{status === "live" ? `✓ ${t("club.statusLive")}` : status === "rejected" ? t("club.statusRejected") : `⏳ ${t("club.statusPending")}`}</div>
                    </div>
                    <Link href={`/v/${c.slug}/manage/${c.manageToken}`} prefetch={false} className="btn-ghost btn-sm">
                      {t("common.edit")}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        {/* No "do you coach?" here, and no door for a club or an organiser either. This screen is a
            player's matches; the stakeholders have their own front doors on the landing page, and
            asking a player to become something else is not what they came for. */}
        <FeedbackInline variant="card" signedInVia={me.telegramId ? "telegram" : "none"} shipped={showsShipped(shipped) ? shipped : undefined} />
        <MySettings player={me} personalToken={token} hasMatches={hasMatches} />
        {/* Last on the page, always: the one action that cannot be undone. */}
        <DeleteAccount />
      </main>
      <Footer />
    </>
  );
}
