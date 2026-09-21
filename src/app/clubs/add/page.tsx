import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { ClubAddForm } from "@/components/ClubAddForm";
import { Footer, Header } from "@/components/Header";
import { getDb } from "@/db";
import { baseUrl } from "@/lib/config";
import { localeAlternates } from "@/lib/seo";
import { getSessionPlayer } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  const locale = await getLocale();
  const title = t("club.addTitle");
  return { title, description: t("club.addSub"), alternates: localeAlternates("/clubs/add", locale), openGraph: { title, description: t("club.addSub"), type: "website", url: `${baseUrl()}/clubs/add` } };
}

/**
 * /clubs/add — anybody puts a club on the map.
 *
 * The door beside it, /clubs/claim, is for the club itself and asks who you are there. This one
 * asks nothing of the kind, because listing a club hands the lister nothing but their name on the
 * page. It exists because every club here came from Thailand or Singapore, and a player anywhere
 * else had no way in.
 */
export default async function AddClubPage({ searchParams }: { searchParams: Promise<{ name?: string }> }) {
  const [t, db, sp] = await Promise.all([getTranslations(), getDb(), searchParams]);
  const me = await getSessionPlayer(db);
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12">
        <section className="card">
          <span className="chip-muted">🏟 {t("club.eyebrow")}</span>
          <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight">{t("club.addTitle")}</h1>
          <p className="mt-2 text-sm text-muted">{t("club.addSub")}</p>
        </section>
        <ClubAddForm hasIdentity={Boolean(me)} initialName={(sp.name ?? "").slice(0, 80)} />
        <section className="card">
          <p className="text-sm text-muted">{t("club.isYoursHelp")}</p>
          <Link href="/clubs/claim" prefetch={false} className="btn-ghost btn-sm mt-3" data-testid="add-to-claim">
            {t("club.claimCta")}
          </Link>
        </section>
      </main>
      <Footer />
    </>
  );
}
