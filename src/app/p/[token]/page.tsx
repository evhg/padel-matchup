import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { AdoptToken } from "@/components/AdoptToken";
import { Footer, Header } from "@/components/Header";
import { MyMatches } from "@/components/MyMatches";
import { getDb } from "@/db";
import { findPlayerByPersonalToken } from "@/lib/domain/identity";
import { markHomescreen } from "@/lib/domain/push";
import { getSessionPlayerId } from "@/lib/session";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t("me.title"), robots: { index: false, follow: false } };
}

/**
 * Personal link: renders My matches for the token's player directly (so a
 * home-screen shortcut works in any cookie jar) and hands the device the cookie.
 */
export default async function PersonalPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ source?: string }> }) {
  const [{ token }, sp] = await Promise.all([params, searchParams]);
  const db = await getDb();
  const player = await findPlayerByPersonalToken(db, token);
  if (!player) notFound();
  if (sp.source === "homescreen" && !player.homescreenAt) {
    await markHomescreen(db, player.id);
    player.homescreenAt = new Date();
  }
  const sessionId = await getSessionPlayerId();
  return (
    <>
      <Header minimal />
      <AdoptToken token={token} needsCookie={sessionId !== player.id} />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-5 px-4 pt-2">
        <MyMatches player={player} personalToken={token} />
      </main>
      <Footer />
    </>
  );
}
