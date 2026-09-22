import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { Db } from "@/db";
import { zonedTimeToUtc } from "@/lib/dates";
import { todayIn } from "@/lib/coach/view";
import { DAY_MS, listCoachLessons, coachCardGaps, hasPhoto, listOffers } from "@/lib/domain/coaching";
import type { Coach } from "@/db/schema";

/** On My matches, for a coach: the way back to the assistant, with today's count, above everything else. */
export async function CoachCard({ db, coach }: { db: Db; coach: Coach }) {
  const now = new Date();
  const from = zonedTimeToUtc(todayIn(coach.tz, now), "00:00", coach.tz);
  const [t, lessons, photos, offers] = await Promise.all([getTranslations("coach"), listCoachLessons(db, coach.id, from, new Date(from.getTime() + DAY_MS)), hasPhoto(db, [coach.id]), listOffers(db, coach.id)]);
  const today = lessons.filter((l) => l.status === "booked" || l.status === "done").length;
  // A coach opens My matches as often as their book. One line here, the whole notice on /coach.
  const gaps = coach.isPublic ? coachCardGaps(coach, { photo: photos.has(coach.id), offers }) : [];
  return (
    <section className="card flex items-center justify-between gap-3" data-testid="coach-card">
      <div className="min-w-0">
        <div className="text-lg font-extrabold">🎾 {t("me.assistant")}</div>
        <div className="text-sm text-muted">{t("me.assistantToday", { count: today })}</div>
        {gaps.length > 0 && (
          <div className="mt-1 text-sm font-bold text-warn" data-testid="coach-card-gaps">
            {t("me.gapLine", { count: gaps.length })}
          </div>
        )}
      </div>
      <Link href="/coach" prefetch={false} className="btn-primary btn-sm shrink-0">
        {t("me.assistantOpen")} →
      </Link>
    </section>
  );
}
