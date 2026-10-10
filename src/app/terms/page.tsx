import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { Footer, Header } from "@/components/Header";
import { legalValues } from "@/lib/legal";
import { localeAlternates } from "@/lib/seo";

// Served under /ru and /es too, so the page is rendered per request rather than once in English at build time.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  const locale = await getLocale();
  return { title: t("terms.title"), description: t("terms.sub"), alternates: localeAlternates("/terms", locale) };
}

const SECTIONS = ["who", "free", "courts", "risk", "fair", "warranty", "law"] as const;

/** The terms of use: short and friendly, as the owner set them out on 9 October 2026. */
export default async function TermsPage() {
  const t = await getTranslations();
  const values = legalValues(await getLocale());
  return (
    <>
      <Header minimal />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight">{t("terms.title")}</h1>
          <p className="mt-1 text-muted">{t("terms.sub")}</p>
        </div>
        {SECTIONS.map((key) => (
          <section key={key} className="card">
            <h2 className="font-extrabold">{t(`terms.${key}Title`)}</h2>
            <p className="mt-1 whitespace-pre-line text-sm text-ink-soft">{t(`terms.${key}Body`, values)}</p>
          </section>
        ))}
        <div className="flex flex-wrap gap-2">
          <Link href="/feedback" prefetch={false} className="btn-secondary">
            {t("privacy.contactLink")}
          </Link>
          <Link href="/privacy" prefetch={false} className="btn-secondary">
            {t("terms.privacyLink")}
          </Link>
        </div>
        <p className="text-center text-xs text-faint">{t("privacy.updated", values)}</p>
      </main>
      <Footer />
    </>
  );
}
