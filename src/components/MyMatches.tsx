import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import type { Player } from "@/db/schema";
import { getDb } from "@/db";
import { calendarTitle } from "@/lib/calendar";
import { baseUrl, emailEnabled } from "@/lib/config";
import { formatEventDay, formatEventTime } from "@/lib/dates";
import { playerHasPush } from "@/lib/domain/push";
import { getPlayerEvents, type MyEvent } from "@/lib/domain/queries";
import { vapidPublicKey } from "@/lib/push";
import { venueWithCourt } from "@/lib/labels";
import { personalPath, personalUrl } from "@/lib/personal";
import { HomeScreenPrompt } from "./HomeScreenPrompt";
import { NameEditor } from "./NameEditor";
import { PersonalLinkCard } from "./PersonalLinkCard";
import { PushToggle } from "./PushToggle";
import { RestoreWithEmail } from "./RestoreWithEmail";

/** "My matches": rendered on /me (cookie identity) and /p/{token} (personal link). */
export async function MyMatches({ player, personalToken }: { player: Player; personalToken: string }) {
  const [t, locale, db] = await Promise.all([getTranslations(), getLocale(), getDb()]);
  const [{ upcoming, past }, hasPush] = await Promise.all([getPlayerEvents(db, player.id), playerHasPush(db, player.id)]);
  const hasHistory = upcoming.length > 0 || past.length > 0;
  const labelOpts = { venueTbd: t("event.venueTbd"), courtNumber: (n: string) => t("event.courtNumber", { n }) };

  const row = (m: MyEvent) => {
    const ev = m.event;
    const title = calendarTitle(ev, t(ev.type === "match" ? "event.match" : "event.tournament"));
    const isWaitlist = m.slot.position > ev.capacity;
    const score = m.scores.map((s) => `${s.sideA}-${s.sideB}`).join("  ");
    const outcomeChip =
      ev.status === "cancelled" ? (
        <span className="chip-danger">{t("me.cancelled")}</span>
      ) : m.placement ? (
        <span className={m.placement === 1 ? "chip-open" : "chip-muted"}>{t("me.placement", { place: m.placement, total: ev.standings?.length ?? m.playerCount })}</span>
      ) : m.outcome === "won" ? (
        <span className="chip-open">{t("score.won")}</span>
      ) : m.outcome === "lost" ? (
        <span className="chip-muted">{t("score.lost")}</span>
      ) : m.outcome === "draw" ? (
        <span className="chip-muted">{t("score.draw")}</span>
      ) : null;
    return (
      <li key={ev.id}>
        <Link href={`/${ev.code}`} prefetch={false} className="card flex items-center gap-4 py-4 hover:border-ink/30">
          <div className="w-14 shrink-0 text-center">
            <div className="text-xs font-bold uppercase text-faint">{formatEventDay(ev.startsAt, ev.tz, locale).split(" ").slice(0, 1)}</div>
            <div className="text-2xl font-extrabold leading-none tabular-nums">{formatEventTime(ev.startsAt, ev.tz, locale)}</div>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="truncate font-bold">{title}</span>
              {m.isCreator && <span className="chip-muted">{t("me.organizer")}</span>}
              {isWaitlist && <span className="chip-full">{t("me.waitlist")}</span>}
            </div>
            <div className="truncate text-sm text-muted">
              {formatEventDay(ev.startsAt, ev.tz, locale)} · {venueWithCourt(ev, labelOpts)}
            </div>
            {m.scores.length > 0 ? (
              <div className="mt-1 flex items-center gap-2">
                <span className="font-extrabold tabular-nums">{score}</span>
                {outcomeChip}
              </div>
            ) : (
              <div className="mt-1 flex items-center gap-2 text-sm text-faint">
                {ev.startsAt.getTime() <= Date.now() && ev.status !== "cancelled" ? t("me.noScore") : t("event.players", { count: m.playerCount, capacity: ev.capacity })}
                {outcomeChip}
              </div>
            )}
          </div>
          <span className="text-faint">›</span>
        </Link>
      </li>
    );
  };

  return (
    <>
      <h1 className="text-3xl font-extrabold tracking-tight">{t("me.title")}</h1>

      {!hasHistory ? (
        <section className="card text-center">
          <p className="text-muted">{t("me.empty")}</p>
          <Link href="/" prefetch={false} className="btn-primary mt-4 w-full">
            {t("me.emptyCta")}
          </Link>
        </section>
      ) : (
        <>
          <section>
            <h2 className="mb-2 text-sm font-extrabold uppercase tracking-wider text-muted">{t("me.upcoming")}</h2>
            {upcoming.length ? <ul className="flex flex-col gap-2">{upcoming.map(row)}</ul> : <p className="text-sm text-faint">—</p>}
          </section>
          <section>
            <h2 className="mb-2 text-sm font-extrabold uppercase tracking-wider text-muted">{t("me.past")}</h2>
            {past.length ? <ul className="flex flex-col gap-2">{past.map(row)}</ul> : <p className="text-sm text-faint">—</p>}
          </section>
          <Link href="/" prefetch={false} className="btn-primary w-full">
            {t("common.newMatch")}
          </Link>
        </>
      )}

      <section className="card">
        <PushToggle vapidPublicKey={vapidPublicKey()} subscribed={hasPush} />
      </section>
      <PersonalLinkCard url={personalUrl(baseUrl(), personalToken)} email={player.email} emailEnabled={emailEnabled()} />
      <HomeScreenPrompt personalPath={personalPath(personalToken)} installed={Boolean(player.homescreenAt)} />
      <section className="card">
        <NameEditor name={player.displayName} />
        <p className="mt-2 text-xs text-faint">{t("me.identityHelp")}</p>
      </section>

      {!hasHistory && emailEnabled() && (
        <section className="card">
          <RestoreWithEmail initialEmail={player.email ?? ""} />
        </section>
      )}
    </>
  );
}
