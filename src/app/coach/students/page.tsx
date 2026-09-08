import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { CoachStudents } from "@/components/coach/CoachStudents";
import { Footer, Header } from "@/components/Header";
import { getDb } from "@/db";
import { getCoachForActor, listStudents, packageLine } from "@/lib/domain/coaching";
import { getSessionPlayer } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("coach");
  return { title: t("students.title"), robots: { index: false, follow: false } };
}

export default async function CoachStudentsPage() {
  const db = await getDb();
  const me = await getSessionPlayer(db);
  const found = me ? await getCoachForActor(db, me.id) : null;
  if (!found) redirect("/coach");
  const { coach } = found;
  const now = new Date();
  const [students, t] = await Promise.all([listStudents(db, coach.id, now), getTranslations("coach")]);
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2">
        <Link href="/coach" prefetch={false} className="text-sm text-muted hover:text-ink">
          ← {t("home.title")}
        </Link>
        <CoachStudents
          coachName={coach.displayName}
          currency="THB"
          promptpayId={coach.promptpayId}
          payLink={coach.payLink}
          qrUrl={coach.qrAssetId ? `/c/${coach.handle}/qr` : null}
          students={students.map((s) => {
            const p = s.activePackage;
            const line = p ? packageLine(p, now) : null;
            return {
              playerId: s.player.id,
              name: s.player.displayName,
              status: s.status,
              lessonsDone: s.lessonsDone,
              pkg: p && line ? { id: p.id, left: line.left, size: p.size, days: line.daysLeft, amount: p.amount, currency: p.currency, paid: Boolean(p.paidAt) } : null,
            };
          })}
        />
      </main>
      <Footer />
    </>
  );
}
