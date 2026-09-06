import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { Footer, Header } from "@/components/Header";
import { MyMatches } from "@/components/MyMatches";
import { NameGate } from "@/components/NameGate";
import { RestoreWithEmail } from "@/components/RestoreWithEmail";
import { TelegramLogin } from "@/components/TelegramLogin";
import { getDb } from "@/db";
import { baseUrl, emailEnabled } from "@/lib/config";
import { getOrCreatePersonalToken } from "@/lib/domain/identity";
import { getSessionPlayer } from "@/lib/session";
import { clubStatus, listClubsClaimedBy } from "@/lib/domain/clubs";
import { PassportCard } from "@/components/PassportCard";
import Link from "next/link";
import { telegramBotId } from "@/lib/telegram/api";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t("me.title") };
}

type Props = { searchParams: Promise<{ telegram?: string }> };

export default async function MePage({ searchParams }: Props) {
  const db = await getDb();
  const [me, { telegram }] = await Promise.all([getSessionPlayer(db), searchParams]);
  // Back from Telegram: one line about how it went, nothing else changes.
  const note = telegram === "linked" ? "linked" : telegram === "invalid" ? "invalid" : null;

  if (!me) {
    const t = await getTranslations();
    return (
      <>
        <Header minimal />
        <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2">
          <h1 className="text-3xl font-extrabold tracking-tight">{t("me.title")}</h1>
          {note === "invalid" && <p className="rounded-2xl bg-danger-soft px-4 py-3 text-sm font-semibold text-danger">{t("telegram.invalid")}</p>}
          <NameGate title={t("me.noIdentity")} />
          {telegramBotId() && (
            <section className="card">
              <TelegramLogin botId={telegramBotId()!} linked={false} linkedUsername={null} lang={await getLocale()} authUrl={`${baseUrl()}/api/telegram/login`} />
            </section>
          )}
          {emailEnabled() && (
            <section className="card">
              <RestoreWithEmail />
            </section>
          )}
        </main>
        <Footer />
      </>
    );
  }

  const [token, myClubs, t] = await Promise.all([getOrCreatePersonalToken(db, me.id), listClubsClaimedBy(db, me.id), getTranslations()]);
  return (
    <>
      <Header minimal />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-5 px-4 pt-2">
        {note === "linked" && <p className="rounded-2xl bg-ok-soft px-4 py-3 text-sm font-semibold text-ok">✓ {t("telegram.justLinked")}</p>}
        {note === "invalid" && <p className="rounded-2xl bg-danger-soft px-4 py-3 text-sm font-semibold text-danger">{t("telegram.invalid")}</p>}
        <MyMatches player={me} personalToken={token} />
        <PassportCard publicOn={me.publicProfile} slug={me.publicSlug} base={baseUrl()} />
        {myClubs.length > 0 && (
          <section className="card">
            <h2 className="text-lg font-extrabold">{t("club.yourClubs")}</h2>
            <p className="mt-1 text-xs text-muted">{t("club.yourClubsHelp")}</p>
            <ul className="mt-3 flex flex-col gap-2">
              {myClubs.map((c) => {
                const status = clubStatus(c);
                return (
                  <li key={c.slug} className="flex items-center justify-between gap-3 rounded-2xl border border-line px-4 py-3">
                    <div className="min-w-0">
                      <div className="truncate font-bold">{c.name}</div>
                      <div className="text-xs text-muted">{status === "live" ? `✓ ${t("club.statusLive")}` : status === "rejected" ? t("club.statusRejected") : `⏳ ${t("club.statusPending")}`}</div>
                    </div>
                    <Link href={`/v/${c.slug}/manage/${c.manageToken}`} prefetch={false} className="btn-ghost btn-sm">
                      {t("common.edit")}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </main>
      <Footer />
    </>
  );
}
