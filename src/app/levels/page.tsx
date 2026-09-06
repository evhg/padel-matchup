import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Footer, Header } from "@/components/Header";
import { baseUrl } from "@/lib/config";
import { LEVEL_BANDS, LEVEL_PRESETS, LEVEL_SCALES, MATCH_K, TOURNAMENT_K, formatLevel, fromScale, type BandKey } from "@/lib/domain/levels";

export const dynamic = "force-static";
export const revalidate = 86400;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  const title = t("levels.title");
  const description = t("levels.metaDescription");
  return { title, description, alternates: { canonical: "/levels" }, openGraph: { title, description, type: "article", url: `${baseUrl()}/levels` } };
}

/** What a padel level number means, how it moves, and how to set yours. One page, the best answer to "what is my padel level". */
export default async function LevelsPage() {
  const t = await getTranslations();
  const bands: BandKey[] = ["starting", "beginner", "intermediate", "advanced", "expert", "pro"];
  const faq = [
    { q: t("levels.faq1q"), a: t("levels.faq1a") },
    { q: t("levels.faq2q"), a: t("levels.faq2a", { match: (MATCH_K).toFixed(2), tournament: TOURNAMENT_K.toFixed(2) }) },
    { q: t("levels.faq3q"), a: t("levels.faq3a") },
    { q: t("levels.faq4q"), a: t("levels.faq4a") },
  ];
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faq.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  };
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
        <section className="card">
          <span className="chip-muted">🎚️ {t("levels.eyebrow")}</span>
          <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight">{t("levels.title")}</h1>
          <p className="mt-2 text-sm text-muted">{t("levels.sub")}</p>
        </section>

        <section className="card">
          <h2 className="text-lg font-extrabold">{t("levels.scale")}</h2>
          <ul className="mt-3 flex flex-col divide-y divide-line">
            {bands.map((b) => {
              const band = LEVEL_BANDS.find((x) => x.key === b)!;
              return (
                <li key={b} className="flex gap-4 py-3">
                  <span className="w-20 shrink-0 text-lg font-extrabold tabular-nums">
                    {formatLevel(band.min)}–{formatLevel(band.max)}
                  </span>
                  <span>
                    <span className="block font-bold">{t(`level.bands.${b}`)}</span>
                    <span className="block text-sm text-muted">{t(`level.bandHelp.${b}`).replace(/^[\d.–]+\s·\s/, "")}</span>
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-xs text-faint">{t("levels.scaleNote")}</p>
        </section>

        <section className="card">
          <h2 className="text-lg font-extrabold">{t("levels.ranges")}</h2>
          <p className="mt-1 text-sm text-muted">{t("levels.rangesHelp")}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {LEVEL_PRESETS.map((p) => (
              <span key={p.key} className="chip-muted">
                {t(`level.${p.key}`)} · {formatLevel(p.min)}–{formatLevel(p.max)}
              </span>
            ))}
          </div>
        </section>

        <section className="card">
          <h2 className="text-lg font-extrabold">{t("passport.scalesTitle")}</h2>
          <p className="mt-1 text-sm text-muted">{t("passport.scalesHelp")}</p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-faint">
                  <th className="py-1 pr-3 font-bold">{t("passport.importScale")}</th>
                  <th className="py-1 pr-3 font-bold">{t("passport.scalesYours")}</th>
                  <th className="py-1 font-bold">{t("passport.scalesKicksmash")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {LEVEL_SCALES.map((s) => {
                  const samples = s.id === "playtomic" ? [1, 3.5, 6] : s.id === "ten" ? [1, 4, 7, 10] : [1, 2, 3, 4, 5];
                  return (
                    <tr key={s.id}>
                      <td className="py-2 pr-3 font-bold">{t(`passport.scale.${s.id}`)}</td>
                      <td className="py-2 pr-3 tabular-nums text-muted">{samples.join(" · ")}</td>
                      <td className="py-2 tabular-nums">{samples.map((v) => formatLevel(fromScale(s.id, v)!)).join(" · ")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card">
          <h2 className="text-lg font-extrabold">{t("levels.faqTitle")}</h2>
          <dl className="mt-2 flex flex-col gap-4">
            {faq.map((f) => (
              <div key={f.q}>
                <dt className="font-bold">{f.q}</dt>
                <dd className="mt-1 text-sm text-muted">{f.a}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="card">
          <h2 className="text-lg font-extrabold">{t("levels.ctaTitle")}</h2>
          <p className="mt-1 text-sm text-muted">{t("levels.ctaHelp")}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link href="/me" prefetch={false} className="btn-primary">
              {t("level.set")}
            </Link>
            <Link href="/" prefetch={false} className="btn-secondary">
              {t("common.newMatch")}
            </Link>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
