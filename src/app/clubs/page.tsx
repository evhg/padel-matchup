import type { Metadata } from "next";
import { localeAlternates } from "@/lib/seo";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { ClubRow } from "@/components/ClubBits";
import { Footer, Header } from "@/components/Header";
import { headers } from "next/headers";
import { getDb } from "@/db";
import { baseUrl } from "@/lib/config";
import { CITIES } from "@/lib/domain/cities";
import { countryName, noneInCountry, visitorCity, visitorCountry } from "@/lib/domain/countries";
import { CLUB_LIMITS, listShownClubs } from "@/lib/domain/clubs";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  const locale = await getLocale();
  const title = t("club.title");
  return { title, description: t("club.metaDescription"), alternates: localeAlternates("/clubs", locale), openGraph: { title, description: t("club.metaDescription"), type: "website", url: `${baseUrl()}/clubs` } };
}

/** /clubs: what a club page is, the founding offer, every club we may show, and the claim button. */
export default async function ClubsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const db = await getDb();
  const [t, locale, all, sp, hdrs] = await Promise.all([getTranslations(), getLocale(), listShownClubs(db), searchParams, headers()]);
  // Every club here is in Thailand or Singapore. A reader in Kuala Lumpur, Berlin, Madrid or Moscow
  // met two city headings and a search that found nothing, and had no reason to believe the product
  // was for their country. Name their country, and offer them the first place in it.
  const here = visitorCountry(hdrs.get("x-vercel-ip-country"), hdrs.get("x-vercel-ip-timezone"));
  const hereName = here ? countryName(here, locale) : null;
  const herePlace = visitorCity(hdrs.get("x-vercel-ip-city"));
  const hereEmpty = noneInCountry(all.map((c) => c.country), here);
  // A club owner's first move is to look for their own club, and there was no box anywhere on the
  // site to type its name into. A form, not a script: it works before the JavaScript arrives.
  const q = (sp.q ?? "").trim().slice(0, 60);
  const needle = q.toLowerCase();
  const clubs = needle ? all.filter((c) => [c.name, c.province, c.city].some((f) => f?.toLowerCase().includes(needle))) : all;
  const byCity = new Map<string, typeof clubs>();
  for (const c of clubs) {
    const key = c.city ?? "other";
    byCity.set(key, [...(byCity.get(key) ?? []), c]);
  }
  // A club anywhere: the ones outside the two cities with pages, by country in the reader's language,
  // each row naming its place. Clubs that named no country close the list.
  const byCountry = new Map<string, typeof clubs>();
  for (const c of byCity.get("other") ?? []) byCountry.set(c.country ?? "", [...(byCountry.get(c.country ?? "") ?? []), c]);
  const countries = [...byCountry.entries()].map(([code, list]) => ({ code, name: code ? countryName(code, locale) : t("club.elsewhere"), list })).sort((a, b) => (a.code === "" ? 1 : b.code === "" ? -1 : a.name.localeCompare(b.name, locale)));
  // Ten founding places in every city: for the places outside the two city pages, the count by the
  // place as typed, from the live clubs on this page (no second read).
  const placesLeft = (list: typeof clubs) => {
    const taken = new Map<string, { name: string; n: number }>();
    for (const c of list) {
      const k = (c.province ?? "").trim().toLowerCase();
      if (!k) continue;
      const cur = taken.get(k) ?? { name: c.province!.trim(), n: 0 };
      if (c.founding) cur.n++;
      taken.set(k, cur);
    }
    return [...taken.values()].map((p) => ({ name: p.name, left: Math.max(0, CLUB_LIMITS.foundingPerCity - p.n) }));
  };
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
          <form action="/clubs" method="get" className="mt-4 flex gap-2" role="search">
            <label className="sr-only" htmlFor="club-q">
              {t("club.searchLabel")}
            </label>
            <input id="club-q" name="q" defaultValue={q} className="input flex-1" placeholder={t("club.searchPlaceholder")} maxLength={60} data-testid="club-search" />
            <button type="submit" className="btn-secondary shrink-0">
              {t("club.searchLabel")}
            </button>
          </form>
          {q && clubs.length === 0 && <p className="mt-3 text-sm text-muted" data-testid="club-search-none">{t("club.searchNone")}</p>}
        </section>

        {hereEmpty && hereName && (
          <section className="card" data-testid="clubs-none-here">
            <p className="text-sm font-bold">{t("club.noneHere", { country: hereName })}</p>
            <p className="mt-1 text-sm text-muted">{t("club.noneHereCta")}</p>
            <Link href="/clubs/claim" prefetch={false} className="btn-secondary mt-3 w-full">
              {t("club.claimCta")}
            </Link>
          </section>
        )}

        <section className="card">
          <h2 className="text-lg font-extrabold">🌱 {t("club.founding")}</h2>
          <p className="mt-2 text-sm text-muted">{t("club.foundingBody")}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {hereEmpty && herePlace && (
              <span className="chip-muted" data-testid="founding-here">
                {t("club.foundingLeft", { count: CLUB_LIMITS.foundingPerCity, city: herePlace })}
              </span>
            )}
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

        {CITIES.map((c) => ({ key: c.slug, name: c.name, href: `/${c.slug}` })).map(({ key, name, href }) => {
          const list = byCity.get(key) ?? [];
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
        {countries.map(({ code, name, list }) => (
          <section key={code || "elsewhere"} className="card" data-testid="clubs-country">
            <h2 className="text-lg font-extrabold">{t("club.inCity", { city: name })}</h2>
            {code && (
              <div className="mt-2 flex flex-wrap gap-2">
                {placesLeft(list).map((p) => (
                  <span key={p.name} className="chip-muted">
                    {t("club.foundingLeft", { count: p.left, city: p.name })}
                  </span>
                ))}
              </div>
            )}
            <ul className="mt-3 flex flex-col gap-2">
              {list.map((c) => (
                <ClubRow key={c.slug} club={c} />
              ))}
            </ul>
          </section>
        ))}
      </main>
      <Footer />
    </>
  );
}
