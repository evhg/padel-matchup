import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { CalendarSubscribe } from "@/components/CalendarSubscribe";
import { Footer, Header } from "@/components/Header";
import { getDb } from "@/db";
import { feedLinks, playerForFeedKey } from "@/lib/calendarFeed";
import { baseUrl } from "@/lib/config";
import { telegramEnabled } from "@/lib/telegram/api";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("calendar");
  return { title: t("feedTitle"), robots: { index: false, follow: false } };
}

/**
 * Where a chat's "📅 Add to calendar" button lands. A chat button can only open an https page, and
 * subscribing needs a `webcal:` link or Google's own page, so this is the one step between them. It
 * knows the feed's key and nothing else: nobody is signed in here, which is why a forwarded message
 * that carries this address hands over a calendar and never an identity.
 */
export default async function CalendarFeedPage({ params }: { params: Promise<{ token: string }> }) {
  const { token: key } = await params;
  const db = await getDb();
  const player = await playerForFeedKey(db, key);
  const t = await getTranslations("calendar");
  const links = feedLinks(baseUrl(), key);
  return (
    <>
      <Header minimal />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2">
        <section className="card" data-testid="calendar-feed-page">
          <h1 className="text-xl font-extrabold">📅 {t("feedTitle")}</h1>
          {player ? (
            <>
              <p className="mt-1 text-sm text-muted">{t("feedLead")}</p>
              {/* Telegram carries a match's changes on Android, where the calendar app cannot subscribe; WhatsApp does not send them yet. */}
              <CalendarSubscribe webcal={links.webcal} google={links.google} chat={telegramEnabled() && player.telegramId != null} />
            </>
          ) : (
            <p className="mt-1 text-sm text-muted">{t("feedGone")}</p>
          )}
        </section>
      </main>
      <Footer />
    </>
  );
}
