import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ClubRow } from "@/components/ClubBits";
import { Footer, Header } from "@/components/Header";
import { getDb } from "@/db";
import { baseUrl } from "@/lib/config";
import { CITIES } from "@/lib/domain/cities";
import { CLUB_LIMITS, listLiveClubs } from "@/lib/domain/clubs";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  const title = t("club.title");
  return { title, description: t("club.metaDescription"), alternates: { canonical: "/clubs" }, openGraph: { title, description: t("club.metaDescription"), type: "website", url: `${baseUrl()}/clubs` } };
}

/** /clubs: what a club page is, the founding offer, the live clubs by city, the claim button. */
export default async function ClubsPage() {
  const db = await getDb();
  const [t, clubs] = await Promise.all([getTranslations(), listLiveClubs(db)]);
  const byCity = new Map<string, typeof clubs>();
  for (const c of clubs) {
    const key = c.city ?? "other";
    byCity.set(key, [...(byCity.get(key) ?? []), c]);
  }
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12">
        <section className="card">
          <span className="chip-muted">🏟 {t("club.eyebrow")}</span>
          <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight">{t("club.title")}</h1>
          <p className="mt-2 text-sm text-muted">{t("club.sub")}</p>
          <Link href="/clubs/claim" prefetch={false} className="btn-primary mt-4 w-full">
            {t("club.claimCta")}
          </Link>
        </section>

        <section className="card">
          <h2 className="text-lg font-extrabold">🌱 {t("club.founding")}</h2>
          <p className="mt-2 text-sm text-muted">{t("club.foundingBody")}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {CITIES.map((city) => {
              const taken = (byCity.get(city.slug) ?? []).filter((c) => c.founding).length;
              return (
                <span key={city.slug} className="chip-muted">
                  {t("club.foundingLeft", { count: Math.max(0, CLUB_LIMITS.foundingPerCity - taken), city: city.name })}
                </span>
              );
            })}
          </div>
        </section>

        {[...CITIES.map((c) => ({ key: c.slug, name: c.name, href: `/${c.slug}` })), { key: "other", name: t("club.cityOther"), href: null }].map(({ key, name, href }) => {
          const list = byCity.get(key) ?? [];
          if (key === "other" && list.length === 0) return null;
          return (
            <section key={key} className="card">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-lg font-extrabold">{t("club.inCity", { city: name })}</h2>
                {href && (
                  <Link href={href} prefetch={false} className="link text-sm">
                    {t("city.title", { city: name })} →
                  </Link>
                )}
              </div>
              {list.length === 0 ? (
                <p className="mt-2 text-sm text-muted">{t("club.noClubs")}</p>
              ) : (
                <ul className="mt-3 flex flex-col gap-2">
                  {list.map((c) => (
                    <ClubRow key={c.slug} club={c} />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </main>
      <Footer />
    </>
  );
}
