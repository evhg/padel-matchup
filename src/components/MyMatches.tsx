import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import type { Player } from "@/db/schema";
import { getDb } from "@/db";
import { calendarTitle } from "@/lib/calendar";
import { baseUrl, emailEnabled } from "@/lib/config";
import { formatEventDay, formatEventTime } from "@/lib/dates";
import { playerHasPush } from "@/lib/domain/push";
import { getPlayerGroups } from "@/lib/domain/groups";
import { getPlayerEvents, type MyEvent } from "@/lib/domain/queries";
import { vapidPublicKey } from "@/lib/push";
import { venueWithCourt } from "@/lib/labels";
import { personalPath, personalUrl } from "@/lib/personal";
import { HomeScreenPrompt } from "./HomeScreenPrompt";
import { LevelEditor } from "./LevelEditor";
import { NameEditor } from "./NameEditor";
import { PersonalLinkCard } from "./PersonalLinkCard";
import { PushToggle } from "./PushToggle";
import { RestoreWithEmail } from "./RestoreWithEmail";
import { DeleteAccount } from "./DeleteAccount";

/** "My matches": rendered on /me (cookie identity) and /p/{token} (personal link). */
export async function MyMatches({ player, personalToken }: { player: Player; personalToken: string }) {
  const [t, locale, db] = await Promise.all([getTranslations(), getLocale(), getDb()]);
  const [{ upcoming, past }, hasPush, groups] = await Promise.all([getPlayerEvents(db, player.id), playerHasPush(db, player.id), getPlayerGroups(db, player.id)]);
  const hasHistory = upcoming.length > 0 || past.length > 0;
  // Stats strip: only matches the player was actually in (not organized-from-the-sidelines).
  const playedList = past.filter((m) => m.event.status !== "cancelled" && m.slot.position > 0 && m.slot.position <= m.event.capacity);
  const won = playedList.filter((m) => m.outcome === "won").length;
  const decided = won + playedList.filter((m) => m.outcome === "lost").length;
  const podiums = playedList.filter((m) => m.placement != null && m.placement <= 3).length;
  const stats = [
    { label: t("level.stats.played"), value: String(playedList.length) },
    { label: t("level.stats.won"), value: String(won) },
    { label: t("level.stats.winRate"), value: decided ? `${Math.round((won / decided) * 100)}%` : "—" },
    { label: t("level.stats.podiums"), value: String(podiums) },
  ];
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
          {playedList.length > 0 && (
            <section className="grid grid-cols-4 gap-2">
              {stats.map((s) => (
                <div key={s.label} className="card px-2 py-3 text-center">
                  <div className="text-xl font-extrabold tabular-nums">{s.value}</div>
                  <div className="text-[11px] font-bold uppercase tracking-wider text-faint">{s.label}</div>
                </div>
              ))}
            </section>
          )}
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

      {groups.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-extrabold uppercase tracking-wider text-muted">{t("group.yourGroups")}</h2>
          <ul className="flex flex-col gap-2">
            {groups.map((g) => (
              <li key={g.group.id}>
                <Link href={`/g/${g.group.code}`} prefetch={false} className="card flex items-center gap-4 py-4 hover:border-ink/30">
                  <span className="inline-grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-ink text-lg">👥</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-bold">{g.group.name}</div>
                    <div className="truncate text-sm text-muted">
                      {t("group.memberCount", { count: g.memberCount })}
                      {g.nextEvent ? ` · ${formatEventDay(g.nextEvent.startsAt, g.nextEvent.tz, locale)} ${formatEventTime(g.nextEvent.startsAt, g.nextEvent.tz, locale)}` : ` · ${t("group.noUpcoming")}`}
                    </div>
                  </div>
                  <span className="text-faint">›</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="card">
        <PushToggle vapidPublicKey={vapidPublicKey()} subscribed={hasPush} />
      </section>
      <PersonalLinkCard url={personalUrl(baseUrl(), personalToken)} email={player.email} emailEnabled={emailEnabled()} />
      <HomeScreenPrompt personalPath={personalPath(personalToken)} installed={Boolean(player.homescreenAt)} />
      <section className="card">
        <NameEditor name={player.displayName} />
        <div className="mt-4 border-t border-line pt-4">
          <LevelEditor level={player.level} source={player.levelSource} log={player.levelLog} />
        </div>
        <p className="mt-3 text-xs text-faint">{t("me.identityHelp")}</p>
      </section>

      {!hasHistory && emailEnabled() && (
        <section className="card">
          <RestoreWithEmail initialEmail={player.email ?? ""} />
        </section>
      )}
      <DeleteAccount />
    </>
  );
}
