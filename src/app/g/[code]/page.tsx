import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { GroupJoin, GroupMembers, GroupSettings } from "@/components/GroupPanel";
import { Footer, Header } from "@/components/Header";
import { LevelChip } from "@/components/LevelSelect";
import { ShareButtons } from "@/components/ShareSheet";
import { getDb } from "@/db";
import { calendarTitle } from "@/lib/calendar";
import { isValidInviteCode } from "@/lib/codes";
import { baseUrl, shortHost } from "@/lib/config";
import { formatEventDay, formatEventTime } from "@/lib/dates";
import { getGroupByCode, getGroupDetail } from "@/lib/domain/groups";
import { hasRange } from "@/lib/domain/levels";
import { venueWithCourt } from "@/lib/labels";
import { rangeChip } from "@/lib/levelText";
import { getSessionPlayer } from "@/lib/session";

type Props = { params: Promise<{ code: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { code } = await params;
  const t = await getTranslations();
  const db = await getDb();
  const group = isValidInviteCode(code) ? await getGroupByCode(db, code) : null;
  return { title: group ? `${group.name} · ${t("group.title")}` : t("group.title"), robots: { index: false, follow: false } };
}

const weekdayNames = (locale: string) => Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, 7 + i))));

/** A crew's home: members, the next matches, one button to create the next one. Anyone with the link can join. */
export default async function GroupPage({ params }: Props) {
  const { code } = await params;
  if (!isValidInviteCode(code)) notFound();
  const db = await getDb();
  const group = await getGroupByCode(db, code);
  if (!group) notFound();
  const [t, locale, me, detail] = await Promise.all([getTranslations(), getLocale(), getSessionPlayer(db), getGroupDetail(db, group)]);
  const member = me ? detail.members.find((m) => m.playerId === me.id) : undefined;
  const isAdmin = member?.role === "admin";
  const url = `${baseUrl()}/g/${code}`;
  const weekdays = weekdayNames(locale);
  const labelOpts = { venueTbd: t("event.venueTbd"), courtNumber: (n: string) => t("event.courtNumber", { n }) };
  const venue = venueWithCourt(group, labelOpts);
  const levelChip = rangeChip(t, { min: group.levelMin, max: group.levelMax });
  const repeats = group.recurDow != null && group.recurTime ? t("group.every", { day: weekdays[group.recurDow], time: group.recurTime }) : t("group.none");

  const eventRow = (ev: (typeof detail.upcoming)[number]) => (
    <li key={ev.id}>
      <Link href={`/${ev.code}`} prefetch={false} className="flex items-center gap-3 rounded-2xl border border-line bg-white px-4 py-3 hover:border-ink/30">
        <div className="w-14 shrink-0 text-center">
          <div className="text-xs font-bold uppercase text-faint">{formatEventDay(ev.startsAt, ev.tz, locale).split(" ")[0]}</div>
          <div className="text-xl font-extrabold leading-none tabular-nums">{formatEventTime(ev.startsAt, ev.tz, locale)}</div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-bold">{calendarTitle(ev, t(ev.type === "match" ? "event.match" : "event.tournament"))}</div>
          <div className="truncate text-sm text-muted">
            {formatEventDay(ev.startsAt, ev.tz, locale)} · {venueWithCourt(ev, labelOpts)}
            {ev.status === "cancelled" ? ` · ${t("me.cancelled")}` : ""}
          </div>
        </div>
        <span className="text-faint">›</span>
      </Link>
    </li>
  );

  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12">
        <section className="card">
          <div className="flex flex-wrap items-center gap-2">
            <span className="chip-muted">👥 {t("group.title")}</span>
            <span className="text-xs font-bold uppercase tracking-wider text-faint">{t(group.type === "match" ? "event.match" : "event.tournament")}</span>
            {levelChip && <span className="chip-muted">🎚️ {levelChip}</span>}
          </div>
          <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight">{group.name}</h1>
          <div className="mt-3 rounded-2xl bg-bg px-4 py-3 text-sm">
            <div className={`font-bold ${group.venueName ? "" : "text-muted"}`}>{venue}</div>
            <div className="text-muted">
              🔁 {repeats}
              {group.recurDow != null ? ` · ${t("group.autoHelp", { n: group.recurLeadDays })}` : ""}
            </div>
          </div>
          <div className="mt-4">
            <GroupJoin code={code} member={Boolean(member)} hasIdentity={Boolean(me)} canLeave={Boolean(member) && group.creatorPlayerId !== me?.id} name={group.name} />
          </div>
          {isAdmin && (
            <div className="mt-4">
              <GroupSettings code={code} name={group.name} recurDow={group.recurDow} recurTime={group.recurTime} recurLeadDays={group.recurLeadDays} weekdays={weekdays} />
            </div>
          )}
        </section>

        <section className="card">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-lg font-extrabold">{t("group.upcoming")}</h2>
            <span className="text-sm text-muted">{t("group.memberCount", { count: detail.members.length })}</span>
          </div>
          {detail.upcoming.length ? <ul className="mt-3 flex flex-col gap-2">{detail.upcoming.map(eventRow)}</ul> : <p className="mt-3 text-sm text-faint">{t("group.noUpcoming")}</p>}
          {member ? (
            <div className="mt-4">
              <Link href={`/?group=${code}`} prefetch={false} className="btn-primary w-full">
                + {t("group.nextMatch")}
              </Link>
              <p className="mt-1.5 text-xs text-faint">{t("group.nextMatchHelp")}</p>
            </div>
          ) : (
            <p className="mt-4 text-sm text-muted">{t("group.memberOnly")}</p>
          )}
        </section>

        <section className="card">
          <h2 className="text-lg font-extrabold">{t("group.members")}</h2>
          <GroupMembers
            code={code}
            members={detail.members.map((m) => ({
              playerId: m.playerId,
              name: m.player.displayName,
              level: m.player.level,
              role: m.role,
              isMe: m.playerId === me?.id,
              removable: Boolean(isAdmin) && m.playerId !== me?.id && m.playerId !== group.creatorPlayerId,
            }))}
          />
          {hasRange({ min: group.levelMin, max: group.levelMax }) && (
            <p className="mt-3 text-xs text-faint">
              <LevelChip level={null} /> {t("level.rangeHelp", { range: levelChip ?? "" })}
            </p>
          )}
        </section>

        <section className="card">
          <h2 className="text-lg font-extrabold">{t("event.share")}</h2>
          <div className="mt-1 mb-3 truncate text-sm font-semibold text-muted">
            {shortHost()}/g/{code}
          </div>
          <ShareButtons url={url} text={t("shareText.group", { name: group.name, url })} />
          <p className="mt-2 text-xs text-faint">{t("group.shareHelp")}</p>
        </section>

        {detail.past.length > 0 && (
          <section className="card">
            <h2 className="text-lg font-extrabold">{t("group.past")}</h2>
            <ul className="mt-3 flex flex-col gap-2">{detail.past.map(eventRow)}</ul>
          </section>
        )}
      </main>
      <Footer />
    </>
  );
}
