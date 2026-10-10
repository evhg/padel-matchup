import type { Metadata } from "next";
import Link from "next/link";
import { localeAlternates } from "@/lib/seo";
import { getLocale, getTranslations } from "next-intl/server";
import { Footer, Header } from "@/components/Header";
import { emailFrom } from "@/lib/config";

// Served under /ru and /es too, so the page is rendered per request rather than once in English at build time.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  const locale = await getLocale();
  return { title: t("about.title"), alternates: localeAlternates("/about", locale) };
}

/** The fine print: privacy, terms, open source, and KicksmashBot (the reader of court times). Short, honest, slightly cheeky. */
export default async function AboutPage() {
  const t = await getTranslations();
  const contact = emailFrom().match(/<([^>]+)>/)?.[1] ?? emailFrom();
  // The promise and the terms each lead on to the page that says them in full.
  const sections: { key: "store" | "never" | "cookies" | "rights" | "terms" | "open"; more?: { href: "/privacy" | "/terms"; label: "about.privacyLink" | "about.termsLink" } }[] = [
    { key: "store" },
    { key: "never", more: { href: "/privacy", label: "about.privacyLink" } },
    { key: "cookies" },
    { key: "rights" },
    { key: "terms", more: { href: "/terms", label: "about.termsLink" } },
    { key: "open" },
  ];
  return (
    <>
      <Header minimal />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight">{t("about.title")}</h1>
          <p className="mt-1 text-muted">{t("about.sub")}</p>
        </div>
        {sections.map(({ key, more }) => (
          <section key={key} className="card">
            <h2 className="font-extrabold">{t(`about.${key}Title`)}</h2>
            <p className="mt-1 whitespace-pre-line text-sm text-ink-soft">{t(`about.${key}Body`)}</p>
            {more && (
              <Link href={more.href} prefetch={false} className="link mt-2 inline-block text-sm">
                {t(more.label)}
              </Link>
            )}
          </section>
        ))}
        {/* The User-Agent every booking platform sees names this page (DECIDING rule 35): what the bot reads, how often, that it stops, and where to write. */}
        <section id="bot" className="card">
          <h2 className="font-extrabold">{t("about.botTitle")}</h2>
          <p className="mt-1 text-sm text-ink-soft">{t("about.botBody")}</p>
          <a className="link mt-1 inline-block text-sm" href={`mailto:${contact}`}>
            {contact}
          </a>
        </section>
        <section className="card">
          <h2 className="font-extrabold">💬 {t("feedback.title")}</h2>
          <p className="mt-1 text-sm text-ink-soft">{t("feedback.sub")}</p>
          <Link href="/feedback" prefetch={false} className="btn-secondary mt-3 self-start">
            {t("feedback.footerLink")} →
          </Link>
        </section>
        <p className="text-center text-xs text-faint">
          {t("about.contact")}{" "}
          <a className="link" href={`mailto:${contact}`}>
            {contact}
          </a>
        </p>
      </main>
      <Footer />
    </>
  );
}
