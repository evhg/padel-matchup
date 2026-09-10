import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { CoachHome } from "@/components/coach/CoachHome";
import { CoachSetup } from "@/components/coach/CoachSetup";
import { Footer, Header } from "@/components/Header";
import { NameGate } from "@/components/NameGate";
import { SourceTag } from "@/components/SourceTag";
import { cleanSource } from "@/lib/source";
import { getDb } from "@/db";
import { baseUrl } from "@/lib/config";
import { zonedTimeToUtc } from "@/lib/dates";
import { coachLessonDTO, dayRange, labelsFor, slotDTOs, todayIn } from "@/lib/coach/view";
import { listOpenRequests, listWaitlist, monthCounts, monthRange } from "@/lib/coach/chains";
import { whenLabel } from "@/lib/coach/strings";
import { busyBetween, DAY_MS, earnedInvite, getCoachForActor, inviteCode, listCoachLessons, listStudents, openSlots, studentLink } from "@/lib/domain/coaching";
import { CoachHint } from "@/components/coach/CoachHint";
import { listLevelChecks } from "@/lib/domain/verify";
import { relativeTime } from "@/lib/dates";
import { getSessionPlayer } from "@/lib/session";
import { serviceAccountEmail } from "@/lib/coach/gcal";
import { telegramBotUsername } from "@/lib/telegram/api";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("coach");
  return { title: t("setup.title"), robots: { index: false, follow: false } };
}

type Props = { searchParams: Promise<{ welcome?: string; s?: string; club?: string; setup?: string }> };

/** The coach's book, or the four taps that create it. One screen, one job. */
export default async function CoachPage({ searchParams }: Props) {
  const db = await getDb();
  const [me, t, locale, sp] = await Promise.all([getSessionPlayer(db), getTranslations("coach"), getLocale(), searchParams]);
  const shell = (children: React.ReactNode) => (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2">{children}</main>
      <Footer />
    </>
  );
  // The door a coach came through (?s=citylist, club, coachpage, invite…) is remembered for a day and counted on setup.
  const tag = <SourceTag source={cleanSource(sp.s)} />;
  if (!me)
    return shell(
      <>
        {tag}
        <NameGate title={t("setup.nameTitle")} />
      </>,
    );
  const found = await getCoachForActor(db, me.id);
  // The setup walk stays on screen after the third step makes the assistant (?setup=1), so the calendar, payment and bot steps can follow.
  if (!found || sp.setup === "1")
    return shell(
      <>
        {tag}
        {!found && <CoachHint present={false} />}
        <CoachSetup initialClubs={(sp.club ?? "").slice(0, 80)} botUsername={telegramBotUsername()} serviceEmail={serviceAccountEmail()} existing={Boolean(found)} />
      </>,
    );

  const { coach } = found;
  const now = new Date();
  const today = todayIn(coach.tz, now);
  const days = dayRange(today, 14);
  const from = zonedTimeToUtc(today, "00:00", coach.tz);
  const to = new Date(from.getTime() + 14 * DAY_MS);
  const month = monthRange(coach.tz, now);
  const [rows, students, busy, requests, waiting, counts, checks, invite] = await Promise.all([listCoachLessons(db, coach.id, from, to), listStudents(db, coach.id, now), busyBetween(db, coach.id, now, to), listOpenRequests(db, coach.id, now), listWaitlist(db, coach.id, now), monthCounts(db, coach.id, month.from, month.to), listLevelChecks(db, { coachId: coach.id }), inviteCode(db, coach)]);
  // The invitation to pass the assistant on waits until it has earned it: a few students on the list, or a few lessons done, ever.
  const earned = earnedInvite(students);
  const monthLabel = new Intl.DateTimeFormat(locale, { month: "long", timeZone: coach.tz }).format(now);
  const labels = labelsFor(days, locale, today, { today: t("today"), tomorrow: t("tomorrow") });
  // The coach may book at short notice: no minimum notice on their own grid.
  const slots = openSlots({ coach: { ...coach, minNoticeHours: 0 }, from: now, to, busy, now });
  return shell(
    <>
      <CoachHint present />
      <CoachHome
        handle={coach.handle}
        coachName={coach.displayName}
        url={`${baseUrl()}/c/${coach.handle}`}
        studentUrl={studentLink(baseUrl(), coach.handle, invite)}
        earned={earned}
        today={today}
        welcome={sp.welcome === "1"}
        students={students.filter((s) => s.status !== "requested").map((s) => ({ id: s.player.id, name: s.player.displayName }))}
        lessons={rows.map((l) => coachLessonDTO(l, coach, locale, labels, now))}
        slots={slotDTOs(slots, coach.tz, locale)}
        dayLabels={labels}
        days={days}
        requests={requests.map((r) => ({ id: r.id, name: r.player.displayName, label: whenLabel(r.startsAt, coach.tz, locale), note: r.note }))}
        waiting={new Set(waiting.map((w) => w.studentPlayerId)).size}
        month={counts.done + counts.noShows > 0 ? { label: monthLabel, done: counts.done, noShows: counts.noShows } : null}
        levelChecks={checks.map((c) => ({ id: c.id, name: c.player.displayName, level: c.level, askedAgo: relativeTime(c.createdAt, locale, now) }))}
      />
    </>,
  );
}
