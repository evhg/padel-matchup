import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { FeedbackForm } from "@/components/FeedbackForm";
import { Footer, Header } from "@/components/Header";
import { getDb } from "@/db";
import { localeAlternates } from "@/lib/seo";
import { getSessionPlayer } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const [t, locale] = await Promise.all([getTranslations("feedback"), getLocale()]);
  return { title: t("title"), description: t("sub"), alternates: localeAlternates("/feedback", locale) };
}

/** Where anyone tells us what should change. The loop that ships it tells them what changed. */
export default async function FeedbackPage() {
  const t = await getTranslations("feedback");
  let via: "telegram" | "none" = "none";
  try {
    const player = await getSessionPlayer(await getDb());
    if (player?.telegramId) via = "telegram";
  } catch {
    via = "none";
  }
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12">
        <section className="card">
          <h1 className="text-2xl font-extrabold">💬 {t("title")}</h1>
          <p className="mt-2 text-sm text-muted">{t("sub")}</p>
        </section>
        <FeedbackForm signedInVia={via} />
      </main>
      <Footer />
    </>
  );
}
