import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { JoinManager } from "@/components/coach/JoinManager";
import { Footer, Header } from "@/components/Header";
import { getDb } from "@/db";
import { coaches } from "@/db/schema";
import { claimManager } from "@/lib/coach/chains";
import { getSessionPlayer } from "@/lib/session";
import { and, eq, isNull } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("coach");
  return { title: t("managers.joinTitle"), robots: { index: false, follow: false } };
}

type Props = { params: Promise<{ code: string }> };

/** The manager link: a signed-in player joins at once; a newcomer gives a name first. */
export default async function JoinManagerPage({ params }: Props) {
  const { code } = await params;
  const db = await getDb();
  const clean = code.toLowerCase();
  const [coach] = await db.select({ displayName: coaches.displayName }).from(coaches).where(and(eq(coaches.managerCode, clean), isNull(coaches.archivedAt))).limit(1);
  const me = await getSessionPlayer(db);
  if (coach && me) {
    await claimManager(db, clean, me.id);
    redirect("/coach");
  }
  const t = await getTranslations("coach");
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2">
        {coach ? <JoinManager code={clean} coachName={coach.displayName} /> : <section className="card"><h1 className="text-2xl font-extrabold tracking-tight">{t("managers.joinGone")}</h1></section>}
      </main>
      <Footer />
    </>
  );
}
