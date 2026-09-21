import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { CoachHome } from "@/components/coach/CoachHome";
import { CoachSetup } from "@/components/coach/CoachSetup";
import { FeedbackInline } from "@/components/FeedbackInline";
import { Footer, Header } from "@/components/Header";
import { NameGate } from "@/components/NameGate";
import { SourceTag } from "@/components/SourceTag";
import { COACH_SOURCE_COOKIE, cleanSource } from "@/lib/source";
import { getDb } from "@/db";
import { listClubsForPicking } from "@/lib/domain/clubs";
import { baseUrl } from "@/lib/config";
import { zonedTimeToUtc } from "@/lib/dates";
import { coachLessonDTO, dayRange, labelsFor, slotDTOs, todayIn } from "@/lib/coach/view";
import { listOpenRequests, listWaitlist, monthCounts, monthRange } from "@/lib/coach/chains";
import { whenLabel } from "@/lib/coach/strings";
import { busyBetween, DAY_MS, earnedInvite, getCoachForActor, inviteCode, listCoachLessons, listStudents, openingsBetween, openSlots, studentLink } from "@/lib/domain/coaching";
import { listLevelChecks } from "@/lib/domain/verify";
import { relativeTime } from "@/lib/dates";
import { getSessionPlayer } from "@/lib/session";
import { playerTicket } from "@/lib/coach/link";
import { botDeepLink } from "@/lib/telegram/bot";
import { telegramBotUsername } from "@/lib/telegram/api";
import { CoachNotify } from "@/components/coach/CoachNotify";
import { reachFor } from "@/lib/coach/reach";
import { emailEnabled } from "@/lib/config";
import { lineEnabled } from "@/lib/line/api";
import { whatsappEnabled } from "@/lib/whatsapp/api";

/** The channels built and waiting on their accounts, named on the channel step. Empty once they are live. */
const waitingChannels = () => [lineEnabled() ? null : "LINE", whatsappEnabled() ? null : "WhatsApp"].filter((x): x is string => Boolean(x));
import { playerHasPush } from "@/lib/domain/push";
import { pushEnabled, vapidPublicKey } from "@/lib/push";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("coach");
  return { title: t("setup.title"), robots: { index: false, follow: false } };
}

type Props = { searchParams: Promise<{ welcome?: string; s?: string | string[]; club?: string | string[]; setup?: string }> };

/** The coach's book, or the four taps that create it. One screen, one job. */
export default async function CoachPage({ searchParams }: Props) {
  const db = await getDb();
  const [me, t, locale, sp] = await Promise.all([getSessionPlayer(db), getTranslations("coach"), getLocale(), searchParams]);
  const shell = (children: React.ReactNode) => (
    <>
      <Header current="coach" />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2">
        {children}
        <FeedbackInline variant="card" signedInVia={me?.telegramId ? "telegram" : "none"} />
      </main>
      <Footer />
    </>
  );
  // The door a coach came through (?s=citylist, club, coachpage, invite…) is remembered for a day and counted on setup.
  const tag = <SourceTag source={cleanSource(sp.s)} cookie={COACH_SOURCE_COOKIE} />;
  if (!me)
    return shell(
      <>
        {tag}
        <NameGate title={t("setup.nameTitle")} />
      </>,
    );
  const found = await getCoachForActor(db, me.id);
  // The setup walk stays on screen after the third step makes the assistant (?setup=1), so the price,
  // the notification channel and the student link can follow without a reload losing the walk.
  if (!found || sp.setup === "1") {
    // Sequential, not parallel: the pooler stalls on pipelined bursts (rule 8). Both are bounded and indexed.
    // Every club a person can pick, listed or claimed — a coach names where they teach, and the name
    // has to be one a club page can match (rule: the slug is the address).
    const clubOptions = (await listClubsForPicking(db)).map((c) => ({ slug: c.slug, name: c.name, city: c.city }));
    const resumedLink = found ? studentLink(baseUrl(), found.coach.handle, await inviteCode(db, found.coach)) : null;
    const hasPush = pushEnabled() ? await playerHasPush(db, me.id) : false;
    return shell(
      <>
        {tag}
        <CoachSetup
          initialClubs={((Array.isArray(sp.club) ? sp.club[0] : sp.club) ?? "").slice(0, 80)}
          clubOptions={clubOptions}
          botUsername={telegramBotUsername()}
          botUrl={botDeepLink(`coach_${playerTicket(me)}`)}
          existing={Boolean(found)}
          studentUrl={resumedLink}
          email={me.email}
          emailEnabled={emailEnabled()}
          vapidPublicKey={vapidPublicKey()}
          pushSubscribed={hasPush}
          waitingChannels={waitingChannels()}
        />
      </>,
    );
  }

  const { coach } = found;
  // A book nobody can hear from is not a book. Coaches who finished the walk before the channel step
  // existed land here, and the same screen a new coach gets stands in the way until one is picked.
  //
  // The coach only, never a manager: a manager runs somebody else's bookings and cannot set the
  // coach's channel, so standing this in their way would block a book that is already reachable.
  const reach = found.role === "coach" ? await reachFor(db, me) : null;
  if (reach && !reach.any)
    return shell(
      <>
        {tag}
        <CoachNotify
          botUsername={telegramBotUsername()}
          botUrl={botDeepLink(`coach_${playerTicket(me)}`)}
          email={me.email}
          emailEnabled={emailEnabled()}
          vapidPublicKey={vapidPublicKey()}
          pushSubscribed={false}
          waiting={waitingChannels()}
          gate
        />
      </>,
    );
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
  // Sequential, after the burst above: the pooler stalls on pipelined bursts (rule 8).
  const openings = await openingsBetween(db, coach.id, now, to);
  const slots = openSlots({ coach: { ...coach, minNoticeHours: 0 }, from: now, to, busy, now, openings });
  const second = coach.secondMinutes && coach.secondMinutes !== coach.lessonMinutes ? coach.secondMinutes : null;
  const slotsSecond = second ? openSlots({ coach: { ...coach, minNoticeHours: 0 }, from: now, to, busy, now, openings, minutes: second }) : [];
  return shell(
    <>
      <CoachHome
        handle={coach.handle}
        coachName={coach.displayName}
        url={`${baseUrl()}/c/${coach.handle}`}
        inviteUrl={`${baseUrl()}/coaches/join?s=invite`}
        studentUrl={studentLink(baseUrl(), coach.handle, invite)}
        earned={earned}
        lengths={[coach.lessonMinutes, ...(second ? [second] : [])]}
        slotsSecond={slotDTOs(slotsSecond, coach.tz, locale)}
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
