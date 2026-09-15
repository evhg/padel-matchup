import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { AdoptToken } from "@/components/AdoptToken";
import { Footer, Header } from "@/components/Header";
import { DeleteAccount } from "@/components/DeleteAccount";
import { playerHasEvents } from "@/lib/domain/queries";
import { MyMatches } from "@/components/MyMatches";
import { MySettings } from "@/components/MySettings";
import { getDb } from "@/db";
import { findPlayerByPersonalToken } from "@/lib/domain/identity";
import { markHomescreen } from "@/lib/domain/push";
import { safeNext } from "@/lib/personal";
import { getSessionPlayerId } from "@/lib/session";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t("me.title"), robots: { index: false, follow: false } };
}

/**
 * Personal link: renders My matches for the token's player directly (so a
 * home-screen shortcut works in any cookie jar) and hands the device the cookie.
 */
export default async function PersonalPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ source?: string; next?: string }> }) {
  const [{ token }, sp] = await Promise.all([params, searchParams]);
  const db = await getDb();
  const player = await findPlayerByPersonalToken(db, token);
  if (!player) notFound();
  if (sp.source === "homescreen" && !player.homescreenAt) {
    await markHomescreen(db, player.id);
    player.homescreenAt = new Date();
  }
  const sessionId = await getSessionPlayerId();
  // A safe internal destination (the bot sends /coach, a match invite its code): straight there when this device holds the
  // identity, and through the hand-off route, which sets the cookie and redirects on, when it does not. No client step either way.
  const next = safeNext(sp.next);
  if (next) redirect(sessionId === player.id ? next : `/p/${token}/go?next=${encodeURIComponent(next)}`);
  return (
    <>
      <Header minimal />
      <AdoptToken token={token} needsCookie={sessionId !== player.id} />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-5 px-4 pt-2">
        <MyMatches player={player} />
        {/* Settings and the delete button came with MyMatches until they were lifted out of it. They
            belong on the page somebody reaches by their own link, so they are here, in the order the
            rest of the app uses: what you read, then what you set, then the one thing you cannot undo. */}
        <MySettings player={player} personalToken={token} hasMatches={await playerHasEvents(db, player.id)} />
        <DeleteAccount />
      </main>
      <Footer />
    </>
  );
}
