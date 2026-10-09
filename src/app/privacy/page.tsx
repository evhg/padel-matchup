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
  return { title: t("privacy.title"), description: t("privacy.sub"), alternates: localeAlternates("/privacy", locale) };
}

const SECTIONS = ["who", "store", "cookies", "ip", "helpers", "keep", "delete", "rights", "law"] as const;

/**
 * The privacy page in full, beside /about's short version. Every line is meant to be true of the code
 * as it runs: the figures come from the constants that enforce them (`legalValues`), and
 * `tests/legal.test.ts` checks the cookie names and the figures in all three languages. The contact is
 * the feedback form, never a person's name or address (owner's decision, 9 October 2026).
 */
export default async function PrivacyPage() {
  const t = await getTranslations();
  const values = legalValues(await getLocale());
  return (
    <>
      <Header minimal />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight">{t("privacy.title")}</h1>
          <p className="mt-1 text-muted">{t("privacy.sub")}</p>
        </div>
        {SECTIONS.map((key) => (
          <section key={key} className="card">
            <h2 className="font-extrabold">{t(`privacy.${key}Title`)}</h2>
            <p className="mt-1 whitespace-pre-line text-sm text-ink-soft">{t(`privacy.${key}Body`, values)}</p>
          </section>
        ))}
        <div className="flex flex-wrap gap-2">
          <Link href="/feedback" prefetch={false} className="btn-secondary">
            {t("privacy.contactLink")}
          </Link>
          <Link href="/terms" prefetch={false} className="btn-secondary">
            {t("privacy.termsLink")}
          </Link>
          <Link href="/about" prefetch={false} className="btn-secondary">
            {t("privacy.shortLink")}
          </Link>
        </div>
        <p className="text-center text-xs text-faint">{t("privacy.updated", values)}</p>
      </main>
      <Footer />
    </>
  );
}
