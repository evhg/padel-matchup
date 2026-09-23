import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { getDb } from "@/db";
import { FeedbackInline } from "@/components/FeedbackInline";
import { Footer, Header } from "@/components/Header";
import { listBuilt } from "@/lib/feedback/store";
import { localeAlternates } from "@/lib/seo";

// New lines arrive whenever a note ships, and the page is served under /ru and /es too.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("feedback");
  const locale = await getLocale();
  return { title: t("builtTitle"), description: t("builtIntro"), alternates: localeAlternates("/built", locale) };
}

/**
 * Ideas that became the app: the proof behind "Kicksmash is built by the players on it".
 *
 * Each line is the summary whoever shipped the note wrote (`feedback.public_summary`), and when it
 * shipped. Never the note's own words and never a name, decided 23 September 2026: a note can be
 * crude, a joke or malicious, and it was written to us, not for a public page. A shipped note without
 * a summary is simply not here yet.
 */
export default async function BuiltPage() {
  const t = await getTranslations("feedback");
  const locale = await getLocale();
  const items = await listBuilt(await getDb()).catch(() => []);
  const day = new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  return (
    <>
      <Header minimal />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-balance">{t("builtTitle")}</h1>
          <p className="mt-1 text-muted">{t("builtIntro")}</p>
        </div>
        {items.length === 0 ? (
          <p className="card text-sm text-muted" data-testid="built-empty">
            {t("builtEmpty")}
          </p>
        ) : (
          <ol className="card flex flex-col divide-y divide-line" data-testid="built-list">
            {items.map((item, i) => (
              <li key={i} className="py-3 first:pt-0 last:pb-0">
                <p className="font-semibold">{item.summary}</p>
                <p className="mt-0.5 text-xs text-faint">{t("builtSince", { date: day.format(item.shippedAt) })}</p>
              </li>
            ))}
          </ol>
        )}
        <FeedbackInline variant="card" signedInVia="none" />
      </main>
      <Footer />
    </>
  );
}
