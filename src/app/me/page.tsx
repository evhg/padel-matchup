import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Footer, Header } from "@/components/Header";
import { MyMatches } from "@/components/MyMatches";
import { NameGate } from "@/components/NameGate";
import { RestoreWithEmail } from "@/components/RestoreWithEmail";
import { getDb } from "@/db";
import { emailEnabled } from "@/lib/config";
import { getOrCreatePersonalToken } from "@/lib/domain/identity";
import { getSessionPlayer } from "@/lib/session";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t("me.title") };
}

export default async function MePage() {
  const db = await getDb();
  const me = await getSessionPlayer(db);

  if (!me) {
    const t = await getTranslations();
    return (
      <>
        <Header minimal />
        <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2">
          <h1 className="text-3xl font-extrabold tracking-tight">{t("me.title")}</h1>
          <NameGate title={t("me.noIdentity")} />
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

  const token = await getOrCreatePersonalToken(db, me.id);
  return (
    <>
      <Header minimal />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-5 px-4 pt-2">
        <MyMatches player={me} personalToken={token} />
      </main>
      <Footer />
    </>
  );
}
