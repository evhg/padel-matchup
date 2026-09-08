import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { CoachStudents } from "@/components/coach/CoachStudents";
import { ImportSheet } from "@/components/coach/ImportSheet";
import { Footer, Header } from "@/components/Header";
import { getDb } from "@/db";
import { monthCounts, monthRange } from "@/lib/coach/chains";
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
  const month = monthRange(coach.tz, now);
  const [students, t, counts] = await Promise.all([listStudents(db, coach.id, now), getTranslations("coach"), monthCounts(db, coach.id, month.from, month.to)]);
  const thisMonth = new Map(counts.perStudent.map((p) => [p.playerId, p.done]));
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
              thisMonth: thisMonth.get(s.player.id) ?? 0,
              pkg: p && line ? { id: p.id, left: line.left, size: p.size, days: line.daysLeft, amount: p.amount, currency: p.currency, paid: Boolean(p.paidAt) } : null,
            };
          })}
        />
        <ImportSheet />
      </main>
      <Footer />
    </>
  );
}
