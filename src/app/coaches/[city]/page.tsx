import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { Footer, Header } from "@/components/Header";
import { getDb } from "@/db";
import { baseUrl } from "@/lib/config";
import { CITIES, cityBySlug } from "@/lib/domain/cities";
import { isFoundingCoach, listPublicCoaches } from "@/lib/domain/coaching";
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
  const [t, tCoach, coaches] = await Promise.all([getTranslations("coaches"), getTranslations("coach"), listPublicCoaches(db, city.tz)]);
  const base = baseUrl();
  const languageName = (code: string) => (code === "ru" ? "Русский" : code === "es" ? "Español" : "English");
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
            {coaches.map((c) => (
              <li key={c.id} className="card flex flex-col gap-2">
                {isFoundingCoach(c) && <span className="chip-muted self-start">🏅 {tCoach("page.founding", { city: city.name })}</span>}
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="text-xl font-extrabold tracking-tight">{c.displayName}</h2>
                  <span className="text-xs text-muted">{tCoach("page.lesson", { minutes: c.lessonMinutes })}</span>
                </div>
                <p className="text-sm text-muted">
                  {c.clubNames.length ? `${tCoach("page.at", { clubs: c.clubNames.join(", ") })} · ` : ""}
                  {c.languages.map(languageName).join(", ")}
                </p>
                {c.bio && <p className="text-sm">{c.bio}</p>}
                <Link href={`/c/${c.handle}`} prefetch={false} className="btn-secondary w-full">
                  {t("open", { name: c.displayName })}
                </Link>
              </li>
            ))}
          </ul>
        )}
        <section className="card">
          <p className="text-sm font-bold">{t("coachQuestion", { city: city.name })}</p>
          <p className="mt-1 text-xs text-muted">{t("coachHelp")}</p>
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
