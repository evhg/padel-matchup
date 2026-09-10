import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import type { Db } from "@/db";
import { dayRange, labelsFor, studentLessonDTO, todayIn } from "@/lib/coach/view";
import { listStudentLessons, packageLine, studentCoaches } from "@/lib/domain/coaching";

/** On My matches: the lessons a player has with their coach, and the quiet door to the coach's own book. */
export async function MyLessons({ db, playerId, asCoach }: { db: Db; playerId: string; asCoach: boolean }) {
  const now = new Date();
  const [t, locale, mine, lessons] = await Promise.all([getTranslations("coach"), getLocale(), studentCoaches(db, playerId, now), listStudentLessons(db, playerId, now)]);
  return (
    <>
      {mine.length > 0 && (
        <section className="card">
          <h2 className="text-lg font-extrabold">{t("me.title")}</h2>
          <ul className="mt-3 flex flex-col gap-3">
            {mine.map(({ coach, status, activePackage }) => {
              const today = todayIn(coach.tz, now);
              const labels = labelsFor(dayRange(today, 60), locale, today, { today: t("today"), tomorrow: t("tomorrow") });
              const line = activePackage ? packageLine(activePackage, now) : null;
              const upcoming = lessons.filter((l) => l.coachId === coach.id && l.status === "booked").map((l) => studentLessonDTO(l, locale, labels, now));
              return (
                <li key={coach.id} className="rounded-2xl border border-line px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-bold">{t("me.with", { name: coach.displayName })}</div>
                      <div className="text-xs text-muted">
                        {status === "requested" ? t("me.requested") : line ? (line.daysLeft === null ? t("packageLineNoExpiry", { left: line.left, size: activePackage!.size }) : t("packageLine", { left: line.left, size: activePackage!.size, days: line.daysLeft })) : t("noPackage")}
                      </div>
                    </div>
                    <Link href={`/c/${coach.handle}`} prefetch={false} className="btn-ghost btn-sm shrink-0">
                      {t("me.book")}
                    </Link>
                  </div>
                  {upcoming.length > 0 && (
                    <ul className="mt-2 flex flex-col gap-1 text-sm">
                      {upcoming.slice(0, 5).map((l) => (
                        <li key={l.id}>🎾 {l.label}</li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {!asCoach && (
        <p className="text-center text-xs text-faint">
          <Link href="/coach" prefetch={false} className="hover:text-muted">
            {t("me.coachLine")} →
          </Link>
        </p>
      )}
    </>
  );
}
