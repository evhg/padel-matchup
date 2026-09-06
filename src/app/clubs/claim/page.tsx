import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { ClubClaimForm } from "@/components/ClubClaimForm";
import { Footer, Header } from "@/components/Header";
import { getDb } from "@/db";
import { baseUrl } from "@/lib/config";
import { CITIES } from "@/lib/domain/cities";
import { getSessionPlayer } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t("club.claimTitle"), robots: { index: false, follow: true } };
}

/** /clubs/claim?name=…: the self-serve claim, one screen. */
export default async function ClaimClubPage({ searchParams }: { searchParams: Promise<{ name?: string }> }) {
  const sp = await searchParams;
  const db = await getDb();
  const [t, me] = await Promise.all([getTranslations(), getSessionPlayer(db)]);
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12">
        <section className="card">
          <span className="chip-muted">🏟 {t("club.eyebrow")}</span>
          <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight">{t("club.claimTitle")}</h1>
          <p className="mt-2 text-sm text-muted">{t("club.claimSub")}</p>
          <p className="mt-2 text-sm text-muted">{t("club.foundingBody")}</p>
        </section>
        <ClubClaimForm initialName={(sp.name ?? "").slice(0, 80)} hasIdentity={Boolean(me)} cities={CITIES.map((c) => ({ slug: c.slug, name: c.name }))} base={baseUrl()} />
      </main>
      <Footer />
    </>
  );
}
