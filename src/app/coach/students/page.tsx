import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations, getLocale } from "next-intl/server";
import { CoachStudents } from "@/components/coach/CoachStudents";
import { ImportSheet } from "@/components/coach/ImportSheet";
import { Footer, Header } from "@/components/Header";
import { getDb } from "@/db";
import { whenLabel } from "@/lib/coach/strings";
import { monthCounts, monthRange } from "@/lib/coach/chains";
import { getCoachForActor, listStudents, owedPerStudent, owedToCoach, packageLine } from "@/lib/domain/coaching";
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
  const t = await getTranslations("coach");
  const locale = await getLocale();
  // One at a time, not Promise.all: the pooler stalls on pipelined bursts (rule 8).
  const students = await listStudents(db, coach.id, now);
  const counts = await monthCounts(db, coach.id, month.from, month.to);
  // One join for every unpaid lesson on the book, bounded; the packages are already in `students`,
  // so what each student owes costs no query of its own (rule 12).
  const unpaidLessons = await owedToCoach(db, coach.id, 200);
  const thisMonth = new Map(counts.perStudent.map((p) => [p.playerId, p.done]));
  const owed = owedPerStudent(
    unpaidLessons,
    students.flatMap((s) => (s.activePackage && !s.activePackage.paidAt ? [{ studentPlayerId: s.player.id, amount: s.activePackage.amount }] : [])),
  );
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2">
        <Link href="/coach" prefetch={false} className="text-sm text-muted hover:text-ink">
          ← {t("home.title")}
        </Link>
        <CoachStudents
          handle={coach.handle}
          unpaid={unpaidLessons.map((l) => ({ lessonId: l.lessonId, studentPlayerId: l.studentPlayerId, label: whenLabel(l.startsAt, coach.tz, locale), amount: l.amount, claimed: Boolean(l.claimedAt), hasSlip: l.hasSlip }))}
          coachName={coach.displayName}
          currency={coach.currency}
          owed={Object.fromEntries(owed)}
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
