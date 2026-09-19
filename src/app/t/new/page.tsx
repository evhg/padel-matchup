import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Footer, Header } from "@/components/Header";
import { CompetitionForm } from "@/components/tournament/CompetitionForm";
import { getDb } from "@/db";
import { CITIES } from "@/lib/domain/cities";
import { listClubsForPicking } from "@/lib/domain/clubs";
import { getSessionPlayer } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t("tournament.newTitle"), robots: { index: false, follow: true } };
}

/** /t/new: the competition in one screen; the categories follow on the manage screen it opens. */
export default async function NewTournamentPage() {
  const db = await getDb();
  const [t, me, clubs] = await Promise.all([getTranslations(), getSessionPlayer(db), listClubsForPicking(db)]);
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12">
        <section className="card">
          <span className="chip-muted">🏆 {t("tournament.eyebrow")}</span>
          <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight">{t("tournament.newTitle")}</h1>
          <p className="mt-2 text-sm text-muted">{t("tournament.newSub")}</p>
        </section>
        <CompetitionForm hasIdentity={Boolean(me)} cities={CITIES.map((c) => ({ slug: c.slug, name: c.name, tz: c.tz }))} listed={clubs.map((c) => c.name)} />
      </main>
      <Footer />
    </>
  );
}
