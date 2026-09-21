import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { formatEventDay, formatEventTime } from "@/lib/dates";
import { formatLevel } from "@/lib/domain/levels";

/** What a player needs to choose between two coaches, in the order they ask for it. */
export type CoachCardData = {
  handle: string;
  displayName: string;
  clubNames: string[];
  languages: string[];
  lessonMinutes: number;
  bio: string | null;
  founding: boolean;
  /** The lowest of the coach's single-lesson prices, and its currency. Null: packages only, or none set. */
  priceFrom: number | null;
  /** Where there is no single price: the cheapest hour inside a package, and that package's size. */
  packageFrom: { each: number; size: number } | null;
  currency: string;
  /** The first hour they are free, or null. Null also when a stranger cannot take that hour. */
  nextFree: string | null;
  tz: string;
  /** A stranger can pick an hour here today. Off: they must ask the coach and be accepted first. */
  canBookNow: boolean;
  /** Anyone may book without asking first. */
  openBooking: boolean;
  levels: { min: number | null; max: number | null };
  /** A face, served from `/c/{handle}/photo`. */
  photo: boolean;
  /** The part of the card the coach cannot write: since when, and lessons actually given. */
  proof: { since: string; lessonsDone: number | null } | null;
};

const languageName = (code: string) => (code === "ru" ? "Русский" : code === "es" ? "Español" : "English");
const formatMonth = (d: Date, locale: string) => new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(d);

/**
 * One coach in a list. It used to carry a name, a lesson length, a club and a language — and three
 * coaches read exactly alike, so a player had no way to choose. The price, the next free hour and
 * the levels are what they actually compare on, so those are on the card and not two taps away.
 */
export async function CoachListCard({ coach, locale, foundingCity }: { coach: CoachCardData; locale: string; foundingCity?: string | null }) {
  const [t, tCoach] = await Promise.all([getTranslations("coaches"), getTranslations("coach")]);
  const free = coach.nextFree ? new Date(coach.nextFree) : null;
  const levels = coach.levels.min != null || coach.levels.max != null;
  return (
    <li className="card flex flex-col gap-2" data-testid="coach-list-card">
      <div className="flex flex-wrap items-center gap-2">
        {coach.founding && foundingCity && <span className="chip-muted">🏅 {tCoach("page.founding", { city: foundingCity })}</span>}
        {coach.openBooking && <span className="chip-open">⚡ {t("cardOpenBooking")}</span>}
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="flex min-w-0 items-center gap-2 text-xl font-extrabold tracking-tight">
          {/* A player told us they were "gambling on a profile picture" — and this card did not even
              have the picture. The initial is a placeholder, never a stock face. */}
          {coach.photo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`/c/${coach.handle}/photo`} alt="" width={40} height={40} className="size-10 shrink-0 rounded-full object-cover" loading="lazy" data-testid="card-photo" />
          ) : (
            <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-full bg-bg text-base font-extrabold text-faint">{coach.displayName.slice(0, 1).toUpperCase()}</span>
          )}
          <span className="truncate">{coach.displayName}</span>
        </h3>
        {/* A price is a number or it is nothing. This slot has already printed the lesson length
            twice, and then sent a reader to a page that had no price on it either. If the coach
            sells only packages, the hour inside the cheapest one is a real number, so say that. */}
        {coach.priceFrom != null ? (
          <span className="shrink-0 text-sm font-extrabold tabular-nums">{t("cardFrom", { amount: `${coach.priceFrom} ${coach.currency}` })}</span>
        ) : coach.packageFrom ? (
          <span className="shrink-0 text-right text-sm font-extrabold tabular-nums">{t("cardFromPackage", { amount: `${coach.packageFrom.each} ${coach.currency}` })}</span>
        ) : null}
      </div>
      {/* The three lines a player reads before they choose: where, who it is for, and when they are free. */}
      <p className="text-sm text-muted">
        {coach.clubNames.length ? `${tCoach("page.at", { clubs: coach.clubNames.join(", ") })} · ` : ""}
        {tCoach("page.lesson", { minutes: coach.lessonMinutes })} · {coach.languages.map(languageName).join(", ")}
      </p>
      {levels && (
        <p className="text-sm text-muted" data-testid="card-levels">
          🎚️ {t("cardLevels", { levels: coach.levels.min != null && coach.levels.max != null ? `${formatLevel(coach.levels.min)}–${formatLevel(coach.levels.max)}` : coach.levels.min != null ? `${formatLevel(coach.levels.min)}+` : `≤ ${formatLevel(coach.levels.max!)}` })}
        </p>
      )}
      {/* Only a coach a stranger can book gets a free hour named here. The card used to promise an
          hour for a coach whose page then showed a stranger no times at all. */}
      <p className={`text-sm font-bold ${free ? "text-ok" : "text-muted"}`} data-testid="card-next-free">
        {!coach.canBookNow ? t("cardAsk") : free ? t("cardNextFree", { when: `${formatEventDay(free, coach.tz, locale)} ${formatEventTime(free, coach.tz, locale)}` }) : t("cardNoFree")}
      </p>
      {coach.bio && <p className="text-sm" data-testid="card-bio">{coach.bio}</p>}
      {/* Nothing here is typed by the coach, which is the point: it is the only line on the card a
          coach cannot dress up, and it was the missing answer to "is this real or three test rows?" */}
      {coach.proof && (
        <p className="text-xs text-faint" data-testid="card-proof">
          {t("cardSince", { month: formatMonth(new Date(coach.proof.since), locale) })}
          {coach.proof.lessonsDone != null ? ` · ${t("cardLessonsDone", { count: coach.proof.lessonsDone })}` : ""}
        </p>
      )}
      <Link href={`/c/${coach.handle}`} prefetch={false} className="btn-secondary w-full">
        {t(coach.openBooking ? "cardBook" : "open", { name: coach.displayName })}
      </Link>
    </li>
  );
}
