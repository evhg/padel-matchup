import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { CoachListCard } from "@/components/coach/CoachListCard";
import { Footer, Header } from "@/components/Header";
import { getDb } from "@/db";
import { baseUrl } from "@/lib/config";
import { CITIES } from "@/lib/domain/cities";
import { busyForCoaches, coachCardFacts, listPublicCoaches, NO_BUSY } from "@/lib/domain/coaching";
import { localeAlternates } from "@/lib/seo";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const [t, locale] = await Promise.all([getTranslations("coaches"), getLocale()]);
  const title = t("indexTitle");
  const description = t("indexMeta");
  return { title, description, alternates: localeAlternates("/coaches", locale), openGraph: { title, description, type: "website", url: `${baseUrl()}/coaches` } };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The player's list: every listed coach, the city the visitor is in first, and on each card the
 * things somebody actually chooses between — the price, the next free hour, the languages, the
 * levels. This page used to be the coach's own front door, so a player who wanted a lesson met a
 * page selling an assistant to coaches; that door is `/coaches/join` now, one line at the foot.
 */
export default async function CoachesPage() {
  const db = await getDb();
  const [t, locale, coaches] = await Promise.all([getTranslations("coaches"), getLocale(), listPublicCoaches(db)]);
  const now = new Date();
  // One query for the whole list's busy time, not one per coach (rule 12).
  const busy = await busyForCoaches(db, coaches.map((c) => c.id), now, new Date(now.getTime() + 14 * DAY_MS));
  // The city the edge reports puts the visitor's own city first; a time zone alone cannot tell Phuket from Bangkok.
  const hdrs = await headers();
  const hereCity = (hdrs.get("x-vercel-ip-city") ?? "").toLowerCase();
  const hereTz = hdrs.get("x-vercel-ip-timezone") ?? "";
  const sections = CITIES.map((city) => ({ city, list: coaches.filter((c) => c.tz === city.tz) }))
    .filter((s) => s.list.length > 0)
    .sort((a, b) => Number(decodeURIComponent(b.city.name).toLowerCase() === hereCity || (b.city.tz === hereTz ? 0.5 : 0)) - Number(decodeURIComponent(a.city.name).toLowerCase() === hereCity || (a.city.tz === hereTz ? 0.5 : 0)));
  const placed = new Set(sections.flatMap((s) => s.list.map((c) => c.id)));
  const elsewhere = coaches.filter((c) => !placed.has(c.id));
  const card = (c: (typeof coaches)[number], cityName: string | null) => <CoachListCard key={c.id} coach={coachCardFacts(c, busy.get(c.id) ?? NO_BUSY, now)} locale={locale} foundingCity={cityName} />;
  // The same list a search engine reads, in the order a visitor sees it.
  const base = baseUrl();
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: t("indexTitle"),
    itemListElement: coaches.map((c, i) => ({ "@type": "ListItem", position: i + 1, url: `${base}/c/${c.handle}`, name: c.displayName })),
  };
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
        <section className="card">
          <span className="chip-muted">🎾 {t("indexEyebrow")}</span>
          <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight">{t("indexTitle")}</h1>
          <p className="mt-2 text-sm text-muted">{t("indexLead")}</p>
        </section>

        {coaches.length === 0 && (
          <section className="card">
            <p className="text-sm text-muted">{t("indexEmpty")}</p>
          </section>
        )}

        {sections.map(({ city, list }) => (
          <section key={city.slug} className="flex flex-col gap-3" data-testid="coach-city">
            <div className="flex items-baseline justify-between gap-3 px-1">
              <h2 className="text-lg font-extrabold">{t("title", { city: city.name })}</h2>
              <Link href={`/coaches/${city.slug}`} prefetch={false} className="link text-sm">
                {t("indexCityMore")}
              </Link>
            </div>
            <ul className="flex flex-col gap-3" data-testid="coach-list">{list.map((c) => card(c, city.name))}</ul>
          </section>
        ))}

        {elsewhere.length > 0 && (
          <section className="flex flex-col gap-3">
            <h2 className="px-1 text-lg font-extrabold">{t("indexElsewhere")}</h2>
            <ul className="flex flex-col gap-3">{elsewhere.map((c) => card(c, null))}</ul>
          </section>
        )}

        {/* The coach's own door: one line, at the foot, where a coach looks and a player does not. */}
        <section className="card">
          <p className="text-sm font-bold">{t("indexForCoaches")}</p>
          <Link href="/coaches/join?s=coachlist" prefetch={false} className="btn-ghost mt-3 w-full">
            {t("coachCta")}
          </Link>
        </section>
      </main>
      <Footer />
    </>
  );
}
