import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { Footer, Header } from "@/components/Header";
import { SourceTag } from "@/components/SourceTag";
import { baseUrl } from "@/lib/config";
import { CITIES } from "@/lib/domain/cities";
import { localeAlternates } from "@/lib/seo";
import { COACH_SOURCE_COOKIE, cleanSource } from "@/lib/source";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const [t, locale] = await Promise.all([getTranslations("coachFront"), getLocale()]);
  const title = t("metaTitle");
  const description = t("metaDescription");
  return { title, description, alternates: localeAlternates("/coaches", locale), openGraph: { title, description, type: "website", url: `${baseUrl()}/coaches` } };
}

type Props = { searchParams: Promise<{ s?: string | string[] }> };

/**
 * The coach's front door: what changes for them, in their words, and one button.
 * Indexed in three languages; every place a coach can be seen points here, and
 * the door they came through (?s=) is counted when they set up.
 */
export default async function CoachesFrontPage({ searchParams }: Props) {
  const [t, sp] = await Promise.all([getTranslations("coachFront"), searchParams]);
  const source = cleanSource(sp.s);
  const start = source ? `/coach?s=${source}` : "/coach";
  const base = baseUrl();
  const tiles = ["t1", "t2", "t3", "t4", "t5", "t6"] as const;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: t("metaTitle"),
    description: t("metaDescription"),
    url: `${base}/coaches`,
    about: { "@type": "SoftwareApplication", name: "Kicksmash for coaches", applicationCategory: "BusinessApplication", operatingSystem: "Web", offers: { "@type": "Offer", price: "0", priceCurrency: "USD" } },
  };
  return (
    <>
      <Header />
      <SourceTag source={source} cookie={COACH_SOURCE_COOKIE} />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
        <section className="card">
          <span className="chip-muted">🎾 {t("eyebrow")}</span>
          <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight">{t("title")}</h1>
          <p className="mt-2 text-muted">{t("lead")}</p>
          <Link href={start} prefetch={false} className="btn-primary mt-4 w-full" data-testid="coach-front-cta">
            {t("cta")}
          </Link>
          <p className="mt-2 text-center text-xs text-muted">{t("ctaHelp")}</p>
        </section>
        <section className="grid gap-3">
          {tiles.map((k) => (
            <div key={k} className="card">
              <h2 className="font-extrabold">{t(`${k}Title`)}</h2>
              <p className="mt-1 text-sm text-ink-soft">{t(k)}</p>
            </div>
          ))}
        </section>
        <section className="card">
          <h2 className="font-extrabold">{t("telegramTitle")}</h2>
          <p className="mt-1 text-sm text-ink-soft">{t("telegram")}</p>
        </section>
        <section className="card">
          <h2 className="font-extrabold">{t("foundingTitle")}</h2>
          <p className="mt-1 text-sm text-ink-soft">{t("founding")}</p>
          <p className="mt-3 text-xs text-faint">
            {t("cities")}{" "}
            {CITIES.map((c) => (
              <Link key={c.slug} href={`/coaches/${c.slug}`} prefetch={false} className="mr-3 hover:text-muted">
                {c.name} →
              </Link>
            ))}
          </p>
        </section>
        <Link href={start} prefetch={false} className="btn-secondary w-full">
          {t("cta")}
        </Link>
      </main>
      <Footer />
    </>
  );
}
