import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { Footer, Header } from "@/components/Header";
import { getDb } from "@/db";
import { competitionsOf, listOpenCompetitions } from "@/lib/domain/competitions";
import { getSessionPlayer } from "@/lib/session";
import { dayRange } from "@/lib/tournamentText";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t("tournament.listTitle"), description: t("tournament.listSub") };
}

/** Every competition open for entries, soonest first, and the ones the visitor organises. */
export default async function TournamentsPage() {
  const db = await getDb();
  const [t, locale, me] = await Promise.all([getTranslations(), getLocale(), getSessionPlayer(db)]);
  // Yesterday in UTC: a competition on its last day is still "open" everywhere on Earth.
  const today = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const open = await listOpenCompetitions(db, today);
  const mine = me ? await competitionsOf(db, me.id) : [];
  const card = (c: (typeof open)[number]) => (
    <li key={c.id}>
      <Link href={`/t/${c.slug}`} prefetch={false} className="block py-3 hover:underline">
        <div className="font-bold">{c.name}</div>
        <div className="text-sm text-muted">
          {dayRange(c.startsOn, c.endsOn, locale)}
          {c.venueName ? ` · ${c.venueName}` : ""}
        </div>
      </Link>
    </li>
  );
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12">
        <section className="card">
          <span className="chip-muted">🏆 {t("tournament.eyebrow")}</span>
          <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight">{t("tournament.listTitle")}</h1>
          <p className="mt-2 text-sm text-muted">{t("tournament.listSub")}</p>
          <Link href="/t/new" prefetch={false} className="btn-primary mt-3" data-testid="new-tournament">
            {t("tournament.newButton")}
          </Link>
        </section>
        {mine.length > 0 && (
          <section className="card" data-testid="my-tournaments">
            <h2 className="text-lg font-extrabold">{t("tournament.mine")}</h2>
            <ul className="mt-1 flex flex-col divide-y divide-line">{mine.map(card)}</ul>
          </section>
        )}
        <section className="card" data-testid="open-tournaments">
          <h2 className="text-lg font-extrabold">{t("tournament.statusOpen")}</h2>
          {open.length === 0 ? <p className="mt-2 text-sm text-muted">{t("tournament.listNone")}</p> : <ul className="mt-1 flex flex-col divide-y divide-line">{open.map(card)}</ul>}
        </section>
      </main>
      <Footer />
    </>
  );
}
