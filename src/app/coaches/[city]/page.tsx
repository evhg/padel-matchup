import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { Footer, Header } from "@/components/Header";
import { getDb } from "@/db";
import { baseUrl } from "@/lib/config";
import { CITIES, cityBySlug } from "@/lib/domain/cities";
import { CoachListCard } from "@/components/coach/CoachListCard";
import { WantCoachForm } from "@/components/WantCoachForm";
import { countCoachWants, shownCount } from "@/lib/domain/coachWants";
import { busyForCoaches, coachCardFacts, listPublicCoaches, hasPhoto, NO_BUSY, offersForCoaches, proofForCoaches, reachableCoaches } from "@/lib/domain/coaching";
import { getSessionPlayer } from "@/lib/session";
import { localeAlternates } from "@/lib/seo";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ city: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { city: slug } = await params;
  const city = cityBySlug(slug.toLowerCase());
  const [t, locale] = await Promise.all([getTranslations("coaches"), getLocale()]);
  if (!city) return { title: t("title", { city: slug }), robots: { index: false, follow: false } };
  const title = t("title", { city: city.name });
  const description = t("metaDescription", { city: city.name });
  return { title, description, alternates: localeAlternates(`/coaches/${city.slug}`, locale), openGraph: { title, description, type: "website", url: `${baseUrl()}/coaches/${city.slug}` } };
}

/** The coaches who chose to be listed in a city: one card each, a link to their book. Nothing ranked, nothing paid. */
export default async function CoachesInCityPage({ params }: Props) {
  const { city: slug } = await params;
  const city = cityBySlug(slug.toLowerCase());
  if (!city) notFound();
  const db = await getDb();
  const [t, tCoach, locale, coaches] = await Promise.all([getTranslations("coaches"), getTranslations("coach"), getLocale(), listPublicCoaches(db, city.tz)]);
  // The other half of the list: who is asking. Two bounded reads, sequential (rule 8).
  const me = await getSessionPlayer(db);
  const waiting = shownCount(await countCoachWants(db, city.slug));
  // One query for the whole list's busy time, so the free hour on each card costs no extra read (rule 12).
  const now = new Date();
  const ids = coaches.map((c) => c.id);
  // Whether a request would reach each coach is one more query for the whole list, never one per card.
  const [busy, offers, photos, proof, reachable] = await Promise.all([busyForCoaches(db, ids, now, new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000)), offersForCoaches(db, ids), hasPhoto(db, ids), proofForCoaches(db, coaches), reachableCoaches(db, ids)]);
  const base = baseUrl();
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: t("title", { city: city.name }),
    itemListElement: coaches.map((c, i) => ({ "@type": "ListItem", position: i + 1, url: `${base}/c/${c.handle}`, item: { "@type": "Person", name: c.displayName, jobTitle: tCoach("page.coach"), url: `${base}/c/${c.handle}`, knowsLanguage: c.languages, ...(c.clubNames.length ? { worksFor: c.clubNames.map((name) => ({ "@type": "SportsActivityLocation", name })) } : {}) } })),
  };
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12">
        {coaches.length > 0 && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />}
        <section className="card">
          <span className="chip-muted">🎾 {city.name}</span>
          <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight">{t("title", { city: city.name })}</h1>
          <p className="mt-2 text-sm text-muted">{t("lead")}</p>
        </section>
        {coaches.length === 0 ? (
          <section className="card">
            <p className="text-sm text-muted">{t("empty", { city: city.name })}</p>
          </section>
        ) : (
          <ul className="flex flex-col gap-3" data-testid="coach-list">
            {/* The same card as the index, so a player compares on the same facts wherever they land. */}
            {coaches.map((c) => (
              <CoachListCard key={c.id} coach={coachCardFacts(c, busy.get(c.id) ?? NO_BUSY, offers.get(c.id) ?? [], now, { reachable: reachable.has(c.id), photo: photos.has(c.id), proof: proof.get(c.id) })} locale={locale} foundingCity={city.name} />
            ))}
          </ul>
        )}
        <WantCoachForm citySlug={city.slug} cityName={city.name} hasIdentity={Boolean(me)} reachable={Boolean(me?.email || me?.telegramId)} waiting={waiting} />
        <section className="card">
          <p className="text-sm font-bold">{t("coachQuestion", { city: city.name })}</p>
          <p className="mt-1 text-xs text-muted">{t("coachHelp")}</p>
          {waiting > 0 && <p className="mt-1 text-xs font-bold" data-testid="coach-waiting">{t("wantWaiting", { count: waiting })}</p>}
          <Link href="/coach?s=citylist" prefetch={false} className="btn-ghost mt-3 w-full">
            {t("coachCta")}
          </Link>
          <Link href="/coaches?s=citylist" prefetch={false} className="mt-2 block text-center text-xs text-faint hover:text-muted">
            {t("coachMore")}
          </Link>
        </section>
        <p className="text-center text-xs text-faint">
          {CITIES.filter((c) => c.slug !== city.slug).map((c) => (
            <Link key={c.slug} href={`/coaches/${c.slug}`} prefetch={false} className="mx-2 hover:text-muted">
              {t("title", { city: c.name })} →
            </Link>
          ))}
        </p>
      </main>
      <Footer />
    </>
  );
}
