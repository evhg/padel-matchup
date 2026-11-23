import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { FilmCourt } from "@/components/FilmCourt";
import { Footer, Header } from "@/components/Header";
import { isValidShareCode } from "@/lib/codes";
import { baseUrl } from "@/lib/config";
import { jsonLdHtml } from "@/lib/jsonLd";
import { localeAlternates } from "@/lib/seo";

// Served under /ru and /es too, so the page is rendered per request rather than once in English at build time.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("film");
  const locale = await getLocale();
  const title = t("metaTitle");
  const description = t("metaDescription");
  return { title, description, alternates: localeAlternates("/film", locale), openGraph: { title, description, type: "article", url: `${baseUrl()}/film` } };
}

const STEPS = ["s1", "s2", "s3", "s4"] as const;

/**
 * How to film a padel match with one phone: four instructions, short enough to read at the court (the
 * owner's notes of 22 November 2026: the 3D court, the level service line, 4K at 60 as a step of its own).
 * It reads no database. `?m=<code>` is the match the player came from, and only makes the two links back.
 */
export default async function FilmPage({ searchParams }: { searchParams: Promise<{ m?: string | string[] }> }) {
  const t = await getTranslations("film");
  const tf = await getTranslations("feedback");
  const m = (await searchParams).m;
  const code = typeof m === "string" && isValidShareCode(m) ? m : null;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "HowTo",
    name: t("metaTitle"),
    description: t("metaDescription"),
    step: STEPS.map((s) => ({ "@type": "HowToStep", name: t(`${s}Title`), text: t(`${s}Body`) })),
  };
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdHtml(jsonLd) }} />
        {code && (
          <Link href={`/${code}`} prefetch={false} className="link px-1 text-sm font-semibold" data-testid="film-back">
            ← {t("back")}
          </Link>
        )}
        <section className="card">
          <h1 className="text-3xl font-extrabold leading-tight tracking-tight">{t("title")}</h1>
          <figure className="mt-4 overflow-hidden rounded-2xl bg-night">
            <FilmCourt className="block h-auto w-full" />
            <figcaption className="px-4 pb-3 text-center text-xs font-semibold text-white/80">{t("caption")}</figcaption>
          </figure>
          <ol className="mt-5 flex flex-col gap-4" data-testid="film-steps">
            {STEPS.map((s, i) => (
              <li key={s} className="flex gap-3">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-night text-sm font-extrabold text-accent">{i + 1}</span>
                <div>
                  <h2 className="font-extrabold leading-snug">{t(`${s}Title`)}</h2>
                  <p className="mt-0.5 text-sm text-muted">{t(`${s}Body`)}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
        <section className="card">
          <h2 className="text-lg font-extrabold">{t("afterTitle")}</h2>
          <p className="mt-1 text-sm text-muted">{t("afterBody", { feedback: tf("title") })}</p>
        </section>
        {code && (
          <Link href={`/${code}`} prefetch={false} className="btn-primary w-full" data-testid="film-got-it">
            {t("gotIt")}
          </Link>
        )}
      </main>
      <Footer />
    </>
  );
}
